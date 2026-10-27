import { browserLearningEventReceipt, createBrowserActionReceipts } from '../scripts/lib/classroom-acceptance-action-receipts.mjs';
import { expect, test, type Locator } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

test.use({ serviceWorkers: "block" });

const courseId = "e2e-project-workspace";
const studentId = "e2e-project-student";
const now = "2026-10-15T00:00:00.000Z";
const topic = "结合校园中不同区域的能源使用情况，设计一份有证据支持的节能改进方案。".repeat(12) + "必须说明方案适用的条件与限制。";
const task = "记录观察地点、日期、用能量与观察时长，比较差异后提出建议。".repeat(15) + "保留全部原始记录。";
const outputs = "提交观察记录表、改进建议和效果评估说明；标注数据来源。";
const policy = "AI 可辅助整理数据，所有结论必须由学生核对。";
const cases = [
  ...[{ width: 1366, height: 768 }, { width: 1024, height: 576 }, { width: 768, height: 1024 },
    { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 },
    { width: 320, height: 568 }].map((viewport) => ({ mode: "document" as const, viewport })),
  ...(["other", "python"] as const).flatMap((mode) =>
    [{ width: 1366, height: 768 }, { width: 390, height: 844 }].map((viewport) => ({ mode, viewport }))),
];

async function expectDialogFits(dialog: Locator) {
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: window.innerWidth, height: window.innerHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
}

for (const { mode, viewport } of cases) {
  test(`${mode} project details and local submission at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
    const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
      ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
      : process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error("A local test JWT signing secret is required.");
    const token = await new SignJWT({ role: "student", sv: 1, userId: studentId, studentName: "测试学生" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(studentId).setIssuer("openpbl")
      .setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: "openpbl_student", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    const course = {
      id: courseId, version: 1, name: "校园节能项目", subject: "科学", grade: "初中", hours: 1,
      summary: "", drivingQuestion: topic, status: "teaching", currentStageIndex: 2,
      stages: DEFAULT_STAGES.map((stage) => ({ ...stage })),
      students: [{ id: studentId, name: "测试学生", joinedAt: now, stageProgress: {} }],
      groups: [], resources: [], submissions: [], activityLog: [], uiState: {},
      pblConfig: { generationTemplate: "new-ai-learning-only", makeArtifactMode: mode },
      content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
        stagePlan: { schemaVersion: 2, source: "resource-package", drivingQuestion: topic,
          projectTask: "比较校园用能情况并提出节能方案。", totalMinutes: 45, lessonCount: 1, minutesPerLesson: 45,
          stages: [{ key: "make", title: "项目实践", durationMin: 25, requirements: task, outputs,
            teacherActions: "仅供教师的指导信息", aiActions: "帮助检查数据是否完整。", checkpoints: ["核对观察记录", "完成建议"] }],
          evaluationCriteria: "证据完整、建议可行、清楚说明限制。", reflectionQuestions: [], aiUsagePolicy: policy,
          finalDeliverables: [{ id: "report", name: "节能方案", format: "PDF", required: true, requirements: "附上原始记录表。" }],
        } },
      projectPdfVersions: mode === "other" ? [{ id: "previous-version", courseId, studentId, stageKey: "make", sequence: 1,
        title: "已有成果.pdf", uploadId: "previous-upload", kind: "pdf", status: "submitted", createdAt: now, submittedAt: now }] : [],
      createdAt: now, updatedAt: now,
    } as Course;
    const errors: string[] = [];
    const unexpectedRequests: string[] = [];
    let courseStateReads = 0;
    const actionReceipts = createBrowserActionReceipts(courseId, now);
    let sendCourseUpdate: ((payload: unknown) => void) | undefined;
    let uploadCount = 0;
    let finishUpload: (() => void) | undefined;
    let saveBehavior: "normal" | "hold" | "fail" = "normal";
    let finishSave: (() => void) | undefined;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.routeWebSocket(/.*/, (socket) => {
      if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
      socket.onMessage((message) => {
        const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
        if (payload.type === "subscribe") {
          sendCourseUpdate = (value) => socket.send(JSON.stringify(value));
          socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
        }
      });
    });
    // All business traffic stays in the browser fixture; no real submissions or AI calls.
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path.startsWith("/api/openmaic/interactive-runtime/") && route.request().method() === "GET") return route.continue();
      if (path === "/api/auth/me") return json({ user: { id: studentId, role: "student", name: "测试学生" } });
      if (path === "/api/courses") return json({ courses: [course], user: { role: "student", name: "测试学生" }, studentId, studentName: "测试学生", joinedCourseId: courseId, hydrated: true });
      if (path === `/api/courses/${courseId}/state`) {
        courseStateReads++;
        return json({ course, eventCursor: "0" });
      }
      if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
      if (path === `/api/courses/${courseId}/presence`) return json({ members: [] });
      if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: course.version, resourceProjection: null, teacherResourceProjection: null });
      if (path === `/api/courses/${courseId}/public-discussion`) return json({ enabled: false, session: null });
      if (path === `/api/courses/${courseId}/actions`) {
        const body = route.request().postDataJSON();
        const previous = actionReceipts.lookup(body);
        if (previous) return json(previous.body, previous.status);
        const submission = body.action?.payload?.submission;
        if (submission && saveBehavior === "hold") await new Promise<void>((resolve) => { finishSave = resolve; });
        if (submission && saveBehavior === "fail") return json({ message: "测试保存失败，草稿仍保留。" }, 503);
        const submissionVersion = submission ? (course.submissions?.find(item => item.id === submission.id)?.version ?? 0) + 1 : undefined;
        if (submission) course.submissions = [...(course.submissions ?? []).filter((item) => item.id !== submission.id), { ...submission, version: submissionVersion }];
        course.version = (course.version ?? 0) + 1;
        return json(actionReceipts.remember(body, { ok: true, courseVersion: course.version, ...(submissionVersion === undefined ? {} : { submissionVersion }), updatedAt: now }));
      }
      if (["/api/ai-collaboration/document", "/api/ai-collaboration/code"].includes(path)) return json({ messages: [], commentThreads: [], starters: [], conversations: [], requests: [], proactiveReviewEnabled: false });
      if (path === "/api/ai-collaboration/memory") return json({ memories: [], continuation: null });
      if (path === "/api/learning-events" && route.request().method() === "POST") {
        const receipt = browserLearningEventReceipt(route.request().postData(), Date.now());
        return json(receipt.body, receipt.status);
      }
      if (["/api/ai-collaboration/events", "/api/learning-events", `/api/courses/${courseId}/learning-events`].includes(path)) return json({ success: true });
      if (["/api/openmaic/server-providers", "/api/openmaic/provider-config", "/api/server-providers"].includes(path)) return json({ providers: [], models: [], success: true });
      if (path === `/api/courses/${courseId}/showcase/artifacts/pdf` && route.request().method() === "POST") {
        uploadCount++;
        if (uploadCount === 1) return json({ message: "测试上传失败，请重试。" }, 503);
        await new Promise<void>((resolve) => { finishUpload = resolve; });
        return json({ versionId: "new-version", uploadId: "new-upload", sequence: 2, submittedAt: now, kind: "file" });
      }
      unexpectedRequests.push(`${route.request().method()} ${path}`);
      return json({ message: "No browser fixture" }, 404);
    });
    await page.goto(`${baseURL}/student/ai-collaboration/${courseId}`);
    const detailsTrigger = page.getByRole("button", { name: "查看完整选题方向与要求", exact: true });
    await expect(detailsTrigger).toBeVisible({ timeout: 30_000 }).catch(async (error) => {
      await testInfo.attach("browser-diagnostics", { contentType: "application/json", body: JSON.stringify({ errors, unexpectedRequests }) });
      throw error;
    });
    if (mode === "python") await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 30_000 });
    const saveStatus = page.locator('[data-slot="save-status"]');
    await expect(saveStatus).toHaveCount(1);
    await expect(saveStatus).toBeVisible();
    expect(await saveStatus.evaluate((element) => element.closest("header")!.classList.contains("fixed"))).toBe(true);
    const leaveBounds = await page.getByRole("button", { name: "离开", exact: true }).boundingBox();
    const saveBounds = await saveStatus.boundingBox();
    expect(leaveBounds!.x + leaveBounds!.width).toBeLessThanOrEqual(saveBounds!.x + 1);
    await expect(page.getByText("服务器已保存", { exact: true })).toHaveCount(0);
    await expect(page.getByText("已就绪", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await detailsTrigger.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "选题方向与要求", exact: true });
    await expect(details.getByText(topic, { exact: true })).toHaveText(topic);
    await expect(details.getByText(task, { exact: true })).toHaveText(task);
    await expect(details.getByText(outputs, { exact: true })).toBeAttached();
    await expect(details.getByText("附上原始记录表。", { exact: false })).toBeAttached();
    await expect(details.getByText("仅供教师的指导信息")).toHaveCount(0);
    await expectDialogFits(details);
    const lastRequirement = details.getByText(policy, { exact: true });
    await lastRequirement.scrollIntoViewIfNeeded();
    await expect(lastRequirement).toBeInViewport({ ratio: 1 });
    await expect(details.getByRole("button", { name: "关闭对话框" })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("requirements.png") });
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(detailsTrigger).toBeFocused();

    if (mode !== "python") {
      const editor = page.locator('[contenteditable="true"]').first();
      await expect(editor).toBeVisible();
      const originalDocument = await editor.innerText();
      const uploadLabel = mode === "other" ? "提交本地成果" : "提交其他成果";
      const uploadTrigger = page.getByRole("button", { name: uploadLabel, exact: true });
      await expect(uploadTrigger).toHaveCount(1);
      expect(await uploadTrigger.evaluate((element) => Boolean(element.closest("header")))).toBe(true);
      await expect(page.locator('input[type="file"]')).toHaveCount(0);
      await uploadTrigger.click();
      const upload = page.getByRole("dialog", { name: uploadLabel, exact: true });
      await expectDialogFits(upload);
      await expect(upload.getByText(/100 MiB/)).toBeVisible();
      if (mode === "other") await expect(upload.getByText("第 1 版 · 已有成果.pdf")).toBeVisible();

      // Exercise error/retry and a modal close during upload in both document variants.
      if (viewport.width === 1366) {
        const file = { name: "成果.txt", mimeType: "text/plain", buffer: Buffer.from("校园节能建议") };
        await upload.locator('input[type="file"]').setInputFiles(file);
        await expect(upload.getByRole("alert")).toContainText("测试上传失败，请重试。");
        await upload.locator('input[type="file"]').setInputFiles(file);
        await expect.poll(() => uploadCount).toBe(2);
        await upload.getByRole("button", { name: "关闭对话框" }).click();
        finishUpload?.();
        await uploadTrigger.click();
        await expect(upload.getByRole("status")).toContainText(mode === "other" ? "本地成果已保存为第 2 个版本" : "项目材料已上传为第 2 份");
        if (mode === "other") await expect(upload.getByText("第 2 版 · 成果.txt")).toBeVisible();
        expect(uploadCount).toBe(2);
      }
      await page.screenshot({ path: testInfo.outputPath("upload.png") });
      await upload.getByRole("button", { name: "关闭对话框" }).click();
      await expect(uploadTrigger).toBeFocused();
      await expect(editor).toHaveText(originalDocument, { useInnerText: true });
      await page.evaluate(() => window.scrollTo(0, 300));
      const toolbar = page.locator('.pbl-document-editor [role="toolbar"]').first();
      await expect.poll(async () => {
        const toolbarTop = (await toolbar.boundingBox())?.y ?? 0;
        const headerBottom = await uploadTrigger.evaluate((element) => element.closest("header")!.getBoundingClientRect().bottom);
        return toolbarTop >= headerBottom;
      }).toBe(true);
      // Layout bounds alone can miss a later-painted toolbar covering the action buttons.
      await uploadTrigger.click({ trial: true });
      await page.getByRole("button", { name: "保存", exact: true }).click({ trial: true });
      if (mode === "document") await page.getByRole("button", { name: "提交最终版", exact: true }).click({ trial: true });
      await toolbar.getByRole("button", { name: "AI 组员", exact: true }).click({ trial: true });
      await page.evaluate(() => window.scrollTo(0, 0));

      if (mode === "document" && viewport.width === 1366) {
        await test.step("native selection survives classroom snapshot renders", async () => {
          const target = "辅助记录0：请在周一登记观察时段。";
          // An empty block's Ctrl+A selects Plate blocks and focuses its
          // off-screen shadow input. This setup needs ordinary body input.
          await expect.poll(() => editor.evaluate((element) =>
            [...element.querySelectorAll('[data-slate-string]')]
              .map((node) => node.textContent ?? "").join(""))).toBe("");
          const paragraph = editor.locator('[data-slate-node="element"]').filter({ visible: true }).first();
          await paragraph.click();
          await expect.poll(() => paragraph.evaluate((block) => {
            const editor = block.closest('[data-slate-editor="true"]');
            const selection = window.getSelection();
            return document.activeElement === editor && selection?.isCollapsed === true
              && block.contains(selection.anchorNode) && block.contains(selection.focusNode);
          })).toBe(true);
          await page.keyboard.insertText(target);
          await expect(editor).toHaveText(target);
          await page.getByRole("button", { name: "保存", exact: true }).click();
          await expect(saveStatus).toContainText("已保存");
          await expect.poll(async () => {
            const saved = course.submissions?.find((item) => item.studentId === studentId
              && item.stageKey === "make" && item.type === "document");
            return page.evaluate((html) => new DOMParser().parseFromString(html, "text/html")
              .body.textContent ?? "", saved?.content ?? "");
          }).toBe(target);
          await editor.locator('[data-slate-node="element"]').last().click();
          await page.keyboard.press("ControlOrMeta+End");
          await expect.poll(() => editor.evaluate((element) => {
            const selection = window.getSelection();
            return document.activeElement === element && selection?.isCollapsed
              && element.contains(selection.focusNode) && selection.focusOffset;
          })).toBe(target.length);
          await expect.poll(() => Boolean(sendCourseUpdate)).toBe(true);
          const initialReads = courseStateReads;
          // These are ordinary fixture WebSocket invalidations and snapshot
          // responses. The production page has no test render/selection hook.
          const refresh = setInterval(() => {
            course.version = (course.version ?? 0) + 1;
            course.summary = `课堂快照 ${course.version}`;
            sendCourseUpdate?.({ type: "course-event", courseId, event: {
              type: "course-updated", payload: { actionType: "SET_UI_STATE", courseVersion: course.version },
            } });
          }, 20);
          try {
            for (let cycle = 0; cycle < 3; cycle++) {
              // No sleeps, retries, editor transforms or DOM range writes
              // between native key presses: every first result must be exact.
              for (const character of target) {
                void character;
                await page.keyboard.press("Shift+ArrowLeft");
              }
              await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(target);
              await page.keyboard.press("ArrowLeft");
              for (const character of target) {
                void character;
                await page.keyboard.press("Shift+ArrowRight");
              }
              await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(target);
              await page.keyboard.press("ArrowRight");
              await page.keyboard.press("Home");
              await expect.poll(() => page.evaluate(() => window.getSelection()?.focusOffset)).toBe(0);
              await page.keyboard.press("End");
              await expect.poll(() => page.evaluate(() => window.getSelection()?.focusOffset)).toBe(target.length);
            }
            expect(courseStateReads - initialReads).toBeGreaterThan(0);
            await expect(editor).toHaveText(target);
          } finally {
            clearInterval(refresh);
          }
        });
        await test.step("native cross-cell release types in the clicked cell", async () => {
          await editor.locator('[data-slate-node="element"]').last().click();
          await page.keyboard.press("ControlOrMeta+End");
          await page.keyboard.press("Enter");
          const tableButton = toolbar.locator("button:has(svg.lucide-table)");
          if (!(await tableButton.isVisible())) {
            await toolbar.locator("[data-toolbar-overflow-more] button").first().click();
          }
          await page.locator("button:has(svg.lucide-table)").filter({ visible: true }).click();
          await page.getByRole("menuitem", { name: "表格", exact: true }).hover();
          await page.getByRole("button", { name: "插入 2 行 2 列表格", exact: true }).click();
          const table = editor.locator("table").last();
          const cells = table.locator("td[data-slate-node],th[data-slate-node]");
          await expect(cells).toHaveCount(4);
          const readCells = () => cells.evaluateAll((nodes) => nodes.map((node) =>
            (node.textContent ?? "").replace(/[\u200B-\u200D\uFEFF]/gu, "")));
          // Read-only hit tests keep this a normal native action. No force,
          // DOM range writes, editor transforms or corrective click retries.
          const point = (index: number) => cells.nth(index).evaluate((cell) => {
            const rect = cell.getBoundingClientRect();
            const candidates: Array<{ x: number; y: number }> = [];
            // A cell's center can lie between wrapped text lines. Select a
            // visible text-line point before falling back for empty cells.
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              if (!text.textContent?.replace(/[\u200B-\u200D\uFEFF]/gu, '').trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              for (const line of range.getClientRects()) {
                if (line.width > 0 && line.height > 0) {
                  candidates.push({ x: line.left + line.width / 2, y: line.top + line.height / 2 });
                }
              }
            }
            for (const x of [rect.left + 12, rect.left + rect.width / 2, rect.right - 12]) {
              candidates.push({ x, y: rect.top + rect.height / 2 });
            }
            const caretDocument = document as Document & {
              caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null;
              caretRangeFromPoint?: (x: number, y: number) => Range | null;
            };
            for (const { x, y } of candidates) {
              const target = document.elementFromPoint(x, y);
              const caretNode = caretDocument.caretPositionFromPoint?.(x, y)?.offsetNode
                ?? caretDocument.caretRangeFromPoint?.(x, y)?.startContainer;
              if (x > 0 && y > 0 && x < innerWidth && y < innerHeight
                && target?.closest("td[data-slate-node],th[data-slate-node]") === cell
                && caretNode && cell.contains(caretNode)
                && !target.closest('button,input,textarea,select,[role="button"],[contenteditable="false"]')) return { x, y };
            }
            throw new Error("The native cell action has no unobstructed visible point with a caret in that cell");
          });
          for (const [index, text] of ["地点", "观察时长", "下一格", "原始记录"].entries()) {
            await cells.nth(index).scrollIntoViewIfNeeded();
            const position = await point(index);
            await page.mouse.click(position.x, position.y);
            await page.keyboard.insertText(text);
            await expect.poll(readCells).toEqual(["地点", "观察时长", "下一格", "原始记录"]
              .map((value, cellIndex) => cellIndex <= index ? value : ""));
          }
          const selectedCellIndices = () => editor.evaluate((element) => {
            const nodes = [...element.querySelectorAll("td[data-slate-node],th[data-slate-node]")];
            const selection = window.getSelection();
            return [selection?.isCollapsed,
              nodes.findIndex((node) => node.contains(selection?.anchorNode ?? null)),
              nodes.findIndex((node) => node.contains(selection?.focusNode ?? null))];
          });
          const dragAcrossCells = async () => {
            const start = await point(0);
            // Start a new range from a native caret. Pressing on text that is
            // already selected can start HTML drag/drop instead of selecting.
            await page.mouse.click(start.x, start.y);
            await expect.poll(() => editor.evaluate((element) => {
              const selection = window.getSelection();
              const cells = [...element.querySelectorAll("td[data-slate-node],th[data-slate-node]")];
              return {
                active: document.activeElement === element,
                collapsed: selection?.isCollapsed,
                anchorCell: cells.findIndex((cell) => cell.contains(selection?.anchorNode ?? null)),
                focusCell: cells.findIndex((cell) => cell.contains(selection?.focusNode ?? null)),
                selectedCells: cells.map((cell) => cell.getAttribute("data-table-cell-selected") === "true"),
              };
            })).toEqual({ active: true, collapsed: true, anchorCell: 0, focusCell: 0,
              selectedCells: [false, false, false, false] });
            const end = await point(3);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 8 });
            await expect.poll(selectedCellIndices).toEqual([false, 0, 3]);
          };
          await expect.poll(() => Boolean(sendCourseUpdate)).toBe(true);
          const initialReads = courseStateReads;
          const refresh = setInterval(() => {
            course.version = (course.version ?? 0) + 1;
            course.summary = `表格课堂快照 ${course.version}`;
            sendCourseUpdate?.({ type: "course-event", courseId, event: {
              type: "course-updated", payload: { actionType: "SET_UI_STATE", courseVersion: course.version },
            } });
          }, 20);
          try {
            for (let cycle = 0; cycle < 3; cycle++) {
              // The same preceding cross-cell drag/collapse/edit sequence was
              // necessary to expose C19 in the unpatched control replay.
              await dragAcrossCells(); await page.mouse.up();
              await page.keyboard.press("ArrowRight");
              const beforePrevious = await readCells();
              const previous = await point(3);
              const previousMarker = `拖选后${cycle}`;
              await page.mouse.click(previous.x, previous.y);
              await page.keyboard.insertText(previousMarker);
              await expect.poll(async () => (await readCells()).map((text, index) =>
                index === 3 ? text.replace(previousMarker, "") : text)).toEqual(beforePrevious);
              await expect(cells.nth(3)).toContainText(previousMarker);

              await dragAcrossCells();
              const outside = await page.locator("header").first().evaluate((header) => {
                const rect = header.getBoundingClientRect();
                for (let y = Math.max(1, rect.top + 8); y < Math.min(innerHeight, rect.bottom - 4); y += 12) {
                  for (let x = Math.max(1, rect.left + 8); x < Math.min(innerWidth, rect.right - 4); x += 16) {
                    const target = document.elementFromPoint(x, y);
                    if (target && header.contains(target)
                      && !target.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"]')) return { x, y };
                  }
                }
                throw new Error("No visible non-interactive point exists outside the editor");
              });
              const released = page.evaluate(() => new Promise<{ trusted: boolean; outside: boolean }>((resolve, reject) => {
                const timer = setTimeout(() => { document.removeEventListener("pointerup", onUp, true); reject(new Error("No native outside pointerup")); }, 5000);
                function onUp(event: PointerEvent) {
                  clearTimeout(timer); document.removeEventListener("pointerup", onUp, true);
                  const editor = document.querySelector('[contenteditable="true"]');
                  resolve({ trusted: event.isTrusted, outside: !editor?.contains(event.target as Node) });
                }
                document.addEventListener("pointerup", onUp, true);
              })).then((value) => ({ value }), (error: unknown) => ({ error }));
              await page.mouse.move(outside.x, outside.y, { steps: 8 });
              await page.mouse.up();
              const outcome = await released;
              if ("error" in outcome) throw outcome.error;
              const release = outcome.value;
              expect(release).toEqual({ trusted: true, outside: true });
              const before = await readCells();
              const next = await point(1);
              const marker = `外部释放后${cycle}`;
              await page.mouse.click(next.x, next.y);
              // Type immediately after the real click: a wait here could hide
              // the stale previous-cell collapse that corrupts user input.
              await page.keyboard.insertText(marker);
              await expect(cells.nth(1)).toContainText(marker);
              await expect.poll(async () => (await readCells()).map((text, index) =>
                index === 1 ? text.replace(marker, "") : text)).toEqual(before);
            }
            expect(courseStateReads - initialReads).toBeGreaterThan(0);
          } finally {
            clearInterval(refresh);
            await page.mouse.up();
          }
          const expected = await readCells();
          await page.getByRole("button", { name: "保存", exact: true }).click();
          await expect(saveStatus).toContainText("已保存");
          await expect.poll(async () => {
            const saved = course.submissions?.find((submission) => submission.studentId === studentId && submission.stageKey === "make");
            if (!saved) return [];
            return page.evaluate((html) => [...new DOMParser().parseFromString(html, "text/html")
              .querySelectorAll("table td,table th")].map((cell) => cell.textContent ?? ""), saved.content);
          }).toEqual(expected);
          await page.reload();
          await expect.poll(readCells).toEqual(expected);
        });
      }

      if (mode === "document" && [1366, 390, 320].includes(viewport.width)) {
        saveBehavior = "hold";
        await editor.fill("保存状态应当跟随当前文档。");
        await expect(saveStatus).toContainText("未保存");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(saveStatus).toContainText("保存中");
        await expect.poll(() => Boolean(finishSave)).toBe(true);
        saveBehavior = "normal";
        finishSave?.();
        await expect(saveStatus).toContainText("已保存");

        saveBehavior = "fail";
        await editor.fill("保存失败后，也要保留最新文档并允许重试。");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(saveStatus).toContainText("保存失败", { timeout: 20_000 });
        const leaveErrorBounds = await page.getByRole("button", { name: "离开", exact: true }).boundingBox();
        const saveErrorBounds = await saveStatus.boundingBox();
        expect(leaveErrorBounds!.x + leaveErrorBounds!.width).toBeLessThanOrEqual(saveErrorBounds!.x + 1);
        await page.screenshot({ path: testInfo.outputPath("save-error.png") });
        saveBehavior = "normal";
        const retryButton = viewport.width < 640
          ? page.getByRole("button", { name: "保存", exact: true })
          : saveStatus.getByRole("button", { name: "重试", exact: true });
        await retryButton.click();
        await expect(saveStatus).toContainText("已保存");
        await expect(editor).toContainText("保存失败后，也要保留最新文档并允许重试。");
      }
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("workspace.png") });
    expect(unexpectedRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
