import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Course } from '@/lib/session/types';
import type { PlateDocumentEditor } from '@/components/plate-document-editor';
import type { AiMemberWorkspace } from './ai-member-workspace';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';

const state = vi.hoisted(() => ({
  course: undefined as unknown as Course,
  editor: undefined as unknown as ComponentProps<typeof PlateDocumentEditor>,
  member: undefined as unknown as ComponentProps<typeof AiMemberWorkspace>,
  post: vi.fn<(requestId: string) => Promise<Response>>(),
  receipt: vi.fn<(requestId: string) => Promise<Response>>(),
  history: vi.fn<() => Promise<Response>>(),
  persist: vi.fn(), apply: vi.fn(), preview: vi.fn(), resolve: vi.fn(),
  confirm: vi.fn(), decision: vi.fn(), audit: vi.fn(),
}));
const beforeHtml = '<p>周一记录了 3.5 升，周二记录了 8 升。</p>';
const afterHtml = '<table><tr><td>周一</td><td>3.5 升</td></tr><tr><td>周二</td><td>8 升</td></tr></table>';
const scope = 'course-1:student-1:make:document';
const request = '请把文档中的现有记录整理成表格，保留原始数据。';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/session/store', () => ({
  useCourse: () => state.course, useHydrated: () => true,
  useSession: () => ({ studentId: 'student-1', studentName: '学生', user: { name: '学生' }, saveState: 'saved',
    submissionSaveConflicts: [], persistSubmission: state.persist,
    upsertAiContribution: vi.fn(), addCompanionProcessRecord: vi.fn(),
    upsertCompanionConfirmation: () => ({ id: 'confirmation-1' }),
    resolveCompanionConfirmation: state.confirm, recordStudentAiDecision: state.decision,
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
vi.mock('./ai-member-workspace', () => ({ AiMemberWorkspace: (props: ComponentProps<typeof AiMemberWorkspace>) => {
  state.member = props;
  return null;
} }));
vi.mock('@/components/plate-document-editor', async () => {
  const { useImperativeHandle } = await import('react');
  return { PlateDocumentEditor: (props: ComponentProps<typeof PlateDocumentEditor>) => {
    state.editor = props;
    useImperativeHandle(props.ref, () => ({
      getBlockCandidates: () => [], resolveCommentSelection: () => null,
      replaceRange: vi.fn(), insertAtCursor: vi.fn(),
      applyDelegatedWorkPlan: state.apply, previewDelegatedWorkPlan: state.preview, previewAiSuggestion: state.preview, resolveAiSuggestion: state.resolve,
      focus: vi.fn(),
    }));
    return <>
      <div data-testid="document">{props.value}</div>
      {props.appliedAiEdit && <button onClick={props.appliedAiEdit.onUndo}>撤销 AI 修改</button>}
    </>;
  } };
});
import { DocumentAiCollaboration } from './document-ai-collaboration';

function delivery(requestId: string, mutate = true) {
  return Response.json({ requestId, status: 'completed', conversationId: 'legacy', result: {
    kind: 'work-delivery', message: '已整理现有记录。', deliverable: {
      title: '整理观察记录', summary: '保留原始数值', content: '周一：3.5 升；周二：8 升。',
      documentActions: mutate ? [{ operation: 'replace', targetText: '周一记录了 3.5 升，周二记录了 8 升。',
        content: '| 日期 | 记录 |\n| --- | --- |\n| 周一 | 3.5 升 |\n| 周二 | 8 升 |', description: '把现有记录排成表格' }] : [{ operation: 'none' }],
      sources: [], researchMode: 'model',
    },
  } });
}
function suggestion(requestId: string) {
  return Response.json({ requestId, status: 'completed', conversationId: 'legacy', result: {
    kind: 'edit-suggestion', message: '统一了日期用词。', suggestion: {
      operation: 'replace', title: '统一日期用词', targetText: '周一', replacement: '星期一', reason: '保留原意。',
    },
  } });
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function mount() {
  const mounted = render(<DocumentAiCollaboration courseId="course-1" />); await tick();
  act(() => state.editor.onOpenAiMember?.());
  return mounted;
}
async function submit(message = request) {
  act(() => state.member.onChangeDraft(message));
  act(() => state.member.onSubmit()); await tick();
}
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear();
  state.post.mockReset(); state.receipt.mockReset(); state.history.mockReset();
  state.persist.mockReset(); state.apply.mockReset(); state.preview.mockReset(); state.resolve.mockReset();
  state.confirm.mockReset(); state.decision.mockReset(); state.audit.mockReset();
  state.course = { ...createPblTemplateCourse('course-1'), name: '观察课堂', status: 'teaching', version: 1,
    stages: [{ key: 'make', label: '项目实践', view: 'project-making', description: '' }], currentStageIndex: 0, groups: [],
    submissions: [{ id: 'document-1', courseId: 'course-1', studentId: 'student-1', stageKey: 'make',
      studentName: '学生', title: '观察记录', type: 'document', content: beforeHtml, version: 1,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
  };
  state.persist.mockImplementation(async input => ({ ...input, version: 2 }));
  // Deliberately omit onChange: the host must synchronize the successful editor
  // result immediately, before the real editor's deferred change notification.
  state.apply.mockReturnValue({ ok: true, beforeHtml, afterHtml });
  state.preview.mockReturnValue({ ok: true, presentation: 'inline' });
  state.resolve.mockReturnValue({ ok: true, beforeHtml, afterHtml });
  state.post.mockImplementation(async requestId => delivery(requestId));
  state.receipt.mockImplementation(async requestId => delivery(requestId));
  state.history.mockImplementation(async () => Response.json({ conversationId: 'legacy', messages: [], requests: [] }));
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith('/api/ai-collaboration/document?')) {
      const requestId = new URL(String(url), 'http://localhost').searchParams.get('requestId');
      return requestId ? state.receipt(requestId) : state.history();
    }
    if (String(url) === '/api/ai-collaboration/document' && init?.method === 'POST') {
      return state.post(JSON.parse(String(init.body)).requestId);
    }
    throw new Error(`Unexpected request ${String(url)}`);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('previews an explicit instruction and only persists after the student applies it, with auditable undo', async () => {
  await mount(); await submit();
  expect(state.preview).toHaveBeenCalledOnce();
  expect(state.apply).not.toHaveBeenCalled();
  expect(state.resolve).not.toHaveBeenCalled();
  expect(state.persist).not.toHaveBeenCalled();
  expect(state.confirm).not.toHaveBeenCalled();
  expect(state.decision).not.toHaveBeenCalled();
  expect(state.member.pendingDelivery?.previewReady).toBe(true);
  expect(screen.getByTestId('document')).toHaveTextContent(beforeHtml);
  act(() => state.member.onAdoptDelivery()); await tick();
  expect(state.resolve).toHaveBeenCalledWith('accepted');
  expect(screen.getByTestId('document')).toHaveTextContent(afterHtml);
  expect(state.persist).toHaveBeenCalledWith(expect.objectContaining({ content: afterHtml, expectedVersion: 1 }));
  expect(state.member.pendingDelivery).toBeNull();
  expect(state.member.messages.at(-1)?.content).not.toContain('已按你的要求修改文档');
  expect(state.confirm).toHaveBeenCalledWith('course-1', 'confirmation-1', 'confirmed');
  expect(state.decision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'adopted', reason: expect.stringContaining('审阅独立交付') }));
  expect(state.audit).toHaveBeenCalledWith(scope, expect.objectContaining({ eventType: 'decision',
    payload: expect.objectContaining({ authorization: 'reviewed', appliedToDocument: true }) }));
  fireEvent.click(screen.getByRole('button', { name: '撤销 AI 修改' })); await tick();
  expect(screen.getByTestId('document')).toHaveTextContent(beforeHtml);
  expect(state.persist).toHaveBeenLastCalledWith(expect.objectContaining({ content: beforeHtml, expectedVersion: 2 }));
  expect(state.decision).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'rejected', reason: expect.stringContaining('撤销') }));
  expect(state.confirm).toHaveBeenCalledOnce();
});

it('keeps a selected-text edit pending until the student accepts it', async () => {
  state.post.mockImplementation(async requestId => suggestion(requestId));
  state.resolve.mockReturnValue({ ok: true, beforeHtml, afterHtml: beforeHtml.replace('周一', '星期一') });
  await mount();
  act(() => state.editor.onSelectionChange?.({ text: '周一', anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 2 } }));
  await submit('请把选中的周一改为星期一。');
  expect(state.preview).toHaveBeenCalledOnce();
  expect(state.resolve).not.toHaveBeenCalled();
  expect(state.member.pendingChange?.title).toBe('统一日期用词');
  expect(state.persist).not.toHaveBeenCalled();
  act(() => state.member.onAcceptChange()); await tick();
  expect(state.resolve).toHaveBeenCalledWith('accepted');
  expect(state.apply).not.toHaveBeenCalled();
  expect(state.member.pendingChange).toBeNull();
  expect(screen.getByTestId('document')).toHaveTextContent('星期一');
  expect(state.persist).toHaveBeenCalledWith(expect.objectContaining({ content: beforeHtml.replace('周一', '星期一') }));
});

it.each(['先给我建议，不要应用。', '先审阅，不要直接写入文档。', '只在对话中提供，不要修改文档。', '先给我看。', '我确认以后再改。', '先不要动正文。', '不要改文档。'])(
  'retains review for an explicitly requested preview: %s', async suffix => {
    await mount(); await submit(`${request}${suffix}`);
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.member.pendingDelivery?.title).toBe('整理观察记录');
    expect(state.persist).not.toHaveBeenCalled();
    act(() => state.member.onAdoptDelivery()); await tick();
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.resolve).toHaveBeenCalledWith('accepted');
    expect(state.decision).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('审阅独立交付') }));
  },
);

it('keeps a failed operation for review and explicitly reports that the document was not changed', async () => {
  state.preview.mockReturnValue({ ok: false, reason: '文档中存在多个相同的目标段落。' });
  await mount(); await submit();
  expect(state.member.pendingDelivery?.error).toContain('尚未修改文档');
  expect(state.member.pendingDelivery?.error).toContain('多个相同');
  expect(screen.getByTestId('document')).toHaveTextContent(beforeHtml);
  expect(state.persist).not.toHaveBeenCalled(); expect(state.confirm).not.toHaveBeenCalled();
  expect(state.decision).not.toHaveBeenCalled();
  expect(state.member.messages.at(-1)?.content).not.toContain('已按你的要求修改文档');
});

it('does not accept a selected-text edit when its preview could not locate the original selection', async () => {
  state.post.mockImplementation(async requestId => suggestion(requestId));
  state.preview.mockReturnValue({ ok: false, reason: '原选区已经失效。' });
  await mount();
  act(() => state.editor.onSelectionChange?.({ text: '周一', anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 2 } }));
  await submit('请把选中的周一改为星期一。');
  expect(state.resolve).not.toHaveBeenCalled();
  expect(state.member.pendingChange?.error).toContain('尚未修改文档');
  expect(state.persist).not.toHaveBeenCalled();
});

it('allows dismissing a failed selection confirmation after the editor has restored its original content', async () => {
  state.post.mockImplementation(async requestId => suggestion(requestId));
  state.resolve.mockReturnValue({ ok: false, reason: '修改确认失败，已恢复生成建议前的文档。' });
  await mount();
  act(() => state.editor.onSelectionChange?.({ text: '周一', anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 2 } }));
  await submit('请把选中的周一改为星期一。');
  act(() => state.member.onAcceptChange()); await tick();
  expect(state.member.pendingChange?.error).toContain('尚未修改文档');
  expect(state.persist).not.toHaveBeenCalled();
  act(() => state.member.onRejectChange()); await tick();
  expect(state.resolve).toHaveBeenCalledOnce();
  expect(state.member.pendingChange).toBeNull();
  expect(state.confirm).toHaveBeenCalledWith('course-1', 'confirmation-1', 'rejected');
});

it('preserves student edits made while the AI response is in flight', async () => {
  let finish!: (value: Response) => void;
  state.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(); await submit();
  const newerHtml = '<p>学生新增了一项真实记录。</p>';
  act(() => state.editor.onChange(newerHtml));
  await act(async () => { finish(delivery('request-1')); }); await tick();
  expect(state.apply).not.toHaveBeenCalled(); expect(state.member.pendingDelivery).toBeNull();
  expect(screen.getByTestId('document')).toHaveTextContent(newerHtml);
  expect(state.member.messages.at(-1)?.content).toContain('文稿或对话已更新');
});

it('recovers an explicit request after refresh as a reviewable result without automatically writing again', async () => {
  sessionStorage.setItem(`openpbl:document-collaboration:requests:${scope}`, JSON.stringify([{
    requestId: 'recovered-request', messageId: 'student-message', contributionId: 'contribution-1',
    createdAt: new Date().toISOString(), conversationId: 'legacy', intent: 'delegate',
    message: request, documentHtml: beforeHtml, selection: null,
  }]));
  state.history.mockImplementation(async () => Response.json({ conversationId: 'legacy', messages: [],
    requests: [{ requestId: 'recovered-request', status: 'processing', message: request, intent: 'delegate' }],
  }));
  await mount(); await tick();
  expect(state.receipt).toHaveBeenCalledWith('recovered-request');
  expect(state.post).not.toHaveBeenCalled(); expect(state.apply).not.toHaveBeenCalled();
  expect(state.member.pendingDelivery?.title).toBe('整理观察记录');
  expect(state.persist).not.toHaveBeenCalled();
});

it('keeps a completed retry reviewable instead of automatically repeating the requested write', async () => {
  state.post.mockImplementationOnce(async requestId => Response.json({ requestId, status: 'failed', retryable: true, error: 'REQUEST_INTERRUPTED' }));
  state.receipt.mockImplementationOnce(async requestId => Response.json({ requestId, status: 'failed', retryable: true, error: 'REQUEST_INTERRUPTED' }));
  await mount(); await submit();
  const requestId = state.member.messages.find(message => message.requestId)?.requestId;
  expect(requestId).toBeTruthy();
  act(() => state.member.onRetryMessage(requestId!)); await tick();
  expect(state.post).toHaveBeenCalledTimes(2);
  expect(state.apply).not.toHaveBeenCalled();
  expect(state.member.pendingDelivery?.title).toBe('整理观察记录');
});

it('does not claim a document edit when the returned delivery contains no document operations', async () => {
  state.post.mockImplementation(async requestId => delivery(requestId, false));
  await mount(); await submit();
  expect(state.apply).not.toHaveBeenCalled(); expect(state.confirm).not.toHaveBeenCalled();
  expect(state.member.pendingDelivery?.title).toBe('整理观察记录');
  expect(state.member.messages.at(-1)?.content).not.toContain('已按你的要求修改文档');
});

it('can populate an empty document and undo back to the empty state', async () => {
  state.course.submissions![0].content = '';
  state.resolve.mockReturnValue({ ok: true, beforeHtml: '', afterHtml });
  await mount(); await submit('请在文档末尾添加空白记录表。');
  expect(state.persist).not.toHaveBeenCalled();
  act(() => state.member.onAdoptDelivery()); await tick();
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(screen.getByTestId('document')).toHaveTextContent(afterHtml);
  fireEvent.click(screen.getByRole('button', { name: '撤销 AI 修改' })); await tick();
  expect(state.persist).toHaveBeenLastCalledWith(expect.objectContaining({ content: '' }));
});

it.each(['reject', 'revise', 'document-control'] as const)('rejects a delivery preview through %s without saving an AI edit', async decision => {
  await mount(); await submit();
  expect(state.member.pendingDelivery?.previewReady).toBe(true);
  act(() => {
    if (decision === 'reject') state.member.onRejectDelivery();
    else if (decision === 'revise') state.member.onReviseDelivery();
    else state.editor.onAiSuggestionDecision?.('rejected');
  }); await tick();
  expect(state.resolve).toHaveBeenCalledWith('rejected');
  expect(state.member.pendingDelivery).toBeNull();
  expect(state.confirm).toHaveBeenCalledWith('course-1', 'confirmation-1', 'rejected');
  expect(state.persist).not.toHaveBeenCalled();
  expect(screen.getByTestId('document')).toHaveTextContent(beforeHtml);
});
