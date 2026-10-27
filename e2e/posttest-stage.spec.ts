import { expect, test, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";
import { composeExperimentForms, publicExperimentQuestions, type ExperimentConfig, type ExperimentQuestion } from "../src/lib/platform/experiment";
import { COTEACH_ASSESSMENT_TEMPLATE, COTEACH_COMMUNITY_REFERENCE, COTEACH_SYSTEM_REFERENCE, COTEACH_TEACHER_REFERENCE, createCoTeachAssessmentTemplate } from "../src/lib/platform/experiment-templates";
import { captureDesktopScreenshot, desktopAcceptanceProfiles, desktopAcceptanceViewports, desktopOnly, withDesktopProfile } from './fixtures/desktop-coverage';

test.use({ serviceWorkers: "block" });

const courseId = "e2e-posttest-layout";
const studentId = "e2e-posttest-student";
const fixedTime = "2026-09-25T00:00:00.000Z";
const questions: ExperimentQuestion[] = [
  { id: "q1", type: "single-choice", prompt: "哪种方法更适合观察校园能耗？", options: ["甲：记录数据", "乙：凭印象判断"], group: { id: "observation", title: "观察与证据", instruction: "根据课堂中的节能情境作答。" } },
  { id: "q2", type: "multiple-choice", prompt: "哪些记录可以帮助比较？", options: ["用电量", "使用时段", "墙面颜色"], group: { id: "observation", title: "观察与证据", instruction: "根据课堂中的节能情境作答。" } },
  { id: "q3", type: "true-false", prompt: "比较前需要统一记录口径。" },
  { id: "q4", type: "scale", prompt: "你有多大信心解释观察结果？", scale: { min: 1, max: 5, minLabel: "没有信心", maxLabel: "很有信心" } },
  { id: "q5", type: "short-answer", prompt: "请写下你的主要发现。" },
  { id: "q6", type: "short-answer", prompt: "下一步你会怎样验证方案？" },
];

function course(): Course {
  return {
    id: courseId, version: 1, name: "校园节能项目", subject: "科学", grade: "七年级", hours: 1,
    summary: "", drivingQuestion: "如何节约校园能源？", status: "teaching",
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 4,
    students: [{ id: studentId, name: "测试学生", joinedAt: fixedTime, stageProgress: {} }],
    resources: [], groups: [], platformContext: { offeringId: "offering", activityId: "activity", templateId: "template", templateVersionId: "version" },
    experimentPosttestSummary: { enabled: true, openedAt: fixedTime, notStartedCount: 0, inProgressCount: 1, submittedCount: 0, studentRows: [{ studentId, status: "in-progress" }] },
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    createdAt: fixedTime, updatedAt: fixedTime,
  } as Course;
}

type FixtureRequest = { method: string; path: string };
type ClassroomFixtureOptions = {
  finished?: boolean;
  closeOnDraftSave?: boolean;
  submittedAnswers?: Record<string, string | string[]>;
  requests?: FixtureRequest[];
};

async function mockClassroom(page: Page, role: "student" | "teacher", assessmentPhase?: "pretest" | "posttest", assessmentQuestions: ExperimentQuestion[] = questions, options: ClassroomFixtureOptions = {}) {
  const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Posttest browser acceptance requires the local JWT secret");
  const token = await new SignJWT(role === "teacher"
    ? { role, sv: 1, username: "e2e-posttest", displayName: "测试教师" }
    : { role, sv: 1, userId: studentId, studentName: "测试学生" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(role === "student" ? studentId : "e2e-posttest-teacher")
    .setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: role === "student" ? "openpbl_student" : "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);

  const state = course();
  if (options.finished) state.status = "finished";
  if (role === "student" && !assessmentPhase) state.platformContext = undefined;
  let assessmentAvailable = !options.finished;
  let draft = { answers: {} as Record<string, string | string[]>, currentPage: 0, version: 0, updatedAt: fixedTime };
  let submission: { id: string; answers: typeof draft.answers; submittedAt: string } | null = options.submittedAnswers
    ? { id: "submitted", answers: options.submittedAnswers, submittedAt: fixedTime } : null;
  await page.routeWebSocket(/.*/, (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
      if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
    });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    options.requests?.push({ method, path });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/me") return json({ user: { id: role === "student" ? studentId : "e2e-posttest-teacher", role, name: role === "student" ? "测试学生" : "测试教师", displayName: role === "student" ? "测试学生" : "测试教师" } });
    if (path === "/api/courses") return json({ courses: [state], user: { role, name: "测试用户" }, studentId, studentName: "测试学生", ...(role === "student" ? { joinedCourseId: courseId } : {}), hydrated: true, updatedAt: fixedTime });
    if (path === `/api/courses/${courseId}/state`) return json({ course: state, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: 1 });
    if (path === `/api/courses/${courseId}/actions`) return json({ ok: true, requestId: route.request().postDataJSON()?.requestId, courseVersion: state.version, updatedAt: state.updatedAt });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: 1, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [] });
    if (path === "/api/platform/activities/activity") return json({ activity: {
      id: "activity", type: "Classroom", title: "校园节能项目", description: null, isOpen: true,
      offering: { id: "offering", name: "科学课", status: "open" }, chapter: { title: "校园观察" },
      progress: { status: "in_progress" },
      instance: { id: courseId, status: state.status, startedAt: fixedTime, endedAt: state.status === "finished" ? fixedTime : null, canWrite: state.status === "teaching", posttestAvailable: true,
        pretestSubmitted: assessmentPhase === "pretest" ? Boolean(submission) : true,
        posttestSubmitted: assessmentPhase === "posttest" ? Boolean(submission) : false,
        experiment: { enabled: true, pretest: assessmentQuestions, posttest: assessmentQuestions } },
    } });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment/results`) return json({ enabled: true, status: "teaching", enrollmentCount: 1, pretestCount: 1, posttestCount: 0, posttestDraftCount: 1, posttestOpenedAt: fixedTime, studentRows: [{ student: { id: studentId, displayName: "测试学生" }, status: "in-progress" }], variantCounts: { aPreBPost: 0, bPreAPost: 0 }, submissions: [] });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment`) {
      if (method === "GET") return json({ enabled: true, available: assessmentAvailable, studentKey: studentId, questions: assessmentQuestions, introduction: assessmentPhase === "pretest" ? createCoTeachAssessmentTemplate().pretestIntroduction : createCoTeachAssessmentTemplate().posttestIntroduction, draft: draft.version ? draft : null, submission,
        blockedReason: assessmentAvailable ? null : "本场课堂已结束，后测作答已关闭。" });
      if (method === "PUT" && options.closeOnDraftSave) { assessmentAvailable = false; state.status = "finished"; }
      if (!assessmentAvailable && ["PUT", "POST"].includes(method)) return json({ code: "ASSESSMENT_UNAVAILABLE", message: "本场课堂已结束，后测作答已关闭。" }, 409);
      if (method === "PUT") {
        const input = route.request().postDataJSON() as { answers: typeof draft.answers; currentPage: number; version: number };
        if (input.version !== draft.version) return json({ message: "版本冲突" }, 409);
        draft = { answers: input.answers, currentPage: input.currentPage, version: draft.version + 1, updatedAt: fixedTime };
        return json({ draft });
      }
      if (method === "POST") {
        const input = route.request().postDataJSON() as { answers: typeof draft.answers };
        submission = { id: "submitted", answers: input.answers, submittedAt: fixedTime };
        return json({ submission });
      }
    }
    return json({ message: `Missing fixture: ${path}` }, 404);
  });
  return baseURL;
}

async function answerFixtureQuestions(page: Page) {
  for (let step = 0; step < questions.length; step++) {
    for (const name of ["甲：记录数据", "正确", "3 分"]) {
      const input = page.getByRole("radio", { name, exact: true });
      if (await input.count()) await input.locator("..").click();
    }
    const checkbox = page.getByRole("checkbox", { name: "用电量", exact: true });
    if (await checkbox.count() && !await checkbox.isChecked()) await checkbox.locator("..").click();
    for (const [name, answer] of [["请写下你的主要发现。", "用电高峰集中在下午。"], ["下一步你会怎样验证方案？", "对比下周同一时段的数据。"]]) {
      const input = page.getByRole("textbox", { name, exact: true });
      if (await input.count()) await input.fill(answer);
    }
    const next = page.getByRole("button", { name: "下一步", exact: true });
    if (!await next.count()) break;
    await next.click();
  }
}

test.describe("finished classroom posttest", () => {
  test.use({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
  const draftKey = `experiment-draft:v1:${studentId}:${courseId}:posttest`;
  const endpoint = `/api/platform/classroom-instances/${courseId}/experiment`;
  const assessmentPath = `/student/activities/activity/assessments/${courseId}/posttest`;
  const writes = (requests: FixtureRequest[]) => requests.filter(request => !["GET", "HEAD", "OPTIONS"].includes(request.method));
  const cachedDraft = (page: Page) => page.evaluate(key => localStorage.getItem(key), draftKey);

  async function seedPendingDraft(page: Page) {
    const raw = JSON.stringify({ answers: { q1: "乙：凭印象判断" }, currentPage: 0, version: 0, updatedAt: fixedTime, pending: true });
    await page.addInitScript(({ key, value }) => {
      // Seed once: navigation and reload must expose any cache cleanup instead
      // of silently recreating the draft under test.
      if (sessionStorage.getItem("e2e-posttest-draft-seeded")) return;
      localStorage.setItem(key, value);
      sessionStorage.setItem("e2e-posttest-draft-seeded", "true");
    }, { key: draftKey, value: raw });
    return raw;
  }

  async function expectClosed(page: Page) {
    await expect(page.getByRole("heading", { name: "暂时无法作答后测", exact: true })).toBeVisible();
    await expect(page.getByText("本场课堂已结束，后测作答已关闭。", { exact: true })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /开始后测|提交检查|检查并提交|确认提交后测|重试同步|保留本机作答/ })).toHaveCount(0);
  }

  async function triggerDraftRetryEvents(page: Page) {
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("visibilitychange"));
    });
    // The normal autosave debounce is 700 ms; wait past it to catch a queued
    // save or an online/visibility retry after the assessment has closed.
    await page.waitForTimeout(900);
  }

  test("hides ended posttest entry and preserves an unsynced local draft", async ({ page }) => {
    const requests: FixtureRequest[] = [];
    const originalDraft = await seedPendingDraft(page);
    const baseURL = await mockClassroom(page, "student", "posttest", questions.slice(0, 1), { finished: true, requests });
    await page.goto(`${baseURL}/student/activities/activity`);
    await expect(page.getByRole("heading", { name: "回顾本次课堂", exact: true })).toBeVisible();
    // The fixture deliberately retains the old posttestAvailable=true flag.
    await expect(page.getByRole("link", { name: "开始后测", exact: true })).toHaveCount(0);
    await expect(page.getByText("已关闭", { exact: true })).toBeVisible();
    expect(await cachedDraft(page)).toBe(originalDraft);

    await page.goto(`${baseURL}${assessmentPath}`);
    await expectClosed(page);
    await triggerDraftRetryEvents(page);
    expect(await cachedDraft(page)).toBe(originalDraft);
    await page.reload();
    await expectClosed(page);
    expect(await cachedDraft(page)).toBe(originalDraft);
    expect(writes(requests)).toEqual([]);
  });

  test("closes an already open answer page after an unavailable draft response without retrying writes", async ({ page }) => {
    const requests: FixtureRequest[] = [];
    const baseURL = await mockClassroom(page, "student", "posttest", questions.slice(0, 1), { closeOnDraftSave: true, requests });
    await page.goto(`${baseURL}${assessmentPath}`);
    const choice = page.getByRole("radio", { name: "甲：记录数据", exact: true });
    await expect(choice).toBeEnabled();
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "PUT");
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "GET");
    await choice.locator("..").click();
    const pendingDraft = await cachedDraft(page);
    expect(JSON.parse(pendingDraft!)).toMatchObject({ answers: { q1: "甲：记录数据" }, pending: true });
    const response = await rejected;
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ASSESSMENT_UNAVAILABLE" });
    expect(await (await refreshed).json()).toMatchObject({ available: false, submission: null });
    await expectClosed(page);
    await triggerDraftRetryEvents(page);
    expect(await cachedDraft(page)).toBe(pendingDraft);
    expect(writes(requests)).toEqual([{ method: "PUT", path: endpoint }]);
    await page.reload();
    await expectClosed(page);
    expect(await cachedDraft(page)).toBe(pendingDraft);
    expect(writes(requests)).toEqual([{ method: "PUT", path: endpoint }]);
  });

  test("keeps submitted posttest answers read only after the classroom ends", async ({ page }) => {
    const requests: FixtureRequest[] = [];
    const originalDraft = await seedPendingDraft(page);
    const baseURL = await mockClassroom(page, "student", "posttest", questions.slice(0, 1), {
      finished: true, submittedAnswers: { q1: "甲：记录数据" }, requests,
    });
    await page.goto(`${baseURL}${assessmentPath}`);
    const saved = page.getByRole("radio", { name: "甲：记录数据", exact: true });
    const unsynced = page.getByRole("radio", { name: "乙：凭印象判断", exact: true });
    await expect(saved).toBeChecked();
    await expect(saved).toBeDisabled();
    await expect(unsynced).not.toBeChecked();
    await expect(unsynced).toBeDisabled();
    await expect(page.getByText("答案已锁定", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /提交检查|检查并提交|确认提交后测|重试同步|重新答题/ })).toHaveCount(0);
    await triggerDraftRetryEvents(page);
    expect(await cachedDraft(page)).toBe(originalDraft);
    await page.reload();
    await expect(saved).toBeChecked();
    await expect(saved).toBeDisabled();
    expect(await cachedDraft(page)).toBe(originalDraft);
    expect(writes(requests)).toEqual([]);
  });
});

for (const viewport of [
  { width: 1366, height: 768 }, { width: 1280, height: 560 },
  { width: 1180, height: 820 }, { width: 820, height: 1180 },
  { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 740 },
]) {
  for (const phase of ["pretest", "posttest"] as const) {
    test(`nine knowledge questions and sticky ${phase} progress at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      const config = createCoTeachAssessmentTemplate();
      const knowledge = publicExperimentQuestions(composeExperimentForms(config, "none", () => 0).pretest);
      const baseURL = await mockClassroom(page, "student", phase, knowledge);
      await page.goto(`${baseURL}/student/activities/activity/assessments/${courseId}/${phase}`);
      const title = phase === "pretest" ? "前测" : "后测";
      const instructions = page.getByRole("region", { name: `${title}作答说明`, exact: true });
      await expect(instructions).toBeVisible();
      await expect(instructions).toContainText(phase === "pretest" ? config.pretestIntroduction! : config.posttestIntroduction!);
      await expect(page.locator("details")).toHaveCount(0);
      await expect(page.getByText("自动保存进度", { exact: true })).toHaveCount(0);
      const header = page.getByRole("heading", { name: title, exact: true }).locator("xpath=ancestor::header");
      expect(await header.evaluate((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, radius: style.borderRadius, shadow: style.boxShadow, background: style.backgroundColor, image: style.backgroundImage };
      })).toEqual({ position: "sticky", radius: "0px", shadow: "none", background: "rgb(255, 255, 255)", image: "none" });
      const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
      const navigationSurface = page.getByRole("navigation", { name: "测验导航", exact: true }).locator("..");
      await expect(navigationSurface).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(navigationSurface).toHaveCSS("background-image", "none");
      const navigation = await navigationSurface.boundingBox();
      expect(Math.abs(navigation!.x)).toBeLessThan(1);
      expect(Math.abs(navigation!.y)).toBeLessThan(1);
      expect(Math.abs(navigation!.width - viewportWidth)).toBeLessThan(1);
      const headerBeforeScroll = await header.boundingBox();
      expect(Math.abs(headerBeforeScroll!.y - navigation!.y - navigation!.height)).toBeLessThan(1);
      expect(Math.abs(headerBeforeScroll!.x)).toBeLessThan(1);
      expect(Math.abs(headerBeforeScroll!.width - viewportWidth)).toBeLessThan(1);
      const heading = await page.getByRole("heading", { name: title, exact: true }).boundingBox();
      const introduction = await instructions.boundingBox();
      expect(Math.abs(heading!.x - introduction!.x)).toBeLessThan(1);
      expect(introduction!.width).toBeLessThan(viewportWidth);
      const rows = page.locator("fieldset");
      await expect(rows).toHaveCount(9);
      await expect(page.getByRole("button", { name: "下一步", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "上一步", exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("knowledge-introduction.png") });
      await rows.first().getByRole("radio", { name: "不知道", exact: true }).locator("..").click();
      await rows.last().getByRole("radio", { name: "不知道", exact: true }).locator("..").click();
      const progress = page.getByRole("progressbar", { name: `${title}作答进度`, exact: true });
      await expect(progress).toHaveAttribute("aria-valuenow", "2");
      await expect(progress).toBeInViewport({ ratio: 1 });
      const top = await header.boundingBox();
      expect(Math.abs(top!.y)).toBeLessThan(1);
      expect(Math.abs(top!.x)).toBeLessThan(1);
      expect(Math.abs(top!.width - viewportWidth)).toBeLessThan(1);
      await page.screenshot({ path: info.outputPath("knowledge-sticky-progress.png") });
      await page.getByRole("button", { name: "检查并提交", exact: true }).click();
      await page.getByRole("button", { name: "第 5 题未答", exact: true }).click();
      await expect(rows.nth(4)).toBeFocused();
      const target = await rows.nth(4).boundingBox();
      const pinned = await header.boundingBox();
      expect(target!.y).toBeGreaterThanOrEqual(pinned!.y + pinned!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
  }

  test(`compact rating rows remain usable at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const form = publicExperimentQuestions(composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0).posttest);
    const active = [form[0], ...form.filter((question) => question.group?.id === form[9].group?.id)];
    const baseURL = await mockClassroom(page, "student", "posttest", active);
    await page.goto(`${baseURL}/student/activities/activity/assessments/${courseId}/posttest`);
    await expect(page.getByText(form[0].prompt, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "我已阅读，开始作答" }).click();
    await expect(page.getByText("答题目录", { exact: true })).toHaveCount(0);
    const rows = page.locator("fieldset");
    await expect(rows).toHaveCount(13);
    const footer = page.getByRole("contentinfo", { name: "后测操作栏", exact: true });
    const before = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    const captions = page.getByRole("list", { name: "分值含义", exact: true }).getByRole("listitem");
    await expect(captions).toHaveCount(5);
    for (let index = 0; index < 5; index++) {
      const caption = await captions.nth(index).boundingBox();
      for (const row of await rows.all()) {
        const score = await row.getByRole("radio", { name: `${index + 1} 分`, exact: true }).locator("..").boundingBox();
        expect(Math.abs(caption!.x + caption!.width / 2 - score!.x - score!.width / 2)).toBeLessThan(1);
        expect(Math.abs(caption!.width - score!.width)).toBeLessThan(1);
      }
    }
    for (const row of await rows.all()) {
      const score = row.getByRole("radio", { name: "4 分", exact: true });
      const label = score.locator("..");
      const box = await label.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await label.click();
      await expect(score).toBeChecked();
    }
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))).toEqual(before);
    await expect(page.getByRole("progressbar", { name: "后测作答进度" })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "检查并提交", exact: true }).click();
    await page.getByRole("button", { name: "返回作答", exact: true }).click();
    for (const score of await page.getByRole("radio", { name: "4 分", exact: true }).all()) await expect(score).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(footer.getByRole("button", { name: "检查并提交", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath("compact-ratings.png"), fullPage: true });
  });
}

const templateViewports = desktopAcceptanceViewports([
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
  { width: 1366, height: 768 },
  { width: 768, height: 576 },
]);

for (const viewport of templateViewports) {
  test(`teacher applies and saves the CoTeach template at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "teacher");
    let config: { customSetting: string; experiment?: ExperimentConfig } = { customSetting: "preserved" };
    let savedVersion: number | null = null;
    await page.route("**/api/platform/offerings", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ offerings: [{ id: "offering", name: "模板验收教学班", chapters: [{ id: "chapter", title: "教学理论", activities: [{ id: "activity", title: "模板验收课堂", type: "Classroom", version: 1, config }] }] }] }) }));
    await page.route("**/api/platform/activities/activity/manage", (route) => {
      const input = route.request().postDataJSON();
      config = input.config;
      savedVersion = input.version;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ activity: { id: "activity", version: 2 } }) });
    });
    await page.goto(`${baseURL}/teacher/classes/offering/activities/activity/experiment`);
    const template = page.getByRole("region", { name: "前后测模板", exact: true });
    const description = await template.getByText(COTEACH_ASSESSMENT_TEMPLATE.description, { exact: true }).boundingBox();
    expect(description && description.width > 200).toBe(true);
    await page.getByRole("button", { name: "一键应用前后测模板" }).click();
    await expect(page.getByRole("tab", { name: "共用题 9" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "后测专属 45" })).toBeVisible();
    await page.getByRole("tab", { name: "学生视角预览" }).click();
    await page.getByRole("tab", { name: "后测", exact: true }).click();
    const preview = page.getByLabel("后测题目预览");
    await expect(preview.locator("fieldset")).toHaveCount(54);
    await expect(preview.getByRole("region", { name: "意见与建议（选填）" }).getByRole("textbox")).toBeVisible();
    await expect(preview.getByText(/^(?:K|CoI|S)\d+　/)).toHaveCount(0);
    await expect(preview.getByText(/Chinese System Usability Scale|来源：|DOI:/)).toHaveCount(0);
    for (const note of [COTEACH_TEACHER_REFERENCE, COTEACH_COMMUNITY_REFERENCE, COTEACH_SYSTEM_REFERENCE]) {
      await expect(preview.getByText(note, { exact: true })).toBeVisible();
    }
    await preview.getByText(COTEACH_COMMUNITY_REFERENCE, { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`template-preview-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach("template-community-reference", { path: screenshot, contentType: "image/png" });
    await page.getByRole("button", { name: "保存实验配置" }).first().click();
    await expect(page.getByText("实验配置已保存到本课堂", { exact: true })).toBeVisible();
    expect(savedVersion).toBe(1);
    expect(config.customSetting).toBe("preserved");
    expect(config.experiment?.sharedQuestions).toHaveLength(9);
    expect(config.experiment?.posttest).toHaveLength(45);
    expect(config.experiment?.posttest.at(-1)).toMatchObject({ type: "short-answer", optional: true });
    expect(config.experiment?.posttest[13].group?.referenceNote).toBe(COTEACH_COMMUNITY_REFERENCE);
  });

  test(`student sees the CoTeach reference on each social page at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const form = publicExperimentQuestions(composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0).posttest);
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "student", "posttest", form);
    await page.goto(`${baseURL}/student/activities/activity/assessments/${courseId}/posttest`);
    await expect(page.getByText(form[0].prompt, { exact: true })).toBeVisible();
    await expect(page.getByText("答题目录", { exact: true })).toHaveCount(0);
    const dialog = page.getByRole("dialog", { name: "先读懂题目中的指代" });
    for (let step = 0; step < form.length && !await page.locator("#experiment-posttest-CoI14").count(); step++) {
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      if (await dialog.count()) await dialog.getByRole("button", { name: "我已阅读，开始作答" }).click();
    }
    await expect(page.getByText(form.find((question) => question.id === "CoI14")!.prompt, { exact: true })).toBeVisible();
    await expect(page.locator("fieldset")).toHaveCount(9);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(COTEACH_COMMUNITY_REFERENCE, { exact: true })).toBeVisible();
    await expect(page.getByText("指代说明 · 请先阅读", { exact: true })).toBeVisible();
    const noteBox = page.getByText(COTEACH_COMMUNITY_REFERENCE, { exact: true }).locator("..");
    await noteBox.evaluate((element) => {
      const headerHeight = document.querySelector("header")!.getBoundingClientRect().height;
      window.scrollBy({ top: element.getBoundingClientRect().top - headerHeight - 12, behavior: "instant" });
    });
    const [noteBounds, footerBounds] = await Promise.all([
      noteBox.boundingBox(),
      page.getByRole("contentinfo", { name: "后测操作栏", exact: true }).boundingBox(),
    ]);
    expect(noteBounds && footerBounds && noteBounds.y >= -1 && noteBounds.y + noteBounds.height <= footerBounds.y).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`template-student-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach("student-community-reference", { path: screenshot, contentType: "image/png" });
    if (viewport.width === 1366) {
      while (await page.getByRole("button", { name: "上一步", exact: true }).isEnabled()) {
        await page.getByRole("button", { name: "上一步", exact: true }).click();
        if (await dialog.count()) await dialog.getByRole("button", { name: "我已阅读，开始作答" }).click();
      }
      for (let index = 0; index < form.length; index++) {
        if (await dialog.count()) await dialog.getByRole("button", { name: "我已阅读，开始作答" }).click();
        const unknown = page.getByRole("radio", { name: "不知道", exact: true });
        const choices = await unknown.count() ? unknown : page.getByRole("radio", { name: "4 分", exact: true });
        for (const choice of await choices.all()) await choice.locator("..").click();
        const next = page.getByRole("button", { name: "下一步", exact: true });
        if (!await next.count()) break;
        await next.click();
      }
      const feedback = page.getByRole("region", { name: "意见与建议（选填）" });
      await expect(feedback.getByRole("textbox")).toHaveValue("");
      await expect(page.locator("fieldset")).toHaveCount(1);
      await page.getByRole("button", { name: "检查并提交", exact: true }).click();
      await expect(page.getByText("必答题已完成", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "跳题原因" })).toHaveCount(0);
      const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname.endsWith("/experiment") && candidate.method() === "POST");
      await page.getByRole("button", { name: "确认提交后测", exact: true }).click();
      expect(Object.keys((await request).postDataJSON().answers)).toHaveLength(53);
      await expect(page.getByRole("link", { name: "查看后测答案", exact: true })).toBeVisible();
    }
  });
}

for (const profile of desktopAcceptanceProfiles([
  { width: 768, height: 576 }, { width: 1024, height: 576 },
  { width: 1366, height: 768 }, { width: 1920, height: 1080 },
])) {
  test(`assessment reading dialog fits ${profile.viewport.width}x${profile.viewport.height} ${profile.name}`, async ({ browser }, info) => {
    test.setTimeout(60_000);
    await withDesktopProfile(profile, browser, info, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const form = publicExperimentQuestions(composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0).posttest);
      // Simulate an existing assignment created before the display changes.
      const legacyQuestions = [form[0], ...form.filter((question) => ["CoI14", "CoI15", "CoI16", "CoI17", "CoI18", "S01"].includes(question.id))]
        .map((question) => ({ ...question, prompt: `${question.id}　${question.prompt}` }));
      const system = legacyQuestions.at(-1)!;
      system.group = { ...system.group!, instruction: `${system.group!.instruction}\n\n量表：Chinese System Usability Scale（C-SUS），10题。来源：Wang et al. DOI: 10.1080/10447318.2019.1700644。` };
      const baseURL = await mockClassroom(page, "student", "posttest", legacyQuestions);
      await page.goto(`${baseURL}/student/activities/activity/assessments/${courseId}/posttest`);
      await expect(page.getByText(form[0].prompt, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "先读懂题目中的指代" });
      const acknowledge = dialog.getByRole("button", { name: "我已阅读，开始作答" });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole("button", { name: "下一步", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("heading")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(acknowledge).toBeInViewport({ ratio: 1 });
      const bounds = await dialog.boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
      expect(await acknowledge.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("region", { name: "指代说明内容" })).toBeFocused();
      await page.keyboard.press("End");
      await expect.poll(() => dialog.getByRole("region", { name: "指代说明内容" }).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
      await page.keyboard.press("Tab");
      await expect(acknowledge).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("region", { name: "指代说明内容" })).toBeFocused();
      await captureDesktopScreenshot(page, info.outputPath("assessment-reading-dialog.png"));
      await acknowledge.click();
      await expect(page.locator("fieldset").first()).toBeFocused();
      await expect(page.getByText(/^(?:K|CoI|S)\d+　/)).toHaveCount(0);
      await page.getByRole("radio", { name: "4 分", exact: true }).first().locator("..").click();
      await page.getByRole("button", { name: "重新阅读说明" }).click();
      await expect(dialog).toBeVisible();
      await acknowledge.click();
      while (!await page.locator("#experiment-posttest-S01").count()) {
        await page.getByRole("button", { name: "下一步", exact: true }).click();
        if (!await page.locator("#experiment-posttest-S01").count()) await expect(dialog).toHaveCount(0);
      }
      await expect(dialog.getByText(COTEACH_SYSTEM_REFERENCE, { exact: true })).toBeVisible();
      await acknowledge.click();
      await expect(page.getByText(/Chinese System Usability Scale|来源：|DOI:/)).toHaveCount(0);
      await expect(page.getByText(/1＝非常不同意；5＝非常同意/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}

for (const { phase, viewport, short } of [
  { phase: "pretest" as const, viewport: { width: 390, height: 568 }, short: false },
  { phase: "posttest" as const, viewport: { width: 1024, height: 576 }, short: true },
]) {
  test(`standalone ${phase} keeps actions fixed and returns to the activity`, async ({ page }) => {
    test.skip(desktopOnly && viewport.width === 390, 'Desktop acceptance excludes phone and tablet scenarios.');
    await page.setViewportSize(viewport);
    const activeQuestions = short ? questions.slice(0, 1) : questions;
    const baseURL = await mockClassroom(page, "student", phase, activeQuestions);
    await page.goto(`${baseURL}/student/activities/activity/assessments/${courseId}/${phase}`);
    const footer = page.getByRole("contentinfo", { name: `${phase === "pretest" ? "前测" : "后测"}操作栏` });
    await expect(footer).toBeVisible();
    const before = await footer.boundingBox();
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    const after = await footer.boundingBox();
    expect(before && after && Math.abs(before.y - after.y) < 2).toBe(true);
    expect(after && after.y + after.height <= viewport.height + 1).toBe(true);
    if (!short) {
      await answerFixtureQuestions(page);
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto";
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)).toBe(true);
      const lastQuestion = await page.getByRole("textbox", { name: "下一步你会怎样验证方案？" }).boundingBox();
      const currentFooter = await footer.boundingBox();
      expect(lastQuestion && currentFooter && lastQuestion.y + lastQuestion.height < currentFooter.y).toBe(true);
    } else {
      await page.getByRole("radio", { name: "甲：记录数据" }).locator("..").click();
    }
    await page.getByRole("button", { name: "检查并提交" }).click();
    await page.getByRole("button", { name: `确认提交${phase === "pretest" ? "前测" : "后测"}` }).click();
    await expect(page).toHaveURL(`${baseURL}/student/activities/activity`);
    if (phase === "pretest") await expect(page.getByRole("button", { name: "进入课堂" })).toBeVisible();
    else await expect(page.getByRole("link", { name: "查看后测答案", exact: true })).toBeVisible();
  });
}

for (const viewport of desktopAcceptanceViewports([{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1366, height: 768 }])) {
  test(`student posttest works at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "student");
    await page.goto(`${baseURL}/student/classroom/${courseId}`);
    await expect(page.getByRole("heading", { name: "后测", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "观察与证据" })).toBeVisible();
    const initialScreenshot = info.outputPath(`posttest-student-start-${viewport.width}.png`);
    await page.screenshot({ path: initialScreenshot, fullPage: true });
    await info.attach("student-posttest-start", { path: initialScreenshot, contentType: "image/png" });
    await answerFixtureQuestions(page);
    await page.getByRole("button", { name: /检查并提交/ }).click();
    await expect(page.getByText("所有题目已完成")).toBeVisible();
    await page.getByRole("button", { name: "确认提交后测" }).click();
    await expect(page.getByText("答案已锁定")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`posttest-student-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach("student-posttest", { path: screenshot, contentType: "image/png" });
  });
}

for (const viewport of desktopAcceptanceViewports([{ width: 390, height: 844 }, { width: 1366, height: 768 }])) {
  test(`teacher posttest shows status and roster at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "teacher");
    await page.goto(`${baseURL}/teacher/teach/${courseId}/classroom`);
    await expect(page.getByRole("heading", { name: "后测", exact: true })).toBeVisible();
    await expect(page.getByLabel("后测进度")).toContainText("作答中");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`posttest-teacher-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach("teacher-posttest", { path: screenshot, contentType: "image/png" });
  });
}
