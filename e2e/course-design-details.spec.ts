import { expect, test } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { courseDesignDetailsFixture } from "./fixtures/course-design-details";
import { captureDesktopScreenshot, desktopAcceptanceProfiles, withDesktopProfile } from "./fixtures/desktop-coverage";

for (const profile of desktopAcceptanceProfiles([{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 820, height: 1180 }])) {
  test(`saved outlines and blueprints remain readable during classroom generation ${profile.viewport.width}x${profile.viewport.height} ${profile.name}`, async ({ browser }, testInfo) => {
    const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || testInfo.project.use.baseURL || "http://localhost:3000";
    await withDesktopProfile(profile, browser, testInfo, async ({ page }) => {
      const { courseId, timestamp, outlines, blueprint, course } = courseDesignDetailsFixture();
      const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
        ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
        : process.env.JWT_SECRET;
      if (secret) {
        const token = await new SignJWT({ role: "teacher", sv: 1, username: "e2e-details", displayName: "详情验收教师" })
          .setProtectedHeader({ alg: "HS256" }).setSubject("e2e-details-teacher").setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
        await page.context().addCookies([{ name: "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
      }
      const writes: string[] = [];
      const unexpected: string[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.routeWebSocket((url) => !url.pathname.includes("_next"), (socket) => socket.onMessage(() => undefined));
      // All API calls use fixtures, so browser verification cannot alter saved courses.
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
        const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
        if (path === "/api/auth/me") return json({ user: { id: "e2e-details-teacher", role: "teacher", name: "详情验收教师", displayName: "详情验收教师" } });
        if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "详情验收教师" }, hydrated: true, updatedAt: timestamp });
        if (path.endsWith("/state")) return json({ course, eventCursor: "0" });
        if (path.endsWith("/events")) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: 1 });
        if (path.endsWith("/presence")) return json({ members: [], degraded: false });
        if (path === "/api/textbooks") return json({ textbooks: [] });
        if (path.endsWith("/resource-package")) return json({ job: null });
        if (path.endsWith("/design-generation")) return json({ backgroundEnabled: true, outlinePreview: outlines, blueprintPreview: blueprint,
          job: { id: "design-1", status: "completed", step: "completed", progress: 100, trace: [], reviewStatus: "auto-continued", updatedAt: timestamp } });
        if (path.endsWith("/generation")) return json({ backgroundEnabled: true, job: {
          id: "classroom-job-1", status: "running", progress: 60, scenesGenerated: 3, totalScenes: 12, message: "正在制作课堂页面", events: [], updatedAt: timestamp,
        } });
        unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      });
      await page.goto(`/teacher/prepare/${courseId}/verify`, { waitUntil: "domcontentloaded" });
      const view = page.getByRole("button", { name: "查看大纲与蓝图", exact: true });
      await expect(view).toBeEnabled();
      {
        const viewport = profile.viewport;
        await view.click();
        const dialog = page.getByRole("dialog", { name: "查看课程大纲与教学蓝图" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: "确认大纲并继续生成" })).toHaveCount(0);
        const firstPageTitle = dialog.getByRole("article", { name: "第 1 页：训练数据页面 1" }).locator("textarea").first();
        await expect(firstPageTitle).toHaveValue("训练数据页面 1");
        await expect(firstPageTitle).toBeDisabled();
        const scrollArea = dialog.getByTestId("outline-review-scroll-area");
        await expect.poll(() => scrollArea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        await scrollArea.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await expect(dialog.getByRole("button", { name: "返回生成进度" })).toBeInViewport();
        await dialog.getByRole("button", { name: "教学蓝图", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "教学蓝图", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(dialog.getByRole("button", { name: "页面大纲", exact: true })).toHaveAttribute("aria-pressed", "false");
        await scrollArea.evaluate((element) => { element.scrollTop = 0; });
        await expect(dialog.getByText("独立验证集用于评估模型的泛化表现。", { exact: true })).toBeVisible();
        await expect(dialog.getByText("验证集不得参与模型训练。", { exact: true })).toBeVisible();
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await captureDesktopScreenshot(page, testInfo.outputPath(`details-${viewport.width}.png`));
        await dialog.getByRole("button", { name: "返回生成进度" }).click();
        await expect(dialog).toBeHidden();
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(view).toBeEnabled();
      await view.click();
      await expect(page.getByRole("dialog", { name: "查看课程大纲与教学蓝图" })).toBeVisible();
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    }, baseURL);
  });
}
