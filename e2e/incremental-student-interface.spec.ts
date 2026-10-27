import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { PDFDocument, rgb } from 'pdf-lib';
import { nativeLearningFixture } from './fixtures/native-learning';
import { captureDesktopScreenshot, desktopAcceptanceProfiles, withDesktopProfile } from './fixtures/desktop-coverage';
import { createBrowserActionReceipts } from '../scripts/lib/classroom-acceptance-action-receipts.mjs';
import { deployedLayoutBuild } from '../scripts/lib/layout-browser.mjs';
import { applySessionAction, initialSessionState } from '../src/lib/session/actions';
import { ActionEnvelopeSchema, type ActionEnvelope } from '../src/lib/courses/contracts';
import { projectionSnapshotFromUiState } from '../src/lib/realtime/projection-state';
import type { Course, ProjectionMode } from '../src/lib/session/types';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Incremental fixtures require a local build');
test.use({ baseURL, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
const at = '2026-10-20T00:00:00.000Z';
const classroomId = 'native-learning-classroom';
const resourceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const title = '观察事实与判断依据：保留中文长标题并核验教师同步状态';
const sourcePaths = [
  'src/app/student/classroom/[id]/page.tsx', 'src/components/classroom/student-projection-surface.tsx',
  'src/components/classroom/simple-stage-resources.tsx', 'src/components/openmaic-bridge/teacher-stage-resources.tsx',
  'src/components/ui/fixed-toolbar-buttons.tsx', 'src/components/editor/plugins/discussion-kit.tsx',
  'src/components/views/student/ai-member-workspace.tsx', 'src/components/views/student/document-ai-collaboration.tsx',
  'src/components/views/student/collaboration-responsive.module.css', 'public/openmaic/avatars/ai-teammate.webp',
  'src/components/openmaic/canvas/canvas-area.tsx', 'src/components/openmaic/stage/scene-renderer.tsx',
  'src/components/openmaic/slide-renderer/Editor/index.tsx', 'src/components/openmaic/slide-renderer/Editor/ScreenCanvas.tsx',
  'src/components/openmaic/slide-renderer/Editor/Canvas/hooks/useViewportSize.ts', 'src/components/openmaic/stage-experience.ts',
  'e2e/incremental-student-interface.spec.ts', 'e2e/fixtures/native-learning.ts', 'e2e/fixtures/desktop-coverage.ts',
];
const scenarios = ['projection', 'pdf', 'document'];
const selected = process.env.OPENPBL_INCREMENTAL_INTERFACE_STATES === '1' || process.env.OPENPBL_INCREMENTAL_INTERFACE_FOCUS === '1' ? []
  : process.env.OPENPBL_INCREMENTAL_INTERFACE_SCENARIOS?.split(',') ?? scenarios;
if (selected.some(id => !scenarios.includes(id))) throw new Error(`Unknown incremental interface scenario: ${selected.join(',')}`);

async function capture(page: Page, info: TestInfo, label: string) {
  const path = info.outputPath(`${label}.png`);
  await captureDesktopScreenshot(page, path);
  await info.attach(label, { path, contentType: 'image/png' });
}

async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  await control.click({ trial: true });
}

/** Reuse the existing native fixture; only changed interfaces need extra state. */
async function fixture(page: Page, kind: string) {
  const baseline = nativeLearningFixture();
  baseline.setMode('document');
  baseline.recoverSave();
  const initial = baseline.response('/api/courses', 'GET', {})!.body as { courses: Course[] };
  let course = initial.courses[0]!;
  const studentId = course.students[0]!.id, role = 'student';
  const actorId = studentId;
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const token = await new SignJWT({ role, sv: 1, userId: actorId, studentName: '增量界面验收', displayName: '增量界面验收' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(actorId).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  const scenes = ['观察事实', '说明依据', '个人学习保留页'].map((name, index) => ({
    id: `incremental-slide-${index + 1}`, stageId: classroomId, outlineId: `incremental-outline-${index + 1}`,
    title: name, type: 'slide', order: index, actions: [], stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching',
    content: { type: 'slide', canvas: { id: `incremental-canvas-${index}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#344a6a'], fontColor: '#1f2933', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [{ id: `incremental-text-${index + 1}`, type: 'text',
        left: 60, top: 80, width: 880, height: 220, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#1f2933',
        content: `<p style="font-size:40px">第 ${index + 1} 页：${name}</p>` }] } },
  }));
  const outlines = scenes.map(scene => ({ id: scene.outlineId, title: scene.title, type: 'slide' as const, order: scene.order,
    stageKey: 'ai-learning', audience: 'student' as const, generationPurpose: 'knowledge-teaching' as const, description: scene.title,
    keyPoints: [], estimatedDuration: 60, knowledgePointIds: ['native-point'] }));
  course.content._openmaicSceneOutlines = outlines;
  course.content.sceneOutlines = outlines;
  course.currentStageIndex = kind === 'document' ? 2 : kind === 'pdf' ? 0 : 1;
  course.aiLearningProgress![studentId] = { classroomId, studentId, currentSceneIndex: 2, totalScenes: 3,
    completedScenes: [], completionModelVersion: 2, lastActiveAt: at, masteryLevel: 'in-progress' };
  if (kind === 'document') course.submissions = [{ id: 'incremental-draft', courseId: course.id, studentId,
    stageKey: 'make', type: 'document', title: '观察记录', content: '<p>初始观察记录。</p>', status: 'draft', version: 1, createdAt: at, updatedAt: at }];
  course.resources = kind === 'pdf' ? [{ id: resourceId, stageKey: 'launch', title, type: 'PDF', size: '2 KB',
    url: `/api/uploads/${resourceId}`, displayMode: 'slides', downloadedBy: [] }] : [];
  const projection = (mode: ProjectionMode, number = 1) => ({ classroomId, sceneId: `incremental-slide-${number}`,
    stageKey: 'ai-learning', title, sceneType: 'slide' as const, startedAt: at, mode, version: number,
    engineMode: 'idle' as const, playback: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: `incremental-slide-${number}` } });
  course.uiState = { ...course.uiState, projectionVersion: 1, projectionUpdatedAt: at,
    teacherResourceProjection: kind === 'projection' ? projection('forced') : null,
    resourceProjection: kind === 'pdf' ? { resourceId, stageKey: 'launch', title, startedAt: at,
      viewState: { page: 1, scrollRatio: 0, revision: 1, updatedAt: at } } : null };
  const pdf = await PDFDocument.create();
  for (const number of [1, 2]) {
    const sheet = pdf.addPage([960, 540]);
    sheet.drawRectangle({ x: 24, y: 24, width: 912, height: 492, borderWidth: 2, borderColor: rgb(0.2, 0.3, 0.45) });
    sheet.drawText(`OBSERVE FACTS / PAGE ${number}`, { x: 60, y: 390, size: 34, color: rgb(0.2, 0.3, 0.45) });
  }
  const pdfBytes = Buffer.from(await pdf.save()), sockets = new Set<(value: string) => void>();
  const unexpected: string[] = [], errors: string[] = [], progressWrites: string[] = [], aiRequests: Record<string, unknown>[] = [];
  const actions: ActionEnvelope[] = [], receipts = createBrowserActionReceipts(course.id, at);
  let frames = 0, historyReleased = kind !== 'document', releaseHistory = () => {}, releaseAi = () => {};
  const historyGate = new Promise<void>(resolve => { releaseHistory = () => { historyReleased = true; resolve(); }; });
  const aiGate = new Promise<void>(resolve => { releaseAi = resolve; });
  const snapshot = () => projectionSnapshotFromUiState({ courseId: course.id, courseVersion: course.version ?? 1, uiState: course.uiState });
  const emit = () => { course.version = (course.version ?? 0) + 1; course.uiState!.projectionVersion!++;
    sockets.forEach(send => send(JSON.stringify({ type: 'course-event', courseId: course.id,
      event: { type: 'projection-changed', payload: snapshot() } }))); };
  page.on('pageerror', error => errors.push(error.message));
  await page.context().routeWebSocket(/.*/, socket => {
    const send = (value: string) => socket.send(value); sockets.add(send); socket.onClose(() => sockets.delete(send));
    socket.onMessage(value => { if (JSON.parse(String(value)).type === 'subscribe') send(JSON.stringify({ type: 'subscribed', courseId: course.id })); });
  });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const body = method === 'GET' || method === 'HEAD' ? {} : request.postDataJSON() ?? {};
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(request.url()); return route.abort(); }
    if (!path.startsWith('/api/') && ['GET', 'HEAD'].includes(method)) {
      if (path === '/internal/resource-player' && request.isNavigationRequest()) frames++;
      return route.continue();
    }
    if (path.startsWith('/api/openmaic/interactive-runtime/') && method === 'GET') return route.continue();
    if (path === `/api/uploads/${resourceId}`) return route.fulfill({ contentType: 'application/pdf', body: pdfBytes });
    if (path === '/api/auth/me' || path === '/api/platform/auth/student-profile') return json({ user: { id: actorId, role, displayName: '增量界面验收' } });
    if (path === '/api/courses') return json({ courses: [course], hydrated: true, user: { role, name: '增量界面验收' }, studentId, studentName: '增量界面验收', joinedCourseId: course.id });
    if (path === `/api/courses/${course.id}/state`) return json({ course, eventCursor: '0' });
    if (path === `/api/courses/${course.id}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${course.id}/lecture-chat` && method === 'GET') {
      const sceneId = url.searchParams.get('sceneId') ?? 'incremental-slide-3';
      return json({ thread: { id: `thread-${sceneId}`, page: { classroomId, sceneId },
        pageTitle: scenes.find(scene => scene.id === sceneId)?.title ?? title, messages: [] }, requests: [], writable: true });
    }
    if (path === `/api/courses/${course.id}/projection`) return json(snapshot());
    if (path === `/api/courses/${course.id}/actions`) {
      const envelope = ActionEnvelopeSchema.parse(body) as unknown as ActionEnvelope;
      actions.push(envelope); const previous = receipts.lookup(envelope); if (previous) return json(previous.body, previous.status);
      let submissionVersion: number | undefined;
      if (envelope.action.type === 'UPSERT_SUBMISSION') {
        const payload = envelope.action.payload;
        const prior = course.submissions?.find(row => row.id === payload.submission.id);
        if ((prior?.version ?? 0) !== payload.expectedSubmissionVersion) return json({ code: 'DRAFT_VERSION_CONFLICT', message: '夹具版本冲突' }, 409);
        submissionVersion = (prior?.version ?? 0) + 1;
        payload.submission = { ...payload.submission, version: submissionVersion };
      }
      course = applySessionAction({ ...initialSessionState(), courses: [course] }, envelope.action).courses[0]!;
      course.version = (course.version ?? 0) + 1;
      return json(receipts.remember(envelope, { courseVersion: course.version, updatedAt: at,
        ...(submissionVersion === undefined ? {} : { submissionVersion }) }));
    }
    if (path === '/api/openmaic/classroom') return json({ success: true, classroom: { stage: { id: classroomId, name: title, createdAt: 1, updatedAt: 1 }, scenes } });
    if (path === '/api/openmaic/progress') {
      if (method === 'POST') progressWrites.push(path);
      return json({ success: true, data: { progress: { [studentId]: course.aiLearningProgress![studentId] } } });
    }
    if (path === '/api/learning-events' && method === 'POST') progressWrites.push(path);
    if (path === '/api/ai-collaboration/document') {
      const statusId = url.searchParams.get('requestId');
      // Retries first consult the existing receipt before replaying the POST.
      if (method === 'GET' && statusId) return json(aiRequests.some(row => row.requestId === statusId)
        ? { requestId: statusId, status: 'failed', retryable: true, error: 'AI_RATE_LIMITED' }
        : { error: 'REQUEST_NOT_FOUND' }, aiRequests.some(row => row.requestId === statusId) ? 200 : 404);
      if (method === 'GET' && !historyReleased) await historyGate;
      if (method === 'POST' && body.message) {
        aiRequests.push(body);
        if (aiRequests.length === 1) return json({ requestId: body.requestId, status: 'failed', error: 'AI_RATE_LIMITED', message: 'AI 服务繁忙，请重试', retryable: true }, 429);
        await aiGate;
        return json({ requestId: body.requestId, status: 'completed', conversationId: 'incremental-conversation', result: {
          kind: 'edit-suggestion', message: `请核验来源后再决定是否采用修改。${'保留原始计数、说明观察条件并核验材料归属。'.repeat(24)}`,
          suggestion: { title: '旧稿建议', reason: '核验依据', operation: 'replace', targetText: '初始观察记录。', replacement: '禁止覆盖最新稿' } } });
      }
      return json({ conversationId: 'incremental-conversation', messages: [], commentThreads: [], requests: [], starters: [], proactiveReviewEnabled: false });
    }
    const response = baseline.response(path, method, body);
    if (response) return json(response.body, response.status);
    unexpected.push(`${method} ${path}`); return json({ error: 'Unconfigured incremental interface fixture' }, 404);
  });
  return { id: course.id, errors, unexpected, progressWrites, actions, aiRequests, frames: () => frames, course: () => course,
    releaseHistory, releaseAi, project(mode: ProjectionMode | null, number = 1) { course.uiState!.teacherResourceProjection = mode ? projection(mode, number) : null; emit(); },
    resourcePage(number: number) { course.uiState!.resourceProjection!.viewState = { page: number, scrollRatio: 0, revision: number, updatedAt: new Date().toISOString() }; emit(); } };
}

// Error/loading behavior needs two representative layouts, not another full matrix.
if (process.env.OPENPBL_INCREMENTAL_INTERFACE_STATES === '1') {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    const profile = { viewport, zoom: 1, dpr: 1, nativeZoom: false, name: 'projection states',
      ...(viewport.width < 1024 ? { hasTouch: true, isMobile: true } : {}) };
    test(`incremental projection loading empty error recovery ${viewport.width}x${viewport.height}`, async ({ browser }, info) => {
      test.setTimeout(90_000);
      const build = await deployedLayoutBuild(baseURL);
      if (process.env.OPENPBL_EXPECTED_BUILD_ID) expect(build).toBe(process.env.OPENPBL_EXPECTED_BUILD_ID);
      await withDesktopProfile(profile, browser, info, async ({ page }) => {
        const audit = await fixture(page, 'projection');
        let releaseDocument = () => {}, mode = 'empty';
        const gate = new Promise<void>(resolve => { releaseDocument = resolve; });
        const injected: Array<{ mode: string; status: number }> = [];
        await page.route('**/internal/resource-player**', async route => { await gate; await route.continue(); });
        await page.route('**/api/openmaic/classroom**', async route => {
          if (mode === 'ready') return route.fallback();
          const status = mode === 'empty' ? 200 : 503; injected.push({ mode, status });
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(mode === 'empty'
            ? { success: true, classroom: { stage: { id: classroomId, name: title }, scenes: [] } }
            : { error: 'Injected scoped resource load failure' }) });
        });
        await page.goto(`/student/classroom/${audit.id}`);
        const dialog = await surface(page);
        await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
        await expect(dialog.getByText('正在加载授课资源…', { exact: true })).toBeVisible();
        await capture(page, info, 'projection-document-loading'); releaseDocument();
        const frame = dialog.frameLocator('iframe');
        await expect(frame.getByRole('paragraph').filter({ hasText: /^所选授课资源场景不存在，请重新生成课程资源$/ })).toBeVisible({ timeout: 30_000 });
        await capture(page, info, 'projection-empty-resource');
        mode = 'error'; await frame.getByRole('button', { name: '重试', exact: true }).click();
        await expect(frame.getByRole('paragraph').filter({ hasText: /^授课资源加载失败（HTTP 503）$/ })).toBeVisible();
        await capture(page, info, 'projection-resource-error');
        mode = 'ready'; await frame.getByRole('button', { name: '重试', exact: true }).click();
        await slide(dialog, 1); await capture(page, info, 'projection-resource-recovered');
        await info.attach('projection-state-injections', { body: JSON.stringify({ build, injected,
          evidence: 'Only iframe resource metadata is injected; iframe document and rendered slide use production assets',
          hashes: Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) }), contentType: 'application/json' });
        expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]); expect(audit.progressWrites).toEqual([]);
      }, baseURL);
      expect(await deployedLayoutBuild(baseURL)).toBe(build);
    });
    test(`incremental PDF projection loading error recovery focus ${viewport.width}x${viewport.height}`, async ({ browser }, info) => {
      test.setTimeout(60_000);
      const build = await deployedLayoutBuild(baseURL);
      if (process.env.OPENPBL_EXPECTED_BUILD_ID) expect(build).toBe(process.env.OPENPBL_EXPECTED_BUILD_ID);
      await withDesktopProfile(profile, browser, info, async ({ page }) => {
        const audit = await fixture(page, 'pdf');
        let releaseBytes = () => {}, failing = true;
        const gate = new Promise<void>(resolve => { releaseBytes = resolve; });
        await page.route(`**/api/uploads/${resourceId}**`, async route => {
          if (!failing) return route.fallback();
          await gate; return route.fulfill({ status: 503, body: 'Injected PDF transport failure' });
        });
        await page.goto(`/student/classroom/${audit.id}`); const dialog = await surface(page);
        await expect(dialog.getByText('正在解析 PDF…', { exact: true })).toBeVisible();
        await capture(page, info, 'pdf-projection-loading'); releaseBytes();
        await expect(dialog.getByText('PDF 读取失败（503）', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('link', { name: '下载文件', exact: true })).toHaveAttribute('href', `/api/uploads/${resourceId}?download=1`);
        await capture(page, info, 'pdf-projection-load-error');
        failing = false; await page.reload(); await surface(page); await pdfPage(dialog, 1);
        audit.resourcePage(2); await pdfPage(dialog, 2);
        const tabs = [];
        for (let index = 0; index < 4; index++) { await page.keyboard.press('Tab'); tabs.push(await dialog.evaluate(element => element.contains(document.activeElement))); }
        await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
        expect(tabs).toEqual([true, true, true, true]);
        await capture(page, info, 'pdf-projection-recovered');
        await info.attach('pdf-projection-state-injection', { contentType: 'application/json', body: JSON.stringify({ build,
          injectedHttpStatus: 503, tabs, recoveredActualPdfPages: [1, 2],
          hashes: Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) }) });
        expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]); expect(audit.progressWrites).toEqual([]);
      }, baseURL);
      expect(await deployedLayoutBuild(baseURL)).toBe(build);
    });
  }
}

async function surface(page: Page) {
  const dialog = page.getByRole('dialog', { name: `教师投屏：${title}`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('教师投屏', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText('同步中', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect.poll(() => dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return Math.max(Math.abs(rect.x), Math.abs(rect.y), Math.abs(rect.width - innerWidth), Math.abs(rect.height - innerHeight));
  })).toBeLessThanOrEqual(1);
  return dialog;
}

async function slide(dialog: Locator, number: number) {
  const node = dialog.frameLocator('iframe').locator(`[data-slide-element-id="incremental-text-${number}"]`);
  // ScreenElement is a zero-size paint wrapper around positioned children.
  await expect(node.locator('p').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => node.evaluate(element => {
    const rect = element.parentElement?.parentElement?.getBoundingClientRect();
    return !!rect && rect.width > 1 && rect.height > 1 && Math.abs(rect.width / rect.height - 16 / 9) < 0.03
      && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  })).toBe(true);
  if (process.env.OPENPBL_EXPECT_PROJECTED_CANVAS_FIT === '1') {
    await expect(dialog.frameLocator('iframe').locator('[data-projected-canvas="true"]')).toBeVisible();
    await expect.poll(() => node.evaluate(element => {
      const canvas = element.parentElement?.parentElement?.getBoundingClientRect();
      const container = element.parentElement?.parentElement?.parentElement?.getBoundingClientRect();
      return canvas && container ? canvas.width / Math.min(container.width, container.height * 16 / 9) : 0;
    })).toBeGreaterThanOrEqual(0.95);
  }
}

async function pdfPage(dialog: Locator, number: number) {
  // A PDF in slides mode uses the PPT canvas, not the continuous reader.
  const canvas = dialog.locator(`canvas[aria-label="PPT 第 ${number} 页"]`);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let ink = 0; for (let i = 0; i < pixels.length; i += 64) if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) ink++;
    return ink;
  })).toBeGreaterThan(10);
}

if (process.env.OPENPBL_INCREMENTAL_INTERFACE_FOCUS === '1') {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    const profile = { viewport, zoom: 1, dpr: 1, nativeZoom: false, name: 'projection keyboard focus',
      ...(viewport.width < 1024 ? { hasTouch: true, isMobile: true } : {}) };
    test(`incremental optional projection keyboard focus ${viewport.width}x${viewport.height}`, async ({ browser }, info) => {
      test.setTimeout(60_000);
      const build = await deployedLayoutBuild(baseURL);
      if (process.env.OPENPBL_EXPECTED_BUILD_ID) expect(build).toBe(process.env.OPENPBL_EXPECTED_BUILD_ID);
      await withDesktopProfile(profile, browser, info, async ({ page }) => {
        const audit = await fixture(page, 'projection'); audit.project('optional');
        await page.goto(`/student/classroom/${audit.id}`);
        const trigger = page.getByRole('button', { name: '查看投屏', exact: true });
        await trigger.focus(); await page.keyboard.press('Enter');
        const dialog = await surface(page); await slide(dialog, 1);
        const active = () => dialog.evaluate(element => ({ insideDialog: element.contains(document.activeElement),
          tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'),
          text: document.activeElement?.textContent?.trim().slice(0, 100) }));
        const opened = await active(), tabs = [];
        for (let index = 0; index < 10; index++) { await page.keyboard.press('Tab'); tabs.push(await active()); }
        await capture(page, info, 'optional-projection-tab-focus');
        await dialog.getByRole('button', { name: '收起投屏', exact: true }).focus(); await page.keyboard.press('Enter');
        await expect(dialog).toHaveCount(0); await expect(trigger).toBeVisible();
        await expect.soft(trigger, 'Collapsing optional projection returns focus to its trigger').toBeFocused();
        const returned = await trigger.evaluate(element => document.activeElement === element);
        await info.attach('optional-projection-focus', { contentType: 'application/json', body: JSON.stringify({ build,
          surfaceSha256: createHash('sha256').update(readFileSync('src/components/classroom/student-projection-surface.tsx')).digest('hex'),
          opened, tabs, returned, evidence: 'Actual keyboard Tab/Enter over the production surface; business API fixtures' }, null, 2) });
        expect.soft(opened.insideDialog, 'Opening a modal projection moves focus inside it').toBe(true);
        expect.soft(tabs.filter(row => !row.insideDialog), 'Tab remains inside the modal projection').toEqual([]);
      }, baseURL);
      expect(await deployedLayoutBuild(baseURL)).toBe(build);
    });
  }
}

for (const profile of desktopAcceptanceProfiles([{ width: 1366, height: 768 }])) {
  for (const scenario of selected) {
    test(`incremental ${scenario} interface ${profile.viewport.width}x${profile.viewport.height} ${profile.name}`, async ({ browser }, info) => {
      test.setTimeout(120_000);
      const build = await deployedLayoutBuild(baseURL);
      if (process.env.OPENPBL_EXPECTED_BUILD_ID) expect(build).toBe(process.env.OPENPBL_EXPECTED_BUILD_ID);
      await info.attach('incremental-source-scope', { contentType: 'application/json', body: JSON.stringify({ build,
        evidence: 'Browser-only business API/socket fixtures; actual compiled page, iframe, images, PDF module and worker',
        owner: 'New tests only; parallel chat product modifications are preserved', scenario,
        hashes: Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) }, null, 2) });
      await withDesktopProfile(profile, browser, info, async ({ page }) => {
        const audit = await fixture(page, scenario);
        if (scenario === 'projection') {
          await page.goto(`/student/classroom/${audit.id}`);
          const dialog = await surface(page), iframe = dialog.locator('iframe'), identity = await iframe.elementHandle();
          await slide(dialog, 1); const documents = audit.frames();
          expect(audit.progressWrites).toEqual([]);
          await expect(dialog.getByRole('button', { name: '收起投屏' })).toHaveCount(0);
          audit.project('forced', 2); await slide(dialog, 2);
          expect(await iframe.evaluate((node, previous) => node === previous, identity)).toBe(true);
          expect(audit.frames()).toBe(documents); expect(audit.progressWrites).toEqual([]);
          await capture(page, info, 'forced-native-projection');
          audit.project(null);
          const personal = page.locator('[data-stage-host-mode="student"]');
          await expect(personal).toHaveAttribute('data-active-scene-id', 'incremental-slide-3', { timeout: 30_000 });
          audit.project('optional'); await expect(page.getByRole('button', { name: '查看投屏', exact: true })).toBeVisible();
          await page.getByRole('button', { name: '查看投屏', exact: true }).click(); await surface(page); await slide(dialog, 1);
          const optionalDocuments = audit.frames(); audit.project('optional', 2); await slide(dialog, 2);
          expect(audit.frames()).toBe(optionalDocuments);
          const close = dialog.getByRole('button', { name: '收起投屏', exact: true }); await reachable(close); await close.click();
          await expect(dialog).toHaveCount(0); await expect(personal).toHaveAttribute('data-active-scene-id', 'incremental-slide-3', { timeout: 30_000 });
          expect(audit.course().uiState?.teacherResourceProjection?.mode).toBe('optional');
          expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
        } else if (scenario === 'pdf') {
          await page.goto(`/student/classroom/${audit.id}`); const dialog = await surface(page);
          for (const number of [1, 2]) {
            if (number === 2) audit.resourcePage(number);
            await pdfPage(dialog, number);
            await capture(page, info, `uploaded-pdf-projection-${number}`);
          }
          expect(audit.progressWrites).toEqual([]);
        } else {
          await page.goto(`/student/ai-collaboration/${audit.id}`);
          const entry = page.getByRole('button', { name: 'AI 组员', exact: true }); await reachable(entry);
          expect(await entry.evaluate(element => element.closest('[data-toolbar-overflow-group]')?.getAttribute('data-toolbar-overflow-group'))).toBe('ai-member');
          await entry.click(); const panel = page.getByRole('region', { name: 'AI 组员工作区', exact: true });
          await expect(panel.getByText('加载协作记录…', { exact: true })).toBeVisible(); audit.releaseHistory();
          await expect(panel.getByText('从正在形成的想法开始协作', { exact: true })).toBeVisible();
          await expect.poll(() => panel.getByRole('img', { name: 'AI 组员头像' }).evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
          await expect.poll(() => panel.evaluate(element => { const r = element.getBoundingClientRect(); return Math.max(-r.x, -r.y, r.right - innerWidth, r.bottom - innerHeight); })).toBeLessThanOrEqual(1);
          const composer = panel.getByRole('textbox'), send = panel.getByRole('button', { name: '发送给 AI 组员', exact: true });
          await composer.fill('请核验初始观察记录的依据。');
          await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true }); expect(audit.aiRequests).toEqual([]);
          await reachable(send); await send.click(); await expect(panel.getByRole('alert')).toContainText('AI 服务繁忙，请重试');
          const retry = panel.getByRole('button', { name: '重新尝试', exact: true }); await reachable(retry); await retry.click();
          await expect.poll(() => audit.aiRequests.length).toBe(2); expect(audit.aiRequests[1]!.requestId).toBe(audit.aiRequests[0]!.requestId);
          await expect(panel.getByRole('status', { name: 'AI 组员正在处理' })).toBeVisible();
          await capture(page, info, 'document-ai-loading');
          await panel.getByRole('button', { name: '收起 AI 组员', exact: true }).click();
          const editor = page.locator('[data-slate-editor="true"]').first(), latest = `AI 等待期间新增的独立观察证据。${'记录日期、地点、时长和原始计数。'.repeat(28)}`;
          await editor.fill(latest); await entry.click(); audit.releaseAi();
          await expect(panel.getByText(/这次结果仅供参考/)).toBeVisible({ timeout: 20_000 });
          await expect(editor).toContainText('AI 等待期间新增的独立观察证据。');
          await expect(panel.getByRole('region', { name: '待确认的 AI 修改' })).toHaveCount(0);
          await reachable(panel.getByRole('button', { name: '收起 AI 组员', exact: true }));
          await capture(page, info, 'document-ai-long-result');
          await panel.getByRole('button', { name: '收起 AI 组员', exact: true }).click();
          await reachable(page.getByRole('button', { name: '保存', exact: true }));
        }
        expect(audit.actions.filter(envelope => envelope.action.type === 'SET_UI_STATE')).toEqual([]);
        expect(audit.errors).toEqual([]); expect(audit.unexpected).toEqual([]);
      }, baseURL);
      expect(await deployedLayoutBuild(baseURL)).toBe(build);
    });
  }
}
