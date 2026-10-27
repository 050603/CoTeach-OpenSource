import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { courseDesignDetailsFixture } from './course-design-details';
import { captureDesktopScreenshot } from './desktop-coverage';
import { settleLayoutAssets } from '../../scripts/lib/layout-browser.mjs';

export const contentCourseId = 'e2e-course-design-details';
export const contentClassroomId = 'desktop-content-teacher-classroom';
export const contentTitle = '从原始观察到证据推理：数据划分、独立验证与社区方案比较（Evidence Review 2026）';
export const contentScript = '请先比较训练数据与独立验证数据的用途，保留证据来源、数量和必要条件，再说明结论成立的范围。';
const at = '2026-10-18T00:00:00.000Z';

export async function installDesktopContentFixtures(page: Page, baseURL: string, role: 'teacher' | 'student') {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Desktop content fixtures require a local service.');
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const user = { id: `desktop-content-${role}`, username: `desktop-content-${role}`, role, displayName: '内容状态验收' };
  const token = await new SignJWT({ ...user, userId: user.id, studentName: user.displayName, sv: 1 })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  const base = courseDesignDetailsFixture();
  const sceneTitles = ['观察资料与数据来源：建立可检验的解释', '比较方案与独立验证：说明结论成立的必要条件'];
  const resources = sceneTitles.map((title, index) => ({ id: `desktop-resource-${index}`, title, type: 'slide', role: index ? 'pbl-topic' : 'introduction', stageKey: index ? 'make' : 'launch', description: '使用教材原文及观察记录解释调查方法，保留完整事实与条件。', keyPoints: ['训练数据用于训练，验证数据保持独立。', '根据原始记录比较样本、观察条件与证据来源。'], script: `${contentScript}\n${contentScript}`, generationPurpose: 'teacher-resource' }));
  const course = {
    ...base.course, name: contentTitle, teacherClassroomId: contentClassroomId, aiLearningClassroomId: contentClassroomId,
    pblConfig: { generationTemplate: 'new-ai-learning-only' },
    learningObjectives: ['解释数据划分的用途，使用独立数据验证结论。'],
    content: {
      ...base.course.content,
      teacherClassroomId: contentClassroomId,
      teacherResources: { generatedAt: at, scenes: resources },
      stagePlan: { schemaVersion: 2, source: 'resource-package', drivingQuestion: '如何用独立证据验证方案？', totalMinutes: 45, stages: base.course.stages.map((stage) => ({ key: stage.key, title: stage.label, durationMin: 9, requirements: '保留原始数据并比较必要条件。', outputs: '观察记录与证据解释', teacherActions: '引导核对来源与数量。', aiActions: '辅助比较证据。' })), evaluationCriteria: '证据完整、论证准确。', reflectionQuestions: ['哪些条件仍需验证？'], aiUsagePolicy: '保留原始判断依据。' },
      knowledgePoints: [{ id: 'kp-1', name: '训练数据与独立验证数据的用途、关系及必要条件', description: contentScript, level: 'core', groupId: 'data', groupName: '数据来源与证据', sourceKnowledgePointNames: ['教材原文：训练与验证'], masteryBoundary: '能够解释独立验证与泛化判断的关系。' }, { id: 'kp-2', name: '方案比较与解释边界', description: '结合样本数量和观察条件说明结论适用的范围。', level: 'application' }],
      knowledgeGraph: { nodes: [{ id: 'kp-1', label: '训练与独立验证', description: contentScript, level: 'core' }, { id: 'kp-2', label: '解释边界', description: '结论适用条件', level: 'application' }], edges: [{ id: 'edge-1', source: 'kp-1', target: 'kp-2', label: '支持解释', type: 'supports' }] },
      moduleTimingPlan: { schemaVersion: 1, totalMinutes: 24, recommendationSource: 'teacher', allocations: [{ id: 'allocation-1', title: '数据来源、独立验证与推理边界', durationMin: 24, knowledgePointIds: ['kp-1', 'kp-2'], notes: '比较原始材料，解释必要条件并结合实例验证。' }], rationaleByStage: { 'ai-learning': '用完整的解释、比较和检测覆盖关键概念。' } },
      teachingBlueprint: base.blueprint, _openmaicSceneOutlines: base.outlines,
      knowledgeLectureSections: [{ id: 'section-1', title: '训练数据', order: 1, sceneOutlineIds: base.outlines.map((outline) => outline.id), knowledgePointIds: ['kp-1'], estimatedMinutes: 24 }],
    },
  };
  const scenes = resources.map((resource, index) => ({
    id: resource.id, stageId: contentClassroomId, title: resource.title, type: 'slide', order: index, actions: [],
    content: { type: 'slide', schemaVersion: 1, canvas: {
      id: `resource-canvas-${index}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#344a6a', '#2f6f65'], fontColor: '#243447', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [
        { id: 'resource-title', type: 'text', left: 48, top: 45, width: 900, height: 90, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#243447', content: `<p style="font-size:30px">${resource.title}</p>` },
        { id: 'resource-body', type: 'text', left: 48, top: 160, width: 850, height: 220, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#243447', content: `<p style="font-size:24px">${contentScript}</p>` },
        { id: 'resource-brand', type: 'image', left: 48, top: 430, width: 240, height: 70, rotate: 0, src: '/brand/coteach/horizontal-color.png', fixedRatio: true },
      ],
    } },
  }));
  const audit = { unexpected: [] as string[], errors: [] as string[], resources: [] as string[], reads: [] as string[], writes: [] as string[] };
  page.on('pageerror', (error) => audit.errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) audit.resources.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', (request) => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') audit.resources.push(`${request.failure()?.errorText} ${request.url()}`); });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== new URL(baseURL).origin) { audit.unexpected.push(`external ${request.url()}`); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method())) return route.continue();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { audit.writes.push(`${request.method()} ${path}`); return json({ message: 'Content acceptance blocks all business writes' }, 405); }
    audit.reads.push(path);
    if (path === '/api/auth/me') return json({ user });
    if (path === '/api/platform/auth/student-profile') return json({ user });
    if (path === '/api/courses') return json({ courses: [course], user: { role, name: user.displayName }, hydrated: true, updatedAt: at });
    if (path === `/api/courses/${contentCourseId}/state`) return json({ course, eventCursor: '0' });
    if (path === `/api/courses/${contentCourseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (path === `/api/courses/${contentCourseId}/presence`) return json({ members: [] });
    if (path === `/api/courses/${contentCourseId}/projection`) return json({ courseVersion: 1, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${contentCourseId}/design-workspace`) return json({ course, statuses: Object.fromEntries(['materials', 'stage-plan', 'knowledge', 'timing', 'blueprint', 'classroom'].map((key) => [key, 'ready'])), pendingUpdates: [], publication: { latestVersion: 2, publishedVersion: 1, draftVersion: 2 }, jobs: { design: null, classroom: null } });
    if (path === '/api/openmaic/classroom') return json({ success: true, classroom: { id: contentClassroomId, stage: { id: contentClassroomId, name: contentTitle, createdAt: 1, updatedAt: 1 }, scenes } });
    if (path === '/api/openmaic/progress') return json({ data: { progress: {} } });
    if (['/api/server-providers', '/api/openmaic/server-providers', '/api/openmaic/provider-config'].includes(path)) return json({ success: true, providers: [], models: [] });
    const activityType = path.match(/^\/api\/platform\/activities\/desktop-(Assignment|Quiz|Resource|Classroom)$/)?.[1];
    if (activityType) {
      const question = { id: 'activity-q', title: '请说明你的证据来源、比较方法与结论成立的条件。', required: true };
      const experimentQuestion = { id: 'experiment-q', type: 'short-answer', prompt: question.title };
      const experiment = { enabled: true, pretest: [experimentQuestion], posttest: [experimentQuestion] };
      return json({ activity: {
        id: `desktop-${activityType}`, type: activityType, title: `${activityType} · ${contentTitle}`, description: '保留原始资料、完整事实、数量及必要条件，结合真实情境解释你的判断。'.repeat(3), isOpen: true,
        offering: { id: contentCourseId, name: contentTitle, status: 'open' }, chapter: { title: '观察、解释与验证：从数据到可检验的方案' },
        config: { content: contentScript.repeat(4), ...(activityType === 'Resource' ? { url: 'https://example.test/community/evidence-review-2026', resourceKind: 'link' } : {}), ...(activityType === 'Quiz' ? { questions: [question, { ...question, id: 'activity-q2', title: '下一步怎样检验方案？', required: false }] } : {}) },
        progress: { status: 'completed', progressData: { answer: '已保存的调查报告与原始记录', answers: { 'activity-q': '保留完整证据和观察条件。' } } },
        instance: activityType === 'Classroom' ? { id: 'current-classroom', status: 'teaching', canWrite: true, startedAt: at, endedAt: null, experiment, pretestSubmitted: true, posttestAvailable: false } : null,
        instances: activityType === 'Classroom' ? [{ id: 'historical-classroom', status: 'finished', startedAt: at, endedAt: at, experiment, pretestSubmitted: true, posttestAvailable: true }] : [],
      } });
    }
    audit.unexpected.push(`${request.method()} ${path}`);
    return json({ message: `No content fixture for ${path}` }, 404);
  });
  return { audit, sceneTitles };
}

export async function captureDesktopContentState(page: Page, info: TestInfo, name: string) {
  for (const frame of page.frames()) await settleLayoutAssets(frame);
  const path = info.outputPath(`${name}.png`);
  await captureDesktopScreenshot(page, path);
  await info.attach(name, { path, contentType: 'image/png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 'Content does not force horizontal page scrolling').toBeLessThanOrEqual(2);
}
