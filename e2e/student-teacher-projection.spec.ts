import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { PDFDocument, rgb } from "pdf-lib";
import { browserLearningEventReceipt, createBrowserActionReceipts } from "../scripts/lib/classroom-acceptance-action-receipts.mjs";
import { applySessionAction, initialSessionState } from "../src/lib/session/actions";
import { ActionEnvelopeSchema, type ActionEnvelope } from "../src/lib/courses/contracts";
import { DEFAULT_STAGES, type Course, type ProjectionMode } from "../src/lib/session/types";
import { projectionSnapshotFromUiState } from "../src/lib/realtime/projection-state";

// Only the local page, compiled assets, and resource-player document come from
// the service. Every application API and socket is handled in this browser.
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://127.0.0.1:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("Student projection fixtures require a local acceptance service");
}
test.use({ baseURL, serviceWorkers: "block", reducedMotion: "reduce", navigationTimeout: 60_000 });
const courseId = "student-teacher-projection-course";
const classroomId = "student-teacher-projection-classroom";
const studentId = "student-teacher-projection-student";
const resourceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const nativeTitle = "观察事实与判断依据";
const pdfTitle = "项目启动：观察与证据";
const at = "2026-10-20T00:00:00.000Z";
const viewports = [
  { width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 820, height: 1180 },
  { width: 390, height: 844 }, { width: 844, height: 390 },
];

async function fixture(page: Page, kind: "forced" | "optional" | "launch" = "forced") {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || "deploy/secrets/jwt_secret.txt", "utf8").trim();
  const token = await new SignJWT({ role: "student", sv: 1, userId: studentId, studentName: "投屏验收学生" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(studentId).setIssuer("openpbl").setAudience("openpbl-app")
    .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: "openpbl_student", value: token, url: baseURL }]);
  const scenes = ["观察事实", "说明判断依据", "个人学习保留页"].map((title, index) => ({
    id: `projection-scene-${index + 1}`, stageId: classroomId, outlineId: `projection-outline-${index + 1}`,
    title, type: "slide", order: index, audience: "student", stageKey: "ai-learning", generationPurpose: "knowledge-teaching", actions: [],
    content: { type: "slide", canvas: {
      id: `projection-canvas-${index + 1}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: "#ffffff", themeColors: ["#344a6a"], fontColor: "#1f2933", fontName: "Noto Sans SC" },
      background: { type: "solid", color: "#ffffff" }, elements: [{
        id: `projection-text-${index + 1}`, type: "text", left: 60, top: 80, width: 880, height: 220, rotate: 0,
        defaultFontName: "Noto Sans SC", defaultColor: "#1f2933",
        content: `<p style="font-size:40px">原生第 ${index + 1} 页：${title}</p>`,
      }],
    } },
  }));
  const progress = { classroomId, studentId, currentSceneIndex: 2, totalScenes: 3,
    completedScenes: ["projection-scene-1"], completionModelVersion: 2 as const, lastActiveAt: at, masteryLevel: "in-progress" as const };
  const teacherProjection = (mode: ProjectionMode, pageNumber = 1) => ({ classroomId, sceneId: `projection-scene-${pageNumber}`,
    stageKey: "ai-learning", title: nativeTitle, sceneType: "slide" as const, startedAt: at, mode, version: pageNumber,
    updatedAt: new Date().toISOString(), engineMode: "idle" as const,
    playback: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: `projection-scene-${pageNumber}` }, interactionState: null });
  let course: Course = {
    id: courseId, version: 1, name: "学生端教师投屏与个人学习隔离验收", subject: "科学", grade: "七年级", hours: 1,
    status: "teaching", summary: "", drivingQuestion: "如何用观察证据支持判断？", createdAt: at, updatedAt: at,
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: kind === "launch" ? 0 : 1,
    students: [{ id: studentId, name: "投屏验收学生", joinedAt: at, stageProgress: {} }],
    resources: kind === "launch" ? [{ id: resourceId, stageKey: "launch", title: pdfTitle, type: "PDF", size: "2 KB",
      url: `/api/uploads/${resourceId}`, displayMode: "slides", downloadedBy: [] }] : [],
    groups: [], submissions: [], activityLog: [], aiLearningClassroomId: classroomId,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    aiLearningProgress: { [studentId]: progress },
    uiState: { projectionVersion: 1, projectionUpdatedAt: at,
      projectionController: { teacherId: "projection-teacher", clientId: "projection-teacher-window" },
      resourceProjection: kind === "launch" ? { resourceId, stageKey: "launch", title: pdfTitle, startedAt: at,
        viewState: { page: 1, scrollRatio: 0, revision: 1, updatedAt: at } } : null,
      teacherResourceProjection: kind === "launch" ? null : teacherProjection(kind),
    },
  };
  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([960, 540]);
  sheet.drawRectangle({ x: 24, y: 24, width: 912, height: 492, color: rgb(0.97, 0.98, 0.99), borderWidth: 2, borderColor: rgb(0.2, 0.3, 0.45) });
  sheet.drawText("OBSERVE FACTS / USE EVIDENCE", { x: 60, y: 390, size: 34, color: rgb(0.2, 0.3, 0.45) });
  const pdfBytes = Buffer.from(await pdf.save());
  const sockets = new Set<(message: string) => void>();
  const unexpected: string[] = [];
  const errors: string[] = [];
  const actions: ActionEnvelope[] = [];
  const progressPosts: Array<Record<string, unknown>> = [];
  const eventBatches: Array<Record<string, unknown>> = [];
  let playerDocuments = 0;
  const receipts = createBrowserActionReceipts(courseId, at);
  const snapshot = () => projectionSnapshotFromUiState({ courseId, courseVersion: course.version ?? 1, uiState: course.uiState });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().routeWebSocket(/.*/, (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
    const send = (message: string) => socket.send(message);
    sockets.add(send);
    socket.onClose(() => sockets.delete(send));
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message));
      if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId }));
    });
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(`${method} ${request.url()}`); return route.abort(); }
    if (!path.startsWith("/api/") && ["GET", "HEAD"].includes(method)) {
      if (path === "/internal/resource-player" && request.isNavigationRequest()) playerDocuments++;
      return route.continue();
    }
    if (path === `/api/uploads/${resourceId}` && method === "GET") return route.fulfill({ contentType: "application/pdf", body: pdfBytes });
    if (path === "/api/auth/me" || path === "/api/platform/auth/student-profile") return json({ user: { id: studentId, role: "student", name: "投屏验收学生", displayName: "投屏验收学生" } });
    if (path === "/api/courses") return json({ courses: [course], hydrated: true, user: { role: "student", name: "投屏验收学生" },
      studentId, studentName: "投屏验收学生", joinedCourseId: courseId });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json(snapshot());
    if (path === `/api/courses/${courseId}/public-discussion` || path === `/api/courses/${courseId}/public-discussion/settings`) return json({ enabled: false, session: null });
    if (path === `/api/courses/${courseId}/lecture-chat` && method === "GET") {
      const sceneId = url.searchParams.get("sceneId") ?? "projection-scene-3";
      return json({ thread: { id: `thread-${sceneId}`, page: { classroomId, sceneId },
        pageTitle: scenes.find((scene) => scene.id === sceneId)?.title ?? "个人学习页", messages: [] }, requests: [], writable: true });
    }
    if (path === `/api/courses/${courseId}/actions`) {
      const parsed = ActionEnvelopeSchema.safeParse(request.postDataJSON());
      if (!parsed.success) { unexpected.push("Invalid action envelope"); return json({ code: "INVALID_ACTION" }, 400); }
      const envelope = parsed.data as unknown as ActionEnvelope;
      actions.push(envelope);
      const previous = receipts.lookup(envelope);
      if (previous) return json(previous.body, previous.status);
      course = applySessionAction({ ...initialSessionState(), courses: [course] }, envelope.action).courses[0]!;
      course.version = (course.version ?? 0) + 1;
      return json(receipts.remember(envelope, { courseVersion: course.version, updatedAt: new Date().toISOString() }));
    }
    if (path === "/api/openmaic/classroom") return json({ success: true,
      classroom: { stage: { id: classroomId, name: course.name, createdAt: at, updatedAt: at }, scenes } });
    if (path === "/api/openmaic/progress" && method === "GET") return json({ data: { progress: { [studentId]: progress } } });
    if (path === "/api/openmaic/progress" && method === "POST") {
      progressPosts.push(request.postDataJSON());
      return json({ success: true, data: { progress: { [studentId]: progress } } });
    }
    if (path === "/api/learning-events" && method === "POST") {
      eventBatches.push(request.postDataJSON());
      const receipt = browserLearningEventReceipt(request.postData(), Date.now());
      return json(receipt.body, receipt.status);
    }
    if (path === "/api/learning-events" || path === `/api/courses/${courseId}/learning-events` || path === `/api/courses/${courseId}/learning-analytics`) return json({ success: true });
    if (["/api/openmaic/provider-config", "/api/openmaic/server-providers", "/api/server-providers"].includes(path)) return json({
      success: true, providers: {}, tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {}, generation: {},
    });
    if (path === "/api/knowledge-lecture/settings") return json({ settings: {} });
    unexpected.push(`${method} ${path}`);
    return json({ error: "Unconfigured isolated student projection fixture" }, 404);
  });
  await page.goto(`/student/classroom/${courseId}`);
  return { errors, unexpected, actions, progressPosts, eventBatches, course: () => course, playerDocuments: () => playerDocuments,
    project(mode: ProjectionMode | null, pageNumber = 1) {
      const timestamp = new Date().toISOString();
      course.uiState = { ...course.uiState, teacherResourceProjection: mode ? teacherProjection(mode, pageNumber) : null,
        resourceProjection: null, projectionVersion: (course.uiState?.projectionVersion ?? 0) + 1, projectionUpdatedAt: timestamp };
      course.version = (course.version ?? 0) + 1;
      const event = JSON.stringify({ type: "course-event", courseId, event: { type: "projection-changed", payload: snapshot() } });
      sockets.forEach((send) => send(event));
    },
  };
}

async function fullscreenSurface(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: `教师投屏：${title}`, exact: true });
  const content = dialog.getByRole("region", { name: "投屏内容", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("教师投屏", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText("同步中", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => {
    const box = await dialog.boundingBox(), viewport = page.viewportSize()!;
    return box ? Math.max(Math.abs(box.x), Math.abs(box.y), Math.abs(box.width - viewport.width), Math.abs(box.height - viewport.height)) : Infinity;
  }).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const box = await content.boundingBox(), viewport = page.viewportSize()!;
    return box ? Math.max(Math.abs(box.x), Math.abs(box.y), Math.abs(box.width - viewport.width), Math.abs(box.height - viewport.height)) : Infinity;
  }).toBeLessThanOrEqual(1);
  const teacher = await dialog.getByText("教师投屏", { exact: true }).boundingBox();
  const sync = await dialog.getByText("同步中", { exact: true }).boundingBox();
  expect(teacher!.x).toBeLessThan(page.viewportSize()!.width / 3);
  expect(sync!.x + sync!.width / 2).toBeGreaterThan(page.viewportSize()!.width * 0.7);
  expect(teacher!.y).toBeLessThan(60); expect(sync!.y).toBeLessThan(60);
  return { dialog, content };
}

async function nativeSlide(page: Page, dialog: Locator, pageNumber: number) {
  const frame = dialog.frameLocator('iframe[title="授课资源播放器"]');
  const element = frame.locator(`[data-slide-element-id="projection-text-${pageNumber}"]`);
  // Renderer element wrappers intentionally have no box; the absolutely
  // positioned text inside them is the visible teaching content.
  await expect(element.locator("p")).toBeVisible({ timeout: 20_000 });
  await expect(frame.locator('[data-projected-canvas="true"]')).toBeVisible();
  await expect.poll(() => element.evaluate((node) => {
    // ScreenElement lives in the scaled content layer within ScreenCanvas.
    const canvas = node.parentElement?.parentElement?.getBoundingClientRect();
    if (!canvas || canvas.width < 1 || canvas.height < 1) return false;
    const maximumWidth = Math.min(innerWidth, innerHeight * 16 / 9);
    return Math.abs(canvas.width / canvas.height - 16 / 9) < 0.03
      && canvas.left >= -1 && canvas.top >= -1 && canvas.right <= innerWidth + 1 && canvas.bottom <= innerHeight + 1
      && canvas.width >= maximumWidth * 0.95;
  })).toBe(true);
  await expect.poll(() => element.evaluate((node) => {
    const surface = node.closest<HTMLElement>('[data-projected-canvas="true"]');
    if (!surface) return false;
    const hasVisibleShadow = (style: CSSStyleDeclaration) => style.boxShadow.split(/,(?![^(]*\))/).some((shadow) => {
      if (shadow === "none" || shadow.includes("transparent") || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(shadow)
        || /[a-z]+\([^)]*\/\s*0(?:\.0+)?\s*\)/i.test(shadow)) return false;
      // Tailwind's shadow-none/ring-0 can serialize as several transparent or
      // zero-sized shadow layers. Only a painted offset/blur/spread decorates.
      const geometry = shadow.replace(/[a-z]+\([^)]*\)/gi, "").match(/-?\d+(?:\.\d+)?px/g) ?? [];
      return geometry.some((length) => Math.abs(parseFloat(length)) > 0.01);
    });
    const surfaceStyle = getComputedStyle(surface);
    if (parseFloat(surfaceStyle.borderRadius) > 0 || hasVisibleShadow(surfaceStyle)
      || [surfaceStyle.borderTopWidth, surfaceStyle.borderRightWidth, surfaceStyle.borderBottomWidth, surfaceStyle.borderLeftWidth].some((width) => parseFloat(width) > 0)
      || !["transparent", "rgba(0, 0, 0, 0)"].includes(surfaceStyle.backgroundColor)) return false;
    // Any decorated ancestor around this page must frame the real 16:9
    // slide, rather than a tall empty card constrained by viewport width.
    for (let current = node.parentElement; current && current !== surface; current = current.parentElement) {
      const style = getComputedStyle(current), box = current.getBoundingClientRect();
      if (box.width > 100 && box.height > 100 && (parseFloat(style.borderRadius) > 0 || hasVisibleShadow(style))
        && Math.abs(box.width / box.height - 16 / 9) > 0.03) return false;
    }
    return true;
  })).toBe(true);
  await expect(dialog.getByRole("status").filter({ hasText: "跟随教师 · 知识点补讲" })).toBeInViewport({ ratio: 1 });
  expect(await page.locator("section").evaluateAll((sections) => sections.filter((section) =>
    !section.closest('[role="dialog"]') && section.getBoundingClientRect().height > 100
    && !section.textContent?.trim() && !section.querySelector("canvas,iframe,img,video")).length)).toBe(0);
}

async function screenshot(page: Page, info: TestInfo, label: string) {
  const path = info.outputPath(`${label}.png`);
  await page.screenshot({ path });
  await info.attach(label, { path, contentType: "image/png" });
}

test("forced supplementary lecture fills each viewport, keeps its iframe on page changes, and restores personal progress", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize(viewports[0]);
  const audit = await fixture(page);
  const { dialog } = await fullscreenSurface(page, nativeTitle);
  const iframe = dialog.locator('iframe[title="授课资源播放器"]');
  await nativeSlide(page, dialog, 1);
  const identity = await iframe.elementHandle();
  const documentCount = audit.playerDocuments();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await fullscreenSurface(page, nativeTitle);
    await nativeSlide(page, dialog, 1);
    await expect(page.locator('[data-stage-host-mode="student"]')).toHaveCount(0);
    await screenshot(page, info, `supplement-${viewport.width}x${viewport.height}`);
  }
  audit.project("forced", 2);
  await nativeSlide(page, dialog, 2);
  expect(await iframe.evaluate((element, previous) => element === previous, identity)).toBe(true);
  expect(audit.playerDocuments()).toBe(documentCount);
  expect(audit.progressPosts).toEqual([]);
  expect(audit.eventBatches).toEqual([]);
  audit.project(null);
  await expect(dialog).not.toBeVisible();
  const personal = page.locator('[data-stage-host-mode="student"]');
  await expect(personal).toHaveAttribute("data-active-scene-id", "projection-scene-3", { timeout: 20_000 });
  await expect(personal.getByText("原生第 3 页：个人学习保留页", { exact: true })).toBeVisible();
  expect(audit.course().aiLearningProgress?.[studentId]?.currentSceneIndex).toBe(2);
  expect(audit.actions.filter(({ action }) => action.type === "SET_UI_STATE")).toEqual([]);
  expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]);
});

test("optional projection opens on request, follows updates, and can be collapsed back to the student's saved page", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const audit = await fixture(page, "optional");
  const personal = page.locator('[data-stage-host-mode="student"]');
  await expect(personal).toHaveAttribute("data-active-scene-id", "projection-scene-3", { timeout: 20_000 });
  await expect(page.getByRole("dialog", { name: `教师投屏：${nativeTitle}`, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "查看投屏", exact: true }).click();
  const { dialog } = await fullscreenSurface(page, nativeTitle);
  await nativeSlide(page, dialog, 1);
  await expect(personal).toHaveCount(0);
  audit.project("optional", 2);
  await nativeSlide(page, dialog, 2);
  await screenshot(page, info, "optional-student-projection");
  await dialog.getByRole("button", { name: "收起投屏", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(personal).toHaveAttribute("data-active-scene-id", "projection-scene-3", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "查看投屏", exact: true })).toBeVisible();
  expect(audit.course().uiState?.teacherResourceProjection?.sceneId).toBe("projection-scene-2");
  expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]);
});

test("launch PDF projection uses the same full viewport surface and synchronization badges", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const audit = await fixture(page, "launch");
  const { dialog } = await fullscreenSurface(page, pdfTitle);
  const canvas = dialog.locator('canvas[aria-label="PPT 第 1 页"]');
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => canvas.evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return 0;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 64) if (pixels[index + 3] && Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 220) ink++;
    return ink;
  })).toBeGreaterThan(10);
  await screenshot(page, info, "launch-pdf-projection-reference");
  expect(audit.progressPosts).toEqual([]);
  expect(audit.eventBatches).toEqual([]);
  expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]);
});
