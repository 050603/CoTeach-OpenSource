import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";

// Browser interaction and layout acceptance with explicit fixtures only.
// Every API request is intercepted; these tests do not prove backend record accuracy.
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("Student record fixtures require a local acceptance service");
}
test.use({ baseURL, serviceWorkers: "block", reducedMotion: "reduce" });

const offeringId = "record-fixture-class";
const pagePath = `/teacher/classes/${offeringId}/students`;
const apiPath = `/api/platform/offerings/${offeringId}/students`;
const at = "2026-10-26T08:00:00.000Z";
const csvBytes = Buffer.from('\uFEFF"姓名","账号"\r\n"模拟学生","fixture"', "utf8");
// Distinct download bytes deliberately make the format switch observable.
const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from("fixture-archive")]);
const activities = Array.from({ length: 6 }, (_, index) => ({
  id: index === 0 ? "form" : `activity-${index + 1}`,
  chapterId: `chapter-${Math.floor(index / 2) + 1}`,
  chapterTitle: `第${Math.floor(index / 2) + 1}章 · 观察与表达`,
  chapterPosition: Math.floor(index / 2) + 1,
  position: index % 2 + 1,
  title: index === 0 ? "校园观察调查" : `学习任务 ${index + 1}`,
  type: "FORM", isOpen: true, archived: false,
}));
const students = Array.from({ length: 25 }, (_, index) => ({
  id: `student-${index + 1}`,
  enrollmentId: `enrollment-${index + 1}`,
  displayName: `验收学生${String(index + 1).padStart(2, "0")}`,
  username: `fixture-${String(index + 1).padStart(2, "0")}`,
  status: "active", joinedAt: "2026-09-01T08:00:00.000Z", participated: true,
  completedOpenActivities: index % 2 ? 1 : 6, openActivityCount: 6,
  classroomParticipationCount: 1,
  lastLearningAt: new Date(Date.parse(at) - index * 60_000).toISOString(),
  activityStatuses: Object.fromEntries(activities.map((activity, activityIndex) => [activity.id, activityIndex === 0 || index % 2 === 0 ? "completed" : "in_progress"])),
  attentionReasons: index % 2 ? ["incomplete_open_activity"] : [],
}));

function studentDetail(enrollmentId: string) {
  const student = students.find((item) => item.enrollmentId === enrollmentId)!;
  return {
    student,
    activities: activities.map((activity) => ({
      ...activity,
      config: { questions: [{ id: "question", title: "当前调查题目（不应替代历史）" }] },
      progress: { status: student.activityStatuses[activity.id], startedAt: at, completedAt: at, lastAccessedAt: at },
    })),
    classrooms: [{
      id: `participation-${enrollmentId}`, firstEnteredAt: at, lastEnteredAt: at, completedAt: null,
      instance: { id: "fixture-run", status: "finished", runNo: 1, startedAt: at, endedAt: at, activity: { id: "classroom-activity", title: "校园探究项目" } },
      stageProgress: { progress: { introduction: "completed" } },
      submissions: [], artifacts: [], reflections: [], evaluations: [], pendingTeacherEvaluation: false,
    }],
    updatedAt: at,
  };
}

type FixtureState = {
  unexpected: string[];
  errors: string[];
  exports: Array<{ format?: string; enrollmentIds: string[]; sections: string[] }>;
  failNextExport: boolean;
};
const states = new WeakMap<Page, FixtureState>();

async function installFixture(context: BrowserContext, page: Page): Promise<FixtureState> {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET || readFileSync("deploy/secrets/jwt_secret.txt", "utf8").trim();
  const token = await new SignJWT({ role: "teacher", sv: 1, username: "record-fixture", displayName: "记录验收教师" })
    .setProtectedHeader({ alg: "HS256" }).setSubject("record-fixture-teacher")
    .setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: "openpbl_teacher", value: token, url: baseURL }]);
  const state: FixtureState = { unexpected: [], errors: [], exports: [], failNextExport: false };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET") {
      if (url.pathname === "/api/auth/me") return json({ user: { id: "record-fixture-teacher", role: "teacher", displayName: "记录验收教师", username: "record-fixture" } });
      if (url.pathname === `/api/platform/offerings/${offeringId}/reset-password`) return json({ request: null });
      if (url.pathname === apiPath && url.searchParams.get("view") === "summary") return json({
        offering: { id: offeringId, name: "校园探究 · 模拟验收教学班", term: "2026 秋季" },
        activities, students, totals: { members: 25, participated: 25, incomplete: 12, pendingEvaluation: 0 }, updatedAt: at,
      });
      const detail = url.pathname.match(new RegExp(`^${apiPath}/(enrollment-\\d+)$`));
      if (detail && students.some((student) => student.enrollmentId === detail[1])) return json(studentDetail(detail[1]));
      if (url.pathname.match(new RegExp(`^${apiPath}/enrollment-\\d+/submissions$`))) return json({
        activity: { id: "form", title: "校园观察调查", type: "FORM" },
        submissions: [
          { id: "latest", activityVersion: 2, activitySnapshot: { config: { questions: [{ id: "question", title: "提交时的调查题目" }] } }, payload: { answers: { question: "步行观察校园环境" } }, submittedAt: at, snapshotSource: "submission" },
          { id: "older", activityVersion: 1, activitySnapshot: { config: { questions: [{ id: "question", title: "第一次调查题目" }] } }, payload: { answers: { question: "上一版方案" } }, submittedAt: "2026-10-25T08:00:00.000Z", snapshotSource: "submission" },
        ],
        pagination: { page: 1, pageSize: 20, total: 2, hasMore: false },
      });
    }
    if (request.method() === "POST" && url.pathname === `${apiPath}/export`) {
      const body = request.postDataJSON() as FixtureState["exports"][number];
      state.exports.push(body);
      if (state.failNextExport) {
        state.failNextExport = false;
        return json({ message: "模拟导出暂时失败，请重试" }, 503);
      }
      const csv = body.format === "csv";
      return route.fulfill({
        contentType: csv ? "text/csv; charset=utf-8" : "application/zip",
        headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(csv ? "模拟班级-学生学习摘要.csv" : "模拟班级-学生学习记录.zip")}` },
        body: csv ? csvBytes : zipBytes,
      });
    }
    state.unexpected.push(`${request.method()} ${url.pathname}${url.search}`);
    return json({ message: "Unexpected API request in isolated student-record fixture" }, 503);
  });
  // A clearly marked destination isolates URL restoration from classroom features.
  await context.route("**/teacher/participations/**", async (route) => {
    if (route.request().resourceType() !== "document") return route.fulfill({ status: 404, body: "Fixture destination requires document navigation" });
    const returnTo = new URL(route.request().url()).searchParams.get("returnTo") || pagePath;
    const escapedReturn = returnTo.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="zh-CN"><body><h1>模拟成果页：仅验证返回地址</h1><a href="${escapedReturn}">返回学生与学习记录</a></body></html>` });
  });
  return state;
}

async function expectReachableControl(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  const viewport = await control.page().evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.beforeEach(async ({ context, page }, info) => {
  info.annotations.push({ type: "data-source", description: "Explicit simulated API records and downloads; no real business writes" });
  await page.setViewportSize({ width: 1440, height: 900 });
  states.set(page, await installFixture(context, page));
});
test.afterEach(async ({ page }) => {
  expect(states.get(page)?.unexpected).toEqual([]);
  expect(states.get(page)?.errors).toEqual([]);
});

test("fixture: pagination selects a visible student and empty search clears the profile", async ({ page }) => {
  await page.goto(pagePath);
  await expect(page.getByRole("heading", { name: "学生与学习记录", exact: true })).toBeVisible();
  await expect(page.locator("[data-enrollment-id]")).toHaveCount(20);
  await expect(page.getByRole("heading", { name: "验收学生01", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator("[data-enrollment-id]")).toHaveCount(5);
  await expect(page.locator('[data-enrollment-id="enrollment-21"]')).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "验收学生21", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一位学生", exact: true }).click();
  await expect(page.getByRole("heading", { name: "验收学生22", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一位学生", exact: true }).click();
  await expect(page.getByRole("heading", { name: "验收学生21", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.getByRole("heading", { name: "验收学生01", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索学生" }).fill("不存在的学生");
  await expect(page.getByText("没有符合条件的学生", { exact: true })).toBeVisible();
  await expect(page.locator("[data-enrollment-id]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^验收学生/ })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("student")).toBeNull();
  await expect(page.getByRole("button", { name: "导出当前结果", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "清除全部", exact: true }).click();
  await expect(page.locator("[data-enrollment-id]")).toHaveCount(20);
  await expect(page.getByRole("heading", { name: "验收学生01", exact: true })).toBeVisible();
});

test("fixture: deep links, reload and cross-page browser return preserve filters and selection", async ({ page }) => {
  const params = new URLSearchParams({ q: "fixture", activity: "form", status: "completed", sort: "name", page: "2", student: "enrollment-23", tab: "classrooms" });
  await page.goto(`${pagePath}?${params}`);
  const assertRestored = async () => {
    await expect(page.getByRole("textbox", { name: "搜索学生" })).toHaveValue("fixture");
    await expect(page.getByLabel("筛选活动")).toHaveValue("form");
    await expect(page.getByLabel("学习状态")).toHaveValue("completed");
    await expect(page.locator('[data-enrollment-id="enrollment-23"]')).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { name: "验收学生23", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "课堂与评价", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("2");
  };
  await assertRestored();
  await page.reload();
  await assertRestored();
  const href = await page.getByRole("link", { name: "进入成果与评价" }).getAttribute("href");
  expect(href).toBeTruthy();
  const target = new URL(href!, baseURL);
  const returnTo = new URL(target.searchParams.get("returnTo")!, baseURL);
  expect(Object.fromEntries(returnTo.searchParams)).toMatchObject(Object.fromEntries(params));
  await page.goto(target.href);
  await expect(page.getByRole("heading", { name: "模拟成果页：仅验证返回地址" })).toBeVisible();
  await page.goBack();
  await assertRestored();
  await page.goForward();
  await page.getByRole("link", { name: "返回学生与学习记录" }).click();
  await assertRestored();
});

test("fixture: advanced filters clear together and submitted answers use the saved snapshot", async ({ page }) => {
  await page.goto(pagePath);
  await page.getByRole("button", { name: /更多筛选/ }).click();
  await page.getByLabel("关注筛选").selectOption("incomplete_open_activity");
  await page.getByLabel("排序方式").selectOption("name");
  await expect(page.locator("[data-enrollment-id]")).toHaveCount(12);
  await expect(page.getByRole("heading", { name: "验收学生02", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除全部", exact: true }).click();
  await expect(page.locator("[data-enrollment-id]")).toHaveCount(20);
  await page.getByRole("tab", { name: "提交记录", exact: true }).click();
  await expect(page.getByText("提交时的调查题目", { exact: true })).toBeVisible();
  await expect(page.getByText("步行观察校园环境", { exact: true })).toBeVisible();
  await expect(page.getByText("当前调查题目（不应替代历史）", { exact: true })).toHaveCount(0);
  await expect(page.getByText("上一版方案", { exact: true })).not.toBeVisible();
});

test("fixture: exports all filtered results as CSV or ZIP and keeps selections after failure", async ({ page }) => {
  const state = states.get(page)!;
  await page.goto(pagePath);
  await page.getByRole("button", { name: "导出当前结果", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "导出学生学习记录", exact: true });
  await expect(dialog.getByRole("radio", { name: /摘要表格（CSV）/ })).toBeChecked();
  await expect(dialog).toContainText("25");
  state.failNextExport = true;
  await dialog.getByRole("button", { name: "下载摘要 CSV", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("模拟导出暂时失败");
  await expect(dialog.getByRole("radio", { name: /摘要表格（CSV）/ })).toBeChecked();
  const csvDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载摘要 CSV", exact: true }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe("模拟班级-学生学习摘要.csv");
  expect(readFileSync((await csv.path())!)).toEqual(csvBytes);
  expect(state.exports.at(-1)).toEqual({ format: "csv", enrollmentIds: students.map((student) => student.enrollmentId), sections: ["summary_csv"] });
  await page.getByRole("textbox", { name: "搜索学生" }).fill("fixture-02");
  await page.getByRole("button", { name: "导出当前结果", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "导出学生学习记录", exact: true });
  await dialog.getByRole("radio", { name: /完整数据包（ZIP）/ }).check();
  const zipDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "生成并下载 ZIP", exact: true }).click();
  const zip = await zipDownload;
  expect(zip.suggestedFilename()).toBe("模拟班级-学生学习记录.zip");
  expect(readFileSync((await zip.path())!)).toEqual(zipBytes);
  expect(state.exports.at(-1)).toMatchObject({ format: "zip", enrollmentIds: ["enrollment-2"] });
  expect(state.exports.at(-1)!.sections).toContain("activity_submissions");
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop-low", width: 1280, height: 560 },
  { name: "tablet-landscape", width: 1180, height: 820 },
  { name: "tablet-portrait", width: 820, height: 1180 },
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
]) {
  test(`fixture layout: ${viewport.name} ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(pagePath);
    await expect(page.getByRole("heading", { name: "学生与学习记录", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath("student-list.png"), fullPage: true, animations: "disabled" });
    const first = page.locator('[data-enrollment-id="enrollment-1"]');
    await expectReachableControl(first);
    await first.click();
    const profile = viewport.width < 1280 ? page.getByRole("dialog", { name: "学生学习档案", exact: true }) : page.locator("aside");
    await expect(profile).toBeVisible();
    await expect(profile.getByRole("heading", { name: "验收学生01", exact: true })).toBeVisible();
    await expectReachableControl(profile.getByRole("button", { name: "下一位学生", exact: true }));
    await profile.getByRole("tab", { name: "账号管理", exact: true }).click();
    await expectReachableControl(profile.getByRole("button", { name: "刷新申请", exact: true }));
    await page.screenshot({ path: info.outputPath("student-profile.png"), animations: "disabled" });
    if (viewport.width < 1280) {
      const back = profile.getByRole("button", { name: "返回学生名单", exact: true });
      await expectReachableControl(back);
      await back.click();
      await expect(profile).not.toBeVisible();
    }
    const exportButton = page.getByRole("button", { name: "导出当前结果", exact: true });
    await expectReachableControl(exportButton);
    await exportButton.click();
    const dialog = page.getByRole("dialog", { name: "导出学生学习记录", exact: true });
    await expect(dialog).toBeVisible();
    await expectReachableControl(dialog.getByRole("button", { name: "下载摘要 CSV", exact: true }));
    await dialog.getByRole("radio", { name: /完整数据包（ZIP）/ }).check();
    await expectReachableControl(dialog.getByRole("button", { name: "生成并下载 ZIP", exact: true }));
    await page.screenshot({ path: info.outputPath("student-export.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(exportButton).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 844, height: 390 }]) {
  test(`fixture: returning restores reading positions ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${pagePath}?student=enrollment-8`);
    await expect(page.getByText("学习任务 6", { exact: true })).toBeVisible();
    const narrow = viewport.width < 1280;
    const positions = await page.evaluate((isNarrow) => {
      if (isNarrow) {
        const drawer = document.querySelector<HTMLElement>('[role="dialog"]')!;
        drawer.scrollTop = 330;
        drawer.dispatchEvent(new Event("scroll"));
        return { windowY: 0, listY: 0, drawerY: drawer.scrollTop };
      }
      window.scrollTo({ top: 240, behavior: "instant" });
      const list = document.querySelector<HTMLElement>(".pbl-student-pane-scroll")!;
      list.scrollTop = 630;
      list.dispatchEvent(new Event("scroll"));
      return { windowY: scrollY, listY: list.scrollTop, drawerY: 0 };
    }, narrow);
    expect(narrow ? positions.drawerY : positions.windowY).toBeGreaterThan(0);
    if (!narrow) expect(positions.listY).toBeGreaterThan(0);
    const returnTo = new URL(page.url()).pathname + new URL(page.url()).search;
    await expect.poll(async () => page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith("teacher-student-records:scroll:")))).toBe(true);
    await page.goto(`/teacher/participations/participation-enrollment-8?returnTo=${encodeURIComponent(returnTo)}`);
    await page.getByRole("link", { name: "返回学生与学习记录" }).click();
    await expect(page.getByText("学习任务 6", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate((isNarrow) => {
      if (isNarrow) return document.querySelector<HTMLElement>('[role="dialog"]')?.scrollTop ?? -1;
      return window.scrollY;
    }, narrow)).toBeCloseTo(narrow ? positions.drawerY : positions.windowY, 0);
    if (!narrow) await expect.poll(() => page.locator(".pbl-student-pane-scroll").evaluate(node => node.scrollTop)).toBeCloseTo(positions.listY, 0);
  });
}
