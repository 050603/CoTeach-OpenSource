import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { SubmissionSaveConflict } from '@/lib/browser/submission-save-outbox';
import type { Course } from '@/lib/session/types';
import type { StudentAiDecision } from '@/lib/learning-evidence/types';
import type { PlateDocumentEditor } from '@/components/plate-document-editor';
import type { AiMemberWorkspace } from './ai-member-workspace';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';
import { readDocumentDrafts } from '@/lib/browser/document-draft';

const state = vi.hoisted(() => ({ course: undefined as unknown as Course,
  editor: undefined as unknown as ComponentProps<typeof PlateDocumentEditor>,
  decisions: new Map<string, StudentAiDecision>(), approval: 'pending',
  conflicts: [] as SubmissionSaveConflict[], resolveSave: vi.fn(),
  persist: vi.fn(), confirm: vi.fn(), process: vi.fn(), audit: vi.fn() }));
const beforeHtml = '<p>辅助记录：请在周一登记观察时段。</p>';
const afterHtml = '<p>辅助记录：请在星期一登记观察时段。</p>';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/session/store', () => ({
  useCourse: () => state.course, useHydrated: () => true,
  useSession: () => ({ studentId: 'student-1', studentName: '学生', user: { name: '学生' },
    saveState: 'saved', submissionSaveConflicts: state.conflicts, resolveSubmissionSaveConflict: state.resolveSave, persistSubmission: state.persist, upsertAiContribution: vi.fn(),
    addCompanionProcessRecord: state.process, upsertCompanionConfirmation: () => ({ id: 'approval-1' }),
    resolveCompanionConfirmation: state.confirm,
    recordStudentAiDecision: (decision: StudentAiDecision) => state.decisions.set(decision.id, decision),
  }),
}));
vi.mock('@/hooks/use-course-presence', () => ({ useCoursePresence: vi.fn() }));
vi.mock('./use-project-memory', () => {
  const memory = { memories: [], replaceMemories: vi.fn(), refresh: vi.fn(async () => undefined) };
  return { useProjectMemory: () => memory };
});
vi.mock('@/lib/resource-package/course-requirements', () => ({ getCourseStageRequirements: () => undefined }));
vi.mock('@/components/dashboard-shell', () => ({ DashboardTopBar: () => null }));
vi.mock('@/components/classroom/student-classroom-header-status', () => ({ StudentClassroomHeaderStatus: () => null }));
vi.mock('./collaboration-project-details', () => ({ CollaborationProjectDetails: () => null }));
vi.mock('./final-artifact-submission', () => ({ FinalArtifactSubmission: () => null }));
vi.mock('./external-artifact-submission', () => ({ ExternalArtifactSubmission: () => null }));
vi.mock('@/lib/browser/ai-event-outbox', () => ({ flushAiInteractionEvents: async () => undefined, queueAiInteractionEvent: state.audit }));
vi.mock('./ai-member-workspace', () => ({ AiMemberWorkspace: (props: ComponentProps<typeof AiMemberWorkspace>) => <>
  <textarea aria-label="辅助编辑要求" value={props.draft} onChange={event => props.onChangeDraft(event.target.value)} />
  <button disabled={props.busy} onClick={props.onSubmit}>发送辅助编辑</button>
  {props.pendingChange && <button onClick={props.onAcceptChange}>接受修改</button>}
</> }));
vi.mock('@/components/plate-document-editor', async () => {
  const { useImperativeHandle } = await import('react');
  return { PlateDocumentEditor: (props: ComponentProps<typeof PlateDocumentEditor>) => {
    state.editor = props;
    useImperativeHandle(props.ref, () => ({ getBlockCandidates: () => [],
      resolveCommentSelection: () => null,
      replaceRange: () => { throw new Error('Unexpected direct document mutation'); },
      insertAtCursor: () => { throw new Error('Unexpected direct document mutation'); },
      previewDelegatedWorkPlan: vi.fn(), applyDelegatedWorkPlan: () => { throw new Error('Unexpected delegated document mutation'); },
      focus: vi.fn(),
      previewAiSuggestion: () => ({ ok: true, presentation: 'inline' }),
      resolveAiSuggestion: () => {
        props.onChange(afterHtml);
        return { ok: true, beforeHtml, afterHtml };
      },
    }));
    return <>
      <div data-testid="document">{props.value}</div>
      <button onClick={() => props.onOpenAiMember?.()}>打开组员</button>
      <button onClick={() => props.onSelectionChange?.({ text: '周一', anchor: { path: [0, 0], offset: 8 }, focus: { path: [0, 0], offset: 10 } })}>选择辅助词</button>
      {props.appliedAiEdit && <button aria-label={`撤销 AI 修改“${props.appliedAiEdit.title}”`} onClick={props.appliedAiEdit.onUndo}>撤销已采用修改</button>}
    </>;
  } };
});
import { DocumentAiCollaboration } from './document-ai-collaboration';

beforeEach(() => {
  vi.useFakeTimers(); state.decisions.clear(); state.approval = 'pending'; state.conflicts = []; state.resolveSave.mockReset();
  state.persist.mockReset(); state.confirm.mockReset(); state.process.mockReset(); state.audit.mockReset();
  state.course = { ...createPblTemplateCourse('course-1'), name: '课堂', status: 'teaching', version: 1,
    stages: [{ key: 'make', label: '项目实践', view: 'project-making', description: '' }], currentStageIndex: 0, groups: [],
    submissions: [{ id: 'document-1', courseId: 'course-1', studentId: 'student-1', stageKey: 'make',
      studentName: '学生', title: '观察记录', type: 'document', content: beforeHtml, version: 1,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
  };
  state.persist.mockImplementation(async input => ({ ...input, version: 2 }));
  state.confirm.mockImplementation((_courseId, _id, status) => {
    if (state.approval !== 'pending' && state.approval !== status) throw new Error('terminal approval is immutable');
    state.approval = status;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith('/api/ai-collaboration/document?')) return Response.json({ messages: [], requests: [], commentThreads: [], proactiveReviewEnabled: false });
    if (String(url) === '/api/ai-collaboration/document' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ requestId: body.requestId, status: 'completed', conversationId: 'legacy', result: {
        kind: 'edit-suggestion', message: '只统一日期用词。', suggestion: { operation: 'replace', title: '统一日期用词',
          targetText: '周一', replacement: '星期一', reason: '保持原意，只调整辅助措辞。' },
      } });
    }
    throw new Error(`Unexpected request ${String(url)}`);
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function adopt() {
  render(<DocumentAiCollaboration courseId="course-1" />); await tick();
  fireEvent.click(screen.getByRole('button', { name: '打开组员' }));
  fireEvent.click(screen.getByRole('button', { name: '选择辅助词' }));
  fireEvent.change(screen.getByRole('textbox', { name: '辅助编辑要求' }), { target: { value: '仅修改所选词，把周一改为星期一，先给我预览，不要直接应用。' } });
  fireEvent.click(screen.getByRole('button', { name: '发送辅助编辑' })); await tick();
  fireEvent.click(screen.getByRole('button', { name: '接受修改' })); await tick();
  expect(state.approval).toBe('confirmed');
  expect([...state.decisions.values()]).toHaveLength(1);
  expect(screen.getByTestId('document')).toHaveTextContent(afterHtml);
  return [...state.decisions.values()][0];
}

it('undoes after the toast expires while retaining the committed approval and original adopted decision', async () => {
  const adopted = await adopt(); expect(adopted.decision).toBe('adopted');
  await tick(6_000);
  expect(screen.queryByText('AI 修改已应用')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '撤销 AI 修改“统一日期用词”' })); await tick();
  expect(state.approval).toBe('confirmed'); expect(state.confirm).toHaveBeenCalledTimes(1);
  expect(state.decisions.get(adopted.id)).toEqual(adopted);
  const undone = [...state.decisions.values()].find(decision => decision.id !== adopted.id);
  expect(undone).toMatchObject({ contributionId: adopted.contributionId, decision: 'rejected', reason: expect.stringContaining('撤销') });
  expect(state.decisions.size).toBe(2);
  expect(state.audit).toHaveBeenCalledWith('course-1:student-1:make:document', expect.objectContaining({ eventType: 'undo',
    payload: expect.objectContaining({ decisionId: undone!.id, adoptedDecisionId: adopted.id }) }));
  expect(state.process).toHaveBeenLastCalledWith(expect.objectContaining({ title: expect.stringContaining('撤销 AI 内容') }));
  expect(screen.getByTestId('document')).toHaveTextContent(beforeHtml);
  expect(state.persist.mock.calls.at(-1)?.[0]).toMatchObject({ content: beforeHtml });
});

it('removes the persistent undo control after a later independent document edit', async () => {
  await adopt();
  act(() => state.editor.onChange('<p>学生新增的独立记录必须保留。</p>')); await tick(900);
  expect(screen.queryByRole('button', { name: /撤销 AI 修改/ })).toBeNull();
  expect([...state.decisions.values()]).toHaveLength(1);
  expect(state.approval).toBe('confirmed');
  expect(state.persist.mock.calls.at(-1)?.[0]).toMatchObject({ content: '<p>学生新增的独立记录必须保留。</p>' });
});


it('does not resurrect the applied document as an unsaved draft after Undo is acknowledged', async () => {
  await adopt();
  fireEvent.click(screen.getByRole('button', { name: '撤销 AI 修改“统一日期用词”' })); await tick();
  expect(state.persist.mock.calls.at(-1)?.[0].content).toBe(beforeHtml);
  expect(readDocumentDrafts('course-1:student-1:make:document')).toEqual([]);
  await tick(1000);
  expect(screen.getByTestId('document')).toHaveTextContent(beforeHtml);
  expect(readDocumentDrafts('course-1:student-1:make:document')).toEqual([]);
});

it('offers a new local edit after Undo without requiring reload or another user edit', async () => {
  await adopt();
  fireEvent.click(screen.getByRole('button', { name: '撤销 AI 修改“统一日期用词”' })); await tick();
  // The editor mock intentionally does not emit onChange when props.value is
  // restored. This matches the real Plate controlled-value contract.
  fireEvent.click(screen.getByRole('button', { name: '选择辅助词' }));
  fireEvent.change(screen.getByRole('textbox', { name: '辅助编辑要求' }), {
    target: { value: '仅修改所选词，把周一改为星期一。这是撤销后的一次独立审阅，先给我预览，不要直接应用。' },
  });
  fireEvent.click(screen.getByRole('button', { name: '发送辅助编辑' })); await tick();
  const request = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/api/ai-collaboration/document' && init?.method === 'POST').at(-1);
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ intent: 'edit', documentHtml: beforeHtml, selectedText: '周一' });
  expect(screen.getByRole('button', { name: '接受修改' })).toBeEnabled();
  expect(screen.getByTestId('document')).toHaveTextContent(beforeHtml);
  expect(state.approval).toBe('confirmed'); expect(state.decisions.size).toBe(2);
});

function saveConflict() {
  const submission = state.course.submissions![0];
  state.conflicts = [{ requestId: 'conflict-request', actorId: 'student-1', createdAt: 1, state: 'conflict',
    action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course-1', submission, expectedSubmissionVersion: 1 } },
    remote: { ...submission, content: '<p>服务器版本</p>', version: 2 } }];
  return submission;
}

it('preserves newer typing when explicit conflict adoption returns a late ACK', async () => {
  const submission = saveConflict();
  let finish!: (value: typeof submission) => void;
  state.resolveSave.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const rendered = render(<DocumentAiCollaboration courseId="course-1" />); await tick();
  fireEvent.click(screen.getByRole('button', { name: '采用当前本机内容并保存' })); await tick();
  // The session archives the explicit choice before the server write finishes.
  state.conflicts = [];
  rendered.rerender(<DocumentAiCollaboration courseId="course-1" />); await tick();
  const latest = '<p>等待冲突保存期间新增的正文。</p>';
  act(() => state.editor.onChange(latest));
  await act(async () => { finish({ ...submission, content: beforeHtml, version: 3 }); }); await tick();
  expect(screen.getByTestId('document')).toHaveTextContent(latest);
  expect(readDocumentDrafts('course-1:student-1:make:document')).toEqual(expect.arrayContaining([
    expect.objectContaining({ content: latest, expectedVersion: 3 }),
  ]));
  await tick(900);
  expect(state.persist).toHaveBeenLastCalledWith(expect.objectContaining({ content: latest, expectedVersion: 3 }));
});

it('ignores a late explicit conflict resolution after switching document scope', async () => {
  const submission = saveConflict();
  let finish!: (value: typeof submission) => void;
  state.resolveSave.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const rendered = render(<DocumentAiCollaboration courseId="course-1" />); await tick();
  fireEvent.click(screen.getByRole('button', { name: '采用当前本机内容并保存' })); await tick();
  const nextHtml = '<p>另一个课堂的新正文。</p>';
  state.conflicts = [];
  state.course = { ...state.course, id: 'course-2', submissions: [{ ...submission, id: 'document-2', courseId: 'course-2', content: nextHtml }] };
  rendered.rerender(<DocumentAiCollaboration courseId="course-2" />); await tick();
  await act(async () => { finish({ ...submission, content: 'OLD_RESPONSE', version: 3 }); }); await tick();
  expect(screen.getByTestId('document')).toHaveTextContent(nextHtml);
  expect(state.persist).not.toHaveBeenCalled();
});
