import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import type { CourseResourceIssue } from '@/lib/course-generation/resource-audit-server';
import type { CourseGenerationInputSummary } from '@/lib/course-design/generation-input-summary';
import { emptyResourcePackageDraft } from '@/lib/resource-package/types';

const mocks = vi.hoisted(() => ({
  resources: [] as CourseResourceIssue[], refresh: vi.fn(), publish: vi.fn(), downloadPptx: vi.fn(), downloadResources: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() }, search: '', player: vi.fn(), review: vi.fn(),
  generationInput: null as CourseGenerationInputSummary | null,
}));
let course: Course;
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'course' }), useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock('@/lib/session/store', () => ({
  useHydrated: () => true, useCourse: () => course,
  useSession: () => ({ user: { name: '张老师' }, refresh: mocks.refresh, publishCourse: mocks.publish }),
}));
vi.mock('@/components/teacher/preparation-shell', () => ({ preparationThemeClassName: 'preparation-theme', PreparationShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/use-course-generation-preview-sync', () => ({ useCourseGenerationPreviewSync: () => ({ refreshKey: 'saved' }) }));
vi.mock('@/components/openmaic-bridge/student-stage-host', () => ({ StudentStageHost: (props: { initialSceneId?: string; mode: string }) => {
  mocks.player(props); return <div data-testid="classroom-preview" data-scene={props.initialSceneId} data-mode={props.mode}/>;
} }));
vi.mock('@/components/classroom/simple-stage-resources', () => ({ StudentPdfResourceViewer: () => <div>PDF 只读预览</div> }));
vi.mock('@/components/openmaic-bridge/openmaic-resource-player', () => ({ OpenMaicResourcePlayer: () => <div>教师资源只读预览</div> }));
vi.mock('@/components/teacher/teaching-tool-runbook', () => ({ TeachingToolRunbook: () => null }));
vi.mock('@/lib/course-resources/download-course-resources', () => ({ downloadCourseResources: mocks.downloadResources, downloadCoursePptx: mocks.downloadPptx }));
vi.mock('@/lib/classroom/new-system-course', () => ({ getNewSystemCourseReadiness: () => [
  { id: 'basics', label: '课程信息', ok: true, message: '信息完整。' },
  { id: 'full-classroom-generation', label: '完整课程', ok: true, message: '页面完整。' },
  { id: 'timing', label: '讲授时长', ok: false, message: '实测时长仍需教师核对。' },
] }));
vi.mock('@/components/teacher/course-quality-review', async () => {
  const { useEffect } = await import('react');
  return { CourseQualityReview: (props: { onDecisionChange: (value: unknown) => void; onOpenPage: (id: string) => void; visible: boolean }) => {
    mocks.review(props);
    const { onDecisionChange } = props;
    useEffect(() => { onDecisionChange({ canConfirm: true, signature: 'a'.repeat(64), acceptedIssueIds: [], acknowledgeFailedCheck: false }); }, [onDecisionChange]);
    return props.visible ? <button onClick={() => props.onOpenPage('page-two')}>查看第二页问题</button> : null;
  } };
});
import PreviewCoursePage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = '';
  mocks.generationInput = null;
  mocks.downloadPptx.mockResolvedValue(undefined);
  course = {
    id: 'course', name: '教学理论与方法', subject: '教育学', grade: '本科一年级', hours: 2,
    summary: '通过真实案例理解教学方法。', drivingQuestion: '怎样理解教学？', expectedOutcome: '完成教学分析', learningObjectives: ['解释教学方法'],
    status: 'preparing', stages: [{ key: 'launch', label: '项目启动', view: 'project-launch', description: '了解项目' }, { key: 'ai-learning', label: '知识讲授', view: 'ai-learning', description: '学习知识' }], aiLearningClassroomId: 'saved-classroom',
    content: { qualityReviewRequired: true, knowledgePoints: [], _openmaicSceneOutlines: [
      { id: 'page-one', title: '教学概念', type: 'slide', stageKey: 'ai-learning', lectureSectionId: 'lesson-one', audience: 'student' },
      { id: 'page-two', title: '教学案例', type: 'slide', stageKey: 'ai-learning', lectureSectionId: 'lesson-two', audience: 'student' },
    ], knowledgeLectureSections: [
      { id: 'lesson-one', title: '理解概念', sceneOutlineIds: ['page-one'] },
      { id: 'lesson-two', title: '分析案例', sceneOutlineIds: ['page-two'] },
    ], stagePlan: { schemaVersion: 2, totalMinutes: 60, stages: [
      { key: 'launch', title: '项目启动', durationMin: 10, requirements: '阅读真实任务', outputs: '提出初步问题', teacherActions: '介绍任务情境', aiActions: '提供案例素材' },
      { key: 'ai-learning', title: '知识讲授', durationMin: 50, requirements: '完成讲授与检测', outputs: '知识小测结果', teacherActions: '查看学习情况', aiActions: '讲解知识与反馈' },
    ], reflectionQuestions: [] },
      classroomGenerationRun: { scope: 'full-course', status: 'completed', generatedOutlineIds: [], fullOutlineCount: 23 } },
  } as unknown as Course;
  mocks.resources = [{ id: 'content:source-sequence:source', type: 'source-consistency', title: '教材清单', detail: '完整来源清单待核对。' }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/resource-repair')
    ? { issues: mocks.resources, repair: { status: 'idle' }, syncRepair: { status: 'idle' } }
    : { generationInput: mocks.generationInput })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openMore() {
  fireEvent.keyDown(screen.getByRole('button', { name: '课程更多操作' }), { key: 'Enter' });
}

describe('course publication readiness', () => {
  it('keeps downloads in the secondary menu and guards both while exporting', async () => {
    let finish!: () => void;
    mocks.downloadPptx.mockImplementationOnce(async (_id, onProgress) => {
      onProgress({ completed: 2, total: 10 });
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    render(<PreviewCoursePage />);
    expect(screen.queryByRole('menuitem', { name: '下载 PPT' })).not.toBeInTheDocument();
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: '下载 PPT' }));
    await screen.findByRole('menuitem', { name: '正在导出 2/10 页…' });
    expect(mocks.downloadPptx).toHaveBeenCalledWith('course', expect.any(Function));
    expect(mocks.downloadResources).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: '下载课程资源' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => finish());
    expect(screen.getByRole('menuitem', { name: '下载 PPT' })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('menuitem', { name: '下载课程资源' })).not.toHaveAttribute('aria-disabled');
  });

  it('allows retrying the PPT download after a rendering failure', async () => {
    mocks.downloadPptx.mockRejectedValueOnce(new Error('第 1 页图片缺失'));
    render(<PreviewCoursePage />);
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: '下载 PPT' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '下载 PPT' })).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(screen.getByRole('menuitem', { name: '下载 PPT' }));
    await waitFor(() => expect(mocks.downloadPptx).toHaveBeenCalledTimes(2));
  });

  it('allows publication with advisory diagnostics and keeps their details available in checks', async () => {
    mocks.search = 'view=checks';
    render(<PreviewCoursePage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并发布' })).toBeEnabled());
    expect(screen.getByText('未发布 · 可以发布')).toBeVisible();
    const timing = screen.getAllByText('实测时长仍需教师核对。')[0];
    expect(timing.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(within(timing.closest('details')!).getByText('课程核对提示'));
    expect(timing).toBeVisible();
    expect(screen.getByText('完整来源清单待核对。', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('影响发布')).toBeNull();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('still disables publication when an actual narration audio file is missing', async () => {
    mocks.resources.push({ id: 'tts:scene:speech', type: 'tts', title: '讲解音频', detail: '语音文件不存在。' });
    render(<PreviewCoursePage />);
    await screen.findByText('还有 1 项课程资源需要处理');
    expect(screen.getByRole('button', { name: '确认并发布' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /还有 1 项课程资源需要处理/ }));
    expect(mocks.router.push).toHaveBeenCalledWith('/teacher/prepare/course/preview?view=checks', { scroll: false });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe('course detail navigation and previews', () => {
  it('opens a readable overview with five destinations and no diagnostic rail ahead of content', async () => {
    render(<PreviewCoursePage />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['课程总览', '教学内容', '课程资料', '课程设置', '检查与发布']);
    expect(screen.getByRole('tab', { name: '课程总览' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: '教学流程' })).toBeVisible();
    expect(screen.queryByRole('complementary', { name: '课程发布状态' })).toBeNull();
    expect(mocks.player).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /02.*知识讲授/ }));
    expect(mocks.router.push).toHaveBeenCalledWith('/teacher/prepare/course/preview?view=content&stage=ai-learning', { scroll: false });
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并发布' })).toBeEnabled());
  });

  it.each(['pages', 'student'])('keeps the old %s link working as a real page preview', async (view) => {
    mocks.search = `view=${view}&section=lesson-two&sceneId=page-two`;
    render(<PreviewCoursePage />);
    expect(screen.getByRole('tab', { name: '教学内容' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('classroom-preview')).toHaveAttribute('data-scene', 'page-two');
    expect(screen.getByTestId('classroom-preview')).toHaveAttribute('data-mode', 'teacher-preview');
    const edit = new URL(screen.getByRole('link', { name: '编辑当前页' }).getAttribute('href')!, 'http://localhost');
    expect(edit.searchParams.get('sceneId')).toBe('page-two');
    expect(edit.searchParams.get('returnTo')).toBe(`/teacher/prepare/course/preview?${mocks.search}`);
    await waitFor(() => expect(mocks.review).toHaveBeenCalled());
  });

  it('restores the URL page and keeps the current stage and section when switching tabs', () => {
    mocks.search = 'view=content&stage=ai-learning&section=lesson-two&sceneId=page-two';
    const view = render(<PreviewCoursePage />);
    expect(screen.getByRole('button', { name: '2教学案例' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('tab', { name: '课程资料' }));
    expect(mocks.router.push).toHaveBeenLastCalledWith('/teacher/prepare/course/preview?view=materials&stage=ai-learning&section=lesson-two&sceneId=page-two', { scroll: false });
    mocks.search = 'view=content&stage=ai-learning&section=lesson-one&sceneId=page-one';
    view.rerender(<PreviewCoursePage />);
    expect(screen.getByTestId('classroom-preview')).toHaveAttribute('data-scene', 'page-one');
    expect(screen.getByRole('button', { name: '1教学概念' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens a review issue directly on its lesson page and returns to the same checks context', async () => {
    mocks.search = 'view=checks&stage=ai-learning&section=lesson-two';
    render(<PreviewCoursePage />);
    fireEvent.click(await screen.findByRole('button', { name: '查看第二页问题' }));
    expect(mocks.router.push).toHaveBeenCalledWith('/teacher/prepare/course/preview?view=content&stage=ai-learning&section=lesson-two&sceneId=page-two', { scroll: false });
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ returnTo: '/teacher/prepare/course/preview?view=checks&stage=ai-learning&section=lesson-two' }));
  });

  it('shows the actual stage responsibilities without mounting the student player', () => {
    mocks.search = 'view=content&stage=launch';
    render(<PreviewCoursePage />);
    for (const value of ['阅读真实任务', '提出初步问题', '介绍任务情境', '提供案例素材']) expect(screen.getByText(value)).toBeVisible();
    expect(mocks.player).not.toHaveBeenCalled();
    expect(screen.getByText('本阶段暂无独立课件，可按上方教学任务与要求开展活动。')).toBeVisible();
  });

  it('keeps course settings read-only and labels class-specific settings accurately', () => {
    mocks.search = 'view=settings';
    course.coverImageUrl = '/api/uploads/cover';
    course.content.adaptiveLearningPlan = { enabled: true, pretest: { questions: [] }, branches: [] } as unknown as NonNullable<Course['content']['adaptiveLearningPlan']>;
    render(<PreviewCoursePage />);
    expect(screen.getByRole('heading', { name: '基本信息与封面' })).toBeVisible();
    expect(new URL(screen.getByRole('img', { name: '教学理论与方法课程封面' }).getAttribute('src')!, 'http://localhost').pathname).toBe('/api/uploads/cover');
    expect(screen.getByText('120 分钟')).toBeVisible();
    expect(screen.getByRole('link', { name: '编辑基本信息与封面' })).toHaveAttribute('href', '/teacher/prepare/course/verify/edit?section=materials&returnTo=%2Fteacher%2Fprepare%2Fcourse%2Fpreview%3Fview%3Dsettings');
    expect(screen.getByRole('link', { name: '查看学习路径' })).toHaveAttribute('href', '/teacher/prepare/course/preview?view=content&stage=ai-learning#course-learning-path');
    expect(screen.getByRole('heading', { name: '时间安排' })).toBeVisible();
    expect(screen.getByText('实际授课时可在对应课堂的班级配置中调整成果形式与人数。')).toBeVisible();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByRole('link', { name: '编辑时间安排' })).toHaveAttribute('href', '/teacher/prepare/course/verify/edit?section=stage-plan&returnTo=%2Fteacher%2Fprepare%2Fcourse%2Fpreview%3Fview%3Dsettings');
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init || !init.method || init.method === 'GET')).toBe(true);
  });

  it('shows the matching saved task inputs, private download and generated resource destinations without starting playback', async () => {
    mocks.search = 'view=materials&stage=ai-learning&section=lesson-two&sceneId=page-two';
    course.content.resourcePackage = { schemaVersion: 2, id: 'pack', revision: 3,
      source: { id: 'package-file', fileName: '课程资料.zip', url: '/api/resource-package/package-file' }, documents: {}, draft: emptyResourcePackageDraft() };
    course.content.courseEvidence = { items: [{ id: 'source', title: '教学方法', content: '教材摘录', source: { textbookId: 'textbook', revisionId: 'revision', revisionVersion: 2, textbookTitle: '教学教材', sectionPath: ['方法'] } }] } as unknown as NonNullable<Course['content']['courseEvidence']>;
    course.teacherClassroomId = 'teacher-classroom';
    course.content.teacherResources = { scenes: [{ id: 'launch-scene', title: '任务介绍', type: 'slide', stageKey: 'launch' }] } as NonNullable<Course['content']['teacherResources']>;
    mocks.generationInput = { sourceStatus: 'current', resourcePackageId: 'pack', resourcePackageRevision: 3, taskStatus: 'failed', teacherBrief: '请结合学校案例讲解。',
      referenceMaterials: [{ id: '123e4567-e89b-42d3-a456-426614174001', fileName: '案例补充.pdf', mimeType: 'application/pdf' }] };
    render(<PreviewCoursePage />);
    expect(await screen.findByText('案例补充.pdf')).toBeVisible();
    expect(screen.getByRole('heading', { name: '最近生成任务的补充资料' })).toBeVisible();
    expect(screen.getByText('请结合学校案例讲解。')).toBeVisible();
    expect(screen.getByRole('link', { name: '下载补充资料' })).toHaveAttribute('href', '/api/uploads/123e4567-e89b-42d3-a456-426614174001?download=1');
    expect(screen.getByRole('link', { name: '预览知识讲授' })).toHaveAttribute('href', '/teacher/prepare/course/preview?view=content&stage=ai-learning');
    expect(screen.getByRole('link', { name: '预览项目启动' })).toHaveAttribute('href', '/teacher/prepare/course/preview?view=content&stage=launch');
    const textbookLink = new URL(screen.getByRole('link', { name: '查看教材' }).getAttribute('href')!, 'http://localhost');
    expect(textbookLink.searchParams.get('returnTo')).toBe(`/teacher/prepare/course/preview?${mocks.search}`);
    expect(mocks.player).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url, init]) => !String(url).includes('design-generation') && (!init?.method || init.method === 'GET'))).toBe(true);
  });

  it('hides stale supplemental files and requirements when the current source has changed', async () => {
    mocks.search = 'view=materials';
    course.content.resourcePackage = { schemaVersion: 2, id: 'pack', revision: 4,
      source: { id: 'package-file', fileName: '课程资料.zip', url: '/api/resource-package/package-file' }, documents: {}, draft: emptyResourcePackageDraft() };
    mocks.generationInput = { sourceStatus: 'current', resourcePackageId: 'pack', resourcePackageRevision: 3, taskStatus: 'completed', teacherBrief: '旧任务的要求', referenceMaterials: [{ id: '123e4567-e89b-42d3-a456-426614174001', fileName: '旧资料.pdf' }] };
    render(<PreviewCoursePage />);
    expect(await screen.findByText('当前资源包与最近生成任务不一致，历史补充资料不作为本课程依据。')).toBeVisible();
    expect(screen.queryByText('旧任务的要求')).toBeNull();
    expect(screen.queryByRole('link', { name: '下载补充资料' })).toBeNull();
  });

  it.each([true, false])('restores directory focus only when the collapsed toggle is visible (visible=%s)', (visible) => {
    mocks.search = 'view=content&stage=ai-learning';
    render(<PreviewCoursePage />);
    const toggle = screen.getByRole('button', { name: /展开课程目录/ });
    vi.spyOn(toggle, 'getClientRects').mockReturnValue((visible ? [{ width: 390 }] : []) as unknown as DOMRectList);
    fireEvent.click(toggle);
    const page = screen.getByRole('button', { name: '2教学案例' });
    page.focus();
    fireEvent.click(page);
    expect(visible ? toggle : page).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers teaching-class arrangement after publication without starting a classroom', async () => {
    course.status = 'ready';
    render(<PreviewCoursePage />);
    fireEvent.click(screen.getByRole('button', { name: '安排到教学班' }));
    expect(mocks.router.push).toHaveBeenCalledWith('/teacher/teach/course/setup');
    expect(screen.queryByRole('button', { name: '开始授课' })).toBeNull();
    expect(mocks.publish).not.toHaveBeenCalled();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});
