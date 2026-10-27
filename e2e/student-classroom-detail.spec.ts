import { expect, test, type BrowserContext } from "@playwright/test";
import { captureDesktopScreenshot, desktopAcceptanceProfiles, withDesktopProfile } from "./fixtures/desktop-coverage";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("Classroom detail fixtures require a local service");
test.use({ baseURL, serviceWorkers: "block", contextOptions: { reducedMotion: "reduce" } });

function classroom() {
  return {
    id: "detail-activity", type: "Classroom", title: "用数据认识校园：从观察到发现", isOpen: true,
    description: "从身边的问题出发，用观察、记录与比较寻找答案。\n\n我们将整理校园中的观察结果，尝试用数据表达发现，并在课堂中交流各自的思考。",
    offering: { id: "detail-course", name: "科学探索与项目实践", status: "open" }, chapter: { title: "第一章 · 观察与证据" },
    progress: { status: "in_progress" },
    experiment: { enabled: true, pretest: [{ id: "before", type: "short-answer", prompt: "课前想法" }], posttest: [{ id: "after", type: "short-answer", prompt: "课后收获" }] },
    instance: { id: "run-2", runNo: 2, status: "teaching", canWrite: true, coverImageUrl: null as string | null, pretestSubmitted: true, posttestSubmitted: false, posttestAvailable: false },
    instances: [{ id: "run-1", runNo: 1, status: "finished", startedAt: "2026-10-12T01:00:00Z", endedAt: "2026-10-12T02:00:00Z", experiment: null }],
  };
}

async function fixture(context: BrowserContext) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || "deploy/secrets/jwt_secret.txt", "utf8").trim();
  const token = await new SignJWT({ role: "student", sv: 1, userId: "detail-student", studentName: "林同学" })
    .setProtectedHeader({ alg: "HS256" }).setSubject("detail-student").setIssuer("openpbl").setAudience("openpbl-app")
    .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: "openpbl_student", value: token, url: baseURL }]);
  const state = { activity: classroom(), refreshStatus: 200, entryRequests: 0, entrySuccess: false };
  // All API traffic is served by browser fixtures, including entry requests.
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/platform/auth/student-profile") return json({ user: { role: "student", displayName: "林同学", username: "lin" } });
    if (url.pathname === "/api/platform/activities/detail-activity") return url.searchParams.has("refresh") && state.refreshStatus !== 200 ? json({ message: "状态暂时无法更新" }, state.refreshStatus) : json({ activity: state.activity });
    if (url.pathname.endsWith("/enter")) {
      state.entryRequests += 1;
      return state.entrySuccess ? json({ participation: { id: "participation" }, instance: { id: "run-2", status: "teaching", templateVersion: { snapshot: { kind: "pbl-course" } } } }) : json({ message: "课堂暂时不可用，请重试" }, 503);
    }
    return json({ message: "Unexpected API request in isolated fixture" }, 503);
  });
  return state;
}

const profiles = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop-low", width: 1280, height: 560 },
  { name: "tablet-landscape", width: 1180, height: 820 },
  { name: "tablet-portrait", width: 820, height: 1180 },
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "phone-small", width: 320, height: 740 },
];

for (const profile of desktopAcceptanceProfiles(profiles)) {
  const label = `${profile.viewport.width}x${profile.viewport.height} ${profile.name}`;
  test(`${label}: content order, controls and long text remain accessible`, async ({ browser }, info) => {
    test.setTimeout(60_000);
    await withDesktopProfile(profile, browser, info, async ({ page, context }) => {
    const state = await fixture(context);
    if (profile.viewport.width !== 1440 || profile.viewport.height !== 1000) {
      state.activity.title += "——保持观察条件一致，比较结果并表达我们的新发现";
      state.activity.description = state.activity.description.repeat(8);
    }
    await page.goto("/student/activities/detail-activity");
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(state.activity.title);
    await expect(page.getByRole("button", { name: "进入课堂", exact: true })).toBeVisible();
    const sidebar = page.getByRole("complementary", { name: "本次课堂" });
    expect(await sidebar.locator("section").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, shadow: style.boxShadow, radius: style.borderRadius };
    })).toEqual({ background: "rgba(0, 0, 0, 0)", shadow: "none", radius: "0px" });
    const cover = page.locator("[class*='layout_'] > [class*='cover_']");
    const introduction = page.getByRole("region", { name: "课堂介绍" });
    const [coverBox, sidebarBox, introBox] = await Promise.all([cover.boundingBox(), sidebar.boundingBox(), introduction.boundingBox()]);
    expect(coverBox && sidebarBox && introBox).toBeTruthy();
    expect(Math.abs(coverBox!.width / coverBox!.height - 16 / 9)).toBeLessThan(.02);
    if (viewport.width >= 1024) {
      expect(sidebarBox!.x).toBeGreaterThan(coverBox!.x + coverBox!.width);
      expect(sidebarBox!.width).toBeCloseTo(340, 0);
      expect(sidebarBox!.y).toBeLessThan(introBox!.y);
    } else {
      expect(sidebarBox!.y).toBeGreaterThanOrEqual(coverBox!.y + coverBox!.height);
      expect(introBox!.y).toBeGreaterThan(sidebarBox!.y + sidebarBox!.height);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
    const enter = page.getByRole("button", { name: "进入课堂", exact: true });
    await enter.scrollIntoViewIfNeeded();
    const enterBox = await enter.boundingBox();
    expect(enterBox!.height).toBeGreaterThanOrEqual(44);
    if (viewport.width >= 1024 && viewport.height < 800) expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe("static");
    await enter.focus();
    expect(await enter.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    await enter.evaluate((element) => { if (element instanceof HTMLElement) element.blur(); });
    await captureDesktopScreenshot(page, info.outputPath("classroom-detail.png"), true);
    await page.getByRole("button", { name: /历史课堂/ }).click();
    await expect(page.getByRole("heading", { name: "第 1 次课堂" })).toBeVisible();
    await page.getByRole("button", { name: "查看课堂记录", exact: true }).click();
    await expect(page.getByRole("region", { name: "历史课堂" }).getByRole("alert")).toHaveText("课堂暂时不可用，请重试");
    expect(state.entryRequests).toBe(1);
    }, baseURL);
  });
}

test("opening, refresh failure, access loss and image fallback retain usable state", async ({ page, context }) => {
  const state = await fixture(context);
  state.activity.instance.status = "scheduled";
  state.activity.instance.canWrite = false;
  state.activity.instance.coverImageUrl = "/classroom-detail-missing-cover.webp";
  await context.route("**/classroom-detail-missing-cover.webp", (route) => route.fulfill({ status: 404, contentType: "image/webp", body: "" }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/student/activities/detail-activity");
  await expect(page.getByRole("heading", { name: "等待教师开始" })).toBeVisible();
  await expect(page.getByRole("img", { name: /图片暂不可用/ })).toBeVisible();
  state.activity.instance.status = "teaching";
  state.activity.instance.canWrite = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "进入课堂", exact: true })).toBeVisible();
  expect(state.entryRequests).toBe(0);
  state.refreshStatus = 503;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "重试更新" })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入课堂", exact: true })).toBeVisible();
  state.refreshStatus = 403;
  await page.getByRole("button", { name: "重试更新" }).click();
  await expect(page.getByRole("heading", { name: "暂时无法访问课堂" })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入课堂", exact: true })).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px: posttest entry waits for classroom completion and student authorization`, async ({ page, context }) => {
    const state = await fixture(context);
    state.activity.instance.posttestAvailable = true;
    await page.setViewportSize(viewport);
    await page.goto("/student/activities/detail-activity");
    const enter = page.getByRole("button", { name: "进入课堂", exact: true });
    await expect(enter).toBeVisible();
    await expect(enter).toHaveClass(/primary_/);
    await expect(page.getByRole("link", { name: "开始后测" })).toHaveCount(0);
    await expect(page.getByText("尚未开放", { exact: true })).toBeVisible();

    state.activity.instance.status = "finished";
    state.activity.instance.canWrite = false;
    state.activity.instance.posttestAvailable = false;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "查看课堂记录", exact: true })).toHaveClass(/primary_/);
    await expect(page.getByRole("link", { name: "开始后测" })).toHaveCount(0);

    state.activity.instance.posttestAvailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const posttest = page.getByRole("link", { name: "开始后测" });
    await expect(posttest).toHaveAttribute("href", "/student/activities/detail-activity/assessments/run-2/posttest");
    await expect(posttest).toHaveClass(/primary_/);
    await expect(page.getByRole("button", { name: "查看课堂记录", exact: true })).toHaveClass(/secondary_/);
    await expect(enter).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  });
}

test("uses the existing entry request and classroom navigation after a successful click", async ({ page, context }) => {
  const state = await fixture(context);
  state.entrySuccess = true;
  await context.route("**/student/classroom/run-2", (route) => route.fulfill({ contentType: "text/html", body: "<main>已进入课堂</main>" }));
  await page.goto("/student/activities/detail-activity");
  await page.getByRole("button", { name: "进入课堂", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/student/classroom/run-2`);
  expect(state.entryRequests).toBe(1);
});
