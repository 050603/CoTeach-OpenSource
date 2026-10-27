import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { createBrowserActionReceipts } from "../scripts/lib/classroom-acceptance-action-receipts.mjs";
import { ActionEnvelopeSchema, actionCourseId, type ActionEnvelope } from "../src/lib/courses/contracts";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("Stage transition fixtures require a local acceptance service.");
}
test.use({ baseURL, serviceWorkers: "block" });
const courseId = "teacher-stage-transition-fixture";
const otherCourseId = `${courseId}-other`;
const at = "2026-10-20T00:00:00.000Z";
const inactiveMessage = "只有授课中的第四阶段可以进行成果汇报。";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function installClassroom(page: Page, initialStage = 2) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || "deploy/secrets/jwt_secret.txt", "utf8").trim();
  const token = await new SignJWT({ role: "teacher", sv: 1, username: "transition-fixture", displayName: "阶段切换验收" })
    .setProtectedHeader({ alg: "HS256" }).setSubject("transition-teacher").setIssuer("openpbl").setAudience("openpbl-app")
    .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: "openpbl_teacher", value: token, url: baseURL }]);
  let course: Course = {
    id: courseId, version: 1, stageVersion: 1, name: "第四阶段切换验收", subject: "科学", grade: "六年级", hours: 1,
    summary: "", drivingQuestion: "怎样用证据汇报？", status: "teaching", currentStageIndex: initialStage,
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })), students: [], groups: [], resources: [],
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: "paused", sessionStartedAt: at, pausedAt: at, activeStageKey: DEFAULT_STAGES[initialStage].key, updatedAt: at,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === initialStage ? "active" : "pending" })),
    } }, createdAt: at, updatedAt: at,
  };
  const otherCourse = { ...structuredClone(course), id: otherCourseId, name: "另一间阶段验收课堂" };
  const save = latch(), read = latch();
  const fault = { save: false, read: false };
  const actions: ActionEnvelope[] = [], showcaseReads: number[] = [], unexpected: string[] = [], errors: string[] = [];
  const receipts = createBrowserActionReceipts(courseId, at);
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/*", socket => socket.close());
  // Resolve every API and block all unexpected writes, so no real classroom is touched.
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.origin !== new URL(baseURL).origin) {
      unexpected.push(`External ${url.origin}`);
      return route.abort("blockedbyclient");
    }
    if (!path.startsWith("/api/")) {
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      unexpected.push(`${request.method()} ${path}`);
      return json({ message: "Fixture blocks non-API writes" }, 405);
    }
    if (path === `/api/courses/${courseId}/showcase/recommendations` && ["GET", "POST"].includes(request.method())) {
      return json({ courseId, targetCount: 3, targetSource: "default", recommendedStudentIds: [], candidates: [], pendingCount: 0, updatedAt: at, revision: "fixture" });
    }
    if (path === `/api/courses/${courseId}/actions` && request.method() === "POST") {
      const parsed = ActionEnvelopeSchema.safeParse(request.postDataJSON());
      if (!parsed.success || actionCourseId(parsed.data.action) !== courseId || parsed.data.action.type !== "UPDATE_COURSE") {
        unexpected.push("Invalid transition action");
        return json({ message: "Unknown fixture action" }, 400);
      }
      const envelope = parsed.data as unknown as ActionEnvelope;
      actions.push(envelope);
      await save.promise;
      if (fault.save) return json({ code: "SAVE_UNAVAILABLE", message: "阶段保存暂时不可用，请重试。" }, 400);
      const previous = receipts.lookup(envelope);
      if (previous) return json(previous.body, previous.status);
      const action = envelope.action as Extract<ActionEnvelope["action"], { type: "UPDATE_COURSE" }>;
      course = { ...course, ...action.payload.patch, version: (course.version ?? 0) + 1, stageVersion: (course.stageVersion ?? 1) + 1 };
      return json(receipts.remember(envelope, { courseVersion: course.version, stageVersion: course.stageVersion, updatedAt: at }));
    }
    if (!["GET", "HEAD"].includes(request.method())) {
      unexpected.push(`${request.method()} ${path}`);
      return json({ message: "Unexpected fixture mutation" }, 405);
    }
    if (path === "/api/auth/me") return json({ user: { id: "transition-teacher", role: "teacher", name: "阶段切换验收", displayName: "阶段切换验收" } });
    if (path === "/api/courses") return json({ courses: [course, otherCourse], user: { role: "teacher", name: "阶段切换验收" }, hydrated: true, updatedAt: at });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: course.version, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${otherCourseId}/state`) return json({ course: otherCourse, eventCursor: "0" });
    if (path === `/api/courses/${otherCourseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: otherCourse.version });
    if (path === `/api/courses/${otherCourseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${otherCourseId}/projection`) return json({ courseVersion: otherCourse.version, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/showcase/presentation`) {
      showcaseReads.push(course.currentStageIndex);
      if (course.currentStageIndex !== 3 || fault.read) return json({ code: "SHOWCASE_INACTIVE", message: inactiveMessage }, 409);
      await read.promise;
      return json({ courseId, stageKey: "showcase", students: [], ownArtifacts: [], presentations: [], activePresentation: null, queue: [], minutesPerStudent: 5 });
    }
    unexpected.push(`${request.method()} ${path}`);
    return json({ message: "Unknown fixture endpoint" }, 404);
  });
  return { save, read, fault, actions, showcaseReads, unexpected, errors, course: () => course };
}

async function enterShowcase(page: Page, fullscreen: boolean) {
  if (fullscreen) {
    await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
    await page.getByLabel("全屏教学阶段").selectOption("3");
  } else {
    await page.getByRole("button", { name: /结束「项目实践」并进入「成果汇报(?:与评价)?」/ }).click();
  }
  const dialog = page.getByRole("dialog", { name: "切换教学阶段", exact: true });
  await dialog.getByRole("button", { name: /进入.*成果汇报/ }).click();
}

async function expectShowcaseReady(page: Page) {
  await expect(page.locator(".classroom-stage").getByRole("heading", { name: /^(选择汇报学生|成果汇报(?:与评价)?)$/ })).toBeVisible();
}

for (const fullscreen of [false, true]) {
  test(`stage reads start after a delayed save acknowledgement (fullscreen: ${fullscreen})`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const fixture = await installClassroom(page);
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    await enterShowcase(page, fullscreen);
    await expect(page.getByRole("status")).toHaveText("正在切换到成果汇报…");
    await expect.poll(() => fixture.actions.length).toBe(1);
    await expect(page.getByLabel(fullscreen ? "全屏教学阶段" : "当前教学阶段")).toBeDisabled();
    await expect(page.locator('footer[aria-label="课堂操作栏"]').getByRole("button", { name: "结束课堂", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "工具", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "课堂工具", exact: true });
    await expect(tools.getByRole("button", { name: "结束课堂", exact: true })).toBeDisabled();
    await tools.getByRole("button", { name: "关闭", exact: true }).click();
    // Hold longer than the previous ordinary polling interval.
    await page.waitForTimeout(3_300);
    expect(fixture.showcaseReads).toEqual([]);
    await expect(page.getByRole("alert").filter({ hasText: inactiveMessage })).toHaveCount(0);
    fixture.save.release();
    await expect.poll(() => fixture.showcaseReads).toEqual([3]);
    await expect(page.getByText("正在读取汇报状态…", { exact: true })).toBeVisible();
    fixture.read.release();
    await expectShowcaseReady(page);
    expect(fixture.course().stageTransitions).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`failed transitions retry the same command (fullscreen: ${fullscreen})`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 576 });
    const fixture = await installClassroom(page);
    fixture.fault.save = true;
    fixture.save.release();
    fixture.read.release();
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    await enterShowcase(page, fullscreen);
    await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "重试阶段切换" }) })).toContainText("阶段保存暂时不可用");
    expect(fixture.showcaseReads).toEqual([]);
    expect(fixture.actions).toHaveLength(1);
    fixture.fault.save = false;
    if (fullscreen) await page.locator('[data-slot="save-status"]').getByRole("button", { name: "重试", exact: true }).click();
    else await page.getByRole("button", { name: "重试阶段切换", exact: true }).click();
    await expectShowcaseReady(page);
    expect(fixture.actions).toHaveLength(2);
    expect(fixture.actions[1].requestId).toBe(fixture.actions[0].requestId);
    expect(fixture.actions[1].action).toEqual(fixture.actions[0].action);
    expect(fixture.course().stageTransitions).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("direct showcase entry preserves real inactive errors and allows an immediate retry", async ({ page }) => {
  const fixture = await installClassroom(page, 3);
  fixture.fault.read = true;
  fixture.read.release();
  await page.goto(`/teacher/teach/${courseId}/classroom`);
  await expect(page.getByRole("alert").filter({ hasText: inactiveMessage })).toBeVisible();
  expect(fixture.actions).toEqual([]);
  fixture.fault.read = false;
  await page.locator(".classroom-stage").getByRole("button", { name: "重试", exact: true }).click();
  await expectShowcaseReady(page);
  await expect(page.getByRole("alert").filter({ hasText: inactiveMessage })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("client navigation restores the pending optimistic stage before reading showcase", async ({ page }) => {
  const fixture = await installClassroom(page);
  await page.goto(`/teacher/teach/${courseId}/classroom`);
  await enterShowcase(page, false);
  await expect(page.getByRole("status")).toHaveText("正在切换到成果汇报…");
  await page.getByRole("button", { name: /^阶段 4\/5/ }).click();
  await page.getByRole("link", { name: /另一间阶段验收课堂/ }).click();
  await expect(page).toHaveURL(new RegExp(`/teacher/teach/${otherCourseId}/classroom$`));
  await page.getByRole("button", { name: /^阶段 3\/5/ }).click();
  await page.getByRole("link", { name: /第四阶段切换验收/ }).click();
  await expect(page).toHaveURL(new RegExp(`/teacher/teach/${courseId}/classroom$`));
  await expect(page.getByRole("status")).toHaveText("正在切换到成果汇报…");
  expect(fixture.showcaseReads).toEqual([]);
  fixture.read.release();
  fixture.save.release();
  await expectShowcaseReady(page);
  expect(fixture.actions).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
