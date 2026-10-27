import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import type { Course } from '../src/lib/session/types';
import { nativeLearningFixture } from './fixtures/native-learning';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Document workspace fixtures require a local service');
}
test.use({ baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(60_000);

/** Exercise shipped UI while keeping every business request in this fixture. */
async function fixture(page: Page, { startInClassroom = false, recoverClassroomRead = false, codeMode = false, documentHtml = '<p>我的观察记录：保持相同观察时长并核验原始计数。</p>'.repeat(55) } = {}) {
  const baseline = nativeLearningFixture();
  baseline.setMode(startInClassroom ? 'quiz' : codeMode ? 'python' : 'document');
  baseline.recoverSave();
  const course = (baseline.response('/api/courses', 'GET', {})!.body as { courses: Course[] }).courses[0]!;
  const studentId = course.students[0]!.id;
  course.submissions = [{ id: 'layout-draft', courseId: course.id, studentId, stageKey: 'make', type: 'document',
    title: '观察记录', content: documentHtml,
    status: 'draft', version: 1, createdAt: course.createdAt, updatedAt: course.updatedAt }];
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '组员工作台验收' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  const errors: string[] = [], unexpected: string[] = [], requests: string[] = [];
  let classroomReads = 0;
  let sendCourseUpdate: ((payload: unknown) => void) | undefined;
  page.on('pageerror', error => errors.push(error.message));
  await page.context().routeWebSocket(url => !url.pathname.startsWith('/_next/'), socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type === 'subscribe') {
        sendCourseUpdate = payload => socket.send(JSON.stringify(payload));
        socket.send(JSON.stringify({ type: 'subscribed', courseId: course.id }));
      }
    });
  });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(request.url()); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path.startsWith('/api/openmaic/interactive-runtime/') && request.method() === 'GET') return route.continue();
    requests.push(`${request.method()} ${path}`);
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: studentId, role: 'student', name: '组员工作台验收' } } });
    const result = baseline.response(path, request.method(), request.postData() ? request.postDataJSON() : {});
    if (path === '/api/openmaic/classroom' && request.method() === 'GET') {
      classroomReads += 1;
      if (recoverClassroomRead && classroomReads === 1) {
        return route.fulfill({ status: 502, json: { error: 'Transient fixture gateway error' } });
      }
      if (recoverClassroomRead && result) {
        const payload = result.body as { classroom: { scenes: Array<{ id: string }> } };
        return route.fulfill({ json: { ...payload, classroom: { ...payload.classroom,
          generationPreview: { active: false, contentVersion: 'published-fixture', jobStatus: 'completed',
            scenes: Object.fromEntries(payload.classroom.scenes.map(scene => [scene.id, { status: 'ready' }])) },
        } } });
      }
    }
    if (result) return route.fulfill({ status: result.status, json: result.body });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: 'Unexpected layout fixture request' } });
  });
  await page.goto(startInClassroom ? `/student/classroom/${course.id}` : `/student/ai-collaboration/${course.id}`);
  const workspace = page.locator('[data-document-workspace]');
  try {
    if (startInClassroom) await expect(page.locator('[data-stage-host-mode="student"]')).toBeVisible({ timeout: 15_000 });
    else if (codeMode) await expect(page.getByRole('button', { name: 'AI 组员', exact: true })).toBeVisible({ timeout: 15_000 });
    else await expect(workspace).toHaveAttribute('data-member-state', 'closed', { timeout: 15_000 });
  }
  catch (error) {
    await test.info().attach('workspace-bootstrap', { body: JSON.stringify({ errors, unexpected, requests }), contentType: 'application/json' });
    throw new Error(`Workspace bootstrap failed: ${JSON.stringify({ errors, unexpected, requests })}`, { cause: error });
  }
  if (!startInClassroom && !codeMode) await expect(page.getByRole('button', { name: '唤醒 AI 组员', exact: true })).toBeVisible();
  return { workspace, course, studentId, errors, unexpected, get classroomReads() { return classroomReads; }, async advanceToProject() {
    await expect.poll(() => Boolean(sendCourseUpdate)).toBe(true);
    baseline.setMode('document');
    baseline.recoverSave();
    course.version = (course.version ?? 0) + 1;
    sendCourseUpdate!({ type: 'course-event', courseId: course.id, event: {
      type: 'course-updated', payload: { actionType: 'ADVANCE_STAGE', courseVersion: course.version },
    } });
  } };
}

test('project document and message inputs keep their own focus surfaces', async ({ page }) => {
  const audit = await fixture(page, { documentHtml: '<p>我的观察记录。</p>' });
  const editor = page.locator('[data-slate-editor="true"]').first();
  await editor.click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS('outline-style', 'none');

  const panel = await openMember(page);
  const input = panel.getByRole('textbox', { name: '发给 AI 组员的消息' });
  const expand = panel.getByRole('button', { name: '全屏输入' });
  const radius = await expand.evaluate(element => getComputedStyle(element).borderRadius);
  await input.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS('outline-style', 'none');
  await expect(input.locator('..')).toHaveCSS('border-color', 'rgb(120, 113, 108)');
  await page.screenshot({ path: test.info().outputPath('document-input-focus.png') });

  await input.press('Tab');
  await expect(expand).toBeFocused();
  await expect(expand).toHaveCSS('border-radius', radius);
  await expect(expand).toHaveCSS('outline-style', 'solid');
  await expect(expand).toHaveCSS('outline-color', 'rgb(120, 113, 108)');
  await expand.press('Enter');
  const dialogInput = page.getByRole('dialog', { name: '给 AI 组员发消息' }).getByRole('textbox');
  await expect(dialogInput).toBeFocused();
  await expect(dialogInput).toHaveCSS('outline-style', 'none');
  await expect(dialogInput).toHaveCSS('border-color', 'rgb(120, 113, 108)');
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test('document typing follows the native pointer caret and keyboard selection after editor upgrades', async ({ page }) => {
  const audit = await fixture(page, { documentHtml: '<p>ABCDE FGHIJ</p>' });
  const editor = page.locator('[data-slate-editor="true"]').first();
  const text = editor.locator('[data-slate-string="true"]').first();
  await expect(text).toHaveText('ABCDE FGHIJ');
  const point = await text.evaluate(element => {
    const node = element.firstChild!;
    const range = document.createRange();
    range.setStart(node, 3);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(3);
  await page.keyboard.type('x');
  await expect(text).toHaveText('ABCxDE FGHIJ');

  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('BC');
  await page.keyboard.type('Y');
  await expect(text).toHaveText('AYxDE FGHIJ');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(text).toHaveText('ABCxDE FGHIJ');
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test('project code input avoids a frame around the internal typing target', async ({ page }) => {
  const audit = await fixture(page, { codeMode: true });
  const lines = page.locator('.monaco-editor .view-lines').first();
  await expect(lines).toBeVisible({ timeout: 20_000 });
  await lines.click({ position: { x: 30, y: 10 } });
  const typingTarget = page.locator('.monaco-editor :focus');
  await expect(typingTarget).toHaveCount(1);
  await expect(typingTarget).toHaveCSS('outline-style', 'none');
  await page.screenshot({ path: test.info().outputPath('code-editor-focus.png') });
  await page.getByRole('button', { name: '标准输入', exact: true }).click();
  const stdin = page.getByPlaceholder('需要 input() 或 scanf() 时，在这里预先输入；每行会按顺序提供给程序。');
  const radius = await stdin.evaluate(element => getComputedStyle(element).borderRadius);
  const idleBorder = await stdin.evaluate(element => getComputedStyle(element).borderColor);
  await stdin.click();
  await expect(stdin).toBeFocused();
  await expect(stdin).toHaveCSS('outline-style', 'none');
  await expect(stdin).toHaveCSS('border-radius', radius);
  await expect(stdin).not.toHaveCSS('border-color', idleBorder);
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test('restores the light document canvas after a dark classroom advances to project practice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('theme', 'system'));
  const audit = await fixture(page, { startInClassroom: true });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await audit.advanceToProject();
  await expect(audit.workspace).toHaveAttribute('data-member-state', 'closed', { timeout: 15_000 });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  const editor = page.locator('[data-slate-editor="true"]').first();
  await expect(editor).toBeVisible();
  const style = await editor.evaluate(element => {
    const css = getComputedStyle(element);
    return { caret: css.caretColor, color: css.color, background: css.backgroundColor,
      scheme: css.colorScheme, cursor: css.cursor };
  });
  expect(style.scheme).toBe('light only');
  expect(style.cursor).toBe('text');
  expect(style.background).toBe('rgb(255, 255, 255)');
  expect(style.caret).toBe('oklch(0.145 0 0)');
  expect(style.color).toBe(style.caret);
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test('selection AI progress stays at the viewport bottom while a long document scrolls and resizes', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const audit = await fixture(page);
  let releaseResponse!: () => void;
  const pendingResponse = new Promise<void>(resolve => { releaseResponse = resolve; });
  const requests: unknown[] = [];
  await page.route('**/api/ai/command', async route => {
    requests.push(route.request().postDataJSON());
    // Keep the real editor's request pending without invoking a model.
    await pendingResponse;
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: [DONE]\n\n' }).catch(() => {});
  });
  try {
    const editor = page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
    const paragraph = editor.locator('[data-slate-node="element"]').first();
    await paragraph.click();
    await paragraph.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.getByRole('button', { name: '询问 AI 组员', exact: true }).click();
    await page.getByRole('option', { name: '改善表达', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    const bar = page.locator('[data-slot="ai-loading-bar"]');
    await expect(bar.getByRole('status')).toHaveText('AI 组员正在思考…');
    const pane = page.locator('[data-document-pane]');
    for (const viewport of [
      { width: 1440, height: 900 }, { width: 1024, height: 768 },
      { width: 768, height: 1024 }, { width: 390, height: 844 },
      { width: 844, height: 390 }, { width: 1000, height: 500 },
    ]) {
      await page.setViewportSize(viewport);
      for (const fraction of [0, 0.5, 1]) {
        await pane.evaluate((element, part) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * part; }, fraction);
        await expect.poll(async () => {
          const bounds = await bar.boundingBox();
          return bounds ? Math.abs(viewport.height - bounds.y - bounds.height - 16) : Infinity;
        }).toBeLessThanOrEqual(1);
        const bounds = (await bar.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(15);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 15);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        const stop = bar.getByRole('button', { name: /停止/ });
        expect((await stop.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await stop.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`selection-ai-${viewport.width}x${viewport.height}.png`) });
    }
    await bar.getByRole('button', { name: /停止/ }).click();
    await expect(bar).toHaveCount(0);
    await expect(editor).toContainText('我的观察记录：保持相同观察时长并核验原始计数。');
    expect(audit.errors).toEqual([]);
    expect(audit.unexpected).toEqual([]);
  } finally {
    releaseResponse();
  }
});

test('recovers a transient classroom read and reuses completed content on playback and focus', async ({ page }) => {
  const audit = await fixture(page, { startInClassroom: true, recoverClassroomRead: true });
  await expect(page.getByText('比较鸟类数量时，为什么要保持观察时长一致？', { exact: true }).first()).toBeVisible();
  expect(audit.classroomReads).toBe(2);
  // Observe the real browser request path across both triggers. All business
  // traffic remains intercepted; the completed lesson should need no refresh.
  const redundantRead = page.waitForRequest(request => new URL(request.url()).pathname === '/api/openmaic/classroom',
    { timeout: 1_500 }).then(() => true, () => false);
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await redundantRead).toBe(false);
  expect(audit.classroomReads).toBe(2);
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

async function openMember(page: Page) {
  await page.getByRole('button', { name: '唤醒 AI 组员', exact: true }).click();
  await expect(page.locator('[data-document-workspace]')).toHaveAttribute('data-member-state', 'open');
  return page.getByRole('region', { name: 'AI 组员工作区', exact: true });
}

async function closeMember(page: Page) {
  await page.getByRole('button', { name: '收起 AI 组员', exact: true }).click();
  await expect(page.locator('[data-document-workspace]')).toHaveAttribute('data-member-state', 'closed');
  await expect(page.getByRole('button', { name: '唤醒 AI 组员', exact: true })).toBeFocused();
}

test('long teammate messages can resize and use full-screen editing without losing the draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const audit = await fixture(page);
  const panel = await openMember(page);
  const compact = panel.getByRole('textbox', { name: '发给 AI 组员的消息' });
  const draft = '我的方案需要先比较条件，再核对每一步的依据。\n'.repeat(35);
  await compact.fill(draft);
  const before = (await compact.boundingBox())!;
  await page.mouse.move(before.x + before.width - 4, before.y + before.height - 4);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 4, before.y + before.height + 85, { steps: 10 });
  await page.mouse.up();
  expect((await compact.boundingBox())!.height).toBeGreaterThan(before.height + 40);

  for (const viewport of [
    { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 },
    { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1000, height: 500 },
  ]) {
    await page.setViewportSize(viewport);
    await panel.getByRole('button', { name: '全屏输入' }).click();
    const dialog = page.getByRole('dialog', { name: '给 AI 组员发消息' });
    const input = dialog.getByRole('textbox');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBe(viewport.width);
    expect(box.height).toBe(viewport.height);
    expect((await input.boundingBox())!.height).toBeGreaterThan(viewport.height / 2);
    const send = dialog.getByRole('button', { name: '发送给 AI 组员' });
    await send.click({ trial: true });
    expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await input.press('Control+End');
    await input.press('Enter');
    await expect(input).toHaveValue(draft + '\n');
    await input.fill(draft);
    await page.screenshot({ path: info.outputPath(`composer-${viewport.width}x${viewport.height}.png`) });
    await input.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '全屏输入' })).toBeFocused();
    await expect(compact).toHaveValue(draft);
    await panel.getByRole('button', { name: '发送给 AI 组员' }).click({ trial: true });
  }
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test('code teammate full-screen input preserves the draft and sends once', async ({ page }) => {
  const audit = await fixture(page, { codeMode: true });
  const sent: string[] = [];
  await page.route('**/api/ai-collaboration/code*', async route => {
    const requestId = new URL(route.request().url()).searchParams.get('requestId');
    if (route.request().method() === 'GET' && requestId) {
      return route.fulfill({ status: 503, json: { status: 'failed', retryable: true, requestId } });
    }
    if (route.request().method() !== 'POST') return route.fallback();
    sent.push(route.request().postDataJSON().message);
    return route.fulfill({ status: 503, json: { message: '测试中的失败提示' } });
  });
  await page.getByRole('button', { name: 'AI 组员', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI 代码组员工作区' });
  await panel.getByRole('textbox').fill('请帮我核对这段代码的边界条件。');
  await panel.getByRole('button', { name: '全屏输入' }).click();
  const dialog = page.getByRole('dialog');
  const draft = '我的代码思路如下：\n先检查输入，再分析边界条件。';
  await dialog.getByRole('textbox').fill(draft);
  await expect(dialog.getByRole('textbox')).toHaveAttribute('maxlength', '1600');
  await dialog.getByRole('button', { name: '收起', exact: true }).click();
  await expect(panel.getByRole('textbox')).toHaveValue(draft);
  await panel.getByRole('button', { name: '全屏输入' }).click();
  await dialog.getByRole('button', { name: '发送给 AI 组员' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveText(/测试中的失败提示/);
  expect(sent).toEqual([draft]);
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 },
  { width: 768, height: 1024 }, { width: 754, height: 720 }, { width: 752, height: 720 },
  { width: 390, height: 844 }, { width: 844, height: 390 },
]) {
  test(`document and teammate share available space at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const audit = await fixture(page);
    const entry = page.getByRole('button', { name: '唤醒 AI 组员', exact: true });
    await expect(entry).toHaveText('点击唤醒组员');
    expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const panel = await openMember(page);
    await expect(entry).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'AI 组员', exact: true })).toBeFocused();
    const layout = await audit.workspace.evaluate(element => {
      const columns = element.firstElementChild!, left = element.querySelector<HTMLElement>('[data-document-pane]')!;
      const right = element.querySelector<HTMLElement>('[data-ai-member-pane]')!, box = right.getBoundingClientRect(), doc = left.getBoundingClientRect();
      return { width: columns.getBoundingClientRect().width, mode: element.getAttribute('data-layout'), hidden: left.hidden,
        leftWidth: doc.width, leftRight: doc.right, rightX: box.x, rightWidth: box.width, rightY: box.y,
        rightBottom: box.bottom, top: doc.top, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.rightBottom).toBeLessThanOrEqual(viewport.height);
    if (layout.width >= 728) {
      expect(layout.mode).toBe('split');
      expect(layout.hidden).toBe(false);
      expect(layout.leftWidth).toBeGreaterThanOrEqual(400 - 0.1);
      expect(layout.rightWidth).toBeGreaterThanOrEqual(320 - 0.1);
      expect(Math.abs(layout.rightX - layout.leftRight - 8)).toBeLessThan(0.1);
      expect(Math.abs(layout.rightY - layout.top)).toBeLessThan(0.1);
      await expect(page.getByRole('separator', { name: '调整文档与 AI 组员的宽度' })).toBeVisible();
    } else {
      expect(layout.mode).toBe('single');
      expect(layout.hidden).toBe(true);
      await expect(page.getByRole('separator')).toHaveCount(0);
    }
    await panel.getByRole('textbox').fill('保留这条尚未发送的协作草稿。');
    const send = panel.getByRole('button', { name: '发送给 AI 组员' });
    await send.scrollIntoViewIfNeeded();
    await send.click({ trial: true });
    await page.screenshot({ path: info.outputPath('workspace-open.png'), animations: 'disabled' });
    await closeMember(page);
    await expect(entry).toBeFocused();
    await expect(page.locator('[data-document-pane]')).toBeVisible();
    await openMember(page);
    await expect(panel.getByRole('textbox')).toHaveValue('保留这条尚未发送的协作草稿。');
    expect(audit.errors).toEqual([]);
    expect(audit.unexpected).toEqual([]);
  });
}

test('resizes both panes, persists the preference and restores it after a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const audit = await fixture(page);
  await openMember(page);
  const divider = page.getByRole('separator', { name: '调整文档与 AI 组员的宽度' });
  const initial = Number(await divider.getAttribute('aria-valuenow'));
  expect(initial).toBe(67);
  await divider.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', String(initial - 2));
  await divider.press('Home');
  expect(await page.locator('[data-document-pane]').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(400, 0);
  await divider.press('End');
  expect(await page.locator('[data-ai-member-pane]').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(320, 0);
  await divider.dblclick();
  await expect(divider).toHaveAttribute('aria-valuenow', '67');
  const bounds = (await divider.boundingBox())!, workspaceBounds = (await audit.workspace.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(workspaceBounds.x + workspaceBounds.width * 0.55, bounds.y + 100, { steps: 8 });
  await page.mouse.up();
  const chosen = Number(await divider.getAttribute('aria-valuenow'));
  expect(chosen).toBeGreaterThanOrEqual(54);
  expect(chosen).toBeLessThanOrEqual(56);
  const key = `openpbl:document-workspace:split:v1:${encodeURIComponent(audit.studentId)}`;
  const saved = await page.evaluate(key => localStorage.getItem(key), key);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(audit.workspace).toHaveAttribute('data-layout', 'single');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(divider).toHaveAttribute('aria-valuenow', String(chosen));
  await closeMember(page);
  await openMember(page);
  await expect(divider).toHaveAttribute('aria-valuenow', String(chosen));
  await page.reload();
  await openMember(page);
  await expect(divider).toHaveAttribute('aria-valuenow', String(chosen));
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test('single-area switching retains editor identity, selection, scroll and both drafts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const audit = await fixture(page);
  const pane = page.locator('[data-document-pane]'), editor = page.locator('[data-slate-editor="true"]').first();
  await editor.evaluate(element => {
    (window as unknown as { retainedEditor: Element }).retainedEditor = element;
    const text = element.querySelector('[data-slate-string]')?.firstChild;
    if (!text) throw new Error('The document must contain a rendered Slate text node');
    const range = document.createRange(); range.selectNodeContents(text);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  const selected = await page.evaluate(() => window.getSelection()!.toString());
  expect(selected).toContain('我的观察记录');
  await pane.evaluate(element => { element.scrollTop = 250; });
  const scrollTop = await pane.evaluate(element => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  const panel = await openMember(page);
  await panel.getByRole('textbox').fill('关闭后继续讨论的草稿');
  await closeMember(page);
  expect(await editor.evaluate(element => element === (window as unknown as { retainedEditor: Element }).retainedEditor)).toBe(true);
  expect(await pane.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
  await editor.fill('这份文档包含尚未提交的独立观察证据。');
  await openMember(page);
  await expect(panel.getByRole('textbox')).toHaveValue('关闭后继续讨论的草稿');
  await closeMember(page);
  await expect(editor).toContainText('这份文档包含尚未提交的独立观察证据。');
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test('avatar flies between its real anchors and a resize completes an interrupted flight', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const audit = await fixture(page);
  const entry = page.getByRole('button', { name: '唤醒 AI 组员', exact: true });
  await expect.poll(() => entry.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  const origin = (await entry.locator('img').boundingBox())!;
  type Sample = { phase: string; staticAvatars: number; left: number; top: number };
  await page.evaluate(() => {
    const samples: Sample[] = [];
    (window as unknown as { avatarFlightSamples: Sample[] }).avatarFlightSamples = samples;
    new MutationObserver(() => {
      const layer = document.querySelector<HTMLElement>('[data-ai-member-flight]');
      if (!layer) return;
      const avatars = document.querySelectorAll<HTMLImageElement>('[aria-label="唤醒 AI 组员"] img, img[alt="AI 组员头像"]');
      const box = layer.getBoundingClientRect();
      samples.push({ phase: layer.dataset.aiMemberFlight!, left: box.left, top: box.top,
        staticAvatars: [...avatars].filter(avatar => getComputedStyle(avatar).visibility !== 'hidden' && avatar.getClientRects().length > 0).length });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-ai-member-flight'] });
  });
  await entry.click();
  const flight = page.locator('[data-ai-member-flight]');
  await expect(audit.workspace).toHaveAttribute('data-member-state', 'open');
  await expect(flight).toHaveCount(0);
  await expect(entry).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'AI 组员头像' })).toBeVisible();
  const opening = await page.evaluate(() => (window as unknown as { avatarFlightSamples: Sample[] }).avatarFlightSamples.filter(sample => sample.phase === 'opening'));
  expect(opening.length).toBeGreaterThan(0);
  expect(opening.every(sample => sample.staticAvatars === 0)).toBe(true);
  expect(opening[0]!.left).toBeCloseTo(origin.x, 0);
  expect(opening[0]!.top).toBeCloseTo(origin.y, 0);
  // Resolve inside the browser when the return layer mounts, so a busy test
  // runner cannot miss a 320 ms transition before sending the resize.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Return flight did not mount')); }, 5000);
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-ai-member-flight="closing"]')) return;
      clearTimeout(timeout); observer.disconnect(); resolve();
    });
    observer.observe(document.body, { subtree: true, childList: true });
    document.querySelector<HTMLButtonElement>('[aria-label="收起 AI 组员"]')!.click();
  }));
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(audit.workspace).toHaveAttribute('data-member-state', 'closed');
  await expect(flight).toHaveCount(0);
  await expect(entry).toBeVisible();
  await expect(entry).toBeFocused();
  const closing = await page.evaluate(() => (window as unknown as { avatarFlightSamples: Sample[] }).avatarFlightSamples.filter(sample => sample.phase === 'closing'));
  expect(closing.length).toBeGreaterThan(0);
  expect(closing.every(sample => sample.staticAvatars === 0)).toBe(true);
  expect(audit.errors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

test.describe('touch divider', () => {
  test.use({ hasTouch: true });
  test('resizes from the extended touch target without covering either pane', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Continuous touch input uses Chromium CDP');
    await page.setViewportSize({ width: 1024, height: 768 });
    const audit = await fixture(page);
    await openMember(page);
    const divider = page.getByRole('separator', { name: '调整文档与 AI 组员的宽度' });
    const bounds = (await divider.boundingBox())!;
    const before = Number(await divider.getAttribute('aria-valuenow'));
    const cdp = await page.context().newCDPSession(page);
    const y = bounds.y + bounds.height / 2;
    // Start outside the visual 8px handle, inside its 44px touch target.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + 16, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x - 90, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeLessThan(before - 5);
    expect(await page.locator('[data-document-pane]').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(400);
    expect(await page.locator('[data-ai-member-pane]').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(320);
    await closeMember(page);
    expect(audit.errors).toEqual([]);
    expect(audit.unexpected).toEqual([]);
    await cdp.detach();
  });
});

for (const width of [1440, 390]) {
  test(`AI document edits remain colored previews until the student decides in chat (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const original = '<h2>观察记录</h2><p>周一记录 3.5 升。</p><p>保留学生原有结论。</p>';
    const audit = await fixture(page, { documentHtml: original });
    const saves: string[] = [];
    page.on('request', request => {
      if (!request.url().includes('/actions') || request.method() !== 'POST') return;
      const action = request.postDataJSON()?.action;
      if (action?.type === 'UPSERT_SUBMISSION') saves.push(action.payload.submission.content);
    });
    await page.route('**/api/ai-collaboration/document', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { requestId: body.requestId, status: 'completed', conversationId: 'legacy', result: {
        kind: 'work-delivery', message: '已准备好修改，请审阅。', deliverable: {
          title: '整理观察记录', summary: '保留原始数据', content: '周一：3.5 升。补充记录日期。',
          documentActions: [
            { operation: 'replace', targetText: '周一记录 3.5 升。', content: '| 日期 | 记录 |\n| --- | --- |\n| 周一 | 3.5 升 |', description: '将已有记录整理为表格' },
            { operation: 'append', targetText: '', content: '补充记录日期。', description: '新增记录提醒' },
          ], sources: [], researchMode: 'model',
        },
      } } });
    });
    const editor = page.locator('[data-slate-editor="true"]').first();
    const member = page.getByRole('region', { name: 'AI 组员工作区', exact: true });
    const pending = page.getByRole('region', { name: '待审阅的 AI 组员交付物', exact: true });
    const send = async () => {
      if (await page.getByRole('button', { name: '唤醒 AI 组员', exact: true }).isVisible()) {
        await page.getByRole('button', { name: '唤醒 AI 组员', exact: true }).click();
      }
      await member.getByRole('textbox').fill('请把文档中的记录整理成表格，并补充记录提醒。');
      await member.getByRole('button', { name: '发送给 AI 组员', exact: true }).click();
      await expect(pending.getByRole('button', { name: '确认并应用到文档', exact: true })).toBeVisible();
      await expect(pending.getByText('修改尚未应用，请查看正文标记后决定。')).toBeVisible();
      expect(audit.course.submissions![0].content).toBe(original);
      expect(saves).toEqual([]);
    };
    await send();
    if (width < 600) await pending.getByRole('button', { name: '查看正文中的修改' }).click();
    await expect(editor.locator('.bg-red-100').first()).toBeVisible();
    await expect(editor.locator('.bg-emerald-100').first()).toBeVisible();
    await expect(editor).toContainText('周一记录 3.5 升。');
    await expect(editor).toContainText('补充记录日期。');
    await page.screenshot({ path: info.outputPath(`ai-preview-${width}.png`), fullPage: true });
    if (width < 600) await page.getByRole('button', { name: '唤醒 AI 组员', exact: true }).click();
    await pending.getByRole('button', { name: '暂不采用', exact: true }).click();
    await expect(pending).toHaveCount(0);
    await expect(editor.locator('[data-block-suggestion="true"]')).toHaveCount(0);
    expect(audit.course.submissions![0].content).toBe(original);
    expect(saves).toEqual([]);
    await send();
    await pending.getByRole('button', { name: '确认并应用到文档', exact: true }).click();
    await expect(pending).toHaveCount(0);
    await expect.poll(() => audit.course.submissions![0].content).toMatch(/<table(?:\s|>)/);
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.every(html => !html.includes('suggestionTransient') && !html.includes('周一记录 3.5 升。'))).toBe(true);
    await expect(editor).toContainText('保留学生原有结论。');
    await expect(editor.locator('[data-block-suggestion="true"]')).toHaveCount(0);
    const savedHtml = audit.course.submissions![0].content;
    await page.reload();
    await expect(editor).toContainText('补充记录日期。');
    expect(audit.course.submissions![0].content).toBe(savedHtml);
    await expect(editor.locator('table')).toHaveCount(1);
    expect(audit.errors).toEqual([]);
    expect(audit.unexpected).toEqual([]);
  });
}
