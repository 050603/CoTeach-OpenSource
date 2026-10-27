import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { ContentMonitorEvent } from "./content-monitor-contract";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";
import { classifyDocumentPaste } from "./content-monitor-policy";

const mocks = vi.hoisted(() => {
  const db = { $queryRaw: vi.fn(), $executeRaw: vi.fn(), $transaction: vi.fn(),
    aiTask: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    aiMessage: { findMany: vi.fn() }, aiInteractionEvent: { findMany: vi.fn() },
    projectGroup: { findFirst: vi.fn() }, teacherAgentDirective: { findMany: vi.fn() },
    classroomSubmission: { findUnique: vi.fn(), findMany: vi.fn() },
    domainEvent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() } };
  return { db, authorize: vi.fn(), publish: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ authorizeLegacyAiScope: mocks.authorize }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
vi.mock("@/lib/llm/client", () => ({ callLLM: vi.fn(), parseLLMJson: JSON.parse }));
import { assertContentMonitorScope, clearedMonitorInput, ContentMonitorScopeClosed, listContentMonitorEvents, monitorEventContentState,
  readContentMonitorCheck, readContentMonitorEvidence, redactContentMonitorEvent, submitContentMonitorCheck, updateContentMonitorEvent, type MonitorSnapshot } from "./content-monitor-service";

const claims = { sub: "student", role: "student", sv: 3 } as AuthClaims;
const runtime = { documentPasteMonitoringEnabled: true, currentStageIndex: 2, stageVersion: 4, makeArtifactMode: "document" };
const live = { runtimeConfig: runtime, snapshot: { design: { stages: [{ key: "launch" }, { key: "ai-learning" }, { key: "make" }], drivingQuestion: "请分析校园浪费问题并根据调查提出解决方案。", content: {} } },
  templateVersionId: "v1", instanceStatus: "TEACHING", offeringStatus: "OPEN", enrollmentStatus: "ACTIVE", archivedAt: null,
  userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 3, studentName: "同学", researchKey: "research", offeringId: "offering" };
const body = { courseId: "course", requestId: "request", fragments: [{ text: "核心内容".repeat(80), beforeText: "不能信任的前文" }], documentText: "当前文稿" };
const snapshot: MonitorSnapshot = { ...body, fingerprint: "hash", studentId: "student", participationId: "participation", offeringId: "offering",
  researchKey: "research", sessionVersion: 3, stageVersion: 4, templateVersionId: "v1", studentName: "同学", submittedAt: "2026-10-25T08:00:00.000Z" };
const event: ContentMonitorEvent = { id: "event", studentId: "student", studentName: "同学", createdAt: "2026-10-25T08:01:00.000Z",
  pastedCharacters: 400, excerpt: "这是足够长的核心方案示例内容。".repeat(4), requirementQuote: "请分析校园浪费问题并根据调查提出解决方案。", reason: "已给出具体方案", status: "pending",
  studentExplanation: "我的草稿", contentState: "unknown", history: [{ at: "now", actor: "student", action: "explain", note: "敏感正文" }] };
const eventRow = { id: "event", payload: { submittedAt: snapshot.submittedAt, event }, createdAt: new Date(event.createdAt),
  participationId: "participation", offeringId: "offering", researchKey: "research" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.$transaction.mockImplementation(async callback => callback(mocks.db));
  mocks.db.$queryRaw.mockResolvedValue([live]);
  mocks.authorize.mockResolvedValue({ user: { id: "student", role: "student" }, participation: { id: "participation" }, studentId: "student" });
  mocks.db.aiTask.count.mockResolvedValue(0);
  mocks.db.aiTask.create.mockImplementation(async ({ data }) => data);
  mocks.db.classroomSubmission.findUnique.mockResolvedValue(null);
  mocks.db.classroomSubmission.findMany.mockResolvedValue([]);
  mocks.db.aiMessage.findMany.mockResolvedValue([]); mocks.db.aiInteractionEvent.findMany.mockResolvedValue([]);
  mocks.db.projectGroup.findFirst.mockResolvedValue(null); mocks.db.teacherAgentDirective.findMany.mockResolvedValue([]);
  mocks.db.domainEvent.findFirst.mockResolvedValue(eventRow);
  mocks.db.domainEvent.findMany.mockResolvedValue([]);
  mocks.db.domainEvent.update.mockImplementation(async ({ data }) => ({ ...eventRow, ...data }));
});

describe("content monitor scope and durable receipts", () => {
  it("reads the server stage key and requires the live document opt-in", async () => {
    await expect(assertContentMonitorScope(mocks.db, snapshot)).resolves.toMatchObject({ studentName: "同学" });
    mocks.db.$queryRaw.mockResolvedValue([{ ...live, runtimeConfig: { ...runtime, documentPasteMonitoringEnabled: undefined } }]);
    await expect(assertContentMonitorScope(mocks.db, snapshot)).rejects.toBeInstanceOf(ContentMonitorScopeClosed);
  });
  it.each([
    { instanceStatus: "FINISHED" }, { offeringStatus: "CLOSED" }, { enrollmentStatus: "WITHDRAWN" }, { userStatus: "DISABLED" },
    { sessionVersion: 4 }, { templateVersionId: "v2" }, { archivedAt: new Date() },
    { runtimeConfig: { ...runtime, makeArtifactMode: "python" } }, { runtimeConfig: { ...runtime, currentStageIndex: 3 } },
    { runtimeConfig: { ...runtime, stageVersion: 5 } },
  ])("rejects changed permission/configuration %j", async delta => {
    mocks.db.$queryRaw.mockResolvedValue([{ ...live, ...delta }]);
    await expect(assertContentMonitorScope(mocks.db, snapshot)).rejects.toBeInstanceOf(ContentMonitorScopeClosed);
  });
  it("queues only the authenticated scope and omits client beforeText", async () => {
    await expect(submitContentMonitorCheck(claims, body)).resolves.toEqual({ requestId: "request", status: "pending" });
    const data = mocks.db.aiTask.create.mock.calls[0][0].data;
    expect(data.input).toMatchObject({ studentId: "student", participationId: "participation", sessionVersion: 3 });
    expect(data.input.fragments[0]).not.toHaveProperty("beforeText");
    expect(mocks.db.domainEvent.create).not.toHaveBeenCalled();
  });
  it("keeps a below-threshold receipt without retaining clipboard text", async () => {
    await expect(submitContentMonitorCheck(claims, { ...body, fragments: [{ text: "少量文本", beforeText: "" }] })).resolves.toMatchObject({ status: "clear" });
    expect(mocks.db.aiTask.create.mock.calls[0][0].data.input).not.toHaveProperty("fragments");
  });
  it("returns the identical receipt on retry and rejects a reused request with other content", async () => {
    await submitContentMonitorCheck(claims, body);
    const created = mocks.db.aiTask.create.mock.calls[0][0].data;
    mocks.db.aiTask.findUnique.mockResolvedValue(created);
    await expect(submitContentMonitorCheck(claims, body)).resolves.toMatchObject({ status: "pending" });
    expect(mocks.db.aiTask.create).toHaveBeenCalledTimes(1);
    await expect(submitContentMonitorCheck(claims, { ...body, documentText: "changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("limits pending work without blocking any document save route", async () => {
    mocks.db.aiTask.count.mockResolvedValue(8);
    await expect(submitContentMonitorCheck(claims, body)).rejects.toMatchObject({ code: "CONTENT_MONITOR_BUSY" });
    expect(mocks.db.aiTask.create).not.toHaveBeenCalled();
  });
  it("never reads a different participant receipt", async () => {
    mocks.db.aiTask.findFirst.mockResolvedValue(null);
    await expect(readContentMonitorCheck(claims, "course", "request")).rejects.toMatchObject({ code: "CHECK_NOT_FOUND" });
    expect(mocks.db.aiTask.findFirst.mock.calls[0][0].where).toMatchObject({ createdById: "student", queueKey: "document-content-monitor-v1" });
  });
  it("retains only identity/fingerprint metadata when clearing input", () => {
    const clean = clearedMonitorInput(snapshot);
    expect(clean).toHaveProperty("fingerprint", "hash");
    expect(JSON.stringify(clean)).not.toContain("核心内容");
    expect(clean).not.toHaveProperty("documentText");
  });
});

describe("source verification and isolated records", () => {
  it("marks a truncated AI history incomplete rather than treating omitted old replies as external text", async () => {
    mocks.db.aiMessage.findMany.mockResolvedValue(Array.from({ length: 301 }, () => ({ content: "旧系统AI正文", metadata: {} })));
    expect((await readContentMonitorEvidence(snapshot)).sourceCoverageComplete).toBe(false);
  });
  it("uses the same real stage-plan contract as the editor, plus owned project and teacher instructions", async () => {
    const draft = emptyResourcePackageDraft();
    mocks.db.$queryRaw.mockResolvedValue([{ ...live, snapshot: { schemaVersion: 2, kind: "pbl-course", design: {
      ...live.snapshot.design, name: "教学设计", learningObjectives: ["运用理论解释教学选择"], content: { stagePlan: { ...draft,
        projectTask: "设计一节解决学习困难的课", stages: draft.stages.map(stage => ({ ...stage,
          requirements: stage.key === "make" ? "以证据比较两种教学方案" : "学习理论", outputs: "个人教案与理由说明", teacherActions: "教师私人提醒" })) } },
    } } }]);
    mocks.db.projectGroup.findFirst.mockResolvedValue({ board: { snapshot: { proposal: { topic: "小学分数课", goal: "纠正分数大小误解" } } } });
    mocks.db.teacherAgentDirective.findMany.mockResolvedValue([{ payload: { view: { stageKey: "make", status: "active", targetScope: "course", goal: "核查选择", instruction: "说明为何选用该案例" } } }]);
    const { taskRequirements } = await readContentMonitorEvidence(snapshot);
    for (const expected of ["设计一节解决学习困难的课", "以证据比较两种教学方案", "个人教案与理由说明", "运用理论解释教学选择", "小学分数课", "说明为何选用该案例"]) expect(taskRequirements).toContain(expected);
    expect(taskRequirements).not.toContain("教师私人提醒");
  });
  it("uses owned server assistant text and visible replacements, never client beforeText or raw request traces", async () => {
    mocks.db.aiMessage.findMany.mockResolvedValue([{ content: "系统AI正文", metadata: { request: "学生请求", response: { raw: "trace" }, replacement: "系统AI替换内容" } }]);
    mocks.db.aiInteractionEvent.findMany.mockResolvedValue([{ content: "旧系统AI正文", payload: { detail: { replacement: "方案", raw: "模型原始推理", request: "用户请求" } } }]);
    const evidence = await readContentMonitorEvidence(snapshot);
    expect(evidence.knownSources).toEqual(["系统AI正文", "系统AI替换内容", "旧系统AI正文", "方案"]);
    expect(mocks.db.aiMessage.findMany.mock.calls[0][0].where).toMatchObject({ role: "assistant", conversation: { userId: "student", participationId: "participation", participation: { instanceId: "course" } } });
    expect(evidence.taskRequirements).toContain(live.snapshot.design.drivingQuestion);
  });
  it("exempts copied visible support cards, suggestions and delivery actions using their persisted shapes", async () => {
    const visible = {
      nextStep: "先根据已有调查数据制作空白对照表，再由你填写并解释发现。".repeat(12),
      reply: "比较方案时分别记录支持证据与尚未验证的假设，不要把推测写成事实。".repeat(12),
      excerpt: "教材参考强调区分样本观察与对总体的推断，结论必须说明适用范围。".repeat(12),
      replacement: "整理后的调查记录表保留日期、样本量、观察值和来源四个字段。".repeat(12),
      delivery: "这是一份供你填写的核验清单，帮助检查自己的方案是否具有可追溯证据。".repeat(12),
      action: "填写调查记录的日期、对象和计量单位，并注明缺失值与记录限制。".repeat(12),
    };
    mocks.db.aiMessage.findMany.mockResolvedValue([{ content: "给学生的简短回复", metadata: {
      projectSupport: { replyBlocks: [{ type: "answer", content: visible.reply, sourceIds: ["source"] }], nextStep: visible.nextStep,
        sources: [{ id: "source", title: "教材", type: "textbook", excerpt: visible.excerpt }], knowledgePoints: [], retrievalStatus: "textbook-supported" },
      request: { projectSupport: { nextStep: "请求中的伪造可见文字" } }, raw: { content: "未经审阅的模型原始结果" }, history: [{ content: "历史用户输入" }],
    } }]);
    mocks.db.aiInteractionEvent.findMany.mockResolvedValue([{ content: null, payload: { detail: {
      suggestion: { operation: "insert", replacement: visible.replacement, targetText: "学生原文不能据此免检" },
      deliverable: { content: visible.delivery, documentActions: [{ operation: "append", content: visible.action, targetText: "学生已有段落" }] },
      request: { suggestion: { replacement: "请求中的替换伪造" } }, raw: { deliverable: { content: "原始交付未获采用" } },
    } } }]);
    const evidence = await readContentMonitorEvidence(snapshot);
    for (const text of Object.values(visible)) {
      expect(evidence.knownSources).toContain(text);
      const generate = vi.fn();
      await expect(classifyDocumentPaste({ ...evidence, pastedText: text }, { generate })).resolves.toMatchObject({ outcome: "exempt" });
      expect(generate).not.toHaveBeenCalled();
    }
    for (const text of ["请求中的伪造可见文字", "未经审阅的模型原始结果", "历史用户输入", "学生原文不能据此免检", "学生已有段落", "请求中的替换伪造", "原始交付未获采用"]) {
      expect(evidence.knownSources).not.toContain(text);
    }
  });
  it("queries only personal event records for a student", async () => {
    mocks.db.domainEvent.findMany.mockResolvedValueOnce([eventRow]).mockResolvedValueOnce([]); mocks.db.$queryRaw.mockResolvedValue([{ studentId: "student", pendingCount: 1, reviewedCount: 0, dismissedCount: 0 }]);
    const result = await listContentMonitorEvents(claims, { courseId: "course" });
    expect(result.events).toHaveLength(1);
    expect(result.studentCounts).toEqual([{ studentId: "student", pendingCount: 1, reviewedCount: 0, dismissedCount: 0 }]);
    const [sql, ...values] = mocks.db.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toContain('e."classroomInstanceId"=?');
    expect(sql.join("?")).toContain('e."actorId"=?');
    expect(values).toEqual(["document_content_reminder_history", "course", "document_content_reminder", "student", "student"]);
    expect(mocks.db.domainEvent.findMany.mock.calls[0][0].where).toEqual({ classroomInstanceId: "course", eventType: "document_content_reminder", actorId: "student" });
  });
  it("returns whole-class student totals even for reminders beyond the first 100 records", async () => {
    mocks.authorize.mockResolvedValue({ user: { id: "teacher", role: "teacher" } });
    mocks.db.domainEvent.findMany.mockResolvedValueOnce(Array.from({ length: 101 }, (_, index) => ({ ...eventRow, id: `event-${index}` }))).mockResolvedValueOnce([]);
    const studentCounts = [
      { studentId: "student", pendingCount: 99, reviewedCount: 1, dismissedCount: 0 },
      { studentId: "outside-first-page", pendingCount: 5, reviewedCount: 2, dismissedCount: 3 },
    ];
    mocks.db.$queryRaw.mockResolvedValue(studentCounts);
    const result = await listContentMonitorEvents({ ...claims, role: "teacher", username: "teacher", displayName: "老师" }, { courseId: "course" });
    expect(result.events).toHaveLength(100);
    expect(result.nextCursor).toBe("event-99");
    expect(result.pendingCount).toBe(104);
    expect(result.studentCounts).toEqual(studentCounts);
    const [sql, ...values] = mocks.db.$queryRaw.mock.calls[0];
    const query = sql.join("?");
    expect(query).toContain("LEFT JOIN LATERAL");
    expect(query).toContain('h."classroomInstanceId"=e."classroomInstanceId"');
    expect(query).toContain("h.payload->>'eventId'=e.id");
    expect(query).toContain('ORDER BY h."createdAt" DESC, h.id DESC LIMIT 1');
    expect(query).toContain('GROUP BY e."actorId"');
    expect(query).not.toContain("LIMIT 100");
    expect(values).toEqual(["document_content_reminder_history", "course", "document_content_reminder", null, null]);
  });
  it("uses the authorized student scope for teacher-filtered totals and rejects cross-student access", async () => {
    mocks.authorize.mockResolvedValue({ user: { id: "teacher", role: "teacher" }, studentId: "selected-student" });
    mocks.db.$queryRaw.mockResolvedValue([{ studentId: "selected-student", pendingCount: 2, reviewedCount: 1, dismissedCount: 0 }]);
    const teacher = { ...claims, role: "teacher" as const, username: "teacher", displayName: "老师" };
    const result = await listContentMonitorEvents(teacher, { courseId: "other-course", studentId: "selected-student", cursor: "page-cursor" });
    expect(result.studentCounts).toEqual([{ studentId: "selected-student", pendingCount: 2, reviewedCount: 1, dismissedCount: 0 }]);
    expect(mocks.authorize).toHaveBeenCalledWith(teacher, "other-course", "selected-student");
    expect(mocks.db.$queryRaw.mock.calls[0].slice(1)).toEqual(["document_content_reminder_history", "other-course", "document_content_reminder", "selected-student", "selected-student"]);
    expect(mocks.db.domainEvent.findMany.mock.calls[0][0]).toMatchObject({ where: { classroomInstanceId: "other-course", actorId: "selected-student" }, cursor: { id: "page-cursor" } });
    mocks.db.$queryRaw.mockClear(); mocks.db.domainEvent.findMany.mockClear();
    mocks.authorize.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "STUDENT_SCOPE_MISMATCH" }));
    await expect(listContentMonitorEvents(claims, { courseId: "other-course", studentId: "selected-student" })).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
    expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.db.domainEvent.findMany).not.toHaveBeenCalled();
  });
  it("returns the latest reviewed status after review and subsequent readback without counting duplicate history", async () => {
    const teacher = { ...claims, role: "teacher" as const, username: "teacher", displayName: "老师" };
    mocks.authorize.mockResolvedValue({ user: { id: "teacher", role: "teacher" } });
    const earlier = { payload: { eventId: "event", actor: "teacher", action: "dismissed" }, createdAt: new Date("2026-10-25T08:02:00.000Z") };
    const reviewed = { payload: { eventId: "event", actor: "teacher", action: "reviewed" }, createdAt: new Date("2026-10-25T08:03:00.000Z") };
    mocks.db.domainEvent.findMany.mockResolvedValueOnce([earlier]);
    mocks.db.domainEvent.create.mockResolvedValue({ ...reviewed });
    await expect(updateContentMonitorEvent(teacher, "event", { courseId: "course", action: "review", status: "reviewed" })).resolves.toMatchObject({ status: "reviewed" });
    mocks.db.domainEvent.findMany.mockResolvedValueOnce([eventRow]).mockResolvedValueOnce([earlier, reviewed, reviewed]);
    mocks.db.$queryRaw.mockResolvedValue([{ studentId: "student", pendingCount: 0, reviewedCount: 1, dismissedCount: 0 }]);
    const result = await listContentMonitorEvents(teacher, { courseId: "course" });
    expect(result.events[0].status).toBe("reviewed");
    expect(result.studentCounts).toEqual([{ studentId: "student", pendingCount: 0, reviewedCount: 1, dismissedCount: 0 }]);
    expect(result.pendingCount).toBe(0);
    expect(mocks.db.domainEvent.update).not.toHaveBeenCalled();
  });
  it("does not allow students to mark reviews, or teachers to submit student explanations", async () => {
    await expect(updateContentMonitorEvent(claims, "event", { courseId: "course", action: "review", status: "dismissed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.authorize.mockResolvedValue({ user: { id: "teacher", role: "teacher" } });
    await expect(updateContentMonitorEvent({ ...claims, role: "teacher", username: "teacher", displayName: "老师" }, "event", { courseId: "course", action: "explain", source: "own-draft", explanation: "text" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("checks the event classroom and owner on an explanation and emits metadata only", async () => {
    await updateContentMonitorEvent(claims, "event", { courseId: "course", action: "explain", source: "own-draft", explanation: "来自我课前草稿" });
    expect(mocks.db.domainEvent.findFirst.mock.calls[0][0].where).toMatchObject({ classroomInstanceId: "course", actorId: "student", participationId: "participation" });
    expect(mocks.db.domainEvent.create.mock.calls[0][0].data.eventType).toBe("document_content_reminder_history");
    expect(mocks.db.domainEvent.update).not.toHaveBeenCalled();
    expect(mocks.publish.mock.calls[0][1].payload).toEqual({ source: "content-monitor", scope: "student", studentId: "student" });
  });
  it("projects review and explanation history without rewriting the original observation", async () => {
    mocks.db.domainEvent.findMany.mockResolvedValueOnce([eventRow]).mockResolvedValueOnce([
      { payload: { eventId: "event", actor: "student", action: "explain", source: "quotation", note: "已补充引用来源" }, createdAt: new Date("2026-10-25T08:02:00.000Z") },
      { payload: { eventId: "event", actor: "teacher", action: "dismissed", note: "已核对引用" }, createdAt: new Date("2026-10-25T08:03:00.000Z") },
    ]);
    mocks.db.$queryRaw.mockResolvedValue([{ studentId: "student", pendingCount: 0, reviewedCount: 0, dismissedCount: 1 }]);
    const result = await listContentMonitorEvents(claims, { courseId: "course" });
    expect(result.events[0]).toMatchObject({ status: "dismissed", studentSource: "quotation", studentExplanation: "已补充引用来源", acknowledgedAt: "2026-10-25T08:02:00.000Z" });
    expect(result.pendingCount).toBe(0);
    expect(result.studentCounts).toEqual([{ studentId: "student", pendingCount: 0, reviewedCount: 0, dismissedCount: 1 }]);
    expect(eventRow.payload.event.status).toBe("pending");
  });
  it("omits all excerpt-bearing fields by default in research export", () => {
    const redacted = redactContentMonitorEvent(event, false);
    expect(redacted).not.toHaveProperty("excerpt"); expect(redacted).not.toHaveProperty("studentExplanation");
    expect(redacted).not.toHaveProperty("reason"); expect(redacted.history[0]).not.toHaveProperty("note");
    expect(redactContentMonitorEvent(event, true)).toEqual(event);
  });
  it("does not call an old or missing saved document removed", () => {
    const at = new Date(snapshot.submittedAt);
    expect(monitorEventContentState(event.excerpt, undefined, at)).toBe("unknown");
    expect(monitorEventContentState(event.excerpt, { text: "旧文稿", updatedAt: new Date(0) }, at)).toBe("unknown");
    expect(monitorEventContentState(event.excerpt, { text: `<p>${event.excerpt}</p>`, updatedAt: at }, at)).toBe("unchanged");
    expect(monitorEventContentState(event.excerpt, { text: "全新文稿", updatedAt: at }, at)).toBe("removed");
    expect(monitorEventContentState(event.excerpt, { text: event.excerpt.slice(0, 30) + "改写部分", updatedAt: at }, at)).toBe("modified");
  });
});
