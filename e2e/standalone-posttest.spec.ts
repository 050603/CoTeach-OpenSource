import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { createCoTeachPostTestTemplate } from "../src/lib/platform/posttest";
import { publicExperimentQuestions, type ExperimentAnswer } from "../src/lib/platform/experiment";

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
const fixedTime = "2026-10-20T00:00:00.000Z";

async function mockPlatform(page: Page, role: "teacher" | "student", existingType?: "Form" | "PostTest" | "Quiz") {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim() : process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Posttest browser acceptance requires the local JWT secret");
  const token = await new SignJWT({ role, sv: 1, username: "posttest-acceptance", displayName: "验收用户", userId: "student", studentName: "验收学生" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(role).setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: role === "student" ? "openpbl_student" : "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  const config = createCoTeachPostTestTemplate();
  const offering = { id: "posttest-course", name: "教学理论", status: "open", chapters: [{ id: "chapter", title: "课后学习", isOpen: true, activities: [] as unknown[] }] };
  const existingConfig = existingType === "Form" ? { schemaVersion: 2, content: "请按实际情况作答", questions: [{ id: "q1", title: "学习体验如何？", type: "short-text", required: true, options: [] }] }
    : existingType === "Quiz" ? { schemaVersion: 1, content: "请独立作答", questions: [{ id: "q1", title: "说明学习要点", required: true }] } : config;
  if (existingType) offering.chapters[0].activities.push({ id: "posttest", title: "课后学习检查", type: existingType, isOpen: true, version: 1, config: existingConfig });
  let draft: { answers: Record<string, ExperimentAnswer>; currentPage: number; version: number; updatedAt: string } | null = null;
  let submission: { id: string; answers: Record<string, ExperimentAnswer>; submittedAt: string } | null = null;
  const questionVersion = "a".repeat(64);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/me") return json({ user: { id: role, role, name: "验收用户", displayName: "验收用户" } });
    if (path === "/api/platform/templates") return json({ templates: [] });
    if (path === "/api/platform/offerings") return json({ offerings: [offering] });
    if (path.endsWith("/chapters/chapter/activities") && method === "POST") {
      const input = route.request().postDataJSON();
      offering.chapters[0].activities.push({ id: "posttest", ...input, isOpen: false });
      return json({ activity: { id: "posttest", ...input } });
    }
    if (path === "/api/platform/activities/posttest/results") return json({
      activity: { id: "posttest", title: "课后学习检查", type: existingType, description: null, isOpen: true, questionCount: existingConfig.questions.length, chapter: { id: "chapter", title: "课后学习" }, offering: { id: offering.id, name: offering.name } },
      summary: { totalStudents: 3, notStartedCount: 1, inProgressCount: 1, submittedCount: 1 },
      students: [
        { student: { id: "s1", displayName: "小林", username: "lin" }, status: "submitted", submission: { id: "submission", submittedAt: fixedTime, activityVersion: 1, snapshotSource: "submission", objectiveScore: null, objectiveTotal: null,
          questions: existingType === "PostTest" ? config.questions : [{ id: "q1", type: "short-answer", prompt: "提交时的学习要点" }],
          answers: existingType === "PostTest" ? Object.fromEntries(config.questions.filter((question) => !question.optional).map((question) => [question.id, question.type === "scale" ? "4" : "不知道"])) : { q1: "正式作答" },
        } },
        { student: { id: "s2", displayName: "小王", username: "wang" }, status: "in-progress", submission: null },
        { student: { id: "s3", displayName: "小陈", username: "chen" }, status: "not-started", submission: null },
      ],
    });
    if (path === "/api/platform/activities/posttest/survey-results") return json({
      activity: { id: "posttest", title: "课后学习检查", isOpen: true, chapter: { id: "chapter", title: "课后学习" }, offering: { id: offering.id, name: offering.name } },
      analytics: { submittedCount: 1, totalStudents: 3, completionRate: 33.3, questions: [{ id: "q1", title: "学习体验如何？", type: "short-text", required: true, responseCount: 1, responses: [{ studentId: "s1", displayName: "小林", content: "正式作答" }], terms: [], keywordStatus: "ready" }] }, updatedAt: fixedTime,
    });
    if (path === "/api/platform/activities/posttest") return json({ activity: {
      id: "posttest", type: "PostTest", title: "教学理解与学习体验后测", isOpen: true,
      offering, chapter: offering.chapters[0], config: { ...config, questions: publicExperimentQuestions(config.questions) }, progress: { status: submission ? "completed" : "in_progress" },
    } });
    if (path === "/api/platform/activities/posttest/posttest") {
      if (method === "GET") return json({ enabled: true, available: !submission, studentKey: "enrollment", questionVersion, questions: publicExperimentQuestions(config.questions), introduction: config.content, draft, submission });
      if (method === "PUT") {
        const input = route.request().postDataJSON();
        if (input.version !== (draft?.version ?? 0)) return json({ code: "DRAFT_VERSION_CONFLICT", message: "草稿版本冲突" }, 409);
        draft = { answers: input.answers, currentPage: input.currentPage, version: input.version + 1, updatedAt: fixedTime };
        return json({ draft });
      }
      if (method === "POST") {
        submission = { id: "submission", answers: route.request().postDataJSON().answers, submittedAt: fixedTime };
        return json({ submission });
      }
    }
    return json({ message: `Missing fixture: ${path}` }, 404);
  });
}

for (const viewport of [
  { width: 1366, height: 768 }, { width: 1280, height: 560 },
  { width: 1180, height: 820 }, { width: 820, height: 1180 },
  { width: 390, height: 844 }, { width: 844, height: 390 },
]) {
  test(`teacher adds a posttest template at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await mockPlatform(page, "teacher");
    await page.goto(`${baseURL}/teacher/classes/posttest-course`);
    await page.getByRole("button", { name: "添加学习内容", exact: true }).click();
    await page.getByLabel("内容类型", { exact: true }).selectOption("PostTest");
    await page.getByRole("button", { name: "应用 CoTeach 后测模板", exact: true }).click();
    await expect(page.getByText("共 54 题 · 53 题必答", { exact: true })).toBeVisible();
    await page.getByLabel("后测第 1 题题干", { exact: true }).fill("课后知识理解检查");
    expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.locator(".pbl-course-dialog-body").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("posttest-builder.png") });
    const saved = page.waitForRequest((request) => request.url().endsWith("/chapters/chapter/activities") && request.method() === "POST");
    await page.getByRole("button", { name: "添加到章节", exact: true }).click();
    const input = (await saved).postDataJSON();
    expect(input.type).toBe("PostTest");
    expect(input.config.questions).toHaveLength(54);
    expect(input.config.questions[0].prompt).toBe("课后知识理解检查");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("后测", { exact: true })).toBeVisible();
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`student answers and revisits the complete standalone posttest at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await mockPlatform(page, "student");
    await page.goto(`${baseURL}/student/activities/posttest`);
    await expect(page.getByRole("region", { name: "后测作答说明", exact: true })).toContainText("本次后测包含 9 道知识题");
    for (let section = 0; section < 6; section++) {
      if ([1, 2, 4].includes(section)) await page.getByRole("button", { name: "我已阅读，开始作答", exact: true }).click();
      const groups = page.getByRole("group");
      if (section === 0) {
        await expect(groups).toHaveCount(9);
        for (const group of await groups.all()) await group.getByRole("radio").first().locator("..").click();
        await page.reload();
        await expect(page.getByRole("group").first().getByRole("radio").first()).toBeChecked();
      } else if (section < 5) {
        for (const group of await groups.all()) await group.getByRole("radio", { name: "4 分", exact: true }).locator("..").click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      if (section === 2) await page.screenshot({ path: info.outputPath("posttest-social-presence.png") });
      if (section < 5) await page.getByRole("button", { name: "下一步", exact: true }).click();
    }
    await page.getByRole("button", { name: "检查并提交", exact: true }).click();
    const saved = page.waitForRequest((request) => request.url().endsWith("/posttest/posttest") && request.method() === "POST");
    await page.getByRole("button", { name: "确认提交后测", exact: true }).click();
    const input = (await saved).postDataJSON();
    expect(Object.keys(input.answers)).toHaveLength(53);
    expect(input.answers.F01).toBeUndefined();
    expect(input.phase).toBeUndefined();
    expect(input.questionVersion).toBe("a".repeat(64));
    await expect(page.getByText("答案已锁定", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("group").first().getByRole("radio").first()).toBeChecked();
    await expect(page.getByRole("group").first().getByRole("radio").first()).toBeDisabled();
  });
}

for (const viewport of [
  { width: 1366, height: 768 }, { width: 1280, height: 560 },
  { width: 1180, height: 820 }, { width: 820, height: 1180 },
  { width: 390, height: 844 }, { width: 844, height: 390 },
]) {
  for (const type of ["Form", "PostTest", "Quiz"] as const) {
    test(`teacher defaults to ${type} results and edits explicitly at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await mockPlatform(page, "teacher", type);
      const writes: string[] = [];
      const classroomReads: string[] = [];
      page.on("request", (request) => { if (request.url().includes("/api/platform/") && ["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) writes.push(request.url()); });
      page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/courses") classroomReads.push(request.url()); });
      await page.goto(`${baseURL}/teacher/classes/posttest-course`);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("link", { name: "打开“课后学习检查”：查看结果", exact: true }).click();
      await page.waitForURL(`**${type === "Form" ? "/teacher/surveys/posttest" : "/teacher/activities/posttest/results"}`);
      await expect(page.getByRole("heading", { name: "课后学习检查", exact: true })).toBeVisible();
      await expect(page.locator(".pbl-platform-theme").getByRole("heading", { name: "课后学习检查", exact: true })).toBeVisible();
      expect(classroomReads).toEqual([]);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      if (type !== "Form") {
        await expect(page.getByLabel("作答人数统计")).toBeVisible();
        const filters = page.getByRole("group", { name: "按学生作答状态筛选", exact: true });
        await expect(filters.getByRole("button", { name: "全部（3 人）", pressed: true })).toBeVisible();
        for (const [status, student] of [["未开始", "小陈"], ["作答中", "小王"]]) {
          await filters.getByRole("button", { name: `${status}（1 人）`, exact: true }).click();
          await expect(page.getByText(student, { exact: true })).toBeVisible();
          await expect(page.getByText(student === "小陈" ? "小王" : "小陈", { exact: true })).toHaveCount(0);
          await expect(page.locator("summary").filter({ hasText: "小林" })).toHaveCount(0);
          await expect(page.getByRole("status")).toHaveText("显示 1 / 3 名学生");
        }
        await filters.getByRole("button", { name: "已提交（1 人）", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(filters.getByRole("button", { name: "已提交（1 人）", pressed: true })).toBeVisible();
        const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/platform/activities/posttest/results");
        await page.getByRole("button", { name: "刷新结果", exact: true }).click();
        await refreshed;
        await expect(filters.getByRole("button", { name: "已提交（1 人）", pressed: true })).toBeVisible();
        await expect(page.getByText("小王", { exact: true })).toHaveCount(0);
        await expect(page.getByText("小陈", { exact: true })).toHaveCount(0);
        for (const filter of await filters.getByRole("button").all()) {
          expect((await filter.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        }
        await filters.getByRole("button", { name: "全部（3 人）", exact: true }).click();
        await expect(page.getByText("小王", { exact: true })).toBeVisible();
        await expect(page.getByText("小陈", { exact: true })).toBeVisible();
        await expect(page.getByRole("status")).toHaveText("显示 3 / 3 名学生");
        await filters.getByRole("button", { name: "已提交（1 人）", exact: true }).click();
        await page.locator("summary").filter({ hasText: "小林" }).click();
        await expect(page.getByText(type === "PostTest" ? "学生作答：不知道" : "学生作答：正式作答", { exact: true }).first()).toBeVisible();
      } else await expect(page.getByText("正式作答", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`${type}-results.png`) });
      await page.getByRole("link", { name: "编辑内容", exact: true }).click();
      await expect(page.getByRole("heading", { name: "编辑学习内容", exact: true })).toBeVisible();
      await expect(page.getByLabel("标题", { exact: true })).toHaveValue("课后学习检查");
      expect(writes).toEqual([]);
    });
  }
}
