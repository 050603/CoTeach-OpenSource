import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { nativeLearningFixture } from './fixtures/native-learning';
import type { Course } from '../src/lib/session/types';
import type { ShowcaseAction, ShowcaseData } from '../src/lib/showcase/types';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const at = '2026-10-20T00:00:00.000Z';
test.use({ baseURL, serviceWorkers: 'block' });

async function fixture(page: Page, role: 'student' | 'teacher') {
  const baseline = nativeLearningFixture();
  if (role === 'teacher') baseline.setTeacherMode(); else baseline.setMode('document');
  baseline.recoverSave();
  const course = (baseline.response('/api/courses', 'GET', {})!.body as { courses: Course[] }).courses[0];
  const studentId = course.students[0].id;
  if (role === 'teacher') course.currentStageIndex = 3;
  const artifact = { kind: 'document' as const, versionId: 'optional-review-artifact', title: '观察成果', sequence: 1, submittedAt: at, displayModes: ['continuous' as const] };
  const showcase: ShowcaseData = { courseId: course.id, stageKey: 'showcase', students: [{ studentId, name: '汇报学生', isAssigned: false, artifacts: [artifact] }], ownArtifacts: [], queue: [], presentations: [], activePresentation: null, minutesPerStudent: 3, currentQueueItem: null, nextQueueItem: null };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
  if (!secret) throw new Error('A local service JWT secret is required');
  const token = await new SignJWT({ role, sv: 1, displayName: '附加审阅验收',
    ...(role === 'student' ? { userId: studentId, studentName: '附加审阅验收' } : { username: 'optional-review-teacher' }) })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(role === 'student' ? studentId : 'optional-review-teacher')
    .setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const body = request.method() === 'POST' ? (request.postDataJSON() ?? {}) as Record<string, unknown> : {};
    requests.push({ path, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/auth/me') return json({ user: { id: role === 'student' ? studentId : 'optional-review-teacher', role, name: '附加审阅验收' } });
    if (path.endsWith('/showcase/recommendations')) return json({ message: '推荐暂不可用，可手动选人' }, 503);
    if (path.endsWith('/showcase/artifacts/optional-review-artifact')) return json({ html: '<h1>观察成果</h1><p>两次观察均采用相同观察时长。</p>' });
    if (path.endsWith('/showcase/presentation')) {
      if (request.method() === 'POST') {
        const action = body as ShowcaseAction;
        if (action.action === 'save-queue') {
          showcase.queue = action.orderedStudentIds.map(id => ({ studentId: id, studentName: '汇报学生', position: 1, status: 'waiting', artifacts: [artifact] }));
          showcase.queueConfig = { ...action, schemaVersion: 1, updatedAt: at };
        } else if (action.action === 'start') {
          showcase.activePresentation = { id: 'optional-presentation', courseId: course.id, studentId, studentName: '汇报学生', artifactKind: 'document', artifactVersionId: artifact.versionId, artifactTitle: artifact.title, displayMode: 'continuous', status: 'active', revision: 1, requestedAt: at, updatedAt: at };
        } else if (action.action === 'end') {
          showcase.activePresentation = null;
          showcase.queue = showcase.queue.map(item => ({ ...item, status: 'completed' }));
        }
      }
      return json(showcase);
    }
    if (path === '/api/ai-collaboration/document') return json({ messages: [], proactiveReviewEnabled: true,
      commentThreads: [{ id: 'legacy-review', blockIndex: 0, targetText: '旧批注', comments: [{ id: 'legacy-comment', role: 'assistant', content: '不应展示的旧自动批注', createdAt: at }], createdAt: at }] });
    const response = baseline.response(path, request.method(), body);
    return response ? json(response.body, response.status) : json({ ok: true });
  });
  return { course, requests };
}

test('student typing and refresh ignore old automatic reviews while saving remains available', async ({ page }) => {
  const { course, requests } = await fixture(page, 'student');
  await page.clock.install();
  await page.goto(`/student/ai-collaboration/${course.id}`);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.fill('相同观察时长内，甲地记录十二次，乙地记录六次，需要比较实际观察条件。');
  await page.clock.fastForward(45_000);
  await expect.poll(() => requests.filter(row => (row.body.action as { type?: string })?.type === 'UPSERT_SUBMISSION').length).toBeGreaterThan(0);
  await page.reload(); await expect(editor).toBeVisible();
  await page.clock.fastForward(45_000);
  await expect(page.getByText(/自动审阅暂未完成|重新审阅|不应展示的旧自动批注|批注历史/)).toHaveCount(0);
  expect(requests.filter(row => ['proactive-document-comments', 'resume-proactive-review'].includes(String(row.body.action)))).toEqual([]);
});

test('teacher completes manual reporting with recommendation service unavailable', async ({ page }) => {
  const { course, requests } = await fixture(page, 'teacher');
  await page.goto(`/teacher/teach/${course.id}/classroom`);
  await expect(page.getByRole('tab', { name: '全部学生', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '采用推荐名单' })).toBeDisabled();
  await page.getByRole('button', { name: '加入汇报学生汇报名单' }).click();
  const start = page.getByRole('button', { name: '开始汇报并投屏', exact: true }).last();
  await expect(start).toBeEnabled(); await start.click();
  const end = page.getByRole('button', { name: '结束汇报', exact: true }).last();
  await expect(end).toBeVisible(); await end.click();
  await expect(page.getByRole('button', { name: '进入下一阶段', exact: true })).toBeEnabled();
  expect(requests.filter(row => row.path.endsWith('/showcase/presentation') && row.body.action).map(row => row.body.action)).toEqual(['save-queue', 'start', 'end']);
});
