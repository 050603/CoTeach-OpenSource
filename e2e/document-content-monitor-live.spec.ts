import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { CONTENT_MONITOR_ACCEPTANCE_CASES } from "../scripts/lib/content-monitor-acceptance-fixtures";
import type { ContentMonitorEvent } from "../src/lib/project-practice/content-monitor-contract";
import type { ClassroomSubmission } from "../src/lib/session/types";

// Opt-in only: a disposable DB from verify-content-monitor-database.ts --keep,
// with an isolated application using that manifest's environment. No mocked APIs.
test.skip(process.env.OPENPBL_CONTENT_MONITOR_LIVE !== "true", "Requires an explicitly prepared disposable application and real model.");
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
test.use({ baseURL, reducedMotion: "reduce" });

async function paste(page: Page, text: string) {
  const editor = page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.locator('[data-slate-node="element"]').filter({ visible: true }).last().click();
  await page.keyboard.press("ControlOrMeta+End");
  await editor.evaluate((node, value) => {
    const data = new DataTransfer(); data.setData("text/plain", value);
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await expect(editor).toContainText(text.split("\n")[0].replace(/^#{1,6}\s+/, ""));
}

test("live student paste → real model → teacher review → durable readback, with AI and template exemptions", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL);
  expect(["localhost", "127.0.0.1"].includes(origin.hostname) && origin.port !== "3000").toBe(true);
  const manifest = JSON.parse(await readFile(process.env.OPENPBL_CONTENT_MONITOR_MANIFEST || ".openpbl-runtime/content-monitor-db-env.json", "utf8"));
  expect(manifest.container).toMatch(/^openpbl-content-monitor-check-/);
  const fixture = manifest.fixture;
  const student = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const teacher = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  for (const [context, token] of [[student, fixture.studentToken], [teacher, fixture.teacherToken]] as const) {
    await context.addCookies([{ name: token.cookieName, value: token.token, domain: origin.hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  }
  const endpoint = `/api/project-practice/content-monitor/events?courseId=${fixture.courseId}`;
  try {
    const initialResponse = await student.request.get(endpoint);
    expect(initialResponse.ok()).toBe(true);
    const initial = (await initialResponse.json()).events as ContentMonitorEvent[];
    for (const event of initial) {
      const ack = await student.request.patch(`/api/project-practice/content-monitor/events/${encodeURIComponent(event.id)}`, {
        headers: { origin: origin.origin }, data: { courseId: fixture.courseId, action: "acknowledge" },
      });
      expect(ack.ok()).toBe(true);
    }
    // Restore through the real save API before mounting the editor so focus and
    // previous local state cannot turn setup into an unintended paste or save.
    const statePath = `/api/courses/${fixture.courseId}/state`;
    const stateResponse = await student.request.get(statePath, { headers: { "x-auth-role": "student" } });
    expect(stateResponse.ok()).toBe(true);
    const submissions = (await stateResponse.json()).course.submissions as ClassroomSubmission[];
    const original = submissions.find(item => item.id === "monitor-browser-document" && item.studentId === fixture.studentId);
    expect(original).toBeDefined();
    const reset = await student.request.post(`/api/courses/${fixture.courseId}/actions`, {
      headers: { origin: origin.origin, "x-auth-role": "student" },
      data: { requestId: randomUUID(), action: { type: "UPSERT_SUBMISSION", payload: {
        courseId: fixture.courseId, expectedSubmissionVersion: original!.version,
        submission: { ...original, groupId: `grp-${fixture.studentId}`, content: `<p>${fixture.text}</p>`, updatedAt: new Date().toISOString() },
      } } },
    });
    expect(reset.ok()).toBe(true);
    const resetVersion = (await reset.json()).submissionVersion;
    const resetState = await student.request.get(statePath, { headers: { "x-auth-role": "student" } });
    expect(resetState.ok()).toBe(true);
    const resetSubmission = ((await resetState.json()).course.submissions as ClassroomSubmission[]).find(item => item.id === original!.id);
    expect(resetSubmission?.content).toBe(`<p>${fixture.text}</p>`);
    expect(resetSubmission?.version).toBe(resetVersion);
    const page = await student.newPage();
    const requests: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/content-monitor/checks")) requests.push(request.postDataJSON().requestId); });
    await page.goto(`/student/ai-collaboration/${fixture.courseId}`);
    await expect(page.getByRole("button", { name: "AI 协作检查已开启，查看说明" })).toBeVisible({ timeout: 45_000 });
    const editor = page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(fixture.text);
    expect(requests).toHaveLength(0);
    const core = CONTENT_MONITOR_ACCEPTANCE_CASES.find(sample => sample.id === "core-complete-answer")!.pastedText;
    const explanation = `隔离验收：这是我离线分析后写的草稿，保留了原始观察记录。验收轮次 ${Date.now()}`;
    await paste(page, core);
    const dialog = page.getByRole("dialog", { name: "请规范使用外部内容和 AI", exact: true });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole("combobox", { name: "来源说明（可选）", exact: true }).selectOption("own-draft");
    await dialog.getByLabel("补充说明（可选）", { exact: true }).fill(explanation);
    await page.screenshot({ path: info.outputPath("live-student-reminder.png"), fullPage: true });
    await dialog.getByRole("button", { name: "保存说明并继续", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('[data-slot="save-status"]')).toContainText("已保存", { timeout: 15_000 });
    const events = (await (await teacher.request.get(endpoint)).json()).events as ContentMonitorEvent[];
    const created = events.filter(event => !initial.some(previous => previous.id === event.id));
    expect(created).toHaveLength(1);
    const event = created[0];
    expect(event.studentSource).toBe("own-draft");
    expect(event.studentExplanation).toContain("保留了原始观察记录");
    expect(core).toContain(event.excerpt);

    // The exact AI text already belongs to this synthetic student's server history.
    await paste(page, fixture.systemAiText);
    await expect.poll(() => requests.length).toBe(2);
    await expect.poll(async () => (await (await student.request.get(`/api/project-practice/content-monitor/checks?courseId=${fixture.courseId}&requestId=${requests[1]}`)).json()).status, { timeout: 45_000 }).toBe("clear");
    const template = CONTENT_MONITOR_ACCEPTANCE_CASES.find(sample => sample.id === "empty-template")!.pastedText;
    await paste(page, `${template}\n${template}`);
    await expect.poll(() => requests.length).toBe(3);
    await expect.poll(async () => (await (await student.request.get(`/api/project-practice/content-monitor/checks?courseId=${fixture.courseId}&requestId=${requests[2]}`)).json()).status, { timeout: 45_000 }).toBe("clear");
    expect((await (await teacher.request.get(endpoint)).json()).events.length).toBe(initial.length + 1);
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator('[data-slot="save-status"]')).toContainText("已保存");
    await page.reload();
    await expect(page.locator('[data-slate-editor="true"]').first()).toContainText(core.slice(0, 40));
    await expect(dialog).toBeHidden();

    const teacherPage = await teacher.newPage();
    await teacherPage.goto(`/teacher/teach/${fixture.courseId}/classroom`);
    await teacherPage.getByRole("button", { name: "课堂操作", exact: true }).click();
    await teacherPage.getByRole("button", { name: /外部内容提醒/ }).click();
    const panel = teacherPage.getByRole("dialog", { name: "外部核心内容使用提醒", exact: true });
    const row = panel.locator("article").filter({ hasText: explanation });
    await expect(row).toBeVisible();
    await row.getByText("查看核实片段与提醒依据", { exact: true }).click();
    await expect(row.getByText(event.excerpt, { exact: true })).toBeVisible();
    await row.getByLabel("核实备注（可选）", { exact: true }).fill("隔离验收：已核对自写草稿，排除误报。");
    await teacherPage.screenshot({ path: info.outputPath("live-teacher-evidence.png"), fullPage: true });
    await row.getByRole("button", { name: "排除这条提醒", exact: true }).click();
    await expect(row).toHaveCount(0);
    await panel.getByRole("combobox", { name: "核实状态", exact: true }).selectOption("all");
    await expect(row).toContainText("已排除");
    const readback = (await (await teacher.request.get(endpoint)).json()).events.find((item: ContentMonitorEvent) => item.id === event.id) as ContentMonitorEvent;
    expect(readback.status).toBe("dismissed");
    expect(readback.history.some(item => item.actor === "teacher" && item.action === "dismissed")).toBe(true);
    const evidencePath = info.outputPath("live-readback.json");
    await writeFile(evidencePath, JSON.stringify({ event: readback, checkRequests: requests,
      mode: "real-browser-real-api-real-model-disposable-db", origin: origin.origin,
      expectedRuntimeBuildId: process.env.OPENPBL_CONTENT_MONITOR_BUILD_ID ?? null }, null, 2));
    await info.attach("live-readback", { path: evidencePath, contentType: "application/json" });
  } finally { await Promise.all([student.close(), teacher.close()]); }
});
