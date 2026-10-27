import { browserLearningEventReceipt, createBrowserActionReceipts } from '../scripts/lib/classroom-acceptance-action-receipts.mjs';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { SignJWT } from 'jose';
import { DEFAULT_STAGES, type ClassroomSubmission, type Course, type KnowledgeLectureAttempt, type KnowledgeLectureTutorThread } from '../src/lib/session/types';
import type { CodeArtifact } from '../src/lib/ai-collaboration/code-artifact';
import type { SubmissionSaveRecord } from '../src/lib/browser/submission-save-outbox';
import { normalizePblCourseConfig } from '../src/lib/pbl-course-config';
import { captureDesktopScreenshot, desktopAcceptanceProfiles, withDesktopProfile } from './fixtures/desktop-coverage';

// Shipped UI with isolated browser fixtures. No business writes reach the service.
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Student usability fixtures require a local acceptance service');
}
test.use({ baseURL, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
const courseId = 'student-usability-course';
const studentId = 'student-usability-student';
const classroomId = 'student-usability-player';
const at = '2026-10-13T00:00:00.000Z';
const prompt = '为了比较两处绿地的鸟类数量，下列哪种记录方式更可靠？';
const explanation = '比较应保持观察时长一致，并保存日期、地点与数量记录，避免仅凭主观印象判断。';
const options = [{ value: 'A', label: '在相同观察时长下记录日期、地点和鸟类数量' }, { value: 'B', label: '仅凭印象判断哪处鸟更多' }];
const mainCContent = '#include <stdio.h>\nint helper(void);\nint main(void) { printf("%d\\n", helper()); return 0; }\n';
const saveAttemptJournals = new WeakMap<BrowserContext, Array<{ at: string; offline: boolean; body: unknown }>>();
test.afterEach(async ({ context }, info) => {
  const attempts = saveAttemptJournals.get(context);
  if (attempts?.length && info.status !== info.expectedStatus) {
    await info.attach('submission-save-attempts', { body: JSON.stringify(attempts, null, 2), contentType: 'application/json' });
  }
});
const attempt: KnowledgeLectureAttempt = {
  id: 'attempt', sectionId: 'section', quizOutlineId: 'quiz', runtimeSceneId: 'quiz',
  submittedAt: at, score: 0, maxScore: 1, gradingSource: 'server', gradingStatus: 'graded', knowledgePointIds: [],
  questions: [{ questionId: 'question', prompt, options, answer: 'B', rawAnswer: ['B'],
    questionType: 'single', correct: false, points: 1, earned: 0, feedback: explanation,
    gradingStatus: 'graded', knowledgePointIds: [] }],
};

async function fixture(context: BrowserContext, mode: 'learning' | 'python' | 'c' | 'document', seedConflictingDraft = true) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '适配验收学生' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  const isCode = mode === 'python' || mode === 'c';
  const code = JSON.stringify({ version: 1, language: mode === 'c' ? 'c' : 'python', activeFileId: 'main', files: [{ id: 'main',
    path: mode === 'c' ? 'main.c' : 'main.py', content: mode === 'c' ? mainCContent : 'print(1)\n' }] });
  const thread: KnowledgeLectureTutorThread = { id: 'thread', attemptId: attempt.id, questionId: 'question',
    messages: [{ id: 'explanation', role: 'assistant', content: explanation, createdAt: at }],
    boardNotes: [{ id: 'note', title: '记录与核验', body: explanation.repeat(5), kind: 'concept', createdAt: at }], createdAt: at, updatedAt: at };
  const course = {
    id: courseId, name: '学生课堂与中文输入适配验收', version: 1, status: 'teaching',
    subject: '科学', grade: '七年级', hours: 1, summary: '', drivingQuestion: '如何比较观察结果？',
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })), currentStageIndex: mode === 'learning' ? 1 : 2,
    pblConfig: normalizePblCourseConfig({ makeArtifactMode: isCode ? mode : 'document' }), aiLearningClassroomId: classroomId,
    students: [{ id: studentId, name: '适配验收学生', joinedAt: at, stageProgress: {} }],
    groups: [], resources: [], activityLog: [], uiState: {},
    submissions: [{ id: 'draft', courseId, studentId, stageKey: 'make', type: isCode ? 'code' : 'document',
      title: '观察成果', content: isCode ? code : '<p>我的观察记录</p>', status: 'draft', version: 2, createdAt: at, updatedAt: at }],
    aiLearningProgress: { [studentId]: { classroomId, studentId, currentSceneIndex: 0, totalScenes: 1,
      completedScenes: [], lastActiveAt: at, masteryLevel: 'in-progress',
      knowledgeLectureAttempts: [attempt], knowledgeLectureTutorThreads: [thread] } },
    content: { pblOutline: '', knowledgePoints: [
      { id: 'observation', name: '观察记录', description: '记录日期、地点、观察时长与数量。' },
      { id: 'comparison', name: '证据比较', description: '统一观察条件后比较记录。' },
    ], knowledgeGraph: {
      nodes: [{ id: 'observation', label: '观察记录', description: '记录日期、地点、观察时长与数量。', level: 'foundation' },
        { id: 'comparison', label: '证据比较', description: '统一观察条件后比较记录。', level: 'core' }],
      edges: [{ id: 'observation-comparison', source: 'observation', target: 'comparison', label: '支持比较', type: 'supports' }],
    }, lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' },
      knowledgeLectureSections: [{ id: 'section', title: '科学观察', order: 0, quizOutlineId: 'quiz', sceneOutlineIds: [], estimatedMinutes: 3, knowledgePointIds: [] }] },
    createdAt: at, updatedAt: at,
  } as Course;
  const scene = { id: 'quiz', outlineId: 'quiz', stageId: classroomId, lectureSectionId: 'section', title: '科学观察小测',
    type: 'quiz', order: 0, knowledgePointIds: ['observation'], actions: [], content: { type: 'quiz', questions: [{ id: 'question', type: 'single',
      question: prompt, options, answer: ['A'], analysis: explanation, points: 1, knowledgePointIds: [] }] } };
  const tutorMessages: string[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const faults = { offline: false };
  const saveAttempts: Array<{ at: string; offline: boolean; body: unknown }> = [];
  saveAttemptJournals.set(context, saveAttempts);
  const saves: Array<{ requestId: string; content: string; expectedVersion: number; submissionVersion: number }> = [];
  const actionReceipts = createBrowserActionReceipts(courseId, at);
  const runs: Array<{ language: string; artifact: CodeArtifact; stdin: string }> = [];
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId }));
  }));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(request.url()); return route.abort(); }
    if (!path.startsWith('/api/') && ['GET', 'HEAD'].includes(method)) return route.continue();
    if (path.startsWith('/api/openmaic/interactive-runtime/') && method === 'GET') return route.continue();
    if (path === '/api/auth/me') return json({ user: { id: studentId, role: 'student', name: '适配验收学生' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'student', name: '适配验收学生' }, studentId, studentName: '适配验收学生', joinedCourseId: courseId, hydrated: true, updatedAt: at });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [] });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseId, courseVersion: course.version, projectionVersion: 0, projectionUpdatedAt: at, serverTime: at, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/public-discussion`) return json({ enabled: false, session: null });
    if (path === `/api/courses/${courseId}/actions`) {
      const body = request.postDataJSON();
      if (body.action?.type === 'UPSERT_SUBMISSION' && saveAttempts.length < 256) {
        saveAttempts.push({ at: new Date().toISOString(), offline: faults.offline, body });
      }
      if (faults.offline) return route.abort('internetdisconnected');
      const previous = actionReceipts.lookup(body);
      if (previous) return json(previous.body, previous.status);
      if (body.action?.type === 'UPSERT_SUBMISSION') {
        const submission = body.action.payload.submission as ClassroomSubmission;
        const current = course.submissions?.find(item => item.id === submission.id);
        const expectedVersion = body.action.payload.expectedSubmissionVersion;
        if ((current?.version ?? 0) !== expectedVersion) return json({ code: 'DRAFT_VERSION_CONFLICT', message: '代码版本已更新，请保留本机草稿。' }, 409);
        const version = (current?.version ?? 0) + 1;
        course.submissions = [...(course.submissions ?? []).filter(item => item.id !== submission.id), { ...submission, version }];
        course.version = (course.version ?? 0) + 1;
        const ack = actionReceipts.remember(body, { courseVersion: course.version, submissionVersion: version, updatedAt: at });
        saves.push({ requestId: body.requestId, content: submission.content, expectedVersion, submissionVersion: version });
        return json(ack);
      }
      return json(actionReceipts.remember(body, { courseVersion: course.version, updatedAt: at }));
    }
    if (path === '/api/knowledge-lecture/settings') return json({ settings: {} });
    if (path === '/api/knowledge-lecture') {
      const body = request.postDataJSON();
      if (body.action === 'tutor-message') tutorMessages.push(body.message);
      return json({ attempt, thread });
    }
    if (path === '/api/openmaic/classroom') return json({ success: true, classroom: {
      stage: { id: classroomId, name: '科学观察', createdAt: 1, updatedAt: 1 }, scenes: [scene],
    } });
    if (path === '/api/openmaic/progress') return json({ data: { progress: {} } });
    if (['/api/openmaic/provider-config', '/api/openmaic/server-providers', '/api/server-providers'].includes(path)) return json({ success: true, providers: [], models: [] });
    if (path === '/api/learning-events' && method === 'POST') {
      const receipt = browserLearningEventReceipt(request.postData(), Date.now());
      return json(receipt.body, receipt.status);
    }
    if (path === '/api/learning-events') return json({ success: true });
    if (path === '/api/ai-collaboration/code/run') {
      runs.push(request.postDataJSON());
      // UI contract only. Real Python/C sandbox execution has separate operational acceptance.
      return json({ status: 'success', phase: 'run', exitCode: 0, stdout: 'C 模拟运行结果：7\n', stderr: '', durationMs: 12, diagnostics: [] });
    }
    if (path === '/api/ai-collaboration/code' || path === '/api/ai-collaboration/document') return json({ conversationId: 'legacy', messages: [], commentThreads: [], memories: [], starters: [], proactiveReviewEnabled: false });
    if (path === '/api/ai-collaboration/memory') return json({ memories: [] });
    if (path === '/api/ai-collaboration/events') return json({ events: [], success: true });
    unexpected.push(`${method} ${path}`);
    return json({ error: 'Unconfigured fixture request' }, 404);
  });
  if (mode !== 'learning' && seedConflictingDraft) {
    await context.addInitScript(({ scope, content, aiScope, origin }) => {
      // Init scripts also run in about:blank and child frames, which cannot access this origin's storage.
      if (location.origin !== origin || window !== window.top) return;
      const key = `openpbl:document-draft:v1:${encodeURIComponent(scope)}:stale`;
      localStorage.setItem(key, JSON.stringify({ key, scope, submissionId: 'draft', expectedVersion: 1, content, updatedAt: Date.now() }));
      if (aiScope) for (const channel of ['sidebar', 'comment']) {
        localStorage.setItem(`openpbl:code-ai-request:v1:${aiScope}:${channel}`, JSON.stringify({ requestId: `pending-${channel}`, body: { message: '请保留我的问题', intent: 'discuss' } }));
      }
    }, { scope: `${courseId}:${studentId}:make:${isCode ? `code:${mode}` : 'document'}`, content: isCode ? code.replace('print(1)', 'print(2)').replace('return 0;', 'return 1;') : '<p>本机未同步的记录</p>', aiScope: isCode ? `${courseId}:${studentId}:make:${mode}` : null, origin: new URL(baseURL).origin });
  }
  return { tutorMessages, unexpected, pageErrors, faults, saves, saveAttempts, runs };
}

for (const profile of desktopAcceptanceProfiles([{ width: 1366, height: 512 }, { width: 1024, height: 576 }, { width: 390, height: 844 }])) {
  const { viewport } = profile;
  test(`student classroom knowledge graph supports selection and returning to the lesson at ${viewport.width}x${viewport.height} ${profile.name}`, async ({ browser }, info) => {
    await withDesktopProfile(profile, browser, info, async ({ context, page }) => {
    const audit = await fixture(context, 'learning');
    await page.goto(`/student/classroom/${courseId}`);
    const openGraph = page.getByRole('button', { name: '完整浏览课程思维导图', exact: true });
    await expectReachable(openGraph, page);
    await openGraph.click();
    const graph = page.getByRole('dialog', { name: '课程思维导图', exact: true });
    await expect(graph).toBeVisible();
    const bounds = await graph.boundingBox();
    const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    // The expanded map uses the available screen, with 8px mobile / 16px desktop margins.
    const margin = actual.width <= 700 ? 8 : 16;
    // innerWidth/Height are integers; native zoom can lay out 100dvw/dvh at
    // fractional CSS pixels. Keep a single-pixel bound for that rounding.
    expect(Math.abs(bounds!.width - Math.min(1440, actual.width - 2 * margin))).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.height - Math.min(900, actual.height - 2 * margin))).toBeLessThanOrEqual(1);
    expect(bounds!.x).toBeGreaterThanOrEqual(margin - 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(margin - 1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(actual.width - margin + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(actual.height - margin + 1);
    // These controls must be both on screen and unobscured by the dialog clip.
    for (const title of ['Zoom In', 'Zoom Out', 'Fit View']) {
      const control = graph.getByRole('button', { name: title, exact: true });
      await expect(control).toBeInViewport({ ratio: 1 });
      await expectReachable(control, page);
      const transform = await graph.locator('.react-flow__viewport').getAttribute('style');
      await control.click();
      await expect(graph.locator('.react-flow__viewport')).not.toHaveAttribute('style', transform!);
    }
    await expect(graph.locator('.react-flow__node')).toHaveCount(2);
    await expect(graph.locator('.react-flow__edge')).toHaveCount(1);
    for (const node of await graph.locator('.react-flow__node').all()) {
      await expect(node).toBeInViewport({ ratio: 1 - 1e-6 });
      await node.click({ trial: true });
    }
    const concept = graph.getByLabel('证据比较，核心', { exact: true });
    // Scaled canvas nodes can report 0.99999988 even when completely inside the clip.
    await expect(concept).toBeInViewport({ ratio: 1 - 1e-6 });
    const conceptBounds = await concept.boundingBox();
    const canvasBounds = await graph.getByRole('application').boundingBox();
    expect(conceptBounds!.x).toBeGreaterThanOrEqual(canvasBounds!.x - 0.01);
    expect(conceptBounds!.y).toBeGreaterThanOrEqual(canvasBounds!.y - 0.01);
    expect(conceptBounds!.x + conceptBounds!.width).toBeLessThanOrEqual(canvasBounds!.x + canvasBounds!.width + 0.01);
    expect(conceptBounds!.y + conceptBounds!.height).toBeLessThanOrEqual(canvasBounds!.y + canvasBounds!.height + 0.01);
    await concept.click();
    await expect(graph.locator('.react-flow__node[data-id="comparison"]')).toHaveClass(/selected/);
    const closeGraph = graph.getByRole('button', { name: '关闭对话框', exact: true });
    await expectReachable(closeGraph, page);
    await captureDesktopScreenshot(page, info.outputPath('student-classroom-knowledge-graph.png'));
    await closeGraph.click();
    await expect(graph).toHaveCount(0);
    await expect(page.locator('[data-stage-host-mode="student"]')).toHaveAttribute('data-active-scene-id', 'quiz');
    await expect(page.getByRole('button', { name: '助教讲解', exact: true })).toBeVisible();
    expect(audit.pageErrors).toEqual([]);
    expect(audit.unexpected).toEqual([]);
    }, baseURL);
  });
}

test('student knowledge graph stays inside native player fullscreen and isolates keyboard controls', async ({ context }, info) => {
  const audit = await fixture(context, 'learning');
  const page = await context.newPage();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/student/classroom/${courseId}`);
  await expect(page.getByRole('button', { name: '完整浏览课程思维导图', exact: true })).toBeVisible();
  // F11 is the shipped player shortcut and enters native element fullscreen.
  await page.keyboard.press('F11');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  const trigger = page.getByRole('button', { name: '完整浏览课程思维导图', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const graph = page.getByRole('dialog', { name: '课程思维导图', exact: true });
  await expect(graph).toBeVisible();
  expect(await graph.evaluate(element => document.fullscreenElement?.contains(element))).toBe(true);
  expect(await graph.evaluate(element => element.contains(document.activeElement))).toBe(true);
  const application = graph.getByRole('application');
  // Wait for the existing active-node focus animation before checking keyboard isolation.
  await expect.poll(async () => {
    const node = await graph.locator('.react-flow__node[data-id="observation"]').boundingBox();
    const canvas = await application.boundingBox();
    if (!node || !canvas) return Number.POSITIVE_INFINITY;
    return Math.max(Math.abs(node.x + node.width / 2 - canvas.x - canvas.width / 2),
      Math.abs(node.y + node.height / 2 - canvas.y - canvas.height / 2));
  }).toBeLessThan(1);
  await application.click({ position: { x: 20, y: 80 } });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(page.locator('[data-stage-host-mode="student"]')).toHaveAttribute('data-active-scene-id', 'quiz');
  await expect(page.locator('button[aria-label="暂停讲解"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('student-knowledge-graph-native-fullscreen.png') });
  await page.keyboard.press('Escape');
  await expect(graph).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('F11');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  expect(audit.pageErrors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});

async function expectReachable(control: Locator, page: Page) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  // Includes occlusion checks, beyond merely having an in-viewport bounding box.
  await control.click({ trial: true });
}

for (const profile of desktopAcceptanceProfiles([{ width: 1366, height: 768 }, { width: 911, height: 512 }, { width: 390, height: 844 }])) {
  const { viewport } = profile;
  test(`student tutor keeps explanation, composer and keyboard usable at ${viewport.width}x${viewport.height} ${profile.name}`, async ({ browser }, info) => {
    await withDesktopProfile(profile, browser, info, async ({ context, page }) => {
    await context.setDefaultTimeout(15_000);
    const audit = await fixture(context, 'learning');
    await page.goto(`/student/classroom/${courseId}`);
    const trigger = page.getByRole('button', { name: '助教讲解', exact: true });
    await expectReachable(trigger, page);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '助教题目讲解' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    const notes = dialog.getByRole('region', { name: '题目与板书解析' });
    await notes.scrollIntoViewIfNeeded();
    expect((await notes.boundingBox())!.height).toBeGreaterThan(180);
    const question = dialog.getByText(prompt, { exact: true });
    await question.scrollIntoViewIfNeeded();
    await expect(question).toBeInViewport();
    const explanationScreenshot = info.outputPath('student-tutor-explanation.png');
    await captureDesktopScreenshot(page, explanationScreenshot);
    await info.attach('student-tutor-explanation', { path: explanationScreenshot, contentType: 'image/png' });
    const input = dialog.getByPlaceholder('把不明白的地方告诉助教…');
    await input.fill('请解释比较的方法');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
    expect(audit.tutorMessages).toEqual([]);
    await input.press('Shift+Enter');
    expect(audit.tutorMessages).toEqual([]);
    const send = dialog.getByRole('button', { name: '发送追问' });
    await expectReachable(send, page);
    const composerScreenshot = info.outputPath('student-tutor-composer.png');
    await captureDesktopScreenshot(page, composerScreenshot);
    await info.attach('student-tutor-composer', { path: composerScreenshot, contentType: 'image/png' });
    await input.press('Enter');
    await expect.poll(() => audit.tutorMessages).toEqual(['请解释比较的方法']);
    await dialog.getByRole('button', { name: '关闭讲解' }).focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(audit.pageErrors).toEqual([]);
    expect(audit.unexpected).toEqual([]);
    }, baseURL);
  });
}

for (const mode of ['python', 'c', 'document'] as const) {
  for (const profile of desktopAcceptanceProfiles([{ width: 768, height: 576 }])) {
  const { viewport } = profile;
  test(`student ${mode} retains draft recovery and save actions in a narrow desktop window ${viewport.width}x${viewport.height} ${profile.name}`, async ({ browser }, info) => {
    await withDesktopProfile(profile, browser, info, async ({ context, page }) => {
    const audit = await fixture(context, mode);
    await page.goto(`/student/ai-collaboration/${courseId}`);
    const download = page.getByRole('button', { name: mode === 'document' ? '下载本机草稿' : '下载本机代码草稿', exact: true });
    await expectReachable(download, page);
    await expectReachable(page.getByRole('button', { name: '保存', exact: true }), page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (mode !== 'document') {
      await expectReachable(page.getByRole('button', { name: '恢复上次 AI 结果', exact: true }), page);
      await expectReachable(page.getByRole('button', { name: '恢复批注回复', exact: true }), page);
      await page.getByRole('button', { name: '新建代码文件', exact: true }).click();
      const fileName = page.getByRole('textbox', { name: '新文件名' });
      const helperName = mode === 'c' ? 'helper.c' : 'helper.py';
      await fileName.fill(helperName);
      await fileName.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
      await expect(fileName).toBeVisible();
      await fileName.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
      await expect(fileName).toBeVisible();
      await fileName.press('Enter');
      await expect(fileName).toHaveCount(0);
      await expect(page.getByRole('button', { name: helperName, exact: true })).toBeVisible();
    }
    const recoveryScreenshot = info.outputPath(`student-${mode}-recovery-header.png`);
    await captureDesktopScreenshot(page, recoveryScreenshot);
    await info.attach(`student-${mode}-recovery-header`, { path: recoveryScreenshot, contentType: 'image/png' });
    expect(audit.pageErrors).toEqual([]);
    expect(audit.unexpected).toEqual([]);
    }, baseURL);
  });
  }
}

test('student C files survive a failed save and reload, then save and run with mocked API', async ({ context }, info) => {
  test.setTimeout(60_000);
  const audit = await fixture(context, 'c', false);
  audit.faults.offline = true;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1024, height: 576 });
  await page.goto(`/student/ai-collaboration/${courseId}`);
  await page.getByRole('button', { name: '新建代码文件', exact: true }).click();
  const filename = page.getByRole('textbox', { name: '新文件名' });
  await filename.fill('helper.c');
  await filename.press('Enter');
  const editor = page.getByRole('textbox', { name: '编辑器内容', exact: true });
  await expect(editor).toBeVisible({ timeout: 25_000 });
  const helperContent = 'int helper(void) { return 7; }\n';
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(helperContent);
  await expect(page.getByText('保存失败', { exact: true }).last()).toBeVisible();
  expect(audit.saves).toHaveLength(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('openpbl:document-draft:v1:'))
    .some(key => localStorage.getItem(key)?.includes('return 7;')))).toBe(true);

  await page.reload();
  await expect(page.getByRole('button', { name: 'helper.c', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const monaco = (window as unknown as { monaco?: { editor: { getModels(): Array<{ getValue(): string; uri: { toString(): string } }> } } }).monaco;
    return monaco?.editor.getModels().find(model => model.uri.toString().endsWith('/helper.c'))?.getValue();
  }), { timeout: 25_000 }).toBe(helperContent);
  await expect(page.getByText('保存失败', { exact: true }).last()).toBeVisible();
  const pending: SubmissionSaveRecord[] = await page.evaluate(({ courseId, studentId }) => Object.keys(localStorage)
    .filter(key => key.startsWith('openpbl:submission-save:v1:'))
    .map(key => JSON.parse(localStorage.getItem(key)!))
    .filter(record => record.actorId === studentId && record.action?.payload.courseId === courseId), { courseId, studentId });
  expect(pending).toHaveLength(1);
  expect(pending[0].state).toBe('pending');
  const pendingContent = pending[0].action.payload.submission.content;
  const pendingArtifact = JSON.parse(pendingContent) as CodeArtifact;
  const localContent: string = await page.evaluate(scope => Object.keys(localStorage)
    .filter(key => key.startsWith('openpbl:document-draft:v1:'))
    .map(key => JSON.parse(localStorage.getItem(key)!))
    .filter(draft => draft.scope === scope).sort((left, right) => right.updatedAt - left.updatedAt)[0]?.content,
  `${courseId}:${studentId}:make:code:c`);
  expect(localContent).toEqual(expect.any(String));
  const expectedArtifact = JSON.parse(localContent) as CodeArtifact;
  expect(expectedArtifact).toEqual({ version: 1, language: 'c', activeFileId: expectedArtifact.files[1]?.id,
    files: [{ id: 'main', path: 'main.c', content: mainCContent }, { id: expect.any(String), path: 'helper.c', content: helperContent }] });
  // A slow editor can send the newly created empty file before typing. That
  // unknown request must get its own original ACK before saving the newer edit.
  const expectedWrites = isDeepStrictEqual(pendingArtifact, expectedArtifact) ? 1 : 2;
  audit.faults.offline = false;
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect.poll(() => audit.saves.length).toBe(expectedWrites);
  expect(audit.saves[0].requestId).toBe(pending[0].requestId);
  expect(audit.saves[0].content).toBe(pendingContent);
  expect(audit.saves[0].expectedVersion).toBe(2);
  expect(new Set(audit.saves.map(save => save.requestId)).size).toBe(expectedWrites);
  expect(new Set(audit.saves.map(save => save.content)).size).toBe(expectedWrites);
  for (const [index, save] of audit.saves.entries()) {
    expect(save.expectedVersion).toBe(2 + index);
    expect(save.submissionVersion).toBe(3 + index);
  }
  const originalAttempts = audit.saveAttempts.map(attempt => attempt.body as { requestId: string; action: unknown })
    .filter(body => body.requestId === pending[0].requestId);
  expect(originalAttempts.length).toBeGreaterThan(1);
  for (const body of originalAttempts) expect(body.action).toEqual(pending[0].action);
  const saved = JSON.parse(audit.saves.at(-1)!.content) as CodeArtifact;
  expect(saved).toEqual(expectedArtifact);
  await expect.poll(() => page.evaluate(({ courseId, studentId }) => Object.keys(localStorage)
    .filter(key => key.startsWith('openpbl:submission-save:v1:'))
    .map(key => JSON.parse(localStorage.getItem(key)!))
    .filter(record => record.actorId === studentId && record.action?.payload.courseId === courseId).length, { courseId, studentId })).toBe(0);

  await page.getByRole('button', { name: '标准输入', exact: true }).click();
  await page.getByPlaceholder('需要 input() 或 scanf() 时，在这里预先输入；每行会按顺序提供给程序。').fill('7\n');
  await expectReachable(page.getByRole('button', { name: '运行', exact: true }), page);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByText('C 模拟运行结果：7', { exact: true })).toBeVisible();
  expect(audit.runs).toHaveLength(1);
  expect(audit.runs[0]).toMatchObject({ language: 'c', artifact: saved, stdin: '7\n' });
  expect(audit.saves).toHaveLength(expectedWrites);
  await page.screenshot({ path: info.outputPath('student-c-recovered-run.png') });
  expect(audit.pageErrors).toEqual([]);
  expect(audit.unexpected).toEqual([]);
});
