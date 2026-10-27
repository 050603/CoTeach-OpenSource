import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { DEFAULT_STAGES, type Course } from '../src/lib/session/types';
import { projectionSnapshotFromUiState } from '../src/lib/realtime/projection-state';
import { preparationPlanFixture } from '../src/lib/collaborative-preparation/fixtures.test-support';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const courseId = 'e2e-collaborative-launch';
const studentId = 'e2e-collaborative-launch-student';
const date = '2026-10-23T10:00:00.000Z';
test.use({ baseURL, serviceWorkers: 'block' });

async function mockLaunch(page: Page, role: 'teacher' | 'student') {
  const plan = preparationPlanFixture();
  const course = {
    id: courseId, version: 1, name: plan.courseName, subject: plan.subject, grade: plan.grade, hours: 0.75,
    summary: '', drivingQuestion: plan.stagePlan.drivingQuestion, learningObjectives: plan.learningObjectives,
    status: 'teaching', currentStageIndex: 0, stages: DEFAULT_STAGES.map(stage => ({ ...stage })),
    students: [{ id: studentId, name: '验收学生', joinedAt: date, stageProgress: {} }], groups: [], resources: [],
    content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], teachingOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' },
      preparationSource: 'collaborative-preparation', stagePlan: { ...plan.stagePlan, stages: plan.stagePlan.stages.map(stage => ({ ...stage, teacherActions: '教师私有备课提示不得出现在启动卡中' })) } },
    uiState: { classroomTiming: { schemaVersion: 1, status: 'paused', sessionStartedAt: date, pausedAt: date, activeStageKey: 'launch', updatedAt: date,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: [300, 900, 900, 300, 300][index], adjustmentSec: 0, elapsedSec: 0, status: index === 0 ? 'active' : 'pending' })) } },
    createdAt: date, updatedAt: date,
  } as Course;
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
  if (!secret) throw new Error('A local service JWT secret is required for the isolated fixture');
  const token = await new SignJWT({ role, sv: 1, displayName: '验收用户', ...(role === 'student' ? { userId: studentId, studentName: '验收学生' } : { username: 'e2e-launch-teacher' }) })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(role === 'student' ? studentId : 'e2e-launch-teacher').setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  const errors: string[] = [], unexpected: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const data = JSON.parse(String(message));
    if (data.type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId: data.courseId }));
  }));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path} ${request.postData() ?? ''}`);
    if (path === '/api/auth/me') return json({ user: { id: role === 'student' ? studentId : 'e2e-launch-teacher', role, name: '验收用户' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role, name: '验收用户' }, ...(role === 'student' ? { studentId, studentName: '验收学生', joinedCourseId: courseId } : {}), hydrated: true, updatedAt: date });
    if (path.endsWith('/state')) return json({ course, eventCursor: '0' });
    if (path.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (path.endsWith('/presence')) return json({ members: [], degraded: false });
    if (path.endsWith('/projection')) return json(projectionSnapshotFromUiState({ courseId, courseVersion: 1, uiState: course.uiState }));
    if (path.endsWith('/public-discussion')) return json({ enabled: false, session: null });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Unexpected fixture endpoint"}' });
  });
  return { errors, unexpected, writes };
}

for (const role of ['teacher', 'student'] as const) {
  test(`${role} sees the confirmed launch plan without a PPT or fabricated reading`, async ({ page }, info) => {
    await page.setViewportSize(role === 'teacher' ? { width: 1280, height: 850 } : { width: 390, height: 844 });
    const fixture = await mockLaunch(page, role);
    await page.goto(role === 'teacher' ? `/teacher/teach/${courseId}/classroom` : `/student/classroom/${courseId}`);
    const card = page.getByRole('region', { name: '项目启动说明' }).filter({ visible: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText('设计并解释一项对照实验');
    await expect(card).toContainText('通过实验比较蒸发快慢并说明控制变量的方法');
    await expect(card).toContainText('课堂安排 · 共 45 分钟');
    await expect(card).toContainText('实验记录');
    await expect(card).toContainText('反思评价');
    await expect(page.getByText('教师私有备课提示不得出现在启动卡中')).toHaveCount(0);
    await expect(page.getByLabel('AI 协同备课对话')).toHaveCount(0);
    await expect(page.getByText('已阅读', { exact: true })).toHaveCount(0);
    if (role === 'teacher') {
      await page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).click();
      await expect(page.locator('.teacher-presentation').getByRole('region', { name: '项目启动说明' })).toBeVisible();
      await expect(page.locator('.teacher-presentation')).toContainText('课堂安排 · 共 45 分钟');
      const finalStage = page.locator('.teacher-presentation').getByRole('listitem').filter({ hasText: '5. 反思评价' });
      await finalStage.scrollIntoViewIfNeeded();
      await expect(finalStage).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${role}-launch.png`), fullPage: true });
    expect(fixture.writes.filter(write => !write.includes('/presence'))).toEqual([]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
