import { expect, test, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { readFile } from "node:fs/promises";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";
import { DEFAULT_PBL_RUBRIC, emptyPblAnswers, pblWeightedScore, type PblEvaluationCommand, type PblEvaluationRecord, type PblEvaluationSnapshot, type PblProcessReport } from "../src/lib/evaluation/pbl-contract";

// Browser/UI acceptance only: every API and classroom socket is intercepted.
// These fixtures never write users, classrooms, grades or reports to a database.
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("PBL evaluation fixtures require a local service");
const mockSecret = process.env.OPENPBL_PBL_E2E_JWT_SECRET || "pbl-evaluation-isolated-browser-mock-secret-only";
test.use({ baseURL, serviceWorkers: "block", reducedMotion: "reduce" });
test.beforeAll(() => {
  if (!process.env.OPENPBL_RESOURCE_E2E_BASE_URL || new URL(baseURL).port === "3000") throw new Error("Run PBL mock acceptance against an isolated non-production port with JWT_SECRET matching OPENPBL_PBL_E2E_JWT_SECRET (or the fixture default).");
});
const instanceId = "e2e-pbl-evaluation";
const studentId = "e2e-pbl-student";
const now = "2026-10-25T03:00:00.000Z";
const rubric = DEFAULT_PBL_RUBRIC;
function report(summary = "已发布：根据作品修订记录，学生能够比较证据并解释修改。 "): PblProcessReport {
  return { id: "report", generatedAt: now, evidenceThrough: now, evidenceGaps: ["缺少现场汇报观察"], confidence: "low", source: "llm", summary, dimensions: [{ id: "iteration", name: "迭代与改进", judgment: "能结合实验结果解释方案修改。", score: 82, evidence: [{ id: "version-1", label: "已保存的第二版方案", detail: "根据两次测量的差异调整了观察条件。" }], gaps: [], suggestion: "继续记录不同条件下的结果。" }, { id: "ai", name: "AI 协作与自主判断", judgment: "未观察到 AI 使用，保留独立完成任务的可能。", score: null, evidence: [], gaps: ["没有 AI 协作记录"], suggestion: "可通过作品与解释说明独立思考。" }] };
}
function evaluation(source: "self" | "peer" | "teacher", version = 1): PblEvaluationRecord {
  return { id: `${source}-evaluation`, participationId: "p1", source, assignmentId: source === "peer" ? "assignment" : null, version, status: "submitted", rubric, answers: { ...emptyPblAnswers(rubric), comment: "能够结合证据说明改进方向。" }, suggestedScore: null, score: null, submittedAt: now, returnedReason: null, updatedAt: now, history: [] };
}
function snapshot(role: "teacher" | "student"): PblEvaluationSnapshot {
  const artifact = { versionId: "artifact-1", title: "校园观察方案", sequence: 2, sourceHtml: "<h2>校园观察方案</h2><p>比较同一时段的用电量，并根据测量结果修订节能方案。</p>", mimeType: "text/html", submittedAt: now, fileUrl: null };
  const own = { participationId: "p1", studentId, name: "林同学", artifacts: [artifact], selfEvaluation: null, peerEvaluations: [], teacherEvaluation: role === "student" ? evaluation("teacher") : null, processReport: role === "student" ? report() : report("教师最新报告，尚未重新发布"), published: role === "student" ? { at: now, teacherEvaluation: evaluation("teacher"), processReport: report() } : null };
  return { contractVersion: 2, role, instanceId, stage: "reflection", canWrite: true, canConfigureRubric: false, canPublish: role === "teacher", config: { version: 0, rubric, peerMode: "balanced", reviewsPerStudent: 1, anonymous: true }, participants: role === "teacher" ? [own, { ...own, participationId: "p2", studentId: "student-2", name: "陈同学", processReport: null, published: null }] : [own], assignments: [{ id: "assignment", reviewerParticipationId: "p1", targetParticipationId: "p2", targetName: "陈同学", reviewerName: "林同学", artifact: { ...artifact, versionId: "artifact-2", title: "教室照明改进方案" }, evaluation: null }], completion: { total: role === "teacher" ? 2 : 1, selfSubmitted: 0, peerAssigned: 1, peerSubmitted: 0, teacherSubmitted: role === "student" ? 1 : 0, published: role === "student" ? 1 : 0 } };
}

async function fixture(page: Page, role: "teacher" | "student", legacy = false) {
  const name = role === "teacher" ? "评价验收教师" : "林同学";
  const token = await new SignJWT({ role, sv: 1, username: "evaluation-fixture", displayName: name, ...(role === "student" ? { userId: studentId, studentName: name } : {}) }).setProtectedHeader({ alg: "HS256" }).setSubject(role === "student" ? studentId : "evaluation-teacher").setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(mockSecret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  const stages = DEFAULT_STAGES.map(stage => stage.key === "reflection" && legacy ? { ...stage, label: "后测", view: "experiment-posttest" as const } : { ...stage });
  let course: Course = { id: instanceId, version: 1, ...(legacy ? {} : { evaluationContractVersion: 2 as const }), name: "校园观察与节能实践", subject: "科学", grade: "七年级", hours: 1, summary: "", drivingQuestion: "怎样根据证据改进校园能源使用？", status: "teaching", stages, currentStageIndex: 4,
    students: [{ id: studentId, name: "林同学", joinedAt: now, stageProgress: {} }, { id: "student-2", name: "陈同学", joinedAt: now, stageProgress: {} }], resources: [], groups: [],
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    uiState: { classroomTiming: { schemaVersion: 1, status: "paused", sessionStartedAt: now, pausedAt: now, activeStageKey: "reflection", updatedAt: now, stages: stages.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 4 ? "active" : "completed" })) } }, createdAt: now, updatedAt: now };
  const state = snapshot(role);
  const writes: PblEvaluationCommand[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => { if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; } socket.onMessage(message => { const input = JSON.parse(String(message)); if (input.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: input.courseId })); }); });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") return json({ user: { id: role === "student" ? studentId : "evaluation-teacher", role, name, displayName: name } });
    if (path === "/api/courses") return json({ courses: [course], user: { role, name }, studentId, studentName: "林同学", ...(role === "student" ? { joinedCourseId: instanceId } : {}), hydrated: true, updatedAt: now });
    if (path === `/api/courses/${instanceId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${instanceId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${instanceId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${instanceId}/projection`) return json({ courseVersion: course.version, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${instanceId}/actions`) {
      const body = request.postDataJSON();
      if (body.action?.type === "SET_UI_STATE") course = { ...course, uiState: { ...course.uiState, ...body.action.payload.patch } };
      return json({ ok: true, requestId: body.requestId, courseVersion: course.version, updatedAt: now });
    }
    if (path === `/api/platform/classroom-instances/${instanceId}/evaluation`) {
      if (request.method() === "GET") return json(state);
      const input = request.postDataJSON() as PblEvaluationCommand;
      writes.push(input);
      if (input.action === "save" || input.action === "submit") {
        const participant = state.participants.find(item => item.participationId === input.participationId);
        const assignment = state.assignments.find(item => item.id === input.assignmentId);
        const previous = input.source === "peer" ? assignment?.evaluation : input.source === "self" ? participant?.selfEvaluation : participant?.teacherEvaluation;
        if (input.version !== (previous?.version ?? 0)) return json({ code: "DRAFT_VERSION_CONFLICT", message: "评价已更新" }, 409);
        const next: PblEvaluationRecord = { ...evaluation(input.source, input.version + 1), participationId: input.participationId, answers: input.answers, status: input.action === "submit" ? "submitted" : "draft", suggestedScore: pblWeightedScore(rubric, input.answers.dimensionScores), score: input.source === "teacher" ? input.answers.finalScore ?? pblWeightedScore(rubric, input.answers.dimensionScores) : null };
        if (input.source === "peer" && assignment) assignment.evaluation = next;
        else if (participant && input.source === "self") participant.selfEvaluation = next;
        else if (participant) participant.teacherEvaluation = next;
      } else if (input.action === "config") state.config = { ...input.config, version: state.config.version + 1 };
      else if (input.action === "publish") for (const participant of state.participants.filter(item => input.participationIds.includes(item.participationId))) participant.published = { at: new Date().toISOString(), teacherEvaluation: participant.teacherEvaluation, processReport: participant.processReport };
      state.completion.selfSubmitted = state.participants.filter(item => item.selfEvaluation?.status === "submitted").length;
      state.completion.peerSubmitted = state.assignments.filter(item => item.evaluation?.status === "submitted").length;
      state.completion.teacherSubmitted = state.participants.filter(item => item.teacherEvaluation?.status === "submitted").length;
      state.completion.published = state.participants.filter(item => item.published).length;
      return json(state);
    }
    if (path === `/api/platform/classroom-instances/${instanceId}/process-evaluation`) return json(request.method() === "GET" ? { reports: [], jobs: [], participants: state.participants } : { queued: 0 });
    if (path === `/api/platform/classroom-instances/${instanceId}/experiment/results`) return json({ enabled: false, studentRows: [], submissions: [] });
    if (path === `/api/platform/classroom-instances/${instanceId}/experiment`) return json({ enabled: false, available: false, questions: [], draft: null, submission: null, blockedReason: "本课堂未配置后测。" });
    // Fail closed: unknown API traffic never falls through to the local database.
    return json({ message: `No isolated fixture for ${path}` }, 404);
  });
  return { writes, errors, state };
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
}
async function exportCurrentSnapshot(page: Page, expected: PblEvaluationSnapshot) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出评价 JSON", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`pbl-evaluation-${instanceId}-${expected.role}.json`);
  expect(JSON.parse(await readFile((await download.path())!, "utf8"))).toEqual(expected);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`mock teacher evaluation settings, dossier and publication ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const data = await fixture(page, "teacher");
    await page.goto(`/teacher/teach/${instanceId}/classroom`);
    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await expect(page.getByRole("heading", { name: "个人评价档案", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "评价设置与互评分配", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("维度 1", { exact: true })).toBeDisabled();
    await dialog.getByLabel("分配方式").selectOption("manual");
    await dialog.getByRole("button", { name: "加入分配名单" }).click();
    await dialog.getByRole("button", { name: "保存并分配互评" }).click();
    await expect(dialog.getByText("互评任务已分配，已提交的评价继续保留。", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "AI 过程评价", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "班级关注点" })).toBeVisible();
    await dialog.getByRole("button", { name: "查看 林同学 的过程报告", exact: true }).click();
    await expect(dialog.getByText("整体证据限制", { exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("mock-teacher-process-drawer.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByText("AI 过程报告 · 已生成", { exact: true }).click();
    await expect(page.getByText("本项暂不计分", { exact: true })).toBeVisible();
    await page.getByLabel("教师综合评语").fill("能用两次测试说明调整方案的依据，后续请记录控制条件。");
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "提交教师评价", exact: true }).click();
    await expect(page.getByText("已提交教师评价，内容已锁定。需要修改时请教师退回修订。", { exact: true })).toBeVisible();
    await page.getByText("发布评价结果", { exact: true }).click();
    await page.getByRole("button", { name: "选择已准备好结果的学生" }).click();
    await page.getByRole("button", { name: "发布给已选 1 人" }).click();
    await expect(page.getByText("已向 1 位学生发布评价结果。", { exact: true })).toBeVisible();
    await exportCurrentSnapshot(page, data.state);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("mock-teacher-evaluation.png"), fullPage: true });
    expect(data.writes.some(input => input.action === "assign")).toBe(true);
    expect(data.writes.some(input => input.action === "publish")).toBe(true);
    expect(data.errors).toEqual([]);
  });

  test(`mock student self, assigned peer and frozen report ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const data = await fixture(page, "student");
    await page.goto(`/student/classroom/${instanceId}`);
    await page.getByLabel("我的作品与过程证据").fill("第二版增加同一时段的用电测量，修订了原有建议。");
    await page.getByLabel("我学会了什么").fill("比较条件一致的数据才能解释变化。");
    await page.getByLabel("下次准备如何改进").fill("补充更多时段并保留每次修改理由。");
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "提交自评", exact: true }).click();
    await expect(page.getByText("已提交自评，内容已锁定。需要修改时请教师退回修订。", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /同伴互评/ }).click();
    await page.getByLabel("有依据的优点").fill("用同一时段的测量支持了照明方案。");
    await page.getByLabel("具体改进建议").fill("增加阴天的观察，比较自然光的影响。");
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "提交同伴互评", exact: true }).click();
    await expect(page.getByText("已提交同伴互评，内容已锁定。需要修改时请教师退回修订。", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "已发布反馈", exact: true }).click();
    await expect(page.getByText(/已发布：根据作品修订记录/)).toBeVisible();
    await expect(page.getByText("教师最新报告，尚未重新发布", { exact: true })).toHaveCount(0);
    await expect(page.getByText("本项暂不计分", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看依据（1）", exact: true }).click();
    await expect(page.getByText("根据两次测量的差异调整了观察条件。", { exact: true })).toBeVisible();
    await exportCurrentSnapshot(page, data.state);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("mock-student-evaluation.png"), fullPage: true });
    expect(data.writes.filter(input => input.action === "submit")).toHaveLength(2);
    expect(data.errors).toEqual([]);
  });
}

test("mock legacy fifth stage keeps the historical posttest entry", async ({ page }) => {
  await fixture(page, "teacher", true);
  await page.goto(`/teacher/teach/${instanceId}/classroom`);
  await page.getByRole("button", { name: "课堂操作", exact: true }).click();
  await expect(page.getByRole("button", { name: "评价设置与互评分配", exact: true })).toHaveCount(0);
  await expect(page.getByText(/本课堂未开启后测|未启用实验模式|未配置后测/).first()).toBeVisible();
});
