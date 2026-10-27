import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { DEFAULT_STAGES, type Course } from '../../src/lib/session/types';
import { captureLayoutScreenshot } from '../../scripts/lib/layout-browser.mjs';

export const desktopCourseId = 'desktop-coverage-course';
export const desktopInstanceId = 'desktop-coverage-instance';
export const desktopParticipationId = 'desktop-coverage-participation';
export const desktopActivityId = 'desktop-coverage-activity';
export const desktopCourseTitle = '跨学科社区生态调查与证据推理：从问题提出、数据采集到方案比较及成果反思（Desktop Review 2026）';
export const desktopStudentName = '跨学科合作探究学习验收学生 · Student 2026';
const fixedTime = '2026-10-18T00:00:00.000Z';
const transientError = '验收故障：学习记录暂时无法读取，请重试。';

const questions = [
  { id: 'q1', type: 'single-choice', prompt: '1. 比较两个地点的鸟类数量时，以下哪种调查记录更能支持合理的解释？', options: ['在相同的观察时长内记录数量、地点及天气条件', '只根据某一天的印象判断'] },
  { id: 'q2', type: 'multiple-choice', prompt: '2. 以下哪些材料可作为比较调查结果的证据？', options: ['有时间和地点的原始观察表', '相同条件下重复调查的记录', '缺少数据来源的结论'] },
  { id: 'q3', type: 'scale', prompt: '3. 我能够用数据解释自己提出的方案。', scale: { min: 1, max: 5, minLabel: '非常不同意', maxLabel: '非常同意' } },
  { id: 'q4', type: 'short-answer', prompt: '4. 请结合观察数据，说明你会如何改进调查方案。' },
  { id: 'q5', type: 'true-false', prompt: '5. 对比调查需要保持必要的观察条件一致。' },
  { id: 'q6', type: 'short-answer', prompt: '6. 请记录本次讨论中的证据、结论以及仍需验证的条件。' },
];

type Audit = {
  unexpected: string[];
  errors: string[];
  consoleErrors: string[];
  failedResources: Array<{ url: string; error?: string; status?: number }>;
  reads: string[];
  writes: string[];
};

export async function installDesktopPageFixtures(page: Page, baseURL: string, role: 'teacher' | 'student') {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Desktop fixtures require a loopback acceptance service.');
  const secretPath = process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt';
  const secret = readFileSync(secretPath, 'utf8').trim();
  const user = { id: `desktop-coverage-${role}`, role, username: `desktop-coverage-${role}`, displayName: role === 'teacher' ? '桌面显示验收教师' : desktopStudentName };
  const token = await new SignJWT({ ...user, sv: 1, userId: user.id, studentName: user.displayName })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  const course = {
    id: desktopCourseId, version: 3, name: desktopCourseTitle, subject: '科学与信息技术', grade: '七年级', hours: 1,
    status: 'preparing', summary: '根据原始证据比较调查方案，理解结论成立的条件。', drivingQuestion: '怎样让社区生态调查更可靠？',
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 0, students: [], resources: [], groups: [],
    content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
    createdAt: fixedTime, updatedAt: fixedTime,
  } as Course;
  const snapshot = {
    schemaVersion: 1, title: desktopCourseTitle, subject: '科学', grade: '七年级', durationMinutes: 45,
    summary: '用真实调查资料分析社区生态问题；注意数据来源、数量、必要条件与方案之间的关系。',
    learningObjectives: ['能够区分观察证据和个人推断，并说明结论成立的必要条件。', '通过协作形成记录、比较、反思与改进方案。'],
    outline: Array.from({ length: 5 }, (_, index) => ({ title: ['问题提出与调查规划', '核心知识与证据解释', '协作整理与方案比较', '成果展示与相互提问', '学习反思与后续改进'][index], durationMinutes: 9, description: '对照原始记录，比较不同条件下的数据，用完整语句说明证据支持哪些结论以及有哪些限制。' })),
    resources: [{ title: '社区调查资料与原始数据说明（含中英文混排的详细文献标题）', url: 'https://example.test/research/desktop-review?source=community-observation-and-comparison-2026' }],
  };
  const outcomes = {
    submissions: [{ id: 'submission-1', stageKey: '0', submittedAt: fixedTime }],
    artifacts: [{ id: 'artifact-1', title: '社区生态调查报告：数据来源、调查条件、比较方法及方案论证（完整版本）', versions: [{ id: 'artifact-v1', sequence: 1, sourceHtml: '<p>我们在相同观察时长内记录了鸟类数量，并保留地点与天气条件。</p>' }] }],
    reflections: [{ id: 'reflection-1', content: '下次调查需要增加样本，并在相同的观察条件下重复记录，用更多证据检验我们的解释。' }],
    evaluations: [{ id: 'evaluation-1', evaluatorType: 'TEACHER', content: '证据来源清楚，方案比较完整；请继续解释观察条件的差异可能带来哪些影响。', score: 92 }],
    showcases: [],
  };
  const ai = {
    conversations: [{ id: 'conversation-1', title: '从原始观察到可解释的结论：讨论数据可靠性与调查边界', status: 'OPEN', messages: [{ id: 'message-1', role: 'assistant', content: '先统一观察时长，再比较不同地点的记录，说明证据和结论的关系。' }], tasks: [{ id: 'task-1', status: 'COMPLETED', error: null }] }],
    supportRecords: [{ id: 'support-1', summary: '根据学生保存的证据表讨论调查条件，保留原始数据并给出下一步验证建议。', status: 'COMPLETED' }],
  };
  const summaries = [3, 2, 1].map((version) => ({
    version, status: version === 2 ? 'PUBLISHED' : 'DRAFT', name: desktopCourseTitle, createdAt: fixedTime,
    pageCount: 18, stageMinutes: 45, measuredSpeechSeconds: 1224, resourceCount: 7,
  }));
  const audit: Audit = { unexpected: [], errors: [], consoleErrors: [], failedResources: [], reads: [], writes: [] };
  // Playwright's serviceWorkers:'block' injects a navigator.serviceWorker read
  // into sandboxed srcdoc previews, where that access itself throws. Only the
  // top-level app can register a worker; keep sandbox previews untouched.
  await page.context().addInitScript(() => {
    if (window !== window.top || !navigator.serviceWorker) return;
    Object.defineProperty(navigator.serviceWorker, 'register', {
      value: () => Promise.reject(new Error('Service worker registration is disabled in the desktop fixture.')),
    });
  });
  let recordMode: 'ready' | 'empty' | 'error' | 'loading' = 'ready';
  let releaseLoading: (() => void) | undefined;
  let draft = { answers: {} as Record<string, string | string[]>, currentPage: 0, version: 0, updatedAt: fixedTime };
  page.on('pageerror', (error) => audit.errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') audit.consoleErrors.push(entry.text()); });
  page.on('requestfailed', (request) => {
    const error = request.failure()?.errorText;
    if (error !== 'net::ERR_ABORTED' && !new URL(request.url()).pathname.startsWith('/api/')) audit.failedResources.push({ url: request.url(), error });
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) audit.failedResources.push({ url: response.url(), status: response.status() });
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== new URL(baseURL).origin) {
      audit.unexpected.push(`External request ${request.url()}`);
      return route.abort('blockedbyclient');
    }
    if (!pathname.startsWith('/api/')) {
      if (method === 'GET' || method === 'HEAD') return route.continue();
      audit.unexpected.push(`${method} ${pathname}`);
      return json({ message: 'Desktop fixture blocks non-API mutations' }, 405);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      audit.writes.push(`${method} ${pathname}`);
      if (method === 'PUT' && pathname === `/api/platform/classroom-instances/${desktopInstanceId}/experiment`) {
        const input = request.postDataJSON() as typeof draft;
        draft = { answers: input.answers, currentPage: input.currentPage, version: draft.version + 1, updatedAt: fixedTime };
        return json({ draft });
      }
      audit.unexpected.push(`${method} ${pathname}`);
      return json({ message: 'Desktop fixture blocks unconfigured mutation' }, 405);
    }
    audit.reads.push(`${method} ${pathname}`);
    if (pathname === '/api/auth/me') return json({ user });
    if (pathname === '/api/platform/auth/student-profile') return json({ user });
    if (pathname === '/api/courses') return json({ courses: [course], user: { role, name: user.displayName }, hydrated: true, updatedAt: fixedTime });
    if (pathname === `/api/courses/${desktopCourseId}/state`) return json({ course, eventCursor: '0' });
    if (pathname === `/api/courses/${desktopCourseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: course.version });
    if (pathname === `/api/courses/${desktopCourseId}/projection`) return json({ courseVersion: course.version, resourceProjection: null, teacherResourceProjection: null });
    if (pathname === `/api/courses/${desktopCourseId}/versions`) {
      const version = Number(url.searchParams.get('version') || 3);
      return json({ courseVersion: course.version, latestVersion: 3, versions: summaries, selected: {
        ...summaries.find((item) => item.version === version), subject: course.subject, grade: course.grade, restorable: true,
        classroomAvailable: true, classroomId: null, summary: course.summary, drivingQuestion: course.drivingQuestion,
        learningObjectives: snapshot.learningObjectives, stagePlan: DEFAULT_STAGES.map((stage) => ({ key: stage.key, title: stage.label, minutes: 9 })),
        pages: Array.from({ length: 18 }, (_, index) => ({ id: `page-${index}`, title: `${index + 1}. 调查证据、观察条件与方案解释：多种材料比较和推理（Evidence Review）`, stageLabel: '知识讲授', seconds: 68 })),
      } });
    }
    if (pathname === `/api/platform/classroom-instances/${desktopInstanceId}/participants`) {
      if (recordMode === 'loading') await new Promise<void>((resolve) => { releaseLoading = resolve; });
      if (recordMode === 'error') return json({ message: transientError }, 503);
      return json({ instance: { id: desktopInstanceId, title: desktopCourseTitle, offeringId: desktopCourseId, status: 'FINISHED', snapshot }, participants: recordMode === 'empty' ? [] : Array.from({ length: 14 }, (_, index) => ({ id: index ? `participation-${index}` : desktopParticipationId, displayName: index ? `协作调查学生 ${index + 1}` : desktopStudentName, lastEnteredAt: fixedTime, completedAt: fixedTime, _count: { artifacts: 2, reflections: 3, evaluations: 1 } })) });
    }
    if (pathname === `/api/platform/classroom-instances/${desktopInstanceId}/experiment/results`) return json({ enabled: false, enrollmentCount: 14, pretestCount: 0, posttestCount: 0, submissions: [] });
    const participationBase = `/api/platform/participations/${desktopParticipationId}`;
    if (pathname === participationBase) return json({
      participation: { id: desktopParticipationId, completedAt: fixedTime }, student: { displayName: desktopStudentName },
      instance: { id: desktopInstanceId, status: 'finished', activityId: desktopActivityId, offeringId: desktopCourseId, offeringName: desktopCourseTitle, title: desktopCourseTitle, runNo: 12, templateVersion: 2, snapshot },
      workspace: { version: 5, projectState: { document: '社区调查报告\n观察地点、日期、样本数量和调查条件均已保存。'.repeat(12), code: '<article><h1>Evidence Review</h1><p>保留原始观察记录。</p></article>', stageKey: '2' } },
      isTeacher: role === 'teacher', canWrite: false,
    });
    if (pathname === `${participationBase}/outcomes`) return json(outcomes);
    if (pathname === `${participationBase}/ai`) return json(ai);
    if (pathname === `/api/platform/classroom-instances/${desktopInstanceId}/experiment`) return json({ enabled: true, available: true, studentKey: user.id, questions, draft: draft.version ? draft : null, submission: null, minutes: 15, introduction: '请根据本次社区生态调查课程中的真实材料作答。注意数据来源、观察条件、证据数量，以及结论成立的边界。' });
    audit.unexpected.push(`${method} ${pathname}`);
    return json({ message: `No desktop fixture for ${pathname}` }, 404);
  });
  return { audit, transientError, setRecordMode(mode: typeof recordMode) { recordMode = mode; if (mode !== 'loading') releaseLoading?.(); } };
}

export async function assertDesktopPageRendering(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const image of document.images) image.loading = 'eager';
    await Promise.all([...document.images].map((image) => Promise.race([image.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))])));
  });
  const metrics = await page.evaluate(() => ({
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    brokenImages: [...document.images].filter((image) => image.getClientRects().length > 0 && (!image.complete || image.naturalWidth === 0)).map((image) => image.currentSrc),
  }));
  expect(metrics.brokenImages, 'All rendered images decode from actual application assets').toEqual([]);
  expect(metrics.scrollWidth, 'Page content fits; internal table scrolling is allowed').toBeLessThanOrEqual(metrics.width + 2);
  await expect(page.locator('body')).not.toContainText('Application error');
  return metrics;
}

export async function attachDesktopState(page: Page, info: TestInfo, label: string) {
  const path = info.outputPath(`${label}.png`);
  await captureLayoutScreenshot(page, path, Boolean(process.env.OPENPBL_DESKTOP_NATIVE_ZOOM));
  await info.attach(label, { path, contentType: 'image/png' });
  await assertDesktopPageRendering(page);
}

export const desktopPageScenarios = [
  { id: 'teacher-versions', role: 'teacher' as const, path: `/teacher/prepare/${desktopCourseId}/versions`, async exercise(page: Page, info: TestInfo) {
    await expect(page.getByRole('heading', { name: '版本时间线', exact: true })).toBeVisible();
    await attachDesktopState(page, info, 'current-version');
    await page.getByRole('button', { name: /^v2 / }).click();
    await expect(page.getByRole('button', { name: '恢复为新草稿', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '恢复为新草稿', exact: true }).click();
    const confirmation = page.getByRole('group', { name: '确认恢复历史版本' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '确认恢复', exact: true }).click({ trial: true });
    await attachDesktopState(page, info, 'restore-confirmation');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await page.getByRole('heading', { name: /学生课堂页面/ }).scrollIntoViewIfNeeded();
    await attachDesktopState(page, info, 'historical-page-list');
  } },
  { id: 'teacher-records', role: 'teacher' as const, path: `/teacher/classrooms/${desktopInstanceId}`, async exercise(page: Page, info: TestInfo) {
    const table = page.getByRole('table', { name: '学生参与、成果、反思和评价记录' });
    await expect(table.getByRole('row')).toHaveCount(15);
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    await expect(table.getByRole('row')).toHaveCount(15);
    await attachDesktopState(page, info, 'classroom-records');
    const link = page.getByRole('link', { name: `查看与评价 ${desktopStudentName}`, exact: true });
    // At split-window widths the table scrolls within its own container.
    await link.scrollIntoViewIfNeeded();
    await link.click({ trial: true });
    await attachDesktopState(page, info, 'classroom-records-table-actions');
  } },
  ...(['teacher', 'student'] as const).map((role) => ({ id: `${role}-participation`, role, path: `/${role}/participations/${desktopParticipationId}`, async exercise(page: Page, info: TestInfo) {
    await expect(page.getByRole('heading', { name: role === 'teacher' ? `${desktopStudentName}的学习档案` : desktopCourseTitle, exact: true })).toBeVisible();
    for (const name of ['成果与评价', '课堂任务', '项目工作区', 'AI 协作']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      if (name === '项目工作区') await expect(page.getByRole('textbox', { name: '项目文档', exact: true })).toHaveAttribute('readonly', '');
      await attachDesktopState(page, info, `participation-${name}`);
    }
    await page.reload();
    await expect(page.getByRole('button', { name: '成果与评价', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } })),
  ...(['pretest', 'posttest'] as const).map((phase) => ({ id: `student-${phase}`, role: 'student' as const, path: `/student/activities/${desktopActivityId}/assessments/${desktopInstanceId}/${phase}`, async exercise(page: Page, info: TestInfo) {
    const label = phase === 'pretest' ? '前测' : '后测';
    const footer = page.getByRole('contentinfo', { name: `${label}操作栏`, exact: true });
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(footer).toBeInViewport({ ratio: 1 });
    await footer.getByRole('button', { name: '下一步', exact: true }).click({ trial: true });
    await attachDesktopState(page, info, `${phase}-questions`);
    await footer.getByRole('button', { name: '下一步', exact: true }).click();
    const input = page.getByRole('textbox', { name: /本次讨论/ });
    await input.fill('我们依据原始观察数据解释方案，并保留条件与样本数量。');
    // Filling a partly visible textarea does not promise that its bottom is
    // above a fixed footer. Wheel over the actual question, after any page
    // transition scroll, rather than assuming a single delta in native zoom.
    const scrollSamples: Array<{ overlap: number; answerY: number; footerY: number }> = [];
    try {
      await expect.poll(async () => {
        const [answer, controls] = await Promise.all([input.boundingBox(), footer.boundingBox()]);
        const overlap = answer!.y + answer!.height - controls!.y;
        scrollSamples.push({ overlap, answerY: answer!.y, footerY: controls!.y });
        if (overlap > 0) {
          // The card's left padding avoids scrolling inside the textarea.
          await page.mouse.move(Math.max(1, answer!.x - 8), Math.max(1, Math.min(answer!.y + 8, controls!.y - 8)));
          await page.mouse.wheel(0, Math.max(96, overlap + 32));
        }
        return overlap;
      }, { message: 'Ordinary scrolling reveals the full answer above the fixed action bar', intervals: [100, 250, 500] }).toBeLessThanOrEqual(0);
    } finally {
      await info.attach('assessment-scroll', { body: JSON.stringify({ samples: scrollSamples, final: await page.evaluate(() => ({
        scrollY, scrollHeight: document.documentElement.scrollHeight, innerHeight,
      })) }, null, 2), contentType: 'application/json' });
    }
    await expect(footer).toBeInViewport({ ratio: 1 });
    const [inputBounds, footerBounds] = await Promise.all([input.boundingBox(), footer.boundingBox()]);
    expect(inputBounds!.y).toBeGreaterThanOrEqual(0);
    expect(inputBounds!.y + inputBounds!.height, 'Scrolling reveals the full answer above the fixed action bar').toBeLessThanOrEqual(footerBounds!.y);
    await attachDesktopState(page, info, `${phase}-last-question`);
    await footer.getByRole('button', { name: '检查并提交', exact: true }).click();
    await expect(footer.getByRole('button', { name: `确认提交${label}`, exact: true })).toBeDisabled();
    await attachDesktopState(page, info, `${phase}-review`);
    await footer.getByRole('button', { name: '返回作答', exact: true }).click();
    await expect(input).toHaveValue('我们依据原始观察数据解释方案，并保留条件与样本数量。');
  } })),
];
