import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { PDFDocument, rgb } from "pdf-lib";
import { captureDesktopScreenshot, desktopAcceptanceProfiles, withDesktopProfile } from "./fixtures/desktop-coverage";

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("PDF fixtures require a local service");
test.use({ baseURL, serviceWorkers: "block", contextOptions: { reducedMotion: "reduce" } });
const activityId = "student-pdf-layout";
const uploadPath = "/api/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function fixture(page: Page, options: { saveFailure?: boolean; resourceFailure?: boolean } = {}) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || "deploy/secrets/jwt_secret.txt", "utf8").trim();
  const token = await new SignJWT({ role: "student", sv: 1, userId: "pdf-student", studentName: "资料阅读验收" })
    .setProtectedHeader({ alg: "HS256" }).setSubject("pdf-student").setIssuer("openpbl").setAudience("openpbl-app")
    .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: "openpbl_student", value: token, url: baseURL }]);
  const pdf = await PDFDocument.create();
  for (let index = 1; index <= 3; index++) {
    const sheet = pdf.addPage([595, 842]);
    sheet.drawText(`EVIDENCE AND OBSERVATION / ${index}`, { x: 32, y: 760, size: 20 });
    sheet.drawRectangle({ x: 32, y: 80, width: 530, height: 600, borderWidth: 2, color: rgb(1, 1, 1), borderColor: rgb(0.2, 0.3, 0.4) });
  }
  const bytes = Buffer.from(await pdf.save());
  const state = { saveFailure: options.saveFailure ?? false, resourceFailure: options.resourceFailure ?? false,
    submitRequests: 0, errors: [] as string[], unexpected: [] as string[], failedResources: [] as string[] };
  const activity = { id: activityId, type: "Resource", title: "社区生态观察资料：统一观察条件、完整记录证据并比较调查结果", isOpen: true,
    description: "阅读观察表与调查说明，保留时间、地点和观察条件，使用完整证据解释调查结果。",
    offering: { id: "pdf-offering", name: "科学探索与项目实践", status: "open" }, chapter: { title: "第一章 · 观察与证据" },
    config: { resourceKind: "file", url: uploadPath, fileName: "社区生态观察资料.pdf" },
    progress: { status: options.saveFailure ? "in_progress" : "completed", progressData: {} }, instance: null, instances: [] };
  page.on("pageerror", error => state.errors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith("/api/")) state.failedResources.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/platform/auth/student-profile") return json({ user: { role: "student", displayName: "资料阅读验收", username: "pdf-student" } });
    if (path === `/api/platform/activities/${activityId}` && request.method() === "GET") return json({ activity });
    if (path === uploadPath && request.method() === "GET") return state.resourceFailure
      ? json({ message: "Injected unavailable PDF" }, 503) : route.fulfill({ status: 200, contentType: "application/pdf", body: bytes });
    if (path === `/api/platform/activities/${activityId}/submit` && request.method() === "POST") {
      state.submitRequests++;
      if (state.saveFailure) return json({ message: "学习记录暂时无法保存" }, 503);
      activity.progress.status = "completed";
      return json({ progress: activity.progress });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return json({ message: "Unconfigured isolated fixture" }, 503);
  });
  return state;
}

for (const profile of desktopAcceptanceProfiles([{ width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }])) {
  test(`student PDF tools hide, recover and restore progress ${profile.viewport.width}x${profile.viewport.height} ${profile.name}`, async ({ browser }, info) => {
    test.setTimeout(60_000);
    await withDesktopProfile(profile, browser, info, async ({ page }) => {
      const audit = await fixture(page);
      await page.goto(`/student/activities/${activityId}`);
      const reader = page.getByRole("region", { name: "PDF 阅读区域", exact: true });
      const pages = page.getByRole("region", { name: "PDF 页面", exact: true });
      const tools = page.getByRole("toolbar", { name: "PDF 阅读工具", exact: true });
      const firstCanvas = reader.locator('canvas[aria-label="PDF 第 1 页"]');
      await expect(firstCanvas).toBeVisible();
      await expect.poll(() => firstCanvas.evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels) return 0;
        let ink = 0;
        for (let index = 0; index < pixels.length; index += 64) if (pixels[index + 3] && Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 220) ink++;
        return ink;
      })).toBeGreaterThan(10);
      await pages.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await expect(tools).toHaveAttribute("data-visible", "false");
      await pages.focus();
      await expect(tools).toHaveAttribute("data-visible", "true");
      const jump = tools.getByRole("spinbutton", { name: "跳转页码", exact: true });
      await jump.focus();
      await expect(jump).toBeInViewport({ ratio: 1 });
      await jump.fill("2");
      await expect(jump).toHaveValue("2");
      await expect.poll(() => pages.evaluate(element => Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight) / 2))).toBeLessThanOrEqual(1);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("openpbl:pdf-reading:activity:student-pdf-layout") || "null")?.page)).toBe(2);
      await page.keyboard.press("Escape");
      await expect(pages).toBeFocused();
      await expect(tools).toHaveAttribute("data-visible", "false");
      const bounds = await pages.boundingBox();
      const point = { x: Math.min(20, bounds!.width / 2), y: Math.min(20, bounds!.height / 2) };
      if (profile.hasTouch) await pages.tap({ position: point });
      else await page.mouse.move(bounds!.x + point.x, bounds!.y + point.y);
      await expect(tools).toHaveAttribute("data-visible", "true");
      await tools.getByRole("combobox", { name: "显示比例", exact: true }).selectOption("fit-width");
      const screenshot = info.outputPath("student-pdf-reader.png");
      await captureDesktopScreenshot(page, screenshot);
      await info.attach("student-pdf-reader", { path: screenshot, contentType: "image/png" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.reload();
      await expect(reader.locator('canvas[aria-label="PDF 第 1 页"]')).toBeVisible();
      await pages.focus();
      await tools.getByRole("button", { name: /继续阅读 · 第 2 页/ }).click();
      await expect(jump).toHaveValue("2");
      expect(audit.submitRequests).toBe(0);
      expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]); expect(audit.failedResources).toEqual([]);
      await info.attach("pdf-fixture-audit", { body: JSON.stringify(audit, null, 2), contentType: "application/json" });
    }, baseURL);
  });
}

test("PDF save and resource failures retain reading and recover without duplicate completion", async ({ page }) => {
  const audit = await fixture(page, { saveFailure: true });
  await page.goto(`/student/activities/${activityId}`);
  await expect(page.getByRole("alert").filter({ hasText: "学习记录暂时无法保存" })).toBeVisible();
  await expect(page.locator('canvas[aria-label="PDF 第 1 页"]')).toBeVisible();
  expect(audit.submitRequests).toBe(1);
  audit.saveFailure = false;
  await page.getByRole("button", { name: "重试保存学习记录", exact: true }).click();
  await expect(page.getByText("已学习", { exact: true })).toBeVisible();
  expect(audit.submitRequests).toBe(2);
  audit.resourceFailure = true;
  await page.reload();
  await expect(page.getByText("PDF 读取失败（503）", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载文件", exact: true }).first()).toHaveAttribute("href", `${uploadPath}?download=1`);
  audit.resourceFailure = false;
  await page.reload();
  await expect(page.locator('canvas[aria-label="PDF 第 1 页"]')).toBeVisible();
  expect(audit.submitRequests).toBe(2);
  expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]);
});
