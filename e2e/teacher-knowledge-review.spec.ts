import { expect, test, type Page } from "@playwright/test";
import { captureDesktopScreenshot, desktopAcceptanceProfiles, visibleLayoutClipping, withDesktopProfile } from "./fixtures/desktop-coverage";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { browserLearningEventReceipt, createBrowserActionReceipts } from "../scripts/lib/classroom-acceptance-action-receipts.mjs";
import { ActionEnvelopeSchema, type ActionEnvelope } from "../src/lib/courses/contracts";
import { applySessionAction, initialSessionState } from "../src/lib/session/actions";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

// Route every application request, including resource-player frames. Classroom
// actions are applied to this in-memory fixture and never reach the database.
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("Knowledge review fixtures require a local acceptance service");
}
test.use({ baseURL, serviceWorkers: "block", contextOptions: { reducedMotion: "reduce" } });
const courseId = "teacher-knowledge-review-course";
const classroomId = "teacher-knowledge-review-classroom";
const at = "2026-10-19T00:00:00.000Z";
const titles = ["观察与记录", "以证据支持判断", "比较与分析"];

async function fixture(page: Page, options: { noKnowledgePoints?: boolean } = {}) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || "deploy/secrets/jwt_secret.txt", "utf8").trim();
  const token = await new SignJWT({ role: "teacher", sv: 1, username: "review-teacher", displayName: "补讲验收教师" })
    .setProtectedHeader({ alg: "HS256" }).setSubject("review-teacher").setIssuer("openpbl")
    .setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: "openpbl_teacher", value: token, url: baseURL }]);
  const scenes = titles.map((title, index) => ({
    id: `review-scene-${index + 1}`, outlineId: `review-outline-${index + 1}`, stageId: classroomId,
    title, type: "slide", order: index, actions: [],
    content: { type: "slide", canvas: {
      id: `review-canvas-${index + 1}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: "#ffffff", themeColors: ["#344A6A"], fontColor: "#1F2933", fontName: "Noto Sans SC" },
      background: { type: "solid", color: "#ffffff" }, elements: [{
        id: `review-text-${index + 1}`, type: "text", left: 48, top: 80, width: 880, height: 220, rotate: 0,
        defaultFontName: "Noto Sans SC", defaultColor: "#1F2933",
        content: `<p style="font-size:36px">补讲第 ${index + 1} 页：${title}</p>`,
      }],
    } },
  }));
  const outlines = scenes.map((scene, index) => ({ id: scene.outlineId, title: scene.title, type: "slide",
    order: index, stageKey: "ai-learning", audience: "student", description: scene.title,
    keyPoints: [], estimatedDuration: 60, knowledgePointIds: [index < 2 ? "point-1" : "point-2"] }));
  let course: Course = {
    id: courseId, version: 1, name: "全班知识点掌握与人工补讲验收课堂", status: "teaching", subject: "科学", grade: "七年级",
    hours: 1, summary: "", drivingQuestion: "如何通过观察证据作出判断？",
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 1, aiLearningClassroomId: classroomId,
    students: Array.from({ length: 5 }, (_, index) => ({ id: `student-${index + 1}`, name: `验收学生${index + 1}`, joinedAt: at, stageProgress: {} })),
    resources: [], groups: [], activityLog: [],
    content: {
      pblOutline: "", knowledgePoints: [
        { id: "point-1", name: "观察证据", description: "记录观察事实，再用证据支持判断" },
        { id: "point-2", name: "比较分析", description: "统一条件后比较差异" },
        { id: "point-3", name: "待补充样本", description: "继续收集有效作答" },
        { id: "point-4", name: "尚未作答", description: "当前还没有有效作答" },
      ], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
      knowledgeLectureSections: [
        { id: "section-1", title: "观察与证据", order: 0, knowledgePointIds: ["point-1", "point-3"], sceneOutlineIds: ["review-outline-1", "review-outline-2"], quizOutlineId: "quiz-1", estimatedMinutes: 10 },
        { id: "section-2", title: "比较与解释", order: 1, knowledgePointIds: ["point-2", "point-4"], sceneOutlineIds: ["review-outline-3"], quizOutlineId: "quiz-2", estimatedMinutes: 10 },
      ], _openmaicSceneOutlines: outlines, sceneOutlines: outlines,
    },
    aiLearningProgress: Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`student-${index + 1}`, {
      classroomId, studentId: `student-${index + 1}`, currentSceneIndex: 1, totalScenes: 3, completedScenes: [], lastActiveAt: at, masteryLevel: "in-progress",
      knowledgeLectureAttempts: ["point-1", "point-2", ...(index === 0 ? ["point-3"] : [])].map((pointId) => ({
        id: `attempt-${index}-${pointId}`, sectionId: pointId === "point-2" ? "section-2" : "section-1",
        quizOutlineId: `quiz-${pointId}`, runtimeSceneId: `quiz-scene-${pointId}`, submittedAt: at,
        score: pointId === "point-2" ? 1 : 0, maxScore: 1, gradingSource: "server", gradingStatus: "graded", knowledgePointIds: [pointId],
        questions: [{ questionId: `question-${pointId}`, prompt: "如何用证据说明判断？", answer: pointId === "point-2" ? "统一条件比较记录" : "凭印象判断",
          points: 1, earned: pointId === "point-2" ? 1 : 0, gradingStatus: "graded", correct: pointId === "point-2",
          feedback: pointId === "point-2" ? "" : "概念混淆，需要区分观察事实与个人判断", knowledgePointIds: [pointId] }],
      })),
    }])),
    uiState: { classroomTiming: {
      schemaVersion: 1, status: "paused", sessionStartedAt: at, pausedAt: at, activeStageKey: "ai-learning", updatedAt: at,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600,
        adjustmentSec: 0, elapsedSec: 0, status: index === 1 ? "active" : "pending" })),
    } }, createdAt: at, updatedAt: at,
  } as Course;
  if (options.noKnowledgePoints) course.content.knowledgePoints = [];
  const actions: ActionEnvelope[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const receipts = createBrowserActionReceipts(courseId, at);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.context().routeWebSocket(/.*/, (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
    socket.onMessage((message) => {
      const body = JSON.parse(String(message));
      if (body.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId }));
    });
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(request.url()); return route.abort(); }
    if (!path.startsWith("/api/") && ["GET", "HEAD"].includes(method)) return route.continue();
    if (path.startsWith("/api/openmaic/interactive-runtime/") && method === "GET") return route.continue();
    if (path === "/api/auth/me") return json({ user: { id: "review-teacher", role: "teacher", name: "补讲验收教师", displayName: "补讲验收教师" } });
    if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "补讲验收教师" }, hydrated: true, updatedAt: at });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseId, courseVersion: course.version, projectionVersion: course.uiState?.projectionVersion ?? 0,
      projectionUpdatedAt: at, serverTime: at, resourceProjection: null, teacherResourceProjection: course.uiState?.teacherResourceProjection ?? null,
      projectionController: course.uiState?.projectionController });
    if (path === `/api/courses/${courseId}/public-discussion` || path === `/api/courses/${courseId}/public-discussion/settings`) return json({ enabled: false, session: null });
    if (path === `/api/platform/classroom-instances/${courseId}/participants`) return json({ instance: { id: courseId, title: course.name, offeringId: "review-offering", status: "FINISHED", snapshot: {} }, participants: [] });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment/results`) return json({ enabled: false });
    if (path === `/api/courses/${courseId}/actions`) {
      const parsed = ActionEnvelopeSchema.safeParse(request.postDataJSON());
      if (!parsed.success) { unexpected.push("Invalid action envelope"); return json({ code: "INVALID_ACTION" }, 400); }
      const envelope = parsed.data as unknown as ActionEnvelope;
      actions.push(envelope);
      const previous = receipts.lookup(envelope);
      if (previous) return json(previous.body, previous.status);
      course = applySessionAction({ ...initialSessionState(), courses: [course] }, envelope.action).courses[0]!;
      course.version = (course.version ?? 0) + 1;
      const projection = envelope.action.type === "SET_UI_STATE" && Object.hasOwn(envelope.action.payload.patch, "teacherResourceProjection");
      if (projection && envelope.action.type === "SET_UI_STATE") course.uiState = { ...course.uiState,
        projectionVersion: (course.uiState?.projectionVersion ?? 0) + 1,
        projectionController: course.uiState?.teacherResourceProjection ? { teacherId: "review-teacher", clientId: envelope.action.payload.projectionControl!.clientId } : null,
      };
      return json(receipts.remember(envelope, { courseVersion: course.version, updatedAt: at,
        ...(projection ? { projection: { courseId, courseVersion: course.version, projectionVersion: course.uiState!.projectionVersion!,
          projectionUpdatedAt: at, serverTime: at, teacherResourceProjection: course.uiState?.teacherResourceProjection ?? null,
          resourceProjection: null, projectionController: course.uiState?.projectionController } } : {}),
      }));
    }
    if (path === "/api/openmaic/classroom") return json({ success: true, classroom: { stage: { id: classroomId, name: course.name, createdAt: 1, updatedAt: 1 }, scenes } });
    if (path === "/api/openmaic/progress") return json({ data: { progress: {} } });
    if (["/api/openmaic/provider-config", "/api/openmaic/server-providers", "/api/server-providers"].includes(path)) return json({ success: true, providers: {}, tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {}, generation: {} });
    if (path === "/api/learning-events" && method === "POST") {
      const receipt = browserLearningEventReceipt(request.postData(), Date.now());
      return json(receipt.body, receipt.status);
    }
    if (path === "/api/learning-events") return json({ success: true });
    unexpected.push(`${method} ${path}`);
    return json({ error: "Unconfigured isolated fixture request" }, 404);
  });
  await page.goto(`/teacher/teach/${courseId}/classroom`);
  await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "知识点补讲", exact: true }).click();
  return { course: () => course, actions, unexpected, pageErrors };
}

for (const profile of desktopAcceptanceProfiles([
  { width: 1920, height: 1080 }, { width: 1366, height: 768 },
  { width: 768, height: 1024 }, { width: 390, height: 844 },
])) {
  const { viewport } = profile;
  test(`knowledge review remains readable and reachable at ${viewport.width}x${viewport.height} ${profile.name}`, async ({ browser }, info) => {
    test.setTimeout(60_000);
    await withDesktopProfile(profile, browser, info, async ({ page }) => {
    const audit = await fixture(page);
    const review = page.getByRole("region", { name: "知识点补讲", exact: true });
    await expect(review).toBeVisible();
    const footer = page.locator('footer[aria-label="全屏课堂操作栏"]');
    await expect(footer).toBeInViewport({ ratio: 1 });
    await expect(footer.getByRole("button", { name: "知识点补讲", exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["观察证据", "比较分析", "待补充样本", "尚未作答"]) {
      await expect(review.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await review.getByRole("button", { name: "观察证据", exact: true }).click();
    await expect(review.getByRole("button", { name: "开始补讲并同步", exact: true })).toBeVisible();
    await expect(review.frameLocator("iframe").getByText(`补讲第 1 页：${titles[0]}`, { exact: true })).toBeVisible({ timeout: 20_000 });
    if (await page.evaluate(() => innerWidth >= 1000)) {
      const preview = review.getByRole("region", { name: "课件预览", exact: true });
      await expect(preview).toBeVisible();
      // Short desktop windows retain a separate scroll area above the fixed
      // synchronization controls. A teacher may scroll that area to read it.
      await preview.scrollIntoViewIfNeeded();
      await info.attach("knowledge-review-preview-layout", { body: JSON.stringify(await preview.evaluate(element => {
        const nodes = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          nodes.push({ tag: node.tagName, className: node.className, bounds: node.getBoundingClientRect().toJSON(),
            clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, overflow: style.overflow, scrollTop: node.scrollTop });
        }
        return nodes;
      }), null, 2), contentType: "application/json" });
      await expect.poll(() => visibleLayoutClipping(preview), { message: "Ordinary scrolling reveals the complete preview within one CSS pixel" }).toBeLessThanOrEqual(1);
      await expect(review.getByRole("button", { name: "开始补讲并同步", exact: true })).toBeInViewport({ ratio: 1 });
    }
    expect(audit.course().uiState?.teacherResourceProjection).toBeUndefined();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const screenshot = info.outputPath("knowledge-review.png");
    await captureDesktopScreenshot(page, screenshot);
    await info.attach("knowledge-review", { path: screenshot, contentType: "image/png" });
    expect(audit.unexpected).toEqual([]);
    expect(audit.pageErrors).toEqual([]);
    }, baseURL);
  });
}

test("preview is local, manual lecture synchronizes pages, and ending restores student progress", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const audit = await fixture(page);
  const originalProgress = structuredClone(audit.course().aiLearningProgress);
  const review = page.getByRole("region", { name: "知识点补讲", exact: true });
  await review.getByRole("button", { name: "观察证据", exact: true }).click();
  await review.getByRole("button", { name: `预览第 2 页：${titles[1]}`, exact: true }).click();
  await expect(review.frameLocator("iframe").getByText(`补讲第 2 页：${titles[1]}`, { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(audit.course().uiState?.teacherResourceProjection).toBeUndefined();
  await review.getByRole("button", { name: "开始补讲并同步", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-2");
  await expect(review.getByRole("status").filter({ hasText: "投屏已提交" })).toBeVisible();
  await expect(review.frameLocator("iframe").getByText(`补讲第 2 页：${titles[1]}`, { exact: true })).toBeVisible();
  expect(audit.course().uiState?.teacherResourceProjection?.mode).toBe("forced");
  expect(audit.course().uiState?.teacherResourceProjection?.engineMode).toBe("idle");
  await review.getByRole("button", { name: "上一页", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-1");
  await expect(review.frameLocator("iframe").getByText(`补讲第 1 页：${titles[0]}`, { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "下一页", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-2");
  await expect(review.frameLocator("iframe").getByText(`补讲第 2 页：${titles[1]}`, { exact: true })).toBeVisible();
  const lectureScreenshot = info.outputPath("knowledge-review-lecture.png");
  await page.screenshot({ path: lectureScreenshot });
  await info.attach("knowledge-review-lecture", { path: lectureScreenshot, contentType: "image/png" });
  await review.getByRole("button", { name: "返回选讲", exact: true }).click();
  await review.getByRole("button", { name: "比较分析", exact: true }).click();
  await expect(review.frameLocator("iframe").getByText(`补讲第 3 页：${titles[2]}`, { exact: true })).toBeVisible();
  expect(audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-2");
  await page.getByRole("button", { name: "班级学情", exact: true }).click();
  expect(audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-2");
  await page.getByRole("button", { name: "知识点补讲", exact: true }).click();
  await expect(review.getByRole("button", { name: "比较分析", exact: true })).toHaveAttribute("aria-pressed", "true");
  await review.getByRole("button", { name: "结束补讲", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection).toBeNull();
  await expect(review.getByRole("status").filter({ hasText: "已停止投屏" })).toBeVisible();
  await review.getByRole("combobox", { name: "学生端展示方式", exact: true }).selectOption("optional");
  await review.getByRole("button", { name: "开始补讲并同步", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-3");
  expect(audit.course().uiState?.teacherResourceProjection?.mode).toBe("optional");
  await review.getByRole("button", { name: "结束补讲", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection).toBeNull();
  expect(audit.course().aiLearningProgress).toEqual(originalProgress);
  expect(audit.unexpected).toEqual([]);
  expect(audit.pageErrors).toEqual([]);
});

test("a narrow classroom without knowledge points can select and lecture from all courseware", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const audit = await fixture(page, { noKnowledgePoints: true });
  const review = page.getByRole("region", { name: "知识点补讲", exact: true });
  await review.getByRole("button", { name: "查看全部课件", exact: true }).filter({ visible: true }).click();
  const drawer = page.getByRole("dialog", { name: "全部知识讲授课件", exact: true });
  await drawer.getByRole("button", { name: `预览第 2 页：${titles[1]}`, exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(review.frameLocator("iframe").getByText(`补讲第 2 页：${titles[1]}`, { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(audit.course().uiState?.teacherResourceProjection).toBeUndefined();
  await review.getByRole("button", { name: "开始补讲并同步", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-2");
  await review.getByRole("button", { name: "下一页", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("review-scene-3");
  await review.getByRole("button", { name: "结束补讲", exact: true }).click();
  await expect.poll(() => audit.course().uiState?.teacherResourceProjection).toBeNull();
  expect(audit.unexpected).toEqual([]);
  expect(audit.pageErrors).toEqual([]);
});
