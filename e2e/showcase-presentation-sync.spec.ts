import { expect, test, type Locator, type Page, type WebSocketRoute } from "@playwright/test";
import { SignJWT } from "jose";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course, type FinalArtifactSummary, type ShowcasePresentationSnapshot } from "../src/lib/session/types";
import type { ShowcaseData } from "../src/lib/showcase/types";

test.use({ serviceWorkers: "block" });

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
const courseId = "e2e-showcase-presentation-sync";
const studentId = "e2e-showcase-presenter";
const fixedTime = "2026-10-20T00:00:00.000Z";
const conclusion = "末尾结论：先完成观察，再比较节能方案，最后检验实施效果。";
const documentArtifact: FinalArtifactSummary = {
  kind: "document", versionId: "final-document", title: "校园节能成果报告", sequence: 1,
  submittedAt: fixedTime, displayModes: ["continuous"],
};
const pdfArtifact: FinalArtifactSummary = {
  kind: "pdf", versionId: "final-pdf", title: "校园节能展示稿.pdf", sequence: 1,
  submittedAt: fixedTime, displayModes: ["slides", "continuous"],
};

async function authenticate(page: Page, role: "teacher" | "student") {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET;
  if (!secret || secret.length < 32) return;
  const token = await new SignJWT({ role, sv: 1, username: "showcase-sync", displayName: "展示验收", userId: studentId, studentName: "展示学生" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(role === "teacher" ? "e2e-showcase-teacher" : studentId)
    .setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
}

/** Isolated classroom: every application API request and socket stays in memory. */
async function createClassroomFixture(artifact: FinalArtifactSummary, withImage = false) {
  const course = {
    id: courseId, version: 1, name: "成果展示同步验收", subject: "科学", grade: "七年级", hours: 1,
    summary: "", drivingQuestion: "如何节约校园能源？", status: "teaching", currentStageIndex: 3,
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })),
    students: [{ id: studentId, name: "展示学生", joinedAt: fixedTime, stageProgress: {} }],
    resources: [], groups: [],
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: "paused", sessionStartedAt: fixedTime, pausedAt: fixedTime, activeStageKey: "showcase", updatedAt: fixedTime,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 3 ? "active" : "pending" })),
    } },
    createdAt: fixedTime, updatedAt: fixedTime,
  } as Course;
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 2; index++) {
    const sheet = pdf.addPage([600, 800]);
    sheet.drawText(`SHOWCASE PAGE ${index + 1}`, { x: 40, y: 740, size: 24 });
  }
  const pdfBytes = Buffer.from(await pdf.save());
  const html = `<h1>校园节能成果</h1>${Array.from({ length: 32 }, (_, index) => `<p>观察 ${index + 1}：在同一时段记录校园不同区域的照明、空调及其他设备用电情况，再根据完整数据比较改进方案的节能效果。</p>`).join("")}${withImage ? '<p><img src="/api/uploads/e2e-showcase-delayed-image.svg" /></p>' : ""}<p>${conclusion}</p>`;
  const sockets = new Set<WebSocketRoute>();
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let active: ShowcasePresentationSnapshot | null = null;
  let releaseImage!: () => void;
  const imageReady = new Promise<void>((resolve) => { releaseImage = resolve; });
  const snapshot = (): ShowcaseData => {
    const item = { studentId, studentName: "展示学生", position: 1, status: active ? "presenting" as const : "waiting" as const, artifacts: [artifact], presentationId: active?.id };
    return {
      courseId, stageKey: "showcase", students: [{ studentId, name: "展示学生", isAssigned: Boolean(active), artifacts: [artifact] }],
      ownArtifacts: [artifact], activePresentation: active, presentations: active ? [active] : [], queue: [item],
      queueConfig: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: [studentId], orderedStudentIds: [studentId], minutesPerStudent: 5, updatedAt: fixedTime },
      minutesPerStudent: 5, currentQueueItem: active ? item : null, nextQueueItem: active ? null : item,
    };
  };
  const broadcast = () => {
    for (const socket of sockets) socket.send(JSON.stringify({ type: "course-event", courseId, event: { type: "showcase-presentation", payload: { snapshot: active } } }));
  };
  async function install(page: Page, role: "teacher" | "student") {
    await authenticate(page, role);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.routeWebSocket(/.*/, (socket) => {
      if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
      sockets.add(socket);
      socket.onClose(() => sockets.delete(socket));
      socket.onMessage((message) => {
        const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
        if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
      });
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/api/auth/me") return json({ user: { id: role === "teacher" ? "e2e-showcase-teacher" : studentId, role, name: "展示验收", displayName: "展示验收" } });
      if (path === "/api/courses") return json({ courses: [course], user: { role, name: "展示验收" }, studentId, studentName: "展示学生", joinedCourseId: courseId, hydrated: true, updatedAt: fixedTime });
      if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
      if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: 1 });
      if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: 1, resourceProjection: null, teacherResourceProjection: null });
      if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
      if (path === `/api/courses/${courseId}/public-discussion` || path === `/api/courses/${courseId}/public-discussion/settings`) return json({ enabled: false }, 404);
      if (path === `/api/courses/${courseId}/showcase/recommendations`) return json({ courseId, targetCount: 1, targetSource: "default", recommendedStudentIds: [], candidates: [], pendingCount: 0, revision: "fixture", updatedAt: fixedTime });
      if (path === "/api/uploads/e2e-showcase-delayed-image.svg") {
        if (role === "student") await imageReady;
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="640" height="900" fill="#d8ece2"/></svg>' });
      }
      if (path === `/api/courses/${courseId}/showcase/artifacts/${artifact.versionId}`) return artifact.kind === "document" ? json({ html }) : route.fulfill({ status: 200, contentType: "application/pdf", body: pdfBytes });
      if (path === `/api/courses/${courseId}/showcase/presentation`) {
        if (request.method() === "GET") return json(snapshot());
        const body = request.postDataJSON() as Record<string, unknown>;
        writes.push({ method: request.method(), body });
        if (request.method() === "POST" && body.action === "start") {
          active = {
            id: "fixture-presentation", courseId, studentId, studentName: "展示学生", groupId: "",
            artifactKind: artifact.kind as "document" | "pdf", artifactVersionId: artifact.versionId, artifactTitle: artifact.title,
            displayMode: body.displayMode as "continuous" | "slides", status: "active", revision: 1,
            controllerClientId: String(body.clientId), controlEpoch: 1,
            requestedAt: fixedTime, startedAt: fixedTime, updatedAt: fixedTime,
            viewState: { scrollRatio: 0, revision: 1, updatedAt: fixedTime },
          };
          broadcast();
          return json(active);
        }
        if (request.method() === "PATCH" && active) {
          active = { ...active, revision: active.revision + 1, updatedAt: new Date().toISOString(), viewState: { ...body.viewState as object, revision: active.revision + 1, updatedAt: new Date().toISOString() } };
          broadcast();
          return json(active);
        }
      }
      unexpected.push(`${request.method()} ${path}`);
      return json({ message: "No fixture for this request" }, 404);
    });
    await page.goto(`${baseURL}/${role === "teacher" ? `teacher/teach/${courseId}/classroom` : `student/classroom/${courseId}`}`, { waitUntil: "domcontentloaded" });
  }
  return { install, writes, unexpected, errors, releaseImage };
}

async function scrollToEnd(viewer: Locator) {
  await viewer.evaluate((node) => { node.scrollTop = node.scrollHeight; });
}

async function expectConclusionFullyVisible(viewer: Locator) {
  await expect.poll(() => viewer.evaluate((node, text) => {
    const paragraph = [...node.querySelectorAll('[data-slate-node="element"], p')].find((element) => element.textContent === text);
    if (!paragraph) return false;
    const content = paragraph.getBoundingClientRect();
    const viewport = node.getBoundingClientRect();
    return node.scrollHeight - node.clientHeight - node.scrollTop <= 2
      && content.top >= Math.max(0, viewport.top) - 1
      && content.bottom <= Math.min(window.innerHeight, viewport.bottom) + 1;
  }, conclusion)).toBe(true);
}

async function expectInsideViewport(locator: Locator) {
  await expect.poll(() => locator.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.top >= -1
      && bounds.right <= window.innerWidth + 1 && bounds.bottom <= window.innerHeight + 1;
  })).toBe(true);
}

async function expectFullscreenFitsViewport(fullscreen: Locator) {
  await expect.poll(() => fullscreen.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return Math.abs(bounds.left) <= 1 && Math.abs(bounds.top) <= 1
      && Math.abs(bounds.right - window.innerWidth) <= 1 && Math.abs(bounds.bottom - window.innerHeight) <= 1
      && document.documentElement.scrollWidth <= window.innerWidth + 1;
  })).toBe(true);
}

for (const artifact of [documentArtifact, pdfArtifact]) {
  test(`teacher can display ${artifact.kind} fullscreen locally without publishing a presentation`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1366, height: 768 });
    const fixture = await createClassroomFixture(artifact);
    await fixture.install(page, "teacher");
    const open = page.getByRole("button", { name: "本机全屏展示", exact: true });
    await expect(open).toBeVisible();
    await open.click();
    const fullscreen = page.getByRole("dialog", { name: `作品全屏展示：${artifact.title}`, exact: true });
    await expect(fullscreen).toHaveAttribute("aria-modal", "true");
    await expect(fullscreen.getByText("仅本机展示", { exact: true })).toBeVisible();
    for (const viewport of [{ width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expectFullscreenFitsViewport(fullscreen);
      await expectInsideViewport(fullscreen.getByRole("button", { name: "退出本机全屏", exact: true }));
      const zoomIn = fullscreen.getByRole("button", { name: "放大作品", exact: true });
      const zoomOut = fullscreen.getByRole("button", { name: "缩小作品", exact: true });
      await expectInsideViewport(zoomIn);
      await expectInsideViewport(zoomOut);
      await zoomIn.click();
      await zoomOut.click();
      if (artifact.kind === "document") {
        const viewer = fullscreen.locator('[aria-label="最终文档预览"]');
        await expect(viewer.getByText("校园节能成果", { exact: true })).toBeAttached();
        await scrollToEnd(viewer);
        await expectConclusionFullyVisible(viewer);
      } else {
        await expectInsideViewport(fullscreen.getByRole("button", { name: "切换本机阅读方式", exact: true }));
        const canvas = fullscreen.locator('canvas[aria-label="PDF 第 1 页"]');
        await expect(canvas).toBeVisible();
        await expect.poll(() => canvas.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const display = node.parentElement!.getBoundingClientRect();
          return bounds.left >= display.left - 1 && bounds.top >= display.top - 1
            && bounds.right <= display.right + 1 && bounds.bottom <= display.bottom + 1;
        })).toBe(true);
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    if (artifact.kind === "document") {
      const viewer = fullscreen.locator('[aria-label="最终文档预览"]');
      await expect(viewer.getByText("校园节能成果", { exact: true })).toBeVisible();
      await scrollToEnd(viewer);
      await expectConclusionFullyVisible(viewer);
    } else {
      await expect(fullscreen.locator('canvas[aria-label="PDF 第 1 页"]')).toBeVisible();
      await fullscreen.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(fullscreen.locator('canvas[aria-label="PDF 第 2 页"]')).toBeVisible();
      const readingMode = fullscreen.getByRole("button", { name: "切换本机阅读方式", exact: true });
      await expect(readingMode).toHaveText("连续阅读");
      await readingMode.click();
      await expect(fullscreen.locator("[data-showcase-page]")).toHaveCount(2);
    }
    await fullscreen.getByRole("button", { name: "退出本机全屏", exact: true }).click();
    await expect(fullscreen).toHaveCount(0);
    if (artifact.kind === "document") await expectConclusionFullyVisible(page.locator('[aria-label="最终文档预览"]'));
    await open.click();
    await expect(fullscreen).toBeVisible();
    if (artifact.kind === "document") await expectConclusionFullyVisible(fullscreen.locator('[aria-label="最终文档预览"]'));
    await page.keyboard.press("Escape");
    await expect(fullscreen).toHaveCount(0);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("student sees the complete last paragraph across viewport sizes and delayed image layout changes", async ({ browser }) => {
  test.setTimeout(90_000);
  const teacherContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const studentContext = await browser.newContext({ viewport: { width: 1024, height: 576 }, serviceWorkers: "block" });
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  const fixture = await createClassroomFixture(documentArtifact, true);
  try {
    await fixture.install(teacher, "teacher");
    await fixture.install(student, "student");
    await teacher.getByRole("button", { name: "开始汇报并投屏", exact: true }).filter({ visible: true }).first().click();
    const teacherPresentation = teacher.getByRole("region", { name: `作品全屏展示：${documentArtifact.title}`, exact: true });
    const teacherViewer = teacherPresentation.locator('[aria-label="最终文档预览"]');
    const studentViewer = student.getByTestId("student-showcase-projection").locator('[aria-label="跟随汇报学生的文档"]');
    await expect(teacherViewer.getByText(conclusion, { exact: true })).toBeAttached();
    await expect(studentViewer.getByText(conclusion, { exact: true })).toBeAttached();
    await expect.poll(() => teacherViewer.locator("img").evaluate((node) => (node as HTMLImageElement).naturalHeight)).toBeGreaterThan(0);
    expect(await studentViewer.locator("img").evaluate((node) => (node as HTMLImageElement).complete)).toBe(false);
    await scrollToEnd(teacherViewer);
    await expectConclusionFullyVisible(teacherViewer);
    await expect.poll(() => fixture.writes.filter((write) => write.method === "PATCH").at(-1)?.body.viewState).toMatchObject({ scrollRatio: 1 });
    await expectConclusionFullyVisible(studentViewer);

    // The public viewport is smaller and wraps text differently from the
    // teacher. Neither a fixed pixel offset nor a leading block is the end.
    await student.setViewportSize({ width: 390, height: 640 });
    await expectConclusionFullyVisible(studentViewer);
    await student.setViewportSize({ width: 844, height: 390 });
    await expectConclusionFullyVisible(studentViewer);

    const beforeImage = await studentViewer.evaluate((node) => node.scrollHeight);
    fixture.releaseImage();
    await expect.poll(() => studentViewer.locator("img").evaluate((node) => (node as HTMLImageElement).naturalHeight)).toBeGreaterThan(0);
    await expect.poll(() => studentViewer.evaluate((node) => node.scrollHeight)).toBeGreaterThan(beforeImage);
    await expectConclusionFullyVisible(studentViewer);
    await student.setViewportSize({ width: 1024, height: 768 });
    await expectConclusionFullyVisible(studentViewer);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseImage();
    await teacherContext.close();
    await studentContext.close();
  }
});
