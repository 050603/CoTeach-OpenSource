import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import type { KnowledgeLectureAttempt, KnowledgeLectureTutorThread } from '../src/lib/session/types';

const at = '2026-10-20T00:00:00.000Z';
const courseId = 'finished-review-fixture';
const classroomId = 'finished-review-classroom';
const studentId = 'finished-review-student';
const participationId = 'finished-review-participation';
const savedAnswer = '当时记录：先统一观察时长，再比较两处的鸟类数量。';
const authoredAnalysis = '原始解析：统一观察时长，完整记录日期、地点与数量，再比较证据。';
const savedAiExplanation = '当时的 AI 讲题：你已经说明了统一时长，还可以补充记录日期与地点。';
const unansweredReference = '参考答案：A（统一观察时长）。';
const forgedAnswer = '浏览器旧缓存中的另一份答案，不是本人的原始提交。';
const courseName = '结束课堂复习：科学观察与证据比较';
const projectDraft = '<h2>当时保存的观察文档</h2><p>草稿记录：比较前统一观察时长。</p><table><tbody><tr><th>地点</th><th>鸟类数量</th></tr><tr><td>校园东侧</td><td>12</td></tr></tbody></table>';
const projectArchive = '<h2>已提交的科学观察报告</h2><p>归档结论：在相同时长内记录并比较两处的数量。</p>';
const teacherFeedback = '教师反馈：比较条件记录完整，下次可补充天气信息。';
const aiFeedback = '这条 AI 反馈不能被显示成教师反馈。';

const directory = (page: Page) => page.getByRole('navigation', { name: '页面目录', exact: true })
  .or(page.getByRole('dialog', { name: '页面目录', exact: true }));

function silentWav(): Buffer {
  const samples = 8_000 * 30;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(16_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  await control.click({ trial: true });
}

async function noHorizontalOverflow(page: Page, scope?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
  if (scope) {
    expect(await scope.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= -1 && bounds.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
    })).toBe(true);
  }
}

async function captureRecord(page: Page, path: string) {
  await expect(page.locator('.pbl-workspace-content')).toHaveCSS('opacity', '1');
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({ path, fullPage: true });
}

async function quizCacheSnapshot(page: Page) {
  return page.evaluate(() => Object.fromEntries(['submitted-quiz', 'unanswered-quiz'].flatMap(sceneId =>
    ['quizAnswers', 'quizResults'].map(prefix => [`${prefix}:${sceneId}`, localStorage.getItem(`${prefix}:${sceneId}`)]))));
}

async function selectPage(page: Page, title: string) {
  const panel = directory(page);
  if (!await panel.isVisible()) await page.getByRole('button', { name: '展开页面目录', exact: true }).click();
  const entry = panel.getByRole('button', { name: title, exact: true });
  await reachable(entry);
  await entry.click();
  if (await panel.isVisible()) await panel.getByRole('button', { name: '收起页面目录', exact: true }).click();
}

// Only business API responses are synthetic. The shipped page, quiz renderer,
// directory, keyboard controls, dialogs and HTML audio elements run unchanged.
async function installReviewFixture(page: Page, baseURL: string, { projectRecords = false } = {}) {
  const pageErrors: string[] = [];
  const missingFixtures: string[] = [];
  const forbiddenWrites: string[] = [];
  const reviewRequests: Array<Record<string, unknown>> = [];
  const readCounts = { course: 0, participation: 0, assessment: 0, archive: 0 };
  const attempt: KnowledgeLectureAttempt = {
    id: 'saved-review-attempt', sectionId: 'submitted-section', quizOutlineId: 'submitted-outline', runtimeSceneId: 'submitted-quiz',
    submittedAt: at, gradingSource: 'server', gradingStatus: 'graded', score: 3, maxScore: 5, knowledgePointIds: ['observation'],
    questions: [{ questionId: 'saved-reasoning', prompt: '请说明如何公平比较两处的观察证据。',
      questionType: 'short_answer', questionFormat: 'scenario_task', answer: savedAnswer, rawAnswer: savedAnswer,
      points: 5, earned: 3, correct: null, gradingStatus: 'graded', feedback: '已说明统一时长，记录条件还可补充。',
      authoredAnalysis, referenceAnswer: '统一条件，记录数量与环境，再比较观察证据。',
      authoredQuestionFingerprint: 'saved-original-question-fingerprint', knowledgePointIds: ['observation'] }],
  };
  const thread: KnowledgeLectureTutorThread = {
    id: 'saved-review-thread', attemptId: attempt.id, questionId: 'saved-reasoning', createdAt: at, updatedAt: at,
    messages: [{ id: 'saved-ai-message', role: 'assistant', content: savedAiExplanation, createdAt: at }],
    boardNotes: [{ id: 'saved-note', title: '完整观察证据', body: '日期、地点、时长、数量。', kind: 'concept', createdAt: at }],
  };
  const slide = (id: string, title: string, order: number) => ({
    id, stageId: classroomId, outlineId: id, title, type: 'slide', order,
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching',
    actions: [{ id: `${id}-speech`, type: 'speech', text: `复习讲解：${title}。`,
      audioUrl: `/api/openmaic/classroom-media/${classroomId}/audio/${id}.wav`, audioDurationSec: 30 }],
    content: { type: 'slide', canvas: { id: `${id}-canvas`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#16766d'], fontColor: '#29394f', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [] } },
  });
  const scenes = [slide('intro', '观察与记录', 0), {
    id: 'unanswered-quiz', stageId: classroomId, outlineId: 'unanswered-outline', lectureSectionId: 'unanswered-section',
    title: '尚未提交的课堂检测', type: 'quiz', order: 1, actions: [],
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching',
    // An objective question with only its answer: review must still provide a
    // readable reference without pretending the learner submitted an answer.
    content: { type: 'quiz', questions: [{ id: 'unanswered-choice', type: 'single', format: 'single_choice',
      question: '比较两处鸟类数量时，应先统一什么？', points: 1, answer: ['A'],
      options: [{ value: 'A', label: '统一观察时长' }, { value: 'B', label: '只凭印象判断' }], knowledgePointIds: ['observation'] }] },
  }, slide('after-unanswered', '后续证据整理', 2), {
    id: 'submitted-quiz', stageId: classroomId, outlineId: 'submitted-outline', lectureSectionId: 'submitted-section',
    title: '当时的作答检测', type: 'quiz', order: 3, actions: [],
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching',
    content: { type: 'quiz', questions: [{ id: 'saved-reasoning', type: 'short_answer', format: 'scenario_task',
      question: attempt.questions[0].prompt, points: 5, analysis: authoredAnalysis,
      referenceAnswer: attempt.questions[0].referenceAnswer, knowledgePointIds: ['observation'] }] },
  }];
  const progress = { classroomId, studentId, currentSceneIndex: 1, totalScenes: scenes.length, completedScenes: [],
    completionModelVersion: 2, lastActiveAt: at, masteryLevel: 'in-progress',
    knowledgeLectureAttempts: [attempt], knowledgeLectureTutorThreads: [thread] };
  const course = {
    id: courseId, version: 17, name: courseName, status: 'finished', subject: '科学', grade: '初中', hours: 1,
    createdAt: at, updatedAt: at, currentStageIndex: 4, aiLearningClassroomId: classroomId,
    platformContext: { activityId: 'review-activity', participationId, offeringId: 'review-offering' },
    stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource' }, { key: 'ai-learning', label: '知识讲授', view: 'ai-learning' },
      { key: 'proposal', label: '方案探究', view: 'simple-resource' }, { key: 'make', label: '作品制作', view: 'simple-resource' },
      { key: 'showcase', label: '成果汇报', view: 'simple-resource' }],
    students: [{ id: studentId, name: '课堂回看验收学生', joinedAt: at, stageProgress: { 'ai-learning': 25 } }],
    aiLearningProgress: { [studentId]: progress },
    experimentPosttestSummary: { enabled: true, notStartedCount: 1, inProgressCount: 0, submittedCount: 0,
      studentRows: [{ studentId, status: 'not-started' }] },
    content: { knowledgePoints: [{ id: 'observation', name: '科学观察', description: '统一观察条件并记录证据。' }],
      lessonOutline: [], pblOutline: '', evaluationPlan: { dimensions: [], overallRubric: '' },
      knowledgeLectureSections: [{ id: 'unanswered-section', title: '观察条件', order: 0, sceneOutlineIds: ['intro'], quizOutlineId: 'unanswered-outline', knowledgePointIds: ['observation'] },
        { id: 'submitted-section', title: '观察证据检测', order: 1, sceneOutlineIds: ['after-unanswered'], quizOutlineId: 'submitted-outline', knowledgePointIds: ['observation'] }] },
    resources: [], groups: [],
    submissions: projectRecords ? [{ id: 'saved-document-draft', courseId, studentId, studentName: '课堂回看验收学生',
      stageKey: 'make', type: 'document', title: '科学观察文档草稿', content: projectDraft, status: 'draft', version: 3, createdAt: at, updatedAt: at }] : [],
    projectDocumentVersions: projectRecords ? [{ id: 'saved-document-version', courseId, submissionId: 'saved-document-draft', studentId,
      stageKey: 'make', sequence: 1, sourceVersion: 2, title: '科学观察报告', sourceHtml: projectArchive,
      docxUploadId: 'saved-report-docx', status: 'submitted', submittedAt: at, createdAt: at }] : [],
    feedback: projectRecords ? [{ id: 'teacher-review-feedback', courseId, targetType: 'student', targetId: studentId, stageKey: 'make',
      kind: 'comment', content: teacherFeedback, sourceRole: 'teacher', sourceName: '科学老师', createdAt: at },
    { id: 'ai-review-feedback', courseId, targetType: 'student', targetId: studentId, stageKey: 'make',
      kind: 'comment', content: aiFeedback, sourceRole: 'ai', sourceName: 'AI 助教', createdAt: at }] : [],
    activityLog: [], uiState: {},
  };
  const participation = { participation: { id: participationId, firstEnteredAt: at, lastEnteredAt: at, completedAt: at, stageProgress: { 'ai-learning': 25 } },
    student: { id: studentId, displayName: '课堂回看验收学生' },
    instance: { id: courseId, status: 'finished', activityId: 'review-activity', offeringId: 'review-offering', offeringName: '科学实践教学班',
      title: course.name, runNo: 1, templateVersion: 1, runtimeConfig: { version: 17 },
      snapshot: { schemaVersion: 2, kind: 'pbl-course', design: { name: course.name, stages: course.stages,
        aiLearningClassroomId: classroomId, content: course.content } } },
    workspace: { version: 3, projectState: { aiLearningProgress: progress }, updatedAt: at },
    isTeacher: false, canWrite: false };
  const original = JSON.stringify({ course, participation, attempt });
  const secret = (await readFile(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, username: studentId,
    studentName: '课堂回看验收学生', displayName: '课堂回看验收学生' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  await page.addInitScript(({ forgedAnswer }) => {
    localStorage.setItem('locale', 'zh-CN');
    for (const sceneId of ['submitted-quiz', 'unanswered-quiz']) {
      if (localStorage.getItem(`quizAnswers:${sceneId}`) === null) {
        localStorage.setItem(`quizAnswers:${sceneId}`, JSON.stringify({ 'saved-reasoning': forgedAnswer, 'unanswered-choice': 'B' }));
      }
      if (localStorage.getItem(`quizResults:${sceneId}`) === null) {
        localStorage.setItem(`quizResults:${sceneId}`, JSON.stringify([{ questionId: 'unanswered-choice', correct: true, status: 'correct', earned: 99 }]));
      }
    }
  }, { forgedAnswer });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.routeWebSocket('**/*', socket => socket.close());
  const wav = silentWav();
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== new URL(baseURL).origin) {
      missingFixtures.push(`${method} ${url}`);
      return route.abort('blockedbyclient');
    }
    if (path === '/api/knowledge-lecture' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.action === 'review-explanation') {
        reviewRequests.push(body);
        if (body.questionId === 'saved-reasoning' && body.attemptId === attempt.id) return json({ thread, resultSource: 'personalized' });
        if (body.questionId === 'unanswered-choice' && body.runtimeSceneId === 'unanswered-quiz' && !body.attemptId) {
          return json({ explanation: { id: 'unanswered-reference', questionFingerprint: 'unanswered-source', source: 'reference',
            text: unansweredReference, boardNotes: [], audioUrl: `/api/openmaic/classroom-media/${classroomId}/audio/reference.wav`, audioDurationSec: 30 }, resultSource: 'reference' });
        }
        missingFixtures.push(`Invalid review scope: ${JSON.stringify(body)}`);
        return json({ error: 'QUESTION_CONTEXT_NOT_FOUND' }, 404);
      }
    }
    // Reading an existing AI explanation may synthesize its narration. No
    // question generation, answer submission or learning-record write is allowed.
    if (path === '/api/openmaic/generate/tts' && method === 'POST') return json({ base64: wav.toString('base64'), format: 'wav' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      forbiddenWrites.push(`${method} ${path}${request.postData() ? ` ${request.postData()}` : ''}`);
      return json({ error: 'READ_ONLY_FIXTURE' }, 409);
    }
    if (!path.startsWith('/api/')) return route.continue();
    if (path.startsWith(`/api/openmaic/classroom-media/${classroomId}/`)) return route.fulfill({ contentType: 'audio/wav', body: wav });
    if (path === '/api/auth/me' || path === '/api/platform/auth/student-profile') return json({ user: { id: studentId, role: 'student', displayName: '课堂回看验收学生', username: studentId } });
    if (path === `/api/platform/participations/${participationId}`) { readCounts.participation += 1; return json(participation); }
    if (path === `/api/platform/participations/${participationId}/outcomes`) return json({ submissions: [], artifacts: [], reflections: [], evaluations: [], showcases: [] });
    if (path === `/api/platform/participations/${participationId}/ai`) return json({ conversations: [], supportRecords: [] });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment`) {
      readCounts.assessment += 1;
      return json({ phase: url.searchParams.get('phase'), questions: [], submission: null });
    }
    if (projectRecords && path === `/api/courses/${courseId}/showcase/artifacts/saved-document-version`) {
      readCounts.archive += 1;
      return json({ kind: 'document', versionId: 'saved-document-version', title: '科学观察报告', sequence: 1, submittedAt: at, html: projectArchive });
    }
    if (path === '/api/courses') { readCounts.course += 1; return json({ courses: [course], hydrated: true,
      user: { role: 'student', name: '课堂回看验收学生' }, studentId, studentName: '课堂回看验收学生', joinedCourseId: courseId }); }
    if (path === `/api/courses/${courseId}/state`) { readCounts.course += 1; return json({ course, courseVersion: course.version, eventCursor: '0' }); }
    if (path.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: course.version });
    if (path.endsWith('/presence')) return json({ members: [] });
    if (path.endsWith('/projection')) return json({ courseId, courseVersion: course.version, projectionVersion: 0, resourceProjection: null, teacherResourceProjection: null });
    if (path.endsWith('/public-discussion')) return json({ enabled: false, session: null });
    if (path.endsWith('/lecture-chat')) return json({ thread: { id: 'saved-page-chat', messages: [] }, requests: [], writable: false });
    if (path === '/api/openmaic/classroom' && url.searchParams.get('id') === classroomId) return json({ success: true, classroom: {
      stage: { id: classroomId, name: course.name, createdAt: 1, updatedAt: 1 }, scenes } });
    if (path === '/api/openmaic/progress') return json({ data: { progress: { [studentId]: progress } } });
    if (path === '/api/knowledge-lecture/settings') return json({ settings: { ttsProviderId: 'fixture-tts', ttsModelId: 'fixture-model', ttsVoice: 'fixture-voice', ttsSpeed: 1 } });
    if (/provider|server-providers/.test(path)) return json({ providers: [], models: [], success: true });
    missingFixtures.push(`${method} ${path}`);
    return json({ error: 'FIXTURE_MISSING' }, 404);
  });
  return { pageErrors, missingFixtures, forbiddenWrites, reviewRequests, readCounts,
    unchanged: () => expect(JSON.stringify({ course, participation, attempt })).toBe(original) };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`结束课堂只读回看 ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, reducedMotion: 'reduce', ...(viewport.width < 1024 ? { hasTouch: true,
      ...(process.env.PRELAUNCH_E2E_BROWSER === 'firefox' ? {} : { isMobile: true }) } : {}) });
    test('reviews saved answers, unanswered quizzes, narration and AI explanations without modifying learning records', async ({ page, baseURL }, info) => {
      test.setTimeout(90_000);
      const fixture = await installReviewFixture(page, baseURL!);
      await page.goto(`${baseURL}/student/participations/${participationId}`);
      const originalQuizCache = await quizCacheSnapshot(page);
      const recordTabs = page.getByRole('navigation', { name: '课堂回顾导航', exact: true });
      await expect(page.getByRole('heading', { name: courseName, exact: true })).toHaveCount(1);
      await expect(recordTabs).toBeVisible();
      await expect(recordTabs.getByRole('button')).toHaveCount(2);
      await expect(recordTabs.getByRole('button', { name: '课程复习', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(recordTabs.getByRole('button', { name: '项目回顾', exact: true })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: '课堂工具', exact: true })).toHaveCount(0);
      for (const absent of ['项目成果', '学习反思', '成长评价', '教师反馈']) {
        await expect(page.getByRole('heading', { name: absent, exact: true })).toHaveCount(0);
      }
      const courseReview = page.getByRole('region', { name: '课程复习', exact: true });
      await expect(courseReview.getByRole('heading', { name: '知识讲授', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /开始前测|开始后测|提交答案|重新答题/ })).toHaveCount(0);
      await noHorizontalOverflow(page, recordTabs);
      await captureRecord(page, info.outputPath('course-review-overview.png'));

      // Saved answers are available directly in the classroom record. Opening
      // an explanation here must use the same immutable first attempt.
      await reachable(recordTabs.getByRole('button', { name: '我的作答', exact: true }));
      await recordTabs.getByRole('button', { name: '我的作答', exact: true }).click();
      const recordAnswers = page.getByRole('region', { name: '我的作答记录', exact: true });
      await expect(recordAnswers.getByRole('navigation', { name: '作答小节', exact: true })).toBeVisible();
      await expect(recordAnswers.locator('details').first()).toHaveAttribute('open', '');
      await expect(recordAnswers.getByText(savedAnswer, { exact: true })).toBeVisible();
      await expect(recordAnswers.getByText(authoredAnalysis, { exact: false })).toBeVisible();
      await expect(recordAnswers.getByText(forgedAnswer, { exact: true })).toHaveCount(0);
      await expect(recordAnswers.getByRole('textbox')).toHaveCount(0);
      await expect(recordAnswers.getByRole('button', { name: /提交|重做|重新答题|重试批阅/ })).toHaveCount(0);
      await expect(page.getByRole('region', { name: '前后测作答记录', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /开始前测|开始后测|提交前测|提交后测/ })).toHaveCount(0);
      const recordLecture = recordAnswers.getByRole('button', { name: 'AI 讲题 · 第 1 题', exact: true });
      await reachable(recordLecture);
      await recordLecture.click();
      const recordBoard = page.getByRole('dialog', { name: '助教题目讲解', exact: true });
      await expect(recordBoard.getByText(savedAiExplanation, { exact: true }).first()).toBeVisible();
      await expect(recordBoard.getByRole('textbox')).toHaveCount(0);
      await expect(recordBoard.getByRole('button', { name: '发送追问', exact: true })).toHaveCount(0);
      await noHorizontalOverflow(page, recordBoard);
      await recordBoard.getByRole('button', { name: '关闭讲解', exact: true }).click();
      await noHorizontalOverflow(page, recordAnswers);
      await captureRecord(page, info.outputPath('saved-answers-in-record.png'));
      await recordTabs.getByRole('button', { name: '课程复习', exact: true }).click();
      const entry = page.getByRole('link', { name: '进入课程回看', exact: true });
      await expect(entry).toHaveAttribute('href', `/student/classroom/${courseId}?returnParticipationId=${participationId}`);
      await reachable(entry);
      await noHorizontalOverflow(page);
      await entry.click();
      await expect(page).toHaveURL(new RegExp(`/student/classroom/${courseId}\\?returnParticipationId=${participationId}$`));
      const returnToRecord = page.getByRole('link', { name: '返回课堂回顾', exact: true });
      await expect(returnToRecord).toHaveAttribute('href', `/student/participations/${participationId}`);
      const tabs = page.getByRole('navigation', { name: '课堂回看', exact: true });
      const player = page.getByRole('region', { name: 'AI 课程回看', exact: true });
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole('button', { name: '回看 AI 课程', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(directory(page)).toBeVisible();
      for (const title of ['第 1 页：观察与记录', '第 2 页：尚未提交的课堂检测', '第 3 页：后续证据整理', '第 4 页：当时的作答检测']) {
        await expect(directory(page).getByRole('button', { name: title, exact: true })).toBeEnabled();
      }
      await noHorizontalOverflow(page, directory(page));

      // The saved current page is an unanswered quiz. Review must allow jumping
      // past it immediately, with no submission or understanding confirmation.
      await selectPage(page, '第 3 页：后续证据整理');
      await expect(player.getByRole('button', { name: '继续讲解', exact: true })).toBeVisible();
      await expect(page.getByPlaceholder('这里没听懂？问一下')).toHaveCount(0);
      await reachable(player.getByRole('button', { name: '继续讲解', exact: true }));
      await player.getByRole('button', { name: '继续讲解', exact: true }).click();
      await expect(player.getByRole('button', { name: '暂停讲解', exact: true })).toBeVisible();
      await player.getByRole('button', { name: '暂停讲解', exact: true }).click();
      await noHorizontalOverflow(page, player);

      await selectPage(page, '第 4 页：当时的作答检测');
      await expect(player.getByText(savedAnswer, { exact: true })).toBeVisible();
      await expect(player.getByText(forgedAnswer, { exact: true })).toHaveCount(0);
      await expect(player.getByText(authoredAnalysis, { exact: true })).toBeVisible();
      await expect(player.getByRole('textbox')).toHaveCount(0);
      await expect(player.getByRole('button', { name: /开始答题|提交答案|重新答题|重试批阅|我已经理解/ })).toHaveCount(0);
      await reachable(player.getByRole('button', { name: '助教讲解', exact: true }));
      await player.getByRole('button', { name: '助教讲解', exact: true }).click();
      const board = page.getByRole('dialog', { name: '助教题目讲解', exact: true });
      await expect(board.getByText(savedAiExplanation, { exact: true }).first()).toBeVisible();
      await expect(board.getByText(savedAnswer, { exact: true })).toBeVisible();
      await expect(board.getByPlaceholder('把不明白的地方告诉助教…')).toHaveCount(0);
      await expect(board.getByRole('button', { name: '发送追问', exact: true })).toHaveCount(0);
      await reachable(board.getByRole('button', { name: '再听一遍', exact: true }));
      await board.getByRole('button', { name: '再听一遍', exact: true }).click();
      await noHorizontalOverflow(page, board);
      await page.screenshot({ path: info.outputPath('saved-ai-explanation.png') });
      await reachable(board.getByRole('button', { name: '关闭讲解', exact: true }));
      await board.getByRole('button', { name: '关闭讲解', exact: true }).click();

      await selectPage(page, '第 2 页：尚未提交的课堂检测');
      await expect(player.getByText('当时未提交本次测验，可浏览题目、参考答案和解析。', { exact: true })).toBeVisible();
      await expect(player.getByRole('button', { name: /统一观察时长/ })).toBeDisabled();
      await expect(player.getByRole('button', { name: /只凭印象判断/ })).toBeDisabled();
      await expect(player.getByText('你的选择', { exact: true })).toHaveCount(0);
      await expect(player.getByRole('textbox')).toHaveCount(0);
      await reachable(player.getByRole('button', { name: '助教讲解', exact: true }));
      await player.getByRole('button', { name: '助教讲解', exact: true }).click();
      await expect(board.getByLabel('统一题目讲解', { exact: true })).toHaveText(unansweredReference);
      await expect(board.getByText('未作答', { exact: true })).toBeVisible();
      await expect(board.getByRole('textbox')).toHaveCount(0);
      await noHorizontalOverflow(page, board);
      await reachable(board.getByRole('button', { name: '关闭讲解', exact: true }));
      await board.getByRole('button', { name: '关闭讲解', exact: true }).click();

      await reachable(tabs.getByRole('button', { name: '我的作答', exact: true }));
      await tabs.getByRole('button', { name: '我的作答', exact: true }).click();
      const answers = page.getByRole('region', { name: '我的作答记录', exact: true });
      await expect(answers.getByText(savedAnswer, { exact: true })).toBeVisible();
      await expect(answers.getByText(authoredAnalysis, { exact: false })).toBeVisible();
      await expect(answers.getByRole('textbox')).toHaveCount(0);
      const answerLecture = answers.getByRole('button', { name: 'AI 讲题 · 第 1 题', exact: true });
      await reachable(answerLecture);
      await answerLecture.click();
      await expect(board.getByText(savedAiExplanation, { exact: true }).first()).toBeVisible();
      await reachable(board.getByRole('button', { name: '关闭讲解', exact: true }));
      await board.getByRole('button', { name: '关闭讲解', exact: true }).click();
      await noHorizontalOverflow(page, answers);
      await tabs.getByRole('button', { name: '回看 AI 课程', exact: true }).click();
      await expect(directory(page)).toBeVisible();
      await selectPage(page, '第 1 页：观察与记录');
      await reachable(player.getByRole('button', { name: '下一页', exact: true }));
      await player.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(player.getByRole('heading', { name: '测验回看', exact: true })).toBeVisible();

      await selectPage(page, '第 4 页：当时的作答检测');
      await player.getByRole('button', { name: '下一页', exact: true }).click();
      const recap = player.getByRole('region', { name: '本课回看', exact: true });
      await expect(recap).toBeVisible();
      await expect(recap.getByText('已提交', { exact: true })).toBeVisible();
      await expect(recap.getByText('1 / 2 题', { exact: true })).toBeVisible();
      await expect(recap.getByText('2 / 2 题', { exact: true })).toHaveCount(0);
      await expect(recap.getByRole('button', { name: '继续完成小测', exact: true })).toHaveCount(0);
      await reachable(recap.getByRole('button', { name: '回看题目与解析', exact: true }));
      await noHorizontalOverflow(page, recap);
      await recap.getByRole('button', { name: '回看题目与解析', exact: true }).click();
      if (await directory(page).isVisible()) {
        await directory(page).getByRole('button', { name: '收起页面目录', exact: true }).click();
      }
      await expect(player.getByText('比较两处鸟类数量时，应先统一什么？', { exact: true })).toBeVisible();
      await expect(player.getByText('当时未提交本次测验，可浏览题目、参考答案和解析。', { exact: true })).toBeVisible();

      // Reload exercises persistence cleanup and rehydration as well as tab
      // unmounts. All server fixtures and the deliberately conflicting browser
      // answer cache must retain their original values.
      expect(await quizCacheSnapshot(page)).toEqual(originalQuizCache);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(directory(page)).toBeVisible();
      expect(await quizCacheSnapshot(page)).toEqual(originalQuizCache);
      await reachable(returnToRecord);
      await returnToRecord.click();
      await expect(page).toHaveURL(new RegExp(`/student/participations/${participationId}$`));
      await expect(page.getByRole('region', { name: '课程复习', exact: true })).toBeVisible();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(recordTabs).toBeVisible();
      expect(await quizCacheSnapshot(page)).toEqual(originalQuizCache);
      fixture.unchanged();
      expect(fixture.readCounts.participation).toBeGreaterThan(0);
      expect(fixture.readCounts.course).toBeGreaterThan(1);
      expect(fixture.readCounts.assessment).toBeGreaterThanOrEqual(2);
      expect(fixture.reviewRequests.some(body => body.questionId === 'saved-reasoning' && body.attemptId === 'saved-review-attempt')).toBe(true);
      expect(fixture.reviewRequests.some(body => body.questionId === 'unanswered-choice' && body.runtimeSceneId === 'unanswered-quiz' && !body.attemptId)).toBe(true);
      expect(fixture.reviewRequests.every(body => body.action === 'review-explanation')).toBe(true);
      expect(fixture.forbiddenWrites).toEqual([]);
      expect(fixture.missingFixtures).toEqual([]);
      expect(fixture.pageErrors).toEqual([]);
    });
  });
}

test.describe('结束课堂的真实项目记录', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  test('shows saved document drafts, immutable submitted versions and teacher feedback without editing controls', async ({ page, baseURL }, info) => {
    test.setTimeout(60_000);
    const fixture = await installReviewFixture(page, baseURL!, { projectRecords: true });
    await page.goto(`${baseURL}/student/participations/${participationId}`);
    const originalQuizCache = await quizCacheSnapshot(page);
    const tabs = page.getByRole('navigation', { name: '课堂回顾导航', exact: true });
    await expect(page.getByRole('heading', { name: courseName, exact: true })).toHaveCount(1);
    await expect(tabs.getByRole('button', { name: '项目回顾', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '教师反馈', exact: true })).toBeVisible();
    await expect(page.getByText(teacherFeedback, { exact: true })).toBeVisible();
    await expect(page.getByText(aiFeedback, { exact: true })).toHaveCount(0);
    await tabs.getByRole('button', { name: '项目回顾', exact: true }).click();

    const documentRecord = page.getByRole('region', { name: '课堂项目记录', exact: true });
    await expect(documentRecord.getByRole('heading', { name: '课堂文档', exact: true })).toBeVisible();
    await expect(documentRecord.getByText('课堂草稿', { exact: true })).toBeVisible();
    await expect(documentRecord.getByRole('heading', { name: '当时保存的观察文档', exact: true })).toBeVisible();
    await expect(documentRecord.getByText('草稿记录：比较前统一观察时长。', { exact: true })).toBeVisible();
    await expect(documentRecord.getByRole('cell', { name: '校园东侧', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '已提交成果版本', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '已提交的科学观察报告', exact: true })).toBeVisible();
    await expect(page.getByText('归档结论：在相同时长内记录并比较两处的数量。', { exact: true })).toBeVisible();
    const download = page.getByRole('link', { name: '下载 Word', exact: true });
    await expect(download).toHaveAttribute('href', '/api/uploads/saved-report-docx?download=1');
    await reachable(download);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /保存|提交|展示此版本|申请修改|编辑|重新生成|发布/ })).toHaveCount(0);
    await noHorizontalOverflow(page, tabs);
    await captureRecord(page, info.outputPath('saved-project-records.png'));

    await tabs.getByRole('button', { name: '我的作答', exact: true }).click();
    await expect(page.getByRole('region', { name: '我的作答记录', exact: true }).getByText(savedAnswer, { exact: true })).toBeVisible();
    await tabs.getByRole('button', { name: '项目回顾', exact: true }).click();
    await expect(page.getByRole('heading', { name: '当时保存的观察文档', exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(tabs).toBeVisible();
    await tabs.getByRole('button', { name: '项目回顾', exact: true }).click();
    await expect(page.getByRole('heading', { name: '已提交的科学观察报告', exact: true })).toBeVisible();
    expect(await quizCacheSnapshot(page)).toEqual(originalQuizCache);
    fixture.unchanged();
    expect(fixture.readCounts.archive).toBeGreaterThan(0);
    expect(fixture.forbiddenWrites).toEqual([]);
    expect(fixture.missingFixtures).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });
});
