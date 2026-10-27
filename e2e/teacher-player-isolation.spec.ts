import { browserLearningEventReceipt, createBrowserActionReceipts } from '../scripts/lib/classroom-acceptance-action-receipts.mjs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { DEFAULT_STAGES, type Course } from '../src/lib/session/types';
import { applySessionAction, initialSessionState } from '../src/lib/session/actions';
import { ActionEnvelopeSchema, type ActionEnvelope } from '../src/lib/courses/contracts';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Player isolation fixtures require a local acceptance service');
}
test.use({ baseURL, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
const courseId = 'teacher-player-isolation-course';
const classroomId = 'teacher-player-isolation-classroom';
const at = '2026-10-13T00:00:00.000Z';
const titles = ['观察与记录', '比较与分析', '验证与改进'];

async function fixture(page: Page, options: { projection?: boolean; activityError?: string; rejectFullscreen?: boolean } = {}) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'isolation-teacher', displayName: '播放器验收教师' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('isolation-teacher').setIssuer('openpbl')
    .setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_teacher', value: token, url: baseURL }]);
  const scenes = titles.map((title, index) => ({
    id: `native-scene-${index + 1}`, outlineId: `outline-${index + 1}`, stageId: classroomId,
    title, type: 'slide', order: index, actions: [],
    content: { type: 'slide', canvas: {
      id: `canvas-${index + 1}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#344A6A'], fontColor: '#1F2933', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [{
        id: `text-${index + 1}`, type: 'text', left: 48, top: 80, width: 880, height: 220, rotate: 0,
        defaultFontName: 'Noto Sans SC', defaultColor: '#1F2933',
        content: `<p style="font-size:36px">原生第 ${index + 1} 页：${title}</p>`,
      }],
    } },
  }));
  const outlines = scenes.map((scene, index) => ({ id: scene.outlineId, title: scene.title, type: 'slide',
    order: index, stageKey: 'ai-learning', audience: 'student', description: scene.title, keyPoints: [], estimatedDuration: 60 }));
  let course = {
    id: courseId, version: 1, name: '三页原生课堂播放器隔离验收', status: 'teaching',
    subject: '科学', grade: '七年级', hours: 1, summary: '', drivingQuestion: '如何使用证据验证方案？',
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })), currentStageIndex: 1,
    aiLearningClassroomId: classroomId, students: [], resources: [], groups: [], activityLog: [],
    content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' },
      _openmaicSceneOutlines: outlines, sceneOutlines: outlines },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: 'paused', sessionStartedAt: at, pausedAt: at, activeStageKey: 'ai-learning', updatedAt: at,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label,
        basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 1 ? 'active' : 'pending' })),
    } }, createdAt: at, updatedAt: at,
  } as Course;
  if (options.projection) {
    course.content.knowledgePoints = [{ id: 'point-1', name: titles[0]!, description: '用观察记录支持判断' }];
    course.content._openmaicSceneOutlines![0]!.knowledgePointIds = ['point-1'];
    course.students = [{ id: 'student-1', name: '验收学生', joinedAt: at, stageProgress: {} }];
    course.aiLearningProgress = { 'student-1': {
      classroomId, studentId: 'student-1', currentSceneIndex: 1, totalScenes: 3, completedScenes: [], lastActiveAt: at, masteryLevel: 'in-progress',
      knowledgeLectureAttempts: [{ id: 'attempt-1', sectionId: 'section-1', quizOutlineId: 'quiz-1', runtimeSceneId: 'quiz-scene-1', submittedAt: at,
        score: 0, maxScore: 1, gradingSource: 'server', gradingStatus: 'graded', knowledgePointIds: ['point-1'],
        questions: [{ questionId: 'question-1', prompt: '如何验证观察结果？', answer: '凭印象判断', points: 1, earned: 0,
          gradingStatus: 'graded', correct: false, feedback: '需要记录证据', knowledgePointIds: ['point-1'] }],
      }],
    } };
  }
  if (options.rejectFullscreen) await page.addInitScript(() => {
    Element.prototype.requestFullscreen = async () => { throw new DOMException('Fixture denies fullscreen', 'NotAllowedError'); };
  });
  let activityError = options.activityError;
  const actions: ActionEnvelope[] = [];
  const receipts = createBrowserActionReceipts(courseId, at);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  let frameHeaders: Record<string, string> | undefined;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/internal/resource-player') frameHeaders = response.headers();
  });
  await page.context().routeWebSocket(/.*/, socket => {
    if (new URL(socket.url()).pathname.startsWith('/_next/')) { socket.connectToServer(); return; }
    socket.onMessage(message => {
      const body = JSON.parse(String(message));
      if (body.type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId }));
    });
  });
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(request.url()); return route.abort(); }
    if (path.startsWith('/__nextjs')) return route.continue();
    // The iframe document keeps the actual production CSP and framing headers.
    if (!path.startsWith('/api/') && ['GET', 'HEAD'].includes(method)) return route.continue();
    if (path.startsWith('/api/openmaic/interactive-runtime/') && method === 'GET') return route.continue();
    if (!['GET', 'HEAD'].includes(method)) writes.push(`${method} ${path}`);
    if (path === '/api/auth/me') return json({ user: { id: 'isolation-teacher', role: 'teacher', name: '播放器验收教师', displayName: '播放器验收教师' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '播放器验收教师' }, hydrated: true, updatedAt: at });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseId, courseVersion: course.version, projectionVersion: course.uiState?.projectionVersion ?? 0, projectionUpdatedAt: at, serverTime: at, resourceProjection: null, teacherResourceProjection: course.uiState?.teacherResourceProjection ?? null, projectionController: course.uiState?.projectionController });
    if (path === `/api/courses/${courseId}/public-discussion` || path === `/api/courses/${courseId}/public-discussion/settings`) return json({ enabled: false, session: null });
    if (options.projection && path === `/api/platform/classroom-instances/${courseId}/participants`) return json({
      instance: { id: courseId, title: course.name, offeringId: 'projection-offering', status: 'FINISHED', snapshot: {} }, participants: [],
    });
    if (options.projection && path === `/api/platform/classroom-instances/${courseId}/experiment/results`) return json({ enabled: false });
    if (path === `/api/courses/${courseId}/actions`) {
      const parsed = ActionEnvelopeSchema.safeParse(request.postDataJSON());
      if (!parsed.success) return json({ code: 'INVALID_ACTION' }, 400);
      const envelope = parsed.data as unknown as ActionEnvelope;
      actions.push(envelope);
      const previous = receipts.lookup(envelope);
      if (previous) return json(previous.body, previous.status);
      if (envelope.action.type === 'ADD_ACTIVITY' && activityError) return json({ code: 'FORBIDDEN_ACTION', message: activityError }, 403);
      course = applySessionAction({ ...initialSessionState(), courses: [course] }, envelope.action).courses[0]!;
      course.version = (course.version ?? 0) + 1;
      const projection = envelope.action.type === 'SET_UI_STATE'
        && Object.hasOwn(envelope.action.payload.patch, 'teacherResourceProjection');
      if (projection && envelope.action.type === 'SET_UI_STATE') course.uiState = { ...course.uiState,
        projectionVersion: (course.uiState?.projectionVersion ?? 0) + 1,
        projectionController: course.uiState?.teacherResourceProjection
          ? { teacherId: 'isolation-teacher', clientId: envelope.action.payload.projectionControl!.clientId } : null,
      };
      return json(receipts.remember(envelope, { courseVersion: course.version, updatedAt: at,
        ...(projection ? { projection: { courseId, courseVersion: course.version, projectionVersion: course.uiState!.projectionVersion!,
          projectionUpdatedAt: at, serverTime: at, teacherResourceProjection: course.uiState?.teacherResourceProjection ?? null, resourceProjection: null,
          projectionController: course.uiState?.projectionController,
        } } : {}),
      }));
    }
    if (path === '/api/openmaic/classroom') return json({ success: true, classroom: { stage: { id: classroomId, name: course.name, createdAt: 1, updatedAt: 1 }, scenes } });
    if (path === '/api/openmaic/progress') return json({ data: { progress: {} } });
    if (['/api/openmaic/provider-config', '/api/openmaic/server-providers', '/api/server-providers'].includes(path)) return json({
      success: true, providers: {}, tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {}, generation: {},
    });
    if (path === '/api/learning-events' && method === 'POST') {
      const receipt = browserLearningEventReceipt(request.postData(), Date.now());
      return json(receipt.body, receipt.status);
    }
    if (path === '/api/learning-events') return json({ success: true });
    unexpected.push(`${method} ${path}`);
    return json({ error: 'Unconfigured isolated fixture request' }, 404);
  });
  return { pageErrors, consoleErrors, unexpected, writes, actions, course: () => course,
    recoverActivity: () => { activityError = undefined; }, frameHeaders: () => frameHeaders };
}

for (const scenario of [
  { name: 'saved activity', fail: false, fallback: false, transitionFirst: true },
  { name: 'failed activity recovery', fail: true, fallback: false, transitionFirst: false },
  { name: 'failed activity recovery without native fullscreen', fail: true, fallback: true, transitionFirst: false },
  { name: 'failed activity stage transition recovery', fail: true, fallback: false, transitionFirst: true },
]) {
  test(`knowledge projection permits a saved classroom finish: ${scenario.name}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1366, height: 768 });
    const reason = '投屏操作记录暂时无法保存，请重试。';
    const audit = await fixture(page, { projection: true, activityError: scenario.fail ? reason : undefined, rejectFullscreen: scenario.fallback });
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    await page.getByRole('button', { name: titles[0], exact: true }).click();
    const supplement = page.getByRole('region', { name: '补讲页面调用区', exact: true });
    await expect(supplement.getByRole('combobox', { name: '自主选择知识讲授PPT页面' })).toHaveValue('outline-1');
    await expect(supplement.frameLocator('iframe').getByText('原生第 1 页：观察与记录', { exact: true })).toBeVisible({ timeout: 20_000 });
    await supplement.getByRole('button', { name: '投屏给全班', exact: true }).click();
    await expect.poll(() => audit.course().uiState?.teacherResourceProjection?.sceneId).toBe('native-scene-1');
    await expect.poll(() => audit.actions.filter(item => item.action.type === 'ADD_ACTIVITY').length).toBe(1);
    await supplement.getByRole('button', { name: '停止投屏', exact: true }).click();
    await expect.poll(() => audit.course().uiState?.teacherResourceProjection).toBeNull();
    await expect.poll(() => audit.actions.filter(item => item.action.type === 'ADD_ACTIVITY').length).toBe(2);

    await page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(!scenario.fallback);
    if (scenario.transitionFirst) {
      await page.getByRole('combobox', { name: '全屏教学阶段' }).selectOption('2');
      await page.getByRole('dialog').getByRole('button', { name: /进入“/ }).click();
      await expect(page.getByRole('progressbar', { name: '教学阶段', exact: true })).toHaveAttribute('aria-valuenow', '3');
      if (scenario.fail) {
        await expect(page.getByRole('alert').filter({ hasText: '阶段切换尚未保存' })).toBeVisible();
        await page.getByRole('button', { name: '工具', exact: true }).click();
        const tools = page.getByRole('dialog', { name: '课堂工具', exact: true });
        await expect(tools.getByRole('button', { name: '结束课堂', exact: true })).toBeDisabled();
        await tools.getByRole('button', { name: '关闭', exact: true }).click();
        // The stage command can be acknowledged while an earlier independent
        // activity save is still pending; the guard waits for the whole flush.
        expect(audit.course().currentStageIndex).toBe(2);
        expect(audit.actions.some(item => item.action.type === 'END_TEACHING')).toBe(false);
        await page.screenshot({ path: info.outputPath('stage-save-error.png') });
        audit.recoverActivity();
        await page.getByRole('button', { name: '重试阶段切换', exact: true }).click();
        expect(audit.course().currentStageIndex).toBe(2);
      }
    }
    if (scenario.fail && !scenario.transitionFirst) await expect(page.locator('[data-slot="save-status"]').filter({ visible: true })).toContainText('保存失败');
    await expect(page.locator('footer[aria-label="课堂操作栏"]').getByRole('button', { name: '结束课堂', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '工具', exact: true }).click();
    const tools = page.getByRole('dialog', { name: '课堂工具', exact: true });
    await expect(tools.getByRole('button', { name: '结束课堂', exact: true })).toBeEnabled();
    await tools.getByRole('button', { name: '结束课堂', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeInViewport({ ratio: 1 });
    if (scenario.fail && !scenario.transitionFirst) {
      await dialog.getByRole('button', { name: '结束课堂', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText(reason);
      await expect(dialog.getByRole('alert')).toContainText('可再次点击“结束课堂”重试');
      expect(audit.actions.some(item => item.action.type === 'END_TEACHING')).toBe(false);
      expect(audit.course().status).toBe('teaching');
      await page.screenshot({ path: info.outputPath('finish-save-error.png') });
      audit.recoverActivity();
    }
    await dialog.getByRole('button', { name: '结束课堂', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/teacher/classrooms/${courseId}$`));
    expect(audit.course().status).toBe('finished');
    expect(audit.actions.filter(item => item.action.type === 'END_TEACHING')).toHaveLength(1);
    const activities = audit.actions.filter(item => item.action.type === 'ADD_ACTIVITY');
    if (scenario.fail) {
      const identities = activities.map(({ requestId, action }) => ({ requestId, action }));
      expect(identities).toHaveLength(scenario.transitionFirst ? 4 : 6);
      for (let offset = 2; offset < identities.length; offset += 2) {
        expect(identities.slice(offset, offset + 2)).toEqual(identities.slice(0, 2));
      }
      expect(audit.course().activityLog).toHaveLength(2);
    }
    expect(audit.unexpected).toEqual([]);
    expect(audit.pageErrors).toEqual([]);
  });
}

async function retainedMainLesson(preview: Locator) {
  await expect(preview).toHaveAttribute('data-active-scene-id', 'native-scene-2');
  const openDirectory = preview.getByRole('button', { name: '展开页面目录', exact: true, includeHidden: true });
  const wasCollapsed = await openDirectory.count() > 0;
  if (wasCollapsed && !await preview.isVisible()) {
    // A hidden preview retains its selected scene; a collapsed directory has
    // no thumbnail subtree until the teacher opens it again.
    await expect(preview.getByTestId('scene-item')).toHaveCount(0);
    return;
  }
  if (wasCollapsed) await openDirectory.click();
  await expect(preview.getByTestId('scene-item')).toHaveCount(3);
  await expect(preview.getByTestId('scene-title')).toHaveText(titles);
  await expect(preview).toHaveAttribute('data-active-scene-id', 'native-scene-2');
  if (wasCollapsed) {
    await preview.getByRole('button', { name: '收起页面目录', exact: true }).click();
    const directory = preview.locator('[data-course-directory]');
    await expect(directory).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => directory.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  }
}

async function pressSpaceOutsidePlayer(page: Page) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press('Space');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1366, height: 768 }]) {
  test(`supplementary slide cannot replace the three-page teacher preview at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const audit = await fixture(page);
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    const toggle = page.getByRole('button', { name: /学生知识讲授课程预览/ });
    await toggle.click();
    const preview = page.locator('[data-stage-host-mode="teacher-preview"]');
    await expect(preview).toHaveCount(1);
    const openDirectory = preview.getByRole('button', { name: '展开页面目录', exact: true });
    if (await openDirectory.isVisible()) await openDirectory.click();
    await expect(preview.getByTestId('scene-item')).toHaveCount(3);
    await preview.getByTestId('scene-item').filter({ hasText: titles[1] }).click();
    await retainedMainLesson(preview);
    const playerIdentity = await preview.elementHandle();

    await page.getByRole('combobox', { name: '自主选择知识讲授PPT页面' }).selectOption('outline-3');
    const supplement = page.frameLocator('iframe[title="授课资源播放器"]');
    await expect(supplement.getByText('原生第 3 页：验证与改进', { exact: true })).toBeVisible();
    await expect.poll(() => audit.frameHeaders()?.['x-frame-options']).toBe('SAMEORIGIN');
    expect(audit.frameHeaders()?.['content-security-policy']).toContain("frame-ancestors 'self'");
    await retainedMainLesson(preview);
    const screenshot = info.outputPath('supplementary-native-slide.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach('supplementary-native-slide', { path: screenshot, contentType: 'image/png' });

    await toggle.click();
    await expect(preview).toBeHidden();
    await pressSpaceOutsidePlayer(page);
    await retainedMainLesson(preview);
    await expect(preview.locator('button[aria-label="暂停讲解"]')).toHaveCount(0);
    await toggle.click();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);

    await page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '授课展示', exact: true }).click();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);
    const footer = page.getByRole('contentinfo', { name: '全屏课堂操作栏' });
    for (const name of ['AI 公开讨论', '教学建议', '课程目录', '收起课程目录']) {
      await expect(footer.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^(收起)?课程目录$/ })).toHaveCount(0);
    await preview.getByRole('button', { name: '展开页面目录', exact: true }).click();
    await expect(preview.getByTestId('scene-list')).toBeVisible();
    await retainedMainLesson(preview);

    await page.getByRole('button', { name: '班级学情', exact: true }).click();
    await expect(preview).toBeHidden();
    await pressSpaceOutsidePlayer(page);
    await retainedMainLesson(preview);
    await expect(preview.locator('button[aria-label="暂停讲解"]')).toHaveCount(0);
    await page.getByRole('button', { name: '授课展示', exact: true }).click();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);
    await page.getByRole('button', { name: '工具', exact: true }).click();
    const tools = page.getByRole('dialog', { name: '课堂工具', exact: true });
    await expect(tools.getByRole('button', { name: '教学建议', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('knowledge-teaching-tools.png') });
    await tools.getByRole('button', { name: 'AI 公开讨论', exact: true }).click();
    await expect(tools).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'AI 公开讨论工作台', exact: true })).toBeVisible();
    await expect(preview).toBeHidden();
    await pressSpaceOutsidePlayer(page);
    await retainedMainLesson(preview);
    await expect(preview.locator('button[aria-label="暂停讲解"]')).toHaveCount(0);
    await page.getByRole('button', { name: '授课展示', exact: true }).click();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);
    await page.getByRole('button', { name: '退出全屏', exact: true }).click();
    await expect(toggle).toBeVisible();
    await retainedMainLesson(preview);
    for (const size of [{ width: 1366, height: 768 }, { width: 768, height: 576 }, { width: 1024, height: 576 }, { width: 1920, height: 1080 }, viewport]) {
      await page.setViewportSize(size);
      await retainedMainLesson(preview);
      expect(await preview.evaluate((element, original) => element === original, playerIdentity)).toBe(true);
      for (const name of ['继续讲解', '下一页']) {
        const control = preview.getByRole('button', { name, exact: true });
        await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
        try { await expect(control, `${name} at ${size.width}x${size.height}`).toBeInViewport({ ratio: 1 }); }
        catch (error) {
          const geometry = await control.evaluate(element => ({ viewport: { width: innerWidth, height: innerHeight, scrollY },
            ancestors: (() => { const result = []; let current: Element | null = element;
              while (current) { const style = getComputedStyle(current); result.push({ tag: current.tagName, class: current.className,
                rect: current.getBoundingClientRect().toJSON(), overflow: style.overflow, overflowX: style.overflowX,
                overflowY: style.overflowY, position: style.position, scrollTop: current.scrollTop, scrollHeight: current.scrollHeight }); current = current.parentElement; }
              return result;
            })(),
          }));
          await info.attach(`teacher-preview-control-${size.width}x${size.height}`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
          throw error;
        }
        await control.click({ trial: true });
        const bounds = await control.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height + 1);
      }
      await page.screenshot({ path: info.outputPath(`teacher-preview-resize-${size.width}x${size.height}.png`) });
    }
    expect(await preview.evaluate((element, original) => element === original, playerIdentity)).toBe(true);
    await playerIdentity?.dispose();

    expect(audit.unexpected).toEqual([]);
    expect(audit.pageErrors).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.writes.some(write => write.includes('/api/openmaic/progress') || write.includes('/api/learning-events'))).toBe(false);
  });
}
