import { expect, test, type Locator, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { browserLearningEventReceipt, createBrowserActionReceipts } from "../scripts/lib/classroom-acceptance-action-receipts.mjs";
import { DEFAULT_STAGES, type ClassroomSubmission, type Course } from "../src/lib/session/types";
import { DEFAULT_PBL_COURSE_CONFIG } from "../src/lib/pbl-course-config";
import type { ContentMonitorCheckInput, ContentMonitorEvent, ContentMonitorEventAction, ContentMonitorReceipt } from "../src/lib/project-practice/content-monitor-contract";

// Real browser/editor behavior with mocked APIs only. Unknown business requests
// fail closed; no fixture request reaches users, submissions, AI or the database.
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
const mockSecret = process.env.OPENPBL_CONTENT_MONITOR_E2E_JWT_SECRET || "content-monitor-isolated-browser-mock-secret-only";
test.use({ baseURL, serviceWorkers: "block", reducedMotion: "reduce" });
test.beforeAll(() => {
  const url = new URL(baseURL);
  if (!process.env.OPENPBL_RESOURCE_E2E_BASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port === "3000") {
    throw new Error("Content monitor browser fixtures require an explicit local, non-production port and JWT_SECRET matching OPENPBL_CONTENT_MONITOR_E2E_JWT_SECRET (or its mock default).");
  }
});

const courseId = "e2e-document-content-monitor";
const studentId = "e2e-content-student";
const now = "2026-10-25T03:00:00.000Z";
const initialText = "我的观察记录：在相同时段比较教室照明。";
const requirement = "比较相同条件下的实际记录，解释节能方案的适用条件，并给出自己的论证。";
const coreText = Array.from({ length: 10 }, (_, index) => `第${index + 1}组比较结论：根据各区域的照明时长、在场人数与自然采光记录，应先调整无人区域的照明，再连续观察一周并检查舒适度变化，最后说明这项方案适用的条件。`).join("\n");
const excerpt = coreText.split("\n")[0];

function reminder(): ContentMonitorEvent {
  return { id: "content-reminder-1", studentId, studentName: "林同学", createdAt: now, pastedCharacters: coreText.length,
    excerpt, requirementQuote: requirement, reason: "这段内容直接给出了任务所要求的分析与结论，建议补充来源和自己的判断。",
    status: "pending", contentState: "unknown", history: [{ at: now, actor: "system", action: "created" }] };
}

async function fixture(page: Page, role: "student" | "teacher", enabled = true) {
  const name = role === "teacher" ? "来源提醒验收教师" : "林同学";
  const token = await new SignJWT({ role, sv: 1, displayName: name, username: "content-monitor-fixture",
    ...(role === "student" ? { userId: studentId, studentName: name } : {}) })
    .setProtectedHeader({ alg: "HS256" }).setSubject(role === "student" ? studentId : "content-monitor-teacher")
    .setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(mockSecret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  const stages = DEFAULT_STAGES.map(stage => ({ ...stage }));
  let course: Course = {
    id: courseId, version: 1, stageVersion: 1, name: "校园照明证据实践", subject: "科学", grade: "七年级", hours: 1,
    summary: "", drivingQuestion: "怎样依据观察记录改进校园照明？", status: "teaching", stages, currentStageIndex: 2,
    students: [{ id: studentId, name: "林同学", joinedAt: now, stageProgress: {} }], groups: [], resources: [], activityLog: [],
    pblConfig: { ...DEFAULT_PBL_COURSE_CONFIG, makeArtifactMode: "document", documentPasteMonitoringEnabled: enabled },
    submissions: [{ id: "document-draft", courseId, studentId, studentName: "林同学", stageKey: "make", type: "document", title: "校园照明观察", status: "draft",
      content: `<p>${initialText}</p>`, version: 1, createdAt: now, updatedAt: now }],
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
      stagePlan: { schemaVersion: 2, source: "resource-package", totalMinutes: 45, lessonCount: 1, minutesPerLesson: 45,
        projectTask: requirement, stages: [{ key: "make", title: "项目实践", durationMin: 25, requirements: requirement,
          outputs: "形成有证据的照明改进方案。", teacherActions: "结合学生说明核实来源。", aiActions: "辅助整理已有观察记录。" }],
        evaluationCriteria: "论证合理，记录真实。", reflectionQuestions: [], aiUsagePolicy: "AI 可辅助整理，核心分析需自己完成。" } },
    uiState: { classroomTiming: { schemaVersion: 1, status: "paused", sessionStartedAt: now, pausedAt: now, activeStageKey: "make", updatedAt: now,
      stages: stages.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 2 ? "active" : "completed" })) } },
    createdAt: now, updatedAt: now,
  };
  const events: ContentMonitorEvent[] = role === "teacher" ? [{ ...reminder(), studentSource: "own-draft", studentExplanation: "这是我离线分析后写的草稿。", acknowledgedAt: now }] : [];
  const checks: ContentMonitorCheckInput[] = [];
  const writes: ContentMonitorEventAction[] = [];
  const saved: ClassroomSubmission[] = [];
  const finalized: Array<{ revisionNote?: string }> = [];
  const errors: string[] = [];
  const unknownRequests: string[] = [];
  const receipts = new Map<string, ContentMonitorReceipt>();
  const actionReceipts = createBrowserActionReceipts(courseId, now);
  const copyEvent = () => events[0] ? structuredClone(events[0]) : undefined;
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => {
    if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
    socket.onMessage(message => {
      const input = JSON.parse(String(message));
      if (input.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: input.courseId }));
    });
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") return json({ user: { id: role === "student" ? studentId : "content-monitor-teacher", role, name, displayName: name } });
    if (path === "/api/courses") return json({ courses: [course], user: { role, name }, studentId, studentName: "林同学", ...(role === "student" ? { joinedCourseId: courseId } : {}), hydrated: true, updatedAt: now });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: course.version, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/public-discussion`) return json({ enabled: false, session: null });
    if (path === `/api/courses/${courseId}/actions`) {
      const body = request.postDataJSON();
      const previous = actionReceipts.lookup(body);
      if (previous) return json(previous.body, previous.status);
      const action = body.action;
      const submitted = action?.payload?.submission as ClassroomSubmission | undefined;
      let submissionVersion: number | undefined;
      if (submitted) {
        const current = course.submissions?.find(item => item.id === submitted.id);
        if (action.payload.expectedSubmissionVersion !== (current?.version ?? 0)) return json({ code: "DRAFT_VERSION_CONFLICT", message: "草稿版本已变化。" }, 409);
        submissionVersion = (current?.version ?? 0) + 1;
        const value = { ...submitted, version: submissionVersion };
        saved.push(value);
        course.submissions = [...(course.submissions ?? []).filter(item => item.id !== submitted.id), value];
      }
      if (action?.type === "UPDATE_COURSE") course = { ...course, ...action.payload.patch };
      if (action?.type === "SET_UI_STATE") course.uiState = { ...course.uiState, ...action.payload.patch };
      course.version = (course.version ?? 0) + 1;
      return json(actionReceipts.remember(body, { ok: true, courseVersion: course.version, ...(submissionVersion ? { submissionVersion } : {}), updatedAt: now }));
    }
    if (path === "/api/project-practice/content-monitor/checks") {
      if (request.method() === "POST") {
        const input = request.postDataJSON() as ContentMonitorCheckInput;
        checks.push(input);
        if (!receipts.has(input.requestId)) {
          if (!events.length) events.push(reminder());
          receipts.set(input.requestId, { requestId: input.requestId, status: "flagged" });
        }
        return json({ ...receipts.get(input.requestId), event: copyEvent() });
      }
      const requestId = url.searchParams.get("requestId") ?? "";
      const result = receipts.get(requestId);
      return result ? json({ ...result, event: copyEvent() }) : json({ message: "未找到检测请求" }, 404);
    }
    if (path === "/api/project-practice/content-monitor/events") return json({ events, pendingCount: events.filter(event => event.status === "pending").length });
    if (path === "/api/project-practice/content-monitor/events/content-reminder-1" && request.method() === "PATCH") {
      const input = request.postDataJSON() as ContentMonitorEventAction;
      writes.push(input);
      const event = events[0];
      if (!event) return json({ message: "未找到记录" }, 404);
      if (input.action === "acknowledge") event.acknowledgedAt = new Date().toISOString();
      if (input.action === "explain") { event.studentSource = input.source; event.studentExplanation = input.explanation; }
      if (input.action === "review") event.status = input.status;
      event.history.push({ at: new Date().toISOString(), actor: role, action: input.action, ...(input.action === "review" ? { note: input.note } : {}) });
      return json({ event });
    }
    if (path === "/api/ai-collaboration/document") return json({ messages: [], commentThreads: [], starters: [], conversations: [], requests: [], proactiveReviewEnabled: false });
    if (path === "/api/ai-collaboration/memory") return json({ memories: [], continuation: null });
    if (path === "/api/project-practice/submissions/finalize" && request.method() === "POST") {
      finalized.push(request.postDataJSON());
      return json({ sequence: 1, submittedAt: now, downloadUrl: "/api/fixture-final-document" });
    }
    if (path === "/api/learning-events" && request.method() === "POST") {
      const receipt = browserLearningEventReceipt(request.postData(), Date.now()); return json(receipt.body, receipt.status);
    }
    if (["/api/ai-collaboration/events", `/api/courses/${courseId}/learning-events`].includes(path)) return json({ success: true });
    if (["/api/openmaic/server-providers", "/api/openmaic/provider-config", "/api/server-providers"].includes(path)) return json({ providers: [], models: [], success: true });
    if (path === `/api/platform/classroom-instances/${courseId}/process-evaluation`) return json({ participants: [], reports: [], jobs: [] });
    unknownRequests.push(`${request.method()} ${path}`);
    return json({ message: `No isolated content-monitor fixture for ${path}` }, 404);
  });
  return { checks, writes, events, saved, finalized, errors, unknownRequests, currentCourse: () => course };
}

async function pasteIntoPlate(page: Page, text: string) {
  const editor = page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.locator('[data-slate-node="element"]').filter({ visible: true }).last().click();
  await page.keyboard.press("ControlOrMeta+End");
  await editor.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  await expect(editor).toContainText(text.split("\n")[0]);
  return editor;
}

async function expectFits(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
  if (dialog) {
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(-1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  }
}

test("mock student: native Plate paste persists, reminder accepts explanation and does not repeat", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 820, height: 1180 });
  const data = await fixture(page, "student");
  await page.goto(`/student/ai-collaboration/${courseId}`);
  await expect(page.getByRole("button", { name: "AI 协作检查已开启，查看说明" })).toBeVisible();
  const editor = await pasteIntoPlate(page, coreText);
  const dialog = page.getByRole("dialog", { name: "请规范使用外部内容和 AI", exact: true });
  await expect(dialog).toBeVisible();
  expect(data.checks).toHaveLength(1);
  expect(data.checks[0].fragments.map(fragment => fragment.text).join("\n")).toBe(coreText);
  expect(data.checks[0].documentText).toContain(excerpt);
  await dialog.getByRole("combobox", { name: "来源说明（可选）", exact: true }).selectOption("own-draft");
  await dialog.getByLabel("补充说明（可选）", { exact: true }).fill("这是我离线完成后复制的观察分析，已保留原始记录。");
  await expectFits(page, dialog);
  await page.screenshot({ path: info.outputPath("mock-student-source-reminder.png"), fullPage: true });
  await dialog.getByRole("button", { name: "保存说明并继续", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => data.writes.filter(write => write.action === "explain").length).toBe(1);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => data.saved.some(submission => submission.content?.includes(excerpt))).toBe(true);
  await expect(page.locator('[data-slot="save-status"]')).toContainText("已保存");
  await expect(editor).toContainText(initialText);

  // A repeated browser paste is still inserted by Plate, but creates no second check.
  await pasteIntoPlate(page, coreText);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => data.saved.at(-1)?.content?.split(excerpt).length).toBe(3);
  expect(data.checks).toHaveLength(1);
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.locator('[data-slate-editor="true"]').first()).toContainText(excerpt);
  await expect(dialog).toBeHidden();
  expect(data.events).toHaveLength(1);
  expect(data.events[0].studentSource).toBe("own-draft");
  expect(data.writes.filter(write => write.action === "acknowledge")).toHaveLength(1);
  await expectFits(page);
  expect(data.errors).toEqual([]);
  expect(data.unknownRequests).toEqual([]);
});

test("mock student: disabled monitoring leaves mobile paste and saving available without checks", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const data = await fixture(page, "student", false);
  await page.goto(`/student/ai-collaboration/${courseId}`);
  await pasteIntoPlate(page, coreText);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => data.saved.some(submission => submission.content?.includes(excerpt))).toBe(true);
  await expect(page.locator('[data-slot="save-status"]')).toContainText("已保存");
  await expect(page.getByRole("dialog", { name: "请规范使用外部内容和 AI" })).toHaveCount(0);
  await expect(page.getByText(/教师已开启外部内容使用提醒/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI 协作检查已开启，查看说明" })).toHaveCount(0);
  expect(data.checks).toHaveLength(0);
  expect(data.events).toHaveLength(0);
  await expectFits(page);
  await page.screenshot({ path: info.outputPath("mock-student-monitor-off.png"), fullPage: true });
  expect(data.errors).toEqual([]);
  expect(data.unknownRequests).toEqual([]);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`mock student: compact header explanation and usable revision note at ${viewport.width}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const data = await fixture(page, "student");
    await page.goto(`/student/ai-collaboration/${courseId}`);
    const status = page.getByRole("button", { name: "AI 协作检查已开启，查看说明", exact: true });
    await expect(status).toBeVisible();
    expect((await status.boundingBox())!.y).toBeLessThan(64);
    await expect(page.locator('[data-document-workspace]').getByText(/教师已开启外部内容使用提醒/)).toHaveCount(0);
    if (viewport.width > 600) {
      await status.hover();
      await expect(page.getByRole("tooltip")).toContainText("提醒需人工核实");
    }
    await status.click();
    const explanation = page.getByRole("dialog", { name: "AI 协作检查说明", exact: true });
    await expect(explanation).toContainText("不自动扣分");
    await expectFits(page, explanation);
    await page.screenshot({ path: info.outputPath("compact-monitor-explanation.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(explanation).toBeHidden();
    await expect(page.getByRole("tooltip")).toBeHidden();

    await page.getByRole("button", { name: "修改说明", exact: true }).click();
    const revision = page.getByRole("dialog", { name: "提交修改说明", exact: true });
    const note = "补充了观察记录，并根据相同时段的数据修正比较结论。";
    await expect(revision).toBeVisible();
    await revision.getByRole("textbox", { name: "提交修改说明", exact: true }).fill(note);
    await expectFits(page, revision);
    await page.screenshot({ path: info.outputPath("revision-note-popover.png"), fullPage: true });
    await revision.getByRole("button", { name: "完成", exact: true }).click();
    await expect(revision).toBeHidden();
    await page.getByRole("button", { name: /^修改说明.*已填写/ }).click();
    await expect(revision.getByRole("textbox")).toHaveValue(note);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "提交最终版", exact: true }).click();
    await expect.poll(() => data.finalized.at(-1)?.revisionNote).toBe(note);
    await expect(page.getByRole("link", { name: "下载第 1 版 Word", exact: true })).toBeVisible();
    expect(data.checks).toHaveLength(0);
    expect(data.errors).toEqual([]);
    expect(data.unknownRequests).toEqual([]);
  });
}

for (const viewport of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
  test(`mock teacher: review, historical records after disabling, private projection ${viewport.width}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const data = await fixture(page, "teacher");
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    await expect(page.getByRole("button", { name: /外部内容提醒/ })).toHaveCount(0);
    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await page.getByRole("button", { name: "外部内容提醒（1 待核实）", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "外部核心内容使用提醒", exact: true });
    await expect(dialog.getByText("这是我离线分析后写的草稿。", { exact: false })).toBeVisible();
    await dialog.getByText("查看核实片段与提醒依据", { exact: true }).click();
    await expect(dialog.getByText(excerpt, { exact: true })).toBeVisible();
    await expect(dialog.getByText(/尚未核对保存稿/)).toBeVisible();
    await dialog.getByLabel("核实备注（可选）", { exact: true }).fill("已查看学生原始草稿和记录，排除此条提醒。");
    await expectFits(page, dialog);
    await page.screenshot({ path: info.outputPath("mock-teacher-source-evidence.png"), fullPage: true });
    await dialog.getByRole("button", { name: "排除这条提醒", exact: true }).click();
    await expect(dialog.getByText("当前筛选下暂无提醒记录。", { exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "核实状态", exact: true }).selectOption("all");
    await expect(dialog.getByRole("heading", { name: "林同学 · 已排除", exact: true })).toBeVisible();
    await dialog.getByRole("switch", { name: "本场课堂开启外部核心内容使用提醒", exact: true }).uncheck();
    await expect(dialog.getByText("本场课堂设置已保存。", { exact: true })).toBeVisible();
    expect(data.currentCourse().pblConfig?.documentPasteMonitoringEnabled).toBe(false);
    await dialog.getByRole("button", { name: "刷新记录", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "林同学 · 已排除", exact: true })).toBeVisible();
    await expect(dialog.getByText("已查看学生原始草稿和记录，排除此条提醒。", { exact: false })).toBeVisible();
    expect(data.writes.filter(write => write.action === "review")).toHaveLength(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "返回展示", exact: true }).click();
    await expect(page.getByRole("button", { name: /外部内容提醒/ })).toHaveCount(0);
    await expect(page.getByText(excerpt, { exact: true })).toHaveCount(0);
    await expect(page.getByText(/这是我离线分析后写的草稿/)).toHaveCount(0);
    await expectFits(page);
    await page.screenshot({ path: info.outputPath("mock-teacher-private-projection.png"), fullPage: true });
    expect(data.errors).toEqual([]);
    expect(data.unknownRequests).toEqual([]);
  });
}
