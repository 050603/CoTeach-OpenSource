import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { DEFAULT_STAGES, type Course, type KnowledgeLectureAttempt } from "../src/lib/session/types";
import { DEFAULT_PBL_RUBRIC, pblWeightedScore, type PblEvaluationCommand, type PblEvaluationRecord, type PblEvaluationSnapshot } from "../src/lib/evaluation/pbl-contract";

// UI fixtures only. All API traffic and application sockets are intercepted;
// no user, classroom, grade, submission or file is created in the database.
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://127.0.0.1:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("Teacher record fixtures require a local service.");
test.use({ baseURL, serviceWorkers: "block", reducedMotion: "reduce" });
test.setTimeout(60_000);

const instanceId = "fixture-teacher-records";
const participationId = "fixture-target-participation";
const studentId = "fixture-target-student";
const at = "2026-10-25T03:00:00.000Z";
const olderVersion = "00000000-0000-4000-8000-000000000001";
const newerVersion = "00000000-0000-4000-8000-000000000002";
const recordPath = `/teacher/participations/${participationId}`;
const backPath = `/teacher/classrooms/${instanceId}?q=${encodeURIComponent("林")}&evaluation=pending`;
const attempt: KnowledgeLectureAttempt = {
  id: "first-answer", sectionId: "section", quizOutlineId: "quiz", runtimeSceneId: "scene", submittedAt: at,
  score: 8, maxScore: 10, knowledgePointIds: ["evidence"],
  questions: [{ questionId: "question", prompt: "怎样保证两次观察可以比较？", answer: "保持同一观察时段", points: 10, earned: 8,
    correct: true, gradingStatus: "graded", feedback: "已注意到控制条件", authoredAnalysis: "比较结果时需要保持关键条件一致。", knowledgePointIds: ["evidence"] }],
};

function courseFixture(): Course {
  return {
    id: instanceId, version: 1, evaluationContractVersion: 2, name: "校园观察课堂", subject: "科学", grade: "七年级", hours: 1,
    summary: "比较观察条件", drivingQuestion: "怎样根据证据改进方案？", status: "finished", currentStageIndex: 4,
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })),
    students: [{ id: "fixture-first-student", name: "首位同学", joinedAt: at, stageProgress: {} },
      { id: studentId, name: "林同学", joinedAt: at, stageProgress: { launch: 100, "ai-learning": 60, make: 80 } }],
    groups: [], resources: [],
    content: { pblOutline: "", lessonOutline: [], knowledgePoints: [{ id: "evidence", name: "控制条件", description: "保持条件一致" }],
      evaluationPlan: { dimensions: [], overallRubric: "" },
      knowledgeLectureSections: [{ id: "section", title: "比较与证据", order: 0, knowledgePointIds: ["evidence"], sceneOutlineIds: ["scene"], quizOutlineId: "quiz", estimatedMinutes: 8 }] },
    aiLearningClassroomId: "fixture-lesson",
    aiLearningProgress: { [studentId]: { classroomId: "fixture-lesson", studentId, currentSceneIndex: 0, totalScenes: 2, completedScenes: ["scene"],
      lastActiveAt: at, masteryLevel: "in-progress", knowledgeLectureAttempts: [attempt] } },
    submissions: [{ id: "draft", courseId: instanceId, studentId, stageKey: "make", type: "document", title: "观察方案草稿",
      content: "<h2>尚未提交的课堂草稿</h2><p>草稿保留两次观察的原始比较。</p>", status: "draft", createdAt: at, updatedAt: at },
      { id: "other-draft", courseId: instanceId, studentId: "fixture-first-student", stageKey: "make", type: "document", title: "其他学生私有草稿", content: "<p>其他学生草稿正文</p>", status: "draft", createdAt: at, updatedAt: at }],
    projectDocumentVersions: [1, 2].map(sequence => ({ id: sequence === 1 ? olderVersion : newerVersion, courseId: instanceId, studentId,
      submissionId: "draft", stageKey: "make", sequence, sourceVersion: sequence + 1, title: `观察方案第${sequence}版`, sourceHtml: "",
      docxUploadId: `fixture-document-${sequence}`, status: "submitted", submittedAt: at, createdAt: at })),
    projectPdfVersions: [], createdAt: at, updatedAt: at,
  };
}

function evaluationFixture(): PblEvaluationSnapshot {
  return { contractVersion: 2, role: "teacher", instanceId, stage: "reflection", canWrite: true, canPublish: true, canConfigureRubric: false,
    config: { version: 0, rubric: DEFAULT_PBL_RUBRIC, peerMode: "off", reviewsPerStudent: 2, anonymous: true },
    participants: [
      { participationId: "fixture-first-participation", studentId: "fixture-first-student", name: "首位同学", artifacts: [], selfEvaluation: null, peerEvaluations: [], teacherEvaluation: null, processReport: null, published: null },
      { participationId, studentId, name: "林同学", artifacts: [{ versionId: newerVersion, title: "观察方案第2版", sequence: 2, sourceHtml: "<p>正式成果供教师评价。</p>", mimeType: "text/html", submittedAt: at, fileUrl: null }],
        selfEvaluation: null, peerEvaluations: [], teacherEvaluation: null, published: null,
        processReport: { id: "fixture-report", generatedAt: at, summary: "保留了比较条件与修改依据。", dimensions: [] } },
    ], assignments: [], completion: { total: 2, selfSubmitted: 0, peerAssigned: 0, peerSubmitted: 0, teacherSubmitted: 0, published: 0 } };
}

async function installFixture(page: Page, options: { failInitialRead?: boolean } = {}) {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET || readFileSync("deploy/secrets/jwt_secret.txt", "utf8").trim();
  if (secret.length < 32) throw new Error("Set JWT_SECRET or OPENPBL_E2E_JWT_SECRET_FILE for the local service.");
  const token = await new SignJWT({ role: "teacher", sv: 1, username: "teacher-record-fixture", displayName: "学习档案验收教师" })
    .setProtectedHeader({ alg: "HS256" }).setSubject("fixture-records-teacher").setIssuer("openpbl").setAudience("openpbl-app")
    .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: "openpbl_teacher", value: token, url: baseURL }]);
  const course = courseFixture(), evaluation = evaluationFixture();
  const reads: Array<{ path: string; role: string | undefined }> = [];
  const writes: PblEvaluationCommand[] = [];
  const unexpected: string[] = [], errors: string[] = [];
  const receipts = new Map<string, { signature: string; snapshot: PblEvaluationSnapshot }>();
  let failInitialRead = options.failInitialRead;
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket(url => !url.pathname.startsWith("/_next/"), socket => socket.close());
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(`External request: ${url.origin}`); return route.abort("blockedbyclient"); }
    if (!path.startsWith("/api/")) {
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      unexpected.push(`${request.method()} ${path}`); return json({ message: "Fixture blocks non-API writes" }, 405);
    }
    if (path === `/api/platform/classroom-instances/${instanceId}/evaluation` && request.method() === "POST") {
      const input = request.postDataJSON() as PblEvaluationCommand;
      if (!input.idempotencyKey || !["save", "submit", "publish"].includes(input.action)
        || ((input.action === "save" || input.action === "submit") && (input.participationId !== participationId || input.source !== "teacher"))
        || (input.action === "publish" && (input.participationIds.length !== 1 || input.participationIds[0] !== participationId))) {
        unexpected.push("Evaluation write outside the selected participant"); return json({ message: "Fixture rejects wrong student or operation" }, 403);
      }
      writes.push(input);
      const signature = JSON.stringify(input), receipt = receipts.get(input.idempotencyKey);
      if (receipt) return receipt.signature === signature ? json(receipt.snapshot) : json({ message: "Retry key conflict" }, 409);
      const target = evaluation.participants[1];
      if (input.action === "save" || input.action === "submit") {
        if (input.version !== (target.teacherEvaluation?.version ?? 0)) return json({ message: "评价已更新" }, 409);
        const next: PblEvaluationRecord = { id: "fixture-teacher-evaluation", participationId, source: "teacher", assignmentId: null,
          version: input.version + 1, status: input.action === "submit" ? "submitted" : "draft", rubric: DEFAULT_PBL_RUBRIC,
          answers: input.answers, suggestedScore: pblWeightedScore(DEFAULT_PBL_RUBRIC, input.answers.dimensionScores),
          score: input.answers.finalScore ?? pblWeightedScore(DEFAULT_PBL_RUBRIC, input.answers.dimensionScores),
          submittedAt: input.action === "submit" ? at : null, returnedReason: null, updatedAt: at, history: [] };
        target.teacherEvaluation = next;
      } else if (input.action === "publish") {
        if (input.includeTeacher && target.teacherEvaluation?.status !== "submitted") return json({ message: "请先提交教师定评" }, 409);
        target.published = { at, teacherEvaluation: input.includeTeacher ? structuredClone(target.teacherEvaluation) : null, processReport: input.includeProcess ? structuredClone(target.processReport) : null };
      }
      evaluation.completion.teacherSubmitted = target.teacherEvaluation?.status === "submitted" ? 1 : 0;
      evaluation.completion.published = target.published ? 1 : 0;
      receipts.set(input.idempotencyKey, { signature, snapshot: structuredClone(evaluation) });
      return json(evaluation);
    }
    if (!["GET", "HEAD"].includes(request.method())) { unexpected.push(`${request.method()} ${path}`); return json({ message: "Fixture blocks unexpected writes" }, 405); }
    reads.push({ path, role: request.headers()["x-openpbl-role"] });
    if (path === "/api/auth/me") return json({ user: { id: "fixture-records-teacher", role: "teacher", username: "teacher-record-fixture", displayName: "学习档案验收教师" } });
    if (path === `/api/platform/participations/${participationId}`) {
      if (failInitialRead) { failInitialRead = false; return json({ message: "模拟课堂记录暂时不可用" }, 503); }
      return json({ participation: { id: participationId, firstEnteredAt: at, lastEnteredAt: at, completedAt: at }, student: { id: studentId, displayName: "林同学" },
        instance: { id: instanceId, status: "finished", activityId: "fixture-activity", offeringId: "fixture-offering", offeringName: "科学探索班", title: course.name, runNo: 2, templateVersion: 1, snapshot: { kind: "pbl-course" } },
        workspace: { version: 0, projectState: null }, isTeacher: true, canWrite: false });
    }
    if (path === "/api/courses" && url.searchParams.get("courseId") === instanceId) return json({ courses: [course], user: { role: "teacher", name: "学习档案验收教师" } });
    if (path === `/api/platform/participations/${participationId}/ai`) return json({ conversations: [{ id: "fixture-document-comments", title: "ai-collaboration-comments:make", metadata: { legacyStageKey: "ai-collaboration-comments:make" }, messages: [
      { id: "comment-meta", role: "system", content: `OPENPBL_DOCUMENT_COMMENT_META:${JSON.stringify({ id: "fixture-comment", targetText: "分别在上午和下午观察", issueType: "比较条件", severity: "critical", impact: "观察时间不同可能影响结果", createdAt: at })}`, createdAt: at },
      { id: "comment-answer", role: "assistant", content: "**建议保持观察时段一致**，再比较结果。", metadata: { conversationId: "fixture-comment" }, createdAt: at },
      { id: "comment-question", role: "user", content: "那我改成每天上午观察。", metadata: { conversationId: "fixture-comment" }, createdAt: at },
      { id: "comment-status", role: "system", content: `OPENPBL_DOCUMENT_COMMENT_STATUS:${JSON.stringify({ id: "fixture-comment", status: "resolved" })}`, createdAt: at },
    ] }, { id: "fixture-document-chat", title: "ai-collaboration:make", metadata: { legacyStageKey: "ai-collaboration:make" }, messages: [{ id: "chat", role: "user", content: "先确认比较条件", createdAt: at }] }], supportRecords: [
      { id: "contribution", type: "AICONTRIBUTIONS", summary: "", status: "decided", structuredPayload: { view: { id: "fixture-suggestion", stageKey: "make", request: "检查观察时间", suggestion: "把两次时间统一", status: "decided" } } },
      { id: "decision", type: "STUDENTAIDECISIONS", summary: "", status: "OPEN", structuredPayload: { view: { contributionId: "fixture-suggestion", decision: "modified", reason: "结合课表调整时间", appliedChangeSummary: "固定为每周一上午" } } },
      { id: "process", type: "COMPANION_PROCESS", summary: "保存了一次文档协作", status: "OPEN", structuredPayload: { stageKey: "make", title: "文档协作过程" } },
      { id: "help", type: "HELP_REQUEST", summary: "请教师检查采样方法", status: "OPEN" },
    ] });
    if (path === `/api/platform/classroom-instances/${instanceId}/evaluation`) return json(evaluation);
    if ([olderVersion, newerVersion].some(id => path === `/api/courses/${instanceId}/showcase/artifacts/${id}`)) {
      const sequence = path.endsWith(newerVersion) ? 2 : 1;
      return json({ kind: "document", versionId: sequence === 1 ? olderVersion : newerVersion, html: `<h2>正式方案第${sequence}版正文</h2><p>第${sequence}版保留了当时提交的比较条件与证据。</p>` });
    }
    if (path === `/api/platform/classroom-instances/${instanceId}/participants`) return json({
      instance: { id: instanceId, title: course.name, offeringId: "fixture-offering", status: "finished", snapshot: { kind: "pbl-course" } },
      participants: [{ id: participationId, displayName: "林同学", username: "lin-fixture", lastEnteredAt: at, completedAt: at, hasLearningEvidence: true, hasFinalOutput: true,
        submittedArtifactVersionCount: 2, evaluationSummary: { teacherStatus: "none", published: false, publishedTeacher: false, pending: true }, _count: { artifacts: 1, reflections: 0, evaluations: 0 } }],
    });
    if (path === `/api/platform/classroom-instances/${instanceId}/experiment/results`) return json({ enabled: false, submissions: [] });
    unexpected.push(`${request.method()} ${path}`);
    return json({ message: `No fixture for ${path}` }, 404);
  });
  return { reads, writes, unexpected, errors, evaluation };
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`fixture teacher dossier reads real projection, drafts and submitted versions ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page);
    await page.goto(`${recordPath}?returnTo=${encodeURIComponent(backPath)}`);
    await expect(page.getByRole("heading", { name: "林同学的课堂档案", exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "知识讲授" })).toHaveAttribute("aria-valuenow", "60");
    await page.getByRole("button", { name: "项目成果", exact: true }).click();
    await expect(page.getByRole("heading", { name: "尚未提交的课堂草稿" })).toBeVisible();
    await expect(page.getByText("课堂草稿", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "正式方案第2版正文" })).toBeVisible();
    await expect(page.getByLabel("已提交成果版本").locator("option")).toHaveCount(2);
    await expect(page.getByRole("link", { name: "下载 Word" })).toHaveAttribute("href", "/api/uploads/fixture-document-2?download=1");
    await page.getByLabel("已提交成果版本").selectOption(`document:${olderVersion}`);
    await expect(page.getByRole("heading", { name: "正式方案第1版正文" })).toBeVisible();
    await expect(page.getByText("其他学生草稿正文")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("fixture-teacher-project-records.png"), fullPage: true });
    await page.getByRole("button", { name: "课堂作答", exact: true }).click();
    await expect(page.getByText("保持同一观察时段", { exact: true })).toBeVisible();
    await expect(page.getByText("比较结果时需要保持关键条件一致。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /AI 讲题/ })).toHaveCount(0);
    await page.getByRole("button", { name: "评价反馈", exact: true }).click();
    await expect(page.getByLabel("教师综合评语")).toBeEnabled();
    await expect(page.getByLabel("选择学生")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath("fixture-teacher-target-evaluation.png"), fullPage: true });
    expect(fixture.reads.find(item => item.path === "/api/courses")?.role).toBe("teacher");
    expect(fixture.reads.some(item => /\/outcomes$|\/knowledge-tutor|\/lecture-chat/.test(item.path))).toBe(false);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("fixture teacher evaluation saves, submits and publishes only the selected second student", async ({ page }, info) => {
  const fixture = await installFixture(page);
  await page.goto(recordPath);
  await page.getByRole("button", { name: "评价反馈", exact: true }).click();
  await expect(page.getByText("林同学", { exact: true })).toBeVisible();
  await expect(page.getByText("首位同学", { exact: true })).toHaveCount(0);
  await page.getByLabel("教师综合评语").fill("能够用原始观察记录解释比较条件，后续请补充重复测量。");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  await expect.poll(() => fixture.evaluation.participants[1].teacherEvaluation?.status).toBe("draft");
  expect(fixture.evaluation.participants[1].published).toBeNull();
  await page.getByRole("button", { name: "提交教师评价", exact: true }).click();
  await expect(page.getByText("已提交教师评价，内容已锁定。需要修改时请教师退回修订。", { exact: true })).toBeVisible();
  await expect.poll(() => fixture.evaluation.participants[1].teacherEvaluation?.status).toBe("submitted");
  expect(fixture.evaluation.participants[1].published).toBeNull();
  await page.getByText("发布评价结果", { exact: true }).click();
  await page.getByRole("button", { name: "发布给当前学生", exact: true }).click();
  await expect(page.getByText("已向 1 位学生发布评价结果。", { exact: true })).toBeVisible();
  await expect(page.getByText(/该学生已收到.*发布的结果/)).toBeVisible();
  expect(fixture.writes.some(input => input.action === "save")).toBe(true);
  expect(fixture.writes.some(input => input.action === "submit")).toBe(true);
  expect(fixture.writes.filter(input => input.action === "publish")).toHaveLength(1);
  expect(fixture.writes.every(input => (input.action === "save" || input.action === "submit") ? input.participationId === participationId
    : input.action === "publish" && input.participationIds.length === 1 && input.participationIds[0] === participationId)).toBe(true);
  expect(fixture.evaluation.participants[0].teacherEvaluation).toBeNull();
  expect(fixture.evaluation.participants[0].published).toBeNull();
  await page.screenshot({ path: info.outputPath("fixture-teacher-published-target.png"), fullPage: true });
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("fixture initial read failure retries and returns to the same classroom list filters", async ({ page }) => {
  const fixture = await installFixture(page, { failInitialRead: true });
  await page.goto(`${recordPath}?returnTo=${encodeURIComponent(backPath)}`);
  await expect(page.getByRole("alert").filter({ hasText: "模拟课堂记录暂时不可用" })).toHaveText("模拟课堂记录暂时不可用");
  await expect(page.getByRole("link", { name: "返回课堂学习记录", exact: true })).toHaveAttribute("href", backPath);
  await expect(page.getByText("还没有提交项目成果", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "学生课堂档案导航" })).toBeVisible();
  await page.getByRole("link", { name: "返回课堂学习记录", exact: true }).click();
  await expect(page).toHaveURL(new URL(backPath, baseURL).href);
  await expect(page.getByRole("textbox", { name: "搜索学生姓名或账号" })).toHaveValue("林");
  await expect(page.getByRole("combobox", { name: "评价状态" })).toHaveValue("pending");
  await expect(page.getByRole("link", { name: "查看与评价 林同学" })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 1180, height: 820 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 520 }]) {
  test(`fixture Chinese collaboration categories and readable comments ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page);
    await page.goto(recordPath);
    await page.locator("summary").filter({ hasText: "项目协作记录" }).click();
    await expect(page.getByRole("navigation", { name: "项目协作记录分类" })).toBeVisible();
    await expect(page.getByText("分别在上午和下午观察", { exact: true })).toBeVisible();
    await expect(page.getByText("观察时间不同可能影响结果", { exact: true })).toBeVisible();
    await expect(page.getByText("已处理", { exact: true })).toBeVisible();
    await expect(page.getByText("那我改成每天上午观察。", { exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/OPENPBL_|ai-collaboration|COMPANION_PROCESS/);
    await page.getByRole("button", { name: /AI 建议与采纳/ }).click();
    await expect(page.getByText("修改后采纳", { exact: true })).toBeVisible();
    await expect(page.getByText("结合课表调整时间", { exact: true })).toBeVisible();
    await expect(page.getByText("固定为每周一上午", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /协作过程/ }).click();
    await expect(page.getByText("保存了一次文档协作", { exact: true })).toBeVisible();
    await expect(page.getByText("待处理", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /教师求助/ }).click();
    await expect(page.getByText("请教师检查采样方法", { exact: true })).toBeVisible();
    await expect(page.getByText("待处理", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /文档批注/ }).click();
    await expect(page.getByRole("heading", { name: "比较条件", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: /选择记录/ }).focus();
    await expect(page.getByRole("combobox", { name: /选择记录/ })).toBeFocused();
    for (const button of await page.getByRole("navigation", { name: "项目协作记录分类" }).getByRole("button").all()) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `test-results/collaboration-chinese/${info.title.replaceAll(/[^a-zA-Z0-9-]/g, "-")}.png`, fullPage: true });
    expect(fixture.writes).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
    expect(fixture.reads.filter(read => read.path.endsWith('/ai'))).toHaveLength(1);
  });
}
