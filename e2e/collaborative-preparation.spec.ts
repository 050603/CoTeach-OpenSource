import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { DEFAULT_STAGES } from '../src/lib/session/types';
import type { PreparationMutationInput, PreparationQuestion, PreparationSessionSnapshot } from '../src/lib/collaborative-preparation/types';
import { preparationPlanFixture } from '../src/lib/collaborative-preparation/fixtures.test-support';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
const courseId = 'e2e-collaborative-preparation';
const date = '2026-10-23T10:00:00.000Z';

const latestPrompt = '这节课希望学生怎样比较不同条件下的蒸发现象？';
const nextPrompt = '你希望怎样检查学生是否真正理解了蒸发？';
const draft = '保留湿手帕的案例，让学生先预测，再记录实际观察。';
const longStageRequirement = '每组分别记录通风、温度和表面积的变化，明确保持不变的条件，并依据三次实际观察解释结果。'.repeat(8);
const finalLearningObjective = '将控制变量的方法迁移到晾晒衣物的新情境，比较证据的充分性并说明实验结论的适用条件。';

function discussionQuestion(id: string, prompt: string): PreparationQuestion {
  return { id, prompt, reason: '先明确学生的观察与解释任务，再确定教师怎样提供帮助。', options: [
    { id: 'groups', label: '小组对照观察', description: '每组只改变一个条件，记录现象并比较结果，再向其他小组说明推断的依据。' },
    { id: 'demo', label: '教师演示并讨论', description: '教师展示不同条件下的湿手帕，学生先独立预测，再根据实际观察修正解释。' },
    { id: 'individual', label: '先独立思考再交流', description: '每位学生先写出自己的想法，小组讨论哪些观察能支持判断，最后共同整理证据。' },
  ] };
}

function longDiscussion(): PreparationSessionSnapshot {
  const turns: PreparationSessionSnapshot['turns'] = [];
  for (let index = 0; index < 14; index += 1) {
    turns.push({ id: `history-user-${index}`, role: 'user', content: `第 ${index + 1} 轮教师要求：保留真实生活案例，给学生充分的观察和交流时间。`, createdAt: date });
    turns.push({ id: `history-ai-${index}`, role: 'assistant', content: '已经记录你的教学想法，我们再明确下一项教学安排。', createdAt: date,
      question: discussionQuestion(`history-${index}`, `第 ${index + 1} 轮具体问题：学生需要哪些观察支持？`) });
  }
  const question = discussionQuestion('latest', latestPrompt);
  turns.push({ id: 'latest-assistant', role: 'assistant', content: '已经保留前面的教学决定，请继续明确课堂上的观察活动。', createdAt: date, question });
  const plan = preparationPlanFixture();
  plan.learningObjectives.push(
    '分别描述通风、温度和表面积如何影响蒸发，并结合观察说明哪些条件需要保持不变。',
    '完整记录实验过程，区分直接观察到的现象与基于证据作出的解释。',
    finalLearningObjective,
  );
  plan.knowledgePoints = Array.from({ length: 6 }, (_, index) => ({
    id: `extended-knowledge-${index}`, name: `观察与解释任务 ${index + 1}`,
    depth: '比较不同实验条件下的实际证据，能说明结论的依据和边界。'.repeat(4),
    teachingApproach: '先独立预测，再以小组对照实验记录结果，用实际证据讨论不同解释。'.repeat(4),
  }));
  plan.stagePlan.stages = plan.stagePlan.stages.map((stage) => ({ ...stage, requirements: longStageRequirement }));
  return { id: 'preparation-1', revision: 15, status: 'discussing', turns, currentQuestion: question,
    plan, fieldOrigins: { grade: 'teacher-stated', teachingApproach: 'ai-proposed' }, readyToConfirm: false,
    missingFields: ['教学活动与检测方式'], suggestions: [], referenceIds: [], referenceMaterials: [], textbookSelections: [], confirmed: null, error: null };
}

for (const viewport of [{ width: 1280, height: 850 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`long course plans stay compact and open read-only details at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const session = longDiscussion();
    session.missingFields = ['teachingApproach', 'teacherRequirements', 'stagePlan'];
    const result = await mockPreparation(page, { initialSession: session });
    await openDiscussion(page);
    const answer = page.getByRole('textbox', { name: '备课想法' });
    const option = page.getByRole('radio', { name: /小组对照观察/ });
    await option.check();
    await answer.fill(draft);

    const summary = page.getByRole('complementary', { name: '课程方案摘要', exact: true });
    await summary.scrollIntoViewIfNeeded();
    await expect(summary).toContainText('水的蒸发');
    await expect(summary).toContainText('四年级');
    await expect(summary).toContainText('45');
    await expect(summary).not.toContainText(longStageRequirement);
    await expect(summary).not.toContainText(finalLearningObjective);
    await expect.poll(() => summary.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(560);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('compact-course-summary.png'), animations: 'disabled' });

    const missingFields = summary.locator('details').filter({ has: page.locator('summary').filter({ hasText: '还需明确 3 项' }) });
    await expect(missingFields).toHaveJSProperty('open', false);
    await missingFields.locator('summary').click();
    await expect(missingFields).toHaveJSProperty('open', true);
    for (const field of ['教学方式', '教师特别要求', '五阶段安排']) await expect(missingFields).toContainText(field);
    await missingFields.locator('summary').click();

    const groups = ['课程概况', '目标与教学', '阶段与成果', '教师要求'];
    const dialog = page.getByRole('dialog', { name: '课程方案详情', exact: true });
    const group = (name: string) => dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: name }) });
    for (const selected of groups) {
      const trigger = summary.getByRole('button', { name: `查看${selected}`, exact: true });
      await expect.poll(() => trigger.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await trigger.click();
      await expect(dialog).toBeVisible();
      for (const name of groups) await expect(group(name)).toHaveJSProperty('open', name === selected);
      await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      if (selected === '课程概况') await expect(group(selected)).toContainText('教师已明确');
      if (selected === '目标与教学') {
        await expect(group(selected)).toContainText(finalLearningObjective);
        await expect(group(selected)).toContainText('观察与解释任务 6');
        await expect(group(selected)).toContainText('AI 建议 · 待确认');
      }
      if (selected === '阶段与成果') {
        await expect(group(selected)).toContainText(longStageRequirement);
        await expect(group(selected)).toContainText('记录观察结果');
        await expect(group(selected)).toContainText('能识别自变量并保持其他条件一致');
        const body = dialog.getByLabel('课程方案详细内容', { exact: true });
        await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expect(dialog.getByRole('button', { name: '返回备课', exact: true })).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: info.outputPath('course-plan-details.png'), animations: 'disabled' });
        await group('教师要求').locator('summary').click();
        await expect(group('教师要求')).toHaveJSProperty('open', true);
        await expect(group('阶段与成果')).toHaveJSProperty('open', false);
        await expect(group('教师要求')).toContainText('保留湿手帕案例');
      }
      const close = dialog.getByRole('button', { name: '返回备课', exact: true });
      await expect.poll(() => close.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      if (selected === '教师要求') await close.click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(answer).toHaveValue(draft);
      await expect(option).toBeChecked();
    }
    expect(result.discussionRequests).toHaveLength(0);
    expect(result.generationRequests).toHaveLength(0);
    expect(result.errors).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });
}

async function mockPreparation(page: Page, options: { initialSession?: PreparationSessionSnapshot; continueDiscussion?: boolean; processing?: boolean } = {}) {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
  if (secret && secret.length >= 32) {
    const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'e2e-preparation', displayName: '备课验收教师' }).setProtectedHeader({ alg: 'HS256' }).setSubject('e2e-teacher').setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  }
  const course = { id: courseId, version: 1, name: '协同备课验收', subject: '', grade: '', hours: 1, status: 'draft', summary: '', drivingQuestion: '', stages: DEFAULT_STAGES, currentStageIndex: 0, students: [], resources: [], groups: [], createdAt: date, updatedAt: date, content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } } };
  let session: PreparationSessionSnapshot | null = options.initialSession ?? null;
  let completedSession: PreparationSessionSnapshot | null = null;
  let job: Record<string, unknown> | null = null;
  const generationRequests: Record<string, unknown>[] = [];
  const discussionRequests: PreparationMutationInput[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket((url) => !url.pathname.includes('_next'), (socket) => socket.onMessage(() => {}));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname === '/api/auth/me') return json({ user: { id: 'e2e-teacher', role: 'teacher', name: '备课验收教师' } });
    if (pathname === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '备课验收教师' }, hydrated: true, updatedAt: date });
    if (pathname === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (pathname.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (pathname.endsWith('/presence')) return json({ members: [], degraded: false });
    if (pathname === '/api/textbooks') return json({ textbooks: [] });
    if (pathname.endsWith('/resource-package')) return json({ job: null });
    if (pathname.endsWith('/collaborative-preparation')) {
      if (request.method() === 'GET') return json({ session });
      const body = request.postDataJSON() as PreparationMutationInput;
      discussionRequests.push(body);
      expect(body.revision).toBe(session?.revision ?? 0);
      expect(body.requestId).toBeTruthy();
      if (body.action === 'confirm') {
        expect(session?.readyToConfirm).toBe(true);
        session = { ...session!, status: 'confirmed', revision: session!.revision + 1, confirmed: { sessionId: session!.id, revision: session!.revision + 1, confirmedAt: date, confirmedBy: 'e2e-teacher', plan: preparationPlanFixture(), referenceIds: [], textbookSelections: [] } };
      } else if (options.continueDiscussion && session) {
        const question = discussionQuestion(`next-${session.revision}`, nextPrompt);
        const answering: PreparationSessionSnapshot = { ...session, revision: session.revision + 1, status: 'processing', currentQuestion: null,
          turns: [...session.turns, { id: `new-user-${session.revision}`, role: 'user', content: body.message ?? '', createdAt: date }] };
        completedSession = { ...answering, revision: answering.revision + 1, status: 'discussing', currentQuestion: question,
          turns: [...answering.turns, { id: `new-assistant-${session.revision}`, role: 'assistant', content: '已保留你补充的案例，接下来讨论怎样检查学生理解。', createdAt: date, question }] };
        session = options.processing ? answering : completedSession;
      } else {
        const first = !session;
        session = { id: 'preparation-1', revision: (session?.revision ?? 0) + 1, status: first ? 'discussing' : 'ready',
          turns: [...(session?.turns ?? []), { id: `user-${session?.revision ?? 0}`, role: 'user', content: body.message ?? '', createdAt: date }, { id: `assistant-${session?.revision ?? 0}`, role: 'assistant', content: first ? '我们先明确教学对象。' : '教学目标已明确，可以核对方案，也可以继续讨论。', createdAt: date }],
          currentQuestion: first ? { id: 'grade', prompt: '这节课面向什么年级？', options: [{ id: 'primary', label: '小学四年级', description: '用观察和对比理解蒸发现象。' }, { id: 'secondary', label: '初中七年级', description: '进一步讨论控制变量和概念边界。' }] } : null,
          plan: first ? { courseName: '水的蒸发' } : preparationPlanFixture(), fieldOrigins: { grade: 'teacher-stated', teachingApproach: 'ai-proposed' }, readyToConfirm: !first, missingFields: first ? ['学段或年级', '课程总分钟数'] : [], suggestions: [], referenceIds: [], referenceMaterials: [], textbookSelections: [], confirmed: null, error: null };
      }
      return json({ session });
    }
    if (pathname.endsWith('/design-generation')) {
      if (request.method() === 'POST') {
        generationRequests.push(request.postDataJSON());
        job = { id: 'design-1', status: 'queued', step: 'queued', stepIndex: 0, progress: 0, message: '开始生成已确认课程', reviewStatus: 'unavailable', trace: [], estimatedRemainingSeconds: 300, requestPreview: request.postDataJSON() };
      }
      return json({ backgroundEnabled: true, job });
    }
    unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Unexpected endpoint"}' });
  });
  return { generationRequests, discussionRequests, errors, unexpected, completeProcessing: () => { if (completedSession) session = completedSession; } };
}

async function openDiscussion(page: Page) {
  await page.addInitScript((id) => {
    localStorage.setItem(`openpbl:preparation-mode:v1:e2e-teacher:${encodeURIComponent(id)}`, 'collaborative-preparation');
  }, courseId);
  await page.goto(`/teacher/prepare/${courseId}/verify`);
  await expect(page.getByRole('region', { name: '当前备课问题' }).getByRole('heading', { name: latestPrompt, exact: true })).toBeVisible();
  await page.locator('[data-preparation-conversation]').evaluate((element) => element.scrollIntoView({ block: 'start' }));
}

async function expectCompactMode(page: Page, selected: '导入交接包' | 'AI 协同备课') {
  const modes = page.getByRole('group', { name: '备课模式', exact: true });
  await expect(modes).toHaveCount(1);
  await expect(modes).toHaveAttribute('data-expanded', 'false');
  await expect(modes.getByRole('button', { name: selected, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => modes.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(52);
  for (const name of ['导入交接包', 'AI 协同备课']) {
    await expect.poll(() => modes.getByRole('button', { name, exact: true }).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
}

async function expectCurrentWorkArea(page: Page, prompt: string) {
  await expect(page.getByRole('region', { name: '当前备课问题' }).getByRole('heading', { name: prompt, exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '提交回答', exact: true })).toBeInViewport({ ratio: 1 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function expectHistoryAtLatest(list: Locator) {
  await expect.poll(() => list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3);
}

async function expectUnifiedNavigation(page: Page) {
  const navigation = page.getByRole('navigation', { name: '教师导航', exact: true });
  await expect(navigation).toBeVisible();
  for (const [name, href] of [['教学班', '/teacher/classes'], ['课程库', '/teacher/templates'], ['教材库', '/teacher/textbooks']]) {
    await expect(navigation.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  }
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    const positions = await page.evaluate(() => {
      const context = document.querySelector('.pbl-platform-topbar-context')!.getBoundingClientRect();
      const nav = document.querySelector('nav[aria-label="教师导航"]')!.getBoundingClientRect();
      return { contextRight: context.right, navigationLeft: nav.left };
    });
    expect(positions.navigationLeft).toBeGreaterThanOrEqual(positions.contextRight);
  }
}

for (const viewport of [{ width: 1280, height: 850 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 576 }]) {
  test(`collaborative preparation starts from the entry idea and requires reviewed confirmation at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const result = await mockPreparation(page);
    await page.goto(`/teacher/prepare/${courseId}/verify`);
    const modes = page.getByRole('group', { name: '备课模式', exact: true });
    await expect(page.getByRole('heading', { level: 1, name: '选择备课方式', exact: true })).toBeVisible();
    await expect(modes).toHaveCount(1);
    await expect(modes).toHaveAttribute('data-expanded', 'true');
    const packageEntry = modes.getByRole('region', { name: '导入交接包', exact: true });
    const aiEntry = modes.getByRole('region', { name: 'AI 协同备课', exact: true });
    await expect(packageEntry.getByRole('button', { name: '选择交接包', exact: true })).toBeVisible();
    await expect(aiEntry.getByRole('textbox', { name: '课程想法', exact: true })).toBeVisible();
    await expect(page.getByLabel('备课想法')).toBeHidden();
    await expect(page.getByLabel('上传课堂资源包')).toBeHidden();
    await expectUnifiedNavigation(page);
    if (viewport.width >= 1024) {
      const left = await packageEntry.boundingBox();
      const right = await aiEntry.boundingBox();
      expect(left!.x + left!.width).toBeLessThan(right!.x);
      expect(left!.width).toBeGreaterThan(350);
      expect(right!.width).toBeGreaterThan(350);
    }
    await page.screenshot({ path: info.outputPath('choose-preparation-mode.png'), animations: 'disabled' });

    const start = aiEntry.getByRole('button', { name: '开始协同备课', exact: true });
    await expect(start).toBeDisabled();
    await aiEntry.getByRole('textbox', { name: '课程想法', exact: true }).fill('   ');
    await expect(start).toBeDisabled();
    const firstIdea = '我想上一节关于蒸发的课程。';
    await aiEntry.getByRole('textbox', { name: '课程想法', exact: true }).fill(firstIdea);
    await expect(start).toBeEnabled();
    await expect.poll(() => start.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await start.click();
    await expectCompactMode(page, 'AI 协同备课');
    await expect(page.getByText('这节课面向什么年级？', { exact: true })).toBeVisible();
    expect(result.discussionRequests).toHaveLength(1);
    expect(result.discussionRequests[0]).toMatchObject({ revision: 0, message: firstIdea });
    await expect(page.getByLabel('备课想法')).toHaveValue('');
    const followup = '45分钟，希望保留湿手帕的案例。';
    await page.getByLabel('备课想法').fill(followup);
    await modes.getByRole('button', { name: '导入交接包', exact: true }).click();
    await expectCompactMode(page, '导入交接包');
    await expect(page.getByRole('heading', { level: 1, name: '准备课程资料', exact: true })).toBeVisible();
    await expect(page.getByLabel('上传课堂资源包')).toBeEnabled();
    await modes.getByRole('button', { name: 'AI 协同备课', exact: true }).click();
    await expectCompactMode(page, 'AI 协同备课');
    await expect(page.getByLabel('备课想法')).toHaveValue(followup);
    await page.reload();
    await expectCompactMode(page, 'AI 协同备课');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 协同备课', exact: true })).toBeVisible();
    await expect(page.getByLabel('备课想法')).toHaveValue(followup);
    await expect(page.getByRole('heading', { level: 1, name: '选择备课方式', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: info.outputPath('compact-preparation-mode.png'), animations: 'disabled' });
    await expect(page.getByText('这节课面向什么年级？', { exact: true })).toBeVisible();
    expect(result.discussionRequests).toHaveLength(1);
    expect(result.generationRequests).toHaveLength(0);
    await page.reload();
    await expectCompactMode(page, 'AI 协同备课');
    await expect(page.getByText('这节课面向什么年级？', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: /小学四年级/ }).check();
    await page.getByLabel('备课想法').fill(followup);
    await page.getByRole('button', { name: '提交回答' }).click();
    await page.getByRole('button', { name: '查看完整方案' }).click();
    await expect(page.getByRole('heading', { name: '确认课程方案' })).toBeVisible();
    const review = page.getByLabel('完整课程方案', { exact: true });
    await expect(review).toContainText('45 分钟');
    await expect(review.getByRole('region', { name: '成果与评价', exact: true })).toContainText('实验记录');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: info.outputPath('complete-course-plan-overview.png'), animations: 'disabled' });
    const stages = review.getByRole('tablist', { name: '教学阶段', exact: true });
    await expect(stages.getByRole('tab')).toHaveCount(5);
    for (const name of ['知识讲授', '项目实践', '成果展示', '反思评价', '项目启动']) {
      const tab = stages.getByRole('tab', { name, exact: true });
      await expect.poll(() => tab.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const panel = review.getByRole('tabpanel', { name, exact: true });
      await expect(panel).toContainText('引导学生明确变量');
      await expect(panel).toContainText('帮助记录证据');
      await expect(review.getByRole('tabpanel')).toHaveCount(1);
    }
    await stages.getByRole('tab', { name: '项目启动', exact: true }).press('End');
    await expect(stages.getByRole('tab', { name: '反思评价', exact: true })).toBeFocused();
    await expect(review.getByRole('tabpanel', { name: '反思评价', exact: true })).toBeVisible();
    const settings = page.getByRole('region', { name: '生成设置', exact: true });
    await expect(settings).toBeVisible();
    expect(await settings.locator('summary').count()).toBe(0);
    const scope = settings.getByRole('radiogroup', { name: '生成范围', exact: true });
    const assessment = settings.getByRole('radiogroup', { name: '课堂检测', exact: true });
    const interaction = settings.getByRole('radiogroup', { name: '交互方式', exact: true });
    await expect(scope.getByRole('radio', { name: '完整课程', exact: true })).toBeChecked();
    await expect(assessment.getByRole('radio', { name: '普通检测', exact: true })).toBeChecked();
    await expect(interaction.getByRole('radio', { name: '普通交互', exact: true })).toBeChecked();
    await scope.getByRole('radio', { name: '单节测试', exact: true }).check();
    await expect(scope.getByRole('radio', { name: '完整课程', exact: true })).not.toBeChecked();
    await expect(settings).toContainText('测试一节');
    await scope.getByRole('radio', { name: '完整课程', exact: true }).check();
    await assessment.getByRole('radio', { name: '综合简答', exact: true }).check();
    await interaction.getByRole('radio', { name: '深度交互', exact: true }).check();
    await expect(settings).toContainText('完整课程 · 综合简答 · 深度交互');
    const settingsPosition = await settings.boundingBox();
    const reviewPosition = await review.boundingBox();
    expect(settingsPosition!.y).toBeGreaterThanOrEqual(reviewPosition!.y + reviewPosition!.height);
    await expectUnifiedNavigation(page);
    await settings.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('complete-plan-generation-settings.png'), animations: 'disabled' });
    expect(result.generationRequests).toHaveLength(0);
    const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(geometry.content).toBeLessThanOrEqual(geometry.viewport + 1);
    await page.getByRole('button', { name: '确认方案并开始生成' }).click();
    await expect.poll(() => result.generationRequests.length).toBe(1);
    expect(result.generationRequests[0]).toMatchObject({ preparationSessionId: 'preparation-1', preparationRevision: 3, generationMode: 'deep-interaction', assessmentMode: 'constructed-response', generationScope: 'full-course' });
    expect(result.generationRequests[0]).not.toHaveProperty('resourcePackageId');
    expect(result.errors).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });
}

test('an existing server discussion restores an entry idea without automatically adding another turn', async ({ page }) => {
  const result = await mockPreparation(page, { initialSession: longDiscussion() });
  await page.goto(`/teacher/prepare/${courseId}/verify`);
  const entry = page.getByRole('region', { name: 'AI 协同备课', exact: true });
  await entry.getByRole('textbox', { name: '课程想法', exact: true }).fill(draft);
  await entry.getByRole('button', { name: '开始协同备课', exact: true }).click();
  await expectCompactMode(page, 'AI 协同备课');
  await expect(page.getByRole('region', { name: '当前备课问题' })).toContainText(latestPrompt);
  await expect(page.getByRole('textbox', { name: '备课想法', exact: true })).toHaveValue(draft);
  expect(result.discussionRequests).toHaveLength(0);
  expect(result.generationRequests).toHaveLength(0);
  expect(result.errors).toEqual([]);
  expect(result.unexpected).toEqual([]);
});

for (const viewport of [{ width: 1280, height: 850 }, { width: 1024, height: 576 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 768, height: 1024 }]) {
  test(`long preparation history keeps the current question and answer accessible at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const result = await mockPreparation(page, { initialSession: longDiscussion(), continueDiscussion: true });
    await openDiscussion(page);
    await expectCurrentWorkArea(page, latestPrompt);
    await expect(page.getByRole('list', { name: '备课讨论记录' })).toHaveCount(0);
    await page.getByRole('textbox', { name: '备课想法' }).fill(draft);
    await page.reload();
    await expect(page.getByRole('textbox', { name: '备课想法' })).toHaveValue(draft);
    await expectCurrentWorkArea(page, latestPrompt);
    expect(result.discussionRequests).toHaveLength(0);

    // Reading the end of a long question must not carry that scroll into the next one.
    await page.locator('[data-preparation-current-scroll]').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.getByRole('button', { name: '提交回答', exact: true }).click();
    await expectCurrentWorkArea(page, nextPrompt);
    await expect(page.getByRole('textbox', { name: '备课想法' })).toHaveValue('');
    await expect.poll(() => page.locator('[data-preparation-current-scroll]').evaluate((element) => element.scrollTop)).toBeLessThan(2);
    expect(result.discussionRequests).toHaveLength(1);
    expect(result.discussionRequests[0].message).toBe(draft);
    expect(result.generationRequests).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('current-question.png'), animations: 'disabled' });

    await page.getByRole('button', { name: /沟通记录/ }).click();
    const history = page.getByRole('dialog', { name: '沟通记录', exact: true });
    const list = history.getByRole('list', { name: '备课讨论记录' });
    await expectHistoryAtLatest(list);
    await expect(list.getByText(nextPrompt, { exact: true })).toBeInViewport();
    await expect(list.getByText(draft, { exact: true })).toBeVisible();
    await expect(history.getByRole('button', { name: '返回当前问题' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('discussion-history.png'), animations: 'disabled' });
    await history.getByRole('button', { name: '返回当前问题' }).click();
    await expect(history).toHaveCount(0);
    await expectCurrentWorkArea(page, nextPrompt);
    expect(result.errors).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });
}

test('preparation keyboard shortcuts preserve multiline and composing input', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  const result = await mockPreparation(page, { initialSession: longDiscussion(), continueDiscussion: true });
  await openDiscussion(page);
  const answer = page.getByRole('textbox', { name: '备课想法' });
  await answer.fill(draft);
  await answer.press('End');
  await answer.press('Enter');
  await answer.pressSequentially('学生需要解释观察的依据。');
  await expect(answer).toHaveValue(`${draft}\n学生需要解释观察的依据。`);
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    await answer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, ...composing });
  }
  expect(result.discussionRequests).toHaveLength(0);
  await answer.press('Control+Enter');
  await expect.poll(() => result.discussionRequests.length).toBe(1);
  await expectCurrentWorkArea(page, nextPrompt);
  expect(result.discussionRequests[0].message).toBe(`${draft}\n学生需要解释观察的依据。`);
  await answer.fill('最后让每个小组用一句话说明证据。');
  await answer.press('Meta+Enter');
  await expect.poll(() => result.discussionRequests.length).toBe(2);
  await expect(answer).toHaveValue('');
  expect(result.discussionRequests[1].message).toBe('最后让每个小组用一句话说明证据。');
  expect(result.generationRequests).toHaveLength(0);
  expect(result.errors).toEqual([]);
  expect(result.unexpected).toEqual([]);
});

test('history shows actual questions and preserves an older reading position during a reply', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 576 });
  const result = await mockPreparation(page, { initialSession: longDiscussion(), continueDiscussion: true, processing: true });
  await openDiscussion(page);
  await page.getByRole('textbox', { name: '备课想法' }).fill(draft);
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '备课想法' })).toBeDisabled();
  await page.getByRole('button', { name: /沟通记录/ }).click();
  const history = page.getByRole('dialog', { name: '沟通记录', exact: true });
  const list = history.getByRole('list', { name: '备课讨论记录' });
  await expectHistoryAtLatest(list);
  await expect(list.getByText(draft, { exact: true })).toBeInViewport();
  await list.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(list.getByText('第 1 轮具体问题：学生需要哪些观察支持？', { exact: true })).toBeInViewport();
  await expect(list.getByText('AI 备课伙伴', { exact: true }).first()).toBeVisible();
  await expect(history.getByRole('button', { name: '回到最新记录' })).toBeVisible();
  result.completeProcessing();
  await expect(list.getByText(nextPrompt, { exact: true })).toBeAttached();
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThan(2);
  await expect(list.getByText('第 1 轮具体问题：学生需要哪些观察支持？', { exact: true })).toBeInViewport();
  await history.getByRole('button', { name: '回到最新记录' }).click();
  await expectHistoryAtLatest(list);
  await expect(list.getByText(nextPrompt, { exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(history).toHaveCount(0);
  await expect(page.getByRole('button', { name: /沟通记录/ })).toBeFocused();
  await expectCurrentWorkArea(page, nextPrompt);
  expect(result.discussionRequests).toHaveLength(1);
  expect(result.generationRequests).toHaveLength(0);
  expect(result.errors).toEqual([]);
  expect(result.unexpected).toEqual([]);
});
