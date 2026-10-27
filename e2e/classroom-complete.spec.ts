import { browserLearningEventReceipt } from '../scripts/lib/classroom-acceptance-action-receipts.mjs';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';

const timestamp = '2026-10-15T00:00:00.000Z';
type ReviewScope = { courseId?: string; classroomId?: string; studentId?: string };
const reviewDirectory = (page: Page) => page.getByRole('navigation', { name: '页面目录', exact: true })
  .or(page.getByRole('dialog', { name: '页面目录', exact: true }));

async function studentThemeColors(page: Page) {
  return page.locator('[data-stage-host-mode="student"]').evaluate(element => {
    const probe = document.createElement('span');
    element.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const colors = { accent: resolve('--pbl-student'), soft: resolve('--pbl-student-soft') };
    probe.remove();
    return colors;
  });
}

function playbackCue() {
  const samples = 8000 * 10;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

// Exercise the shipped player and ending page. Synthetic identities, attempts,
// progress and all business writes stay inside browser route fixtures.
async function openReview(page: Page, baseURL: string, mode: 'graded' | 'pending' | 'unsubmitted' | 'none' = 'graded', scope: ReviewScope = {}, withPlayback = false) {
  const { courseId = 'completion-review-fixture', classroomId = 'completion-review-classroom', studentId = 'completion-review-student' } = scope;
  const errors: string[] = [];
  const scene = (id: string, order: number) => ({
    id, stageId: classroomId, outlineId: id, title: id === 'intro' ? '观察与记录' : '比较证据', type: 'slide', order,
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching',
    actions: withPlayback ? [{ id: `${id}-speech`, type: 'speech', text: '观察与记录',
      audioUrl: `/api/openmaic/classroom-media/${classroomId}/audio/theme-cue.wav`, audioDurationSec: 10 }] : [],
    content: { type: 'slide', canvas: { id: `canvas-${id}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#16766d'], fontColor: '#29394f', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [] } },
  });
  const questions = [
    { id: 'conditions', type: 'single', question: '比较观察结果时，应该控制什么条件？', points: 20,
      options: [{ value: 'A', label: '观察时长' }, { value: 'B', label: '凭印象比较' }], answer: ['A'] },
    { id: 'evidence', type: 'short_answer', question: '请说明如何记录观察证据。', points: 15, answer: '记录日期、地点、时长与数量' },
    { id: 'method', type: 'short_answer', format: 'fill_blank', question: '观察时长应保持什么关系？', points: 10, answer: '一致' },
  ];
  const attempt = {
    id: 'saved-first-attempt', sectionId: 'observation-section', quizOutlineId: 'quiz-outline', runtimeSceneId: 'previous-device-quiz',
    submittedAt: timestamp, gradingSource: 'server', gradingStatus: mode === 'pending' ? 'pending' : 'graded',
    score: 35, maxScore: 45, knowledgePointIds: [],
    questions: questions.map((question, index) => ({ questionId: question.id, prompt: question.question,
      questionType: question.type, answer: index ? '记录与比较' : 'A', rawAnswer: index ? '记录与比较' : 'A',
      points: question.points, earned: mode === 'pending' ? 0 : [20, 5, 10][index], correct: index === 0 ? true : null,
      gradingStatus: mode === 'pending' ? 'pending' : 'graded', feedback: '', knowledgePointIds: [] })),
  };
  const scenes = [scene('intro', 0), scene('evidence', 1), ...(mode === 'none' ? [] : [{
    id: 'quiz', stageId: classroomId, outlineId: 'quiz-outline', type: 'quiz', title: '观察方法检测', order: 2, actions: [],
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', content: { type: 'quiz', questions },
  }])];
  const course = {
    id: courseId, version: 1, name: '社区生态调查：从观察记录到有证据支持的行动方案', status: 'teaching', subject: '科学', grade: '初中', hours: 1,
    createdAt: timestamp, updatedAt: timestamp, currentStageIndex: 1, aiLearningClassroomId: classroomId,
    stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource' }, { key: 'ai-learning', label: '知识讲授', view: 'ai-learning' }],
    students: [{ id: studentId, name: '学习回顾验收', joinedAt: timestamp, stageProgress: {} }],
    aiLearningProgress: { [studentId]: { classroomId, currentSceneIndex: 0, totalScenes: scenes.length,
      completedScenes: [], completionModelVersion: 2, knowledgeLectureAttempts: mode === 'none' || mode === 'unsubmitted' ? [] : [attempt], lastActiveAt: timestamp } },
    content: { knowledgePoints: [], lessonOutline: [], pblOutline: '', evaluationPlan: { dimensions: [], overallRubric: '' } },
    resources: [], groups: [], submissions: [], activityLog: [], uiState: {},
  };
  const secret = (await readFile(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '学习回顾验收', displayName: '学习回顾验收', username: studentId })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
  await page.routeWebSocket('**/*', socket => socket.close());
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (withPlayback && pathname === `/api/openmaic/classroom-media/${classroomId}/audio/theme-cue.wav`) {
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: playbackCue() });
    }
    if (pathname === '/api/auth/me') return json({ user: { id: studentId, role: 'student', displayName: '学习回顾验收' } });
    if (pathname === '/api/courses') return json({ courses: [course], hydrated: true, user: { role: 'student', name: '学习回顾验收' }, studentId, joinedCourseId: courseId });
    if (pathname === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (pathname.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false });
    if (pathname.endsWith('/presence')) return json({ members: [] });
    if (pathname.endsWith('/projection')) return json({ courseId, courseVersion: 1, projectionVersion: 0, resourceProjection: null, teacherResourceProjection: null });
    if (pathname.endsWith('/public-discussion')) return json({ enabled: false, session: null });
    if (pathname === '/api/openmaic/classroom') return json({ success: true, classroom: { stage: { id: classroomId, name: course.name, createdAt: 1, updatedAt: 1 }, scenes } });
    if (pathname === '/api/openmaic/progress') return json({ data: { progress: {} } });
    if (pathname === '/api/knowledge-lecture/settings') return json({ settings: {} });
    if (pathname.endsWith('/lecture-chat')) return json({ thread: { id: 'review-thread', messages: [] }, requests: [], writable: true });
    if (pathname === '/api/learning-events' && request.method() === 'POST') {
      const receipt = browserLearningEventReceipt(request.postData(), Date.now());
      return json(receipt.body, receipt.status);
    }
    if (pathname.includes('learning-events') || pathname.includes('learning-analytics')) return json({ success: true });
    if (/provider|server-providers/.test(pathname)) return json({ providers: [], models: [], success: true });
    if (pathname.endsWith('/actions')) return json({ success: true, courseVersion: 1 });
    errors.push(`Missing fixture: ${request.method()} ${pathname}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseURL}/student/classroom/${courseId}`);
  await expect(page.getByPlaceholder('这里没听懂？问一下')).toBeVisible();
  await expect(page.getByRole('button', { name: '展开页面目录', exact: true })).toHaveCount(0);
  for (let index = 0; index < scenes.length; index += 1) {
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    if (index < scenes.length - 1) {
      await expect(page.getByText(`${index + 2} / ${scenes.length + 1}`, { exact: true })).toBeVisible();
    }
  }
  const review = page.getByRole('region', { name: '本课学习完成' });
  await expect(review).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'AI 授课字幕与播放控制' })).toHaveCount(0);
  await expect.poll(() => review.evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.pending || animation.playState === 'running').length)).toBe(0);
  return { review, errors };
}

for (const viewport of [
  { width: 1440, height: 900 }, { width: 768, height: 576 },
  { width: 1024, height: 768 }, { width: 768, height: 1024 },
  { width: 390, height: 844 }, { width: 320, height: 568 },
  { width: 844, height: 390 }, { width: 568, height: 320 },
]) {
  test.describe(`课堂学习回顾 ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, ...(viewport.width <= 1024 ? { hasTouch: true,
      ...(process.env.PRELAUNCH_E2E_BROWSER === 'firefox' ? {} : { isMobile: true }) } : {}) });
    test('keeps results and review actions readable and reachable', async ({ page, baseURL }, testInfo) => {
      const { review, errors } = await openReview(page, baseURL!);
      await expect(review.getByText('正确率', { exact: true })).toBeVisible();
      const accuracy = review.locator('dd').filter({ hasText: /^67%$/ });
      await expect(accuracy).toBeVisible();
      await expect(review.getByText(/\d+ \/ \d+ 分/)).toHaveCount(0);
      const accuracyLayout = await accuracy.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return { lines: range.getClientRects().length, overflow: element.scrollWidth > element.clientWidth + 1 };
      });
      expect(accuracyLayout).toEqual({ lines: 1, overflow: false });
      await expect(review.getByText('3 / 3 题')).toBeVisible();
      await expect(review.getByText('完全答对')).toBeVisible();
      await expect(review.getByText('2 题', { exact: true })).toBeVisible();
      await expect(review.getByText(/别忘了回看错题与解析/)).toBeVisible();
      await expect(review.getByRole('heading')).toHaveCount(1);
      await expect(review.getByRole('button')).toHaveCount(2);
      await expect(review.getByRole('group', { name: '小测回顾' })).toHaveCount(1);
      await expect(review.getByText(/^(本课内容|知识讲授)$|题数|道题可以继续巩固/)).toHaveCount(0);
      await expect(review.locator('svg[viewBox="0 0 200 200"]')).toBeVisible();
      const layout = await review.evaluate(element => ({
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        infiniteAnimations: element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations === Infinity).length,
      }));
      expect(layout).toEqual({ horizontalOverflow: false, pageOverflow: false, infiniteAnimations: 0 });
      await page.screenshot({ path: testInfo.outputPath('lesson-review.png') });
      for (const name of ['回看错题与解析', '回顾本课内容']) {
        const button = review.getByRole('button', { name });
        await button.scrollIntoViewIfNeeded();
        const bounds = await button.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
      }
      await review.getByRole('button', { name: '回看错题与解析' }).click();
      await expect(review).toHaveCount(0);
      await expect(page.getByText('比较观察结果时，应该控制什么条件？', { exact: true })).toBeVisible();
      const panel = reviewDirectory(page);
      const directory = page.getByRole('button', { name: '展开页面目录', exact: true });
      await expect(panel).toBeVisible();
      await expect(directory).toHaveCount(0);
      await expect(panel.getByRole('button', { name: '第 3 页：观察方法检测', exact: true })).toHaveAttribute('aria-current', 'page');
      await panel.getByRole('button', { name: '收起页面目录', exact: true }).click();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(review).toBeVisible();
      await review.getByRole('button', { name: '回顾本课内容' }).click();
      await expect(review).toHaveCount(0);
      await expect(page.getByPlaceholder('这里没听懂？问一下')).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'AI 授课字幕与播放控制' })).toBeVisible();
      await expect(panel).toBeVisible();
      await expect(directory).toHaveCount(0);
      const activePage = panel.getByRole('button', { name: '第 1 页：观察与记录', exact: true });
      const colors = await studentThemeColors(page);
      await expect(activePage).toHaveAttribute('aria-current', 'page');
      await expect(activePage).toHaveCSS('background-color', colors.soft);
      await expect(activePage.getByTestId('scene-title')).toHaveCSS('color', colors.accent);
      await expect(activePage.getByText('1', { exact: true })).toHaveCSS('background-color', colors.accent);
      expect(await panel.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= -1 && bounds.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
      })).toBe(true);
      if (await page.evaluate(() => innerWidth <= 1023)) {
        await expect(panel.getByRole('button', { name: '第 1 页：观察与记录', exact: true })).toBeFocused();
      }
      await page.screenshot({ path: testInfo.outputPath('review-directory-expanded.png') });
      await panel.getByRole('button', { name: '收起页面目录', exact: true }).click();
      await expect(page.locator('[data-canvas-play-hint] svg')).toHaveCSS('color', colors.accent);
      await expect(page.getByRole('button', { name: '继续讲解', exact: true })).toHaveCSS('background-color', colors.accent);
      await expect(directory).toBeVisible();
      await expect(directory).toHaveAttribute('aria-expanded', 'false');
      await directory.focus();
      await page.keyboard.press('Enter');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('scene-item')).toHaveCount(3);
      if (await page.evaluate(() => innerWidth <= 1023)) {
        const controls = await panel.getByRole('button').all();
        await expect(controls.at(-1)!).toContainText('学习回顾');
        await controls[0].focus();
        for (const control of controls.slice(1)) {
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
        }
        await page.keyboard.press('Tab');
        await expect(controls[0]).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(controls.at(-1)!).toBeFocused();
      }
      await panel.getByRole('button', { name: '第 2 页：比较证据', exact: true }).click();
      await expect(page.getByText('2 / 4', { exact: true })).toBeVisible();
      if (await page.evaluate(() => innerWidth <= 1023)) {
        await expect(panel).toBeHidden();
        await expect(directory).toBeFocused();
        await directory.click();
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(directory).toBeFocused();
      } else {
        await panel.getByRole('button', { name: '收起页面目录', exact: true }).click();
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(directory).toBeVisible();
      await expect(directory).toHaveAttribute('aria-expanded', 'false');
      expect(errors).toEqual([]);
    });
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`学生播放主题 ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, reducedMotion: 'reduce' });
    test('keeps the student theme through play, pause and review selection', async ({ page, baseURL }, testInfo) => {
      const { review, errors } = await openReview(page, baseURL!, 'none', {}, true);
      await review.getByRole('button', { name: '回顾本课内容', exact: true }).click();
      const panel = reviewDirectory(page);
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: '收起页面目录', exact: true }).click();
      const colors = await studentThemeColors(page);
      const play = page.getByRole('button', { name: '继续讲解', exact: true });
      await expect(play).toHaveCSS('background-color', colors.accent);
      await expect(page.locator('[data-canvas-play-hint] svg')).toHaveCSS('fill', colors.accent);
      await play.click();
      await page.mouse.move(0, 0);
      const pause = page.getByRole('button', { name: '暂停讲解', exact: true });
      await expect(pause).toBeVisible();
      await expect(pause).toHaveCSS('background-color', colors.accent);
      await expect(page.getByLabel('正在讲解', { exact: true }).locator('span').first()).toHaveCSS('background-color', colors.accent);
      await expect(page.locator('[data-canvas-play-hint]')).toHaveCSS('opacity', '0');
      await page.screenshot({ path: testInfo.outputPath('student-theme-playing.png') });
      await pause.click();
      await expect(play).toBeVisible();
      await expect(page.locator('[data-canvas-play-hint] svg')).toHaveCSS('color', colors.accent);
      await expect(page.locator('[data-canvas-play-hint]')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: testInfo.outputPath('student-theme-paused.png') });
      expect(errors).toEqual([]);
    });
  });
}

test('late server grades replace pending feedback on the open ending page', async ({ page, baseURL }) => {
  const { review, errors } = await openReview(page, baseURL!, 'pending');
  await expect(review.getByText('待批阅', { exact: true })).toBeVisible();
  await expect(review.getByText('3 / 3 题')).toBeVisible();
  await expect(review.getByText('0 题', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: '查看作答记录' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('openpbl:knowledge-lecture-server-graded', { detail: { sceneId: 'quiz', results: [
    { questionId: 'conditions', correct: true, status: 'correct', earned: 20 },
    { questionId: 'evidence', correct: null, status: 'graded', earned: 15 },
    { questionId: 'method', correct: null, status: 'graded', earned: 10 },
  ] } })));
  await expect(review.getByText('正确率', { exact: true })).toBeVisible();
  await expect(review.getByText('100%', { exact: true })).toBeVisible();
  await expect(review.getByText('3 题', { exact: true })).toBeVisible();
  await expect(review.getByText(/这次小测全部答对了/)).toBeVisible();
  await expect(review.getByText('待批阅', { exact: true })).toHaveCount(0);
  await expect(review.getByRole('button', { name: '回看小测' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('unfinished quiz feedback leads directly back to the unanswered quiz', async ({ page, baseURL }) => {
  const { review, errors } = await openReview(page, baseURL!, 'unsubmitted');
  await expect(review.getByText('0 / 3 题')).toBeVisible();
  await expect(review.getByText('待提交', { exact: true })).toBeVisible();
  await expect(review.getByText(/还有小测未完成/)).toBeVisible();
  await expect(review.getByText('正确率', { exact: true })).toHaveCount(0);
  await review.getByRole('button', { name: '继续完成小测' }).click();
  await expect(review).toHaveCount(0);
  await expect(reviewDirectory(page)).toBeVisible();
  await reviewDirectory(page).getByRole('button', { name: '收起页面目录', exact: true }).click();
  await page.getByRole('button', { name: '开始答题', exact: true }).click();
  await expect(page.getByText('比较观察结果时，应该控制什么条件？', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('回顾目录状态隔离', () => {
  test.use({ reducedMotion: 'reduce' });
  const scopes: { name: string; scope: ReviewScope }[] = [
    { name: 'student identity', scope: { studentId: 'completion-review-another-student' } },
    { name: 'course session', scope: { courseId: 'completion-review-another-session' } },
    { name: 'classroom', scope: { classroomId: 'completion-review-another-classroom' } },
  ];
  for (const { name, scope } of scopes) {
    test(`does not transfer unlocked review to another ${name} in the same browser context`, async ({ page, baseURL }) => {
      const first = await openReview(page, baseURL!, 'none');
      await first.review.getByRole('button', { name: '回顾本课内容', exact: true }).click();
      await expect(reviewDirectory(page)).toBeVisible();
      // Preserve cookies/storage in this context. The second fixture asserts
      // the new, uncompleted scope has no directory before visiting its ending.
      const second = await openReview(page, baseURL!, 'none', scope);
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    });
  }
});

test.describe('减少动态效果', () => {
  test.use({ reducedMotion: 'reduce' });
  test('shows a static, usable ending for a lesson without quizzes', async ({ page, baseURL }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    const { review, errors } = await openReview(page, baseURL!, 'none');
    await expect(review.getByRole('heading', { name: '本课学习完成' })).toBeVisible();
    await expect(review.getByRole('group', { name: '小测回顾' })).toHaveCount(0);
    await expect(review.getByRole('button')).toHaveCount(1);
    expect(await review.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    const button = review.getByRole('button', { name: '回顾本课内容' });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(review).toHaveCount(0);
    await expect(reviewDirectory(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
