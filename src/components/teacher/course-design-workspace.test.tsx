import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { TeachingBlueprint } from '@/lib/session/types';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';
import { PPT_PAGE_PLANNING_VERSION } from '@/lib/course-design/ppt-page-planning-contract';
import { COURSE_DESIGN_WORKSPACE_SECTIONS } from '@/lib/course-design/workspace';
import { emptyResourcePackageDraft } from '@/lib/resource-package/types';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), search: 'section=blueprint' }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'course' }),
  useRouter: () => navigation, useSearchParams: () => new URLSearchParams(navigation.search) }));
vi.mock('@/components/teacher/preparation-shell', () => ({ preparationThemeClassName: 'preparation-theme', PreparationShell: ({ children, backHref, onNavigate, saveStatus }: { children: ReactNode; backHref: string; onNavigate?: (href: string) => void; saveStatus?: { state: string } }) => <><a href={backHref} onClick={(event) => { event.preventDefault(); onNavigate?.(backHref); }}>外层返回</a><output aria-label="保存状态">{saveStatus?.state}</output>{children}</> }));
vi.mock('@/components/teacher/course-cover-settings', () => ({ CourseCoverSettings: () => null }));
vi.mock('@/components/teacher/launch-presentation-replacement', () => ({ LaunchPresentationReplacement: () => null }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/session/store', () => ({ useSession: () => ({ user: { name: '教师' }, refresh: vi.fn() }) }));
import { CourseDesignWorkspace } from './course-design-workspace';
import { TeachingBlueprintDetails } from './teaching-blueprint-details';

function blueprint(native: boolean): TeachingBlueprint {
  return { schemaVersion: 3, inputFingerprint: 'source', assessmentMode: 'adaptive', createdAt: '2026-10-04',
    budget: { totalDurationSec: 600, teachingDurationSec: 480, learnerActivityDurationSec: 0,
      assessmentDurationSec: 120, teachingRatio: 0.8, assessmentRatio: 0.2 },
    sections: [{ id: 'section', contentMode: 'spoken', ...(native ? { pptPlanningVersion: PPT_PAGE_PLANNING_VERSION } : {}),
      title: '认识与案例', order: 0, knowledgePointIds: ['kp'], learningObjective: '解释关系', assessmentFocus: ['关系'],
      understandingCriteria: { goals: ['解释关系'], answerEssentials: [], misconceptions: [], supportingUnitIds: ['unit'] },
      sharedContext: { learningPurpose: '理解过程', caseId: '', caseFacts: [], stableTerms: [], fixedWording: [], conceptBoundaries: [] },
      teachingDurationSec: 480, learnerActivityDurationSec: 0, assessmentDurationSec: 120,
      units: [{ id: 'unit', title: '过程', knowledgePointIds: ['kp'], learningOutcome: '理解关系',
        explanation: '', mechanism: '', workedExample: '', conditions: [], misconceptions: [], sourceKind: 'course-source', evidenceQuotes: [],
        explanationNodes: [{ id: 'node', kind: 'concept', content: '完整讲稿与证据原样保留。', knowledgePointIds: ['kp'],
          prerequisiteNodeIds: [], provenance: 'course-source', sourceBindings: [] }] }],
      pages: [{ id: 'page', title: '完整认识', type: 'slide', unitIds: ['unit'], knowledgePointIds: ['kp'],
        description: '概念与案例共同说明关系', keyPoints: ['原生要点'], teachingObjective: '理解关系', introducesNodeIds: ['node'],
        ...(!native ? { presentationItems: [{ text: '旧版显示要点', nodeIds: ['node'], role: 'key-point' as const }] } : {}) }],
    }] };
}

beforeEach(() => { navigation.push.mockClear(); navigation.replace.mockClear(); navigation.search = 'section=blueprint'; });
afterEach(() => vi.unstubAllGlobals());

describe('native page plan in the teacher workspace', () => {
  it.each([true, false])('edits the authoritative page fields and preserves canonical speech (native=%s)', async (native) => {
    const course = createPblTemplateCourse('course', { name: '课程', subject: '科学', grade: '七年级', hours: 1 });
    course.version = 1;
    course.content.knowledgePoints = [{ id: 'kp', name: '知识', description: '关系' }];
    course.content.teachingBlueprint = blueprint(native);
    const originalUnits = structuredClone(course.content.teachingBlueprint.sections[0]!.units);
    const payload = { course, statuses: Object.fromEntries(COURSE_DESIGN_WORKSPACE_SECTIONS.map(({ key }) => [key, 'ready'])),
      pendingUpdates: [], publication: { latestVersion: null, publishedVersion: null, draftVersion: null },
      jobs: { design: null, classroom: null } };
    const requests: Array<{ data: TeachingBlueprint }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') {
        const request = JSON.parse(options.body as string);
        requests.push(request);
        course.content.teachingBlueprint = request.data;
      }
      return { ok: true, json: async () => payload };
    }));
    render(<CourseDesignWorkspace />);
    const point = await screen.findByDisplayValue(native ? '原生要点' : '旧版显示要点');
    fireEvent.change(point, { target: { value: '教师修改后的页面要点' } });
    fireEvent.change(screen.getByLabelText('页面说明'), { target: { value: '新的完整页面职责' } });
    if (native) fireEvent.click(screen.getByRole('button', { name: '添加页面' }));
    fireEvent.click(screen.getByRole('button', { name: '保存蓝图大纲' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    const saved = requests[0]!.data.sections[0]!;
    expect(saved.pages[0]).toMatchObject({ keyPoints: ['教师修改后的页面要点'], description: '新的完整页面职责' });
    expect(saved.units).toEqual(originalUnits);
    if (native) {
      expect(saved.pptPlanningVersion).toBe(PPT_PAGE_PLANNING_VERSION);
      expect(saved.pages).toHaveLength(2);
      expect(saved.pages.every((page) => page.presentationItems === undefined)).toBe(true);
      expect(saved.pages[1]).toMatchObject({ type: 'slide', introducesNodeIds: [], keyPoints: ['请补充页面要点'] });
    } else expect(saved.pages[0]!.presentationItems?.[0]?.text).toBe('教师修改后的页面要点');
  });

  it.each([true, false])('shows the adopted page duties in review details (native=%s)', (native) => {
    render(<TeachingBlueprintDetails blueprint={blueprint(native)} />);
    expect(screen.getByText(native ? '原生要点' : '旧版显示要点')).toBeTruthy();
    expect(screen.getByText('概念与案例共同说明关系')).toBeTruthy();
    expect(screen.getByText('完整讲稿与证据原样保留。')).toBeTruthy();
  });
});

function editableWorkspace() {
  const course = createPblTemplateCourse('course', { name: '课程', subject: '科学', grade: '七年级', hours: 1 });
  course.version = 1;
  course.content.teachingBlueprint = blueprint(true);
  return { course, statuses: Object.fromEntries(COURSE_DESIGN_WORKSPACE_SECTIONS.map(({ key }) => [key, 'ready'])),
    pendingUpdates: [], publication: { latestVersion: null, publishedVersion: null, draftVersion: null },
    jobs: { design: null, classroom: null } };
}

describe('collaborative preparation source isolation in the editor', () => {
  it.each(['materials', 'knowledge'])('does not reuse a retained package in %s', async (section) => {
    navigation.search = `section=${section}`;
    const payload = editableWorkspace();
    const draft = emptyResourcePackageDraft();
    payload.course.content.preparationSource = 'collaborative-preparation';
    payload.course.content.knowledgePoints = [{ id: 'kp', name: '实验观察', description: '观察与比较现象' }];
    payload.course.content.resourcePackage = {
      schemaVersion: 2, id: 'old-package', revision: 1,
      source: { id: 'old-upload', fileName: '旧交接包.zip', url: '/api/uploads/old-upload' }, documents: {},
      draft: { ...draft, stages: draft.stages.map((stage) => stage.key === 'ai-learning'
        ? { ...stage, title: '旧包的讲授名称', requirements: '比较旧案例', aiActions: '提供其他指导' } : stage) },
    };
    payload.course.content.teachingRequirements = { schemaVersion: 1, conflicts: [], items: [
      { id: 'legacy-requirement', kind: 'stage-requirement', source: 'resource-package', text: '比较旧案例', sourceKnowledgePointIds: [] },
      { id: 'current-activity', kind: 'stage-requirement', source: 'teacher', responsibility: 'learner-activity', text: '观察新的实验现象', sourceKnowledgePointIds: [] },
    ] };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));
    render(<CourseDesignWorkspace />);
    await screen.findByText(/比较旧案例/);
    expect(screen.queryByText('旧交接包.zip')).toBeNull();
    if (section === 'materials') {
      expect(screen.getByText(/讲授责任：比较旧案例/)).toBeTruthy();
    } else {
      expect(screen.getByText('阶段讲授要求')).toBeTruthy();
      expect(screen.getByText('阶段：知识讲授 / 学习任务与要求')).toBeTruthy();
      expect(screen.queryByText(/旧包的讲授名称/)).toBeNull();
    }
  });
});

describe('course editor navigation', () => {
  it.each(['外层返回', '版本记录', '返回课程详情'])('protects unsaved edits from %s and keeps them after a save conflict', async (name) => {
    const payload = editableWorkspace();
    navigation.search += '&returnTo=' + encodeURIComponent('/teacher/prepare/course/preview?view=content&sceneId=page');
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'PATCH'
      ? { ok: false, json: async () => ({ message: '课程版本已更新' }) }
      : { ok: true, json: async () => payload }));
    render(<CourseDesignWorkspace />);
    const point = await screen.findByDisplayValue('原生要点');
    fireEvent.change(point, { target: { value: '本地修改' } });
    fireEvent.click(screen.getByRole('link', { name }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));
    await screen.findByText('课程版本已更新');
    expect(point).toHaveValue('本地修改');
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(point).toHaveValue('本地修改');
  });

  it('returns to the original detail position after discarding', async () => {
    const payload = editableWorkspace();
    const returnTo = '/teacher/prepare/course/preview?view=content&stage=ai-learning&sceneId=page';
    navigation.search += '&returnTo=' + encodeURIComponent(returnTo);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));
    render(<CourseDesignWorkspace />);
    fireEvent.change(await screen.findByDisplayValue('原生要点'), { target: { value: '本地修改' } });
    fireEvent.click(screen.getByRole('link', { name: '返回课程详情' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(navigation.push).toHaveBeenCalledWith(returnTo);
  });

  it('preserves newer edits while a save is pending and stays in the editor', async () => {
    const payload = editableWorkspace();
    let complete!: (value: unknown) => void;
    const saving = new Promise((resolve) => { complete = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'PATCH' ? saving : { ok: true, json: async () => payload }));
    render(<CourseDesignWorkspace />);
    const point = await screen.findByDisplayValue('原生要点');
    fireEvent.change(point, { target: { value: '首次修改' } });
    fireEvent.click(screen.getByRole('link', { name: '返回课程详情' }));
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));
    fireEvent.change(point, { target: { value: '保存期间的新修改' } });
    complete({ ok: true, json: async () => payload });
    await waitFor(() => expect(screen.getByLabelText('保存状态')).toHaveTextContent('unsaved'));
    expect(point).toHaveValue('保存期间的新修改');
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
