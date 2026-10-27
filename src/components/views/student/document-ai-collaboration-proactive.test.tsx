import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Course } from '@/lib/session/types';
import { emitDocumentReviewCompletion } from '@/lib/browser/document-review-notifications';
import type { PlateDocumentEditor } from '@/components/plate-document-editor';
import type { AiMemberWorkspace } from '@/components/views/student/ai-member-workspace';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';

const state = vi.hoisted(() => ({ course: undefined as unknown as Course,
  editor: undefined as unknown as ComponentProps<typeof PlateDocumentEditor>,
  member: undefined as unknown as ComponentProps<typeof AiMemberWorkspace>,
  persist: vi.fn(), post: vi.fn(), review: vi.fn(), manual: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/session/store', () => ({
  useCourse: () => state.course, useHydrated: () => true,
  useSession: () => ({ studentId: 'student-1', studentName: '学生', user: { name: '学生' }, saveState: 'saved', persistSubmission: state.persist,
    upsertAiContribution: vi.fn(), addCompanionProcessRecord: vi.fn(), upsertCompanionConfirmation: () => ({ id: 'confirmation-1' }) }),
}));
vi.mock('@/hooks/use-course-presence', () => ({ useCoursePresence: vi.fn() }));
vi.mock('@/components/views/student/use-project-memory', () => {
  const memory = { memories: [], replaceMemories: vi.fn(), refresh: vi.fn(async () => undefined) };
  return { useProjectMemory: () => memory };
});
vi.mock('@/lib/resource-package/course-requirements', () => ({ getCourseStageRequirements: () => undefined }));
vi.mock('@/components/dashboard-shell', () => ({ DashboardTopBar: () => null }));
vi.mock('@/components/classroom/student-classroom-header-status', () => ({ StudentClassroomHeaderStatus: () => null }));
vi.mock('@/components/views/student/collaboration-project-details', () => ({ CollaborationProjectDetails: () => null }));
vi.mock('@/components/views/student/final-artifact-submission', () => ({ FinalArtifactSubmission: () => null }));
vi.mock('@/components/views/student/external-artifact-submission', () => ({ ExternalArtifactSubmission: () => null }));
vi.mock('@/components/views/student/ai-member-workspace', () => ({ AiMemberWorkspace: (props: ComponentProps<typeof AiMemberWorkspace>) => { state.member = props; return null; } }));
vi.mock('@/lib/browser/ai-event-outbox', () => ({ flushAiInteractionEvents: async () => undefined, queueAiInteractionEvent: vi.fn() }));
vi.mock('@/components/plate-document-editor', async () => {
  const { useImperativeHandle } = await import('react');
  return { PlateDocumentEditor: (props: ComponentProps<typeof PlateDocumentEditor>) => {
    state.editor = props;
    useImperativeHandle(props.ref, () => ({
      getBlockCandidates: () => [{ blockId: 'p1', blockIndex: 0, type: 'p', text: props.value.replace(/<[^>]*>/g, '') }],
      previewAiSuggestion: () => ({ ok: true, presentation: 'inline' }),
      resolveCommentSelection: () => null,
      replaceRange: () => { throw new Error('Unexpected document mutation'); },
      insertAtCursor: () => { throw new Error('Unexpected document mutation'); },
      previewDelegatedWorkPlan: vi.fn(), applyDelegatedWorkPlan: () => { throw new Error('Unexpected document mutation'); },
      resolveAiSuggestion: () => { throw new Error('Unexpected document mutation'); },
      focus: vi.fn(),
    }));
    return <div data-testid="document">{props.value}</div>;
  } };
});
import { DocumentAiCollaboration } from '@/components/views/student/document-ai-collaboration';

const html = '<p>甲地观察记录为十二次，乙地观察记录为六次，比较两个地点应采用相同观察时长。</p>';
const scope = 'course-1:student-1:make:document';
function fixture(id = 'course-1'): Course {
  return { ...createPblTemplateCourse(id), name: '课堂', status: 'teaching', version: 1,
    stages: [{ key: 'make', label: '项目实践', view: 'project-making', description: '' }], currentStageIndex: 0, groups: [],
    submissions: [{ id: 'document-1', studentId: 'student-1', studentName: '学生', courseId: id, stageKey: 'make', type: 'document', title: '观察记录', content: html, version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); vi.spyOn(Math, 'random').mockReturnValue(0);
  state.course = fixture(); state.post.mockReset(); state.review.mockReset(); state.persist.mockReset(); state.manual.mockReset();
  state.persist.mockImplementation(async (input) => ({ ...input, version: 2 }));
  state.review.mockImplementation(() => new Promise(() => undefined));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/ai-collaboration/document?')) return Response.json({ messages: [], commentThreads: [], proactiveReviewEnabled: true });
    if (url === '/api/ai-collaboration/document' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); state.post(body);
      if (body.action === 'proactive-document-comments') { state.review(body); return new Promise<Response>(() => undefined); }
      return state.manual(body) as Promise<Response>;
    }
    throw new Error(`Unexpected request ${url}`);
  }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() {
  const view = render(<DocumentAiCollaboration courseId={state.course.id} />);
  await tick(0); expect(screen.getByTestId('document').textContent).toBe(html);
  return view;
}

it('never submits automatic reviews after typing, autosave, refresh or completion notifications', async () => {
  const view = await mount();
  const revised = '<p>我已补充观察时长和实际数据，并保存新的课堂记录。</p>';
  act(() => state.editor.onChange(revised));
  await tick(900); expect(state.persist).toHaveBeenCalledOnce();
  await tick(5 * 60_000);
  view.rerender(<DocumentAiCollaboration courseId="course-1" />);
  await act(async () => { emitDocumentReviewCompletion('course-1', {
    source: 'ai-interaction-event', scope: 'student', studentId: 'student-1', requestId: 'old-review',
  }); });
  await tick(30_000);
  expect(state.review).not.toHaveBeenCalled(); expect(state.post).not.toHaveBeenCalled();
  expect(screen.queryByText(/自动审阅|重新审阅/)).toBeNull();
});

it('ignores retained and malformed legacy review outboxes without blocking document saves', async () => {
  localStorage.setItem('openpbl:document-review:v1:legacy', '{corrupt');
  const key = `openpbl:document-review:v1:${encodeURIComponent(scope)}:old-review`;
  const retained = JSON.stringify({ key, scope, requestId: 'old-review', createdAt: Date.now(), body: JSON.stringify({
    action: 'proactive-document-comments', courseId: 'course-1', studentId: 'student-1', stageKey: 'make', workspaceKind: 'document',
    requestId: 'old-review', documentHtml: html, paragraphs: [{ candidateId: 'p1', blockIndex: 0, targetText: '观察记录' }],
  }) });
  localStorage.setItem(key, retained);
  await mount();
  act(() => state.editor.onChange('<p>这是继续编辑的新正文，旧审阅任务不影响保存。</p>'));
  await tick(900); await tick(60_000);
  expect(state.persist).toHaveBeenCalledOnce(); expect(state.post).not.toHaveBeenCalled();
  expect(localStorage.getItem('openpbl:document-review:v1:legacy')).toBe('{corrupt');
  expect(localStorage.getItem(key)).toBe(retained);
  expect(screen.queryByText(/自动审阅|重新审阅|批注请求/)).toBeNull();
});

it('does not restore historical automatic comments even when an older history response includes them', async () => {
  const previousFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('/api/ai-collaboration/document?')
    ? Promise.resolve(Response.json({ messages: [], commentThreads: [{ id: 'old', targetText: '旧批注', comments: [{ role: 'assistant', content: '后台旧建议' }] }], proactiveReviewEnabled: true }))
    : previousFetch(input, init)));
  await mount(); await tick(60_000);
  expect(state.editor.aiCommentThreads).toBeUndefined();
  expect(screen.queryByText(/批注历史|后台旧建议|重新审阅/)).toBeNull();
});

it('keeps student-initiated AI collaboration available', async () => {
  state.manual.mockResolvedValue(Response.json({ status: 'completed', result: { kind: 'discussion', message: '可以核对相同观察时长内的数据。' } }));
  await mount();
  act(() => state.editor.onOpenAiMember?.());
  act(() => state.member.onChangeDraft('请检查当前观察记录。'));
  act(() => state.member.onSubmit()); await tick(0);
  expect(state.manual).toHaveBeenCalledOnce(); expect(state.member.busy).toBe(false);
  expect(state.member.messages.some(message => message.content === '可以核对相同观察时长内的数据。')).toBe(true);
  expect(state.review).not.toHaveBeenCalled();
});
