import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Course } from '@/lib/session/types';
import type { PlateDocumentEditor } from '@/components/plate-document-editor';
import type { AiMemberWorkspace } from './ai-member-workspace';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';
import { DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS } from '@/lib/ai-collaboration/request-budget';

type WorkspaceProps = ComponentProps<typeof AiMemberWorkspace>;
type RequestBody = { requestId: string; courseId?: string; action?: string; message?: string; documentHtml?: string;
  intent?: string; revisionOf?: { title: string; content: string } };
const state = vi.hoisted(() => ({
  course: undefined as unknown as Course,
  editor: undefined as unknown as ComponentProps<typeof PlateDocumentEditor>,
  workspace: undefined as unknown as WorkspaceProps,
  post: vi.fn<(body: RequestBody) => Promise<Response>>(),
  receipt: vi.fn<(requestId: string) => Promise<Response>>(),
  history: vi.fn<(courseId: string | null) => Promise<Response>>(),
  digest: vi.fn<(html: string) => Promise<string | null>>(),
  cancel: vi.fn<(body: RequestBody) => Promise<Response>>(),
  persist: vi.fn(), apply: vi.fn(), confirm: vi.fn(), decision: vi.fn(),
}));
const initialHtml = '<p>周一记录了 3.5 升，周二记录了 8 升。</p>';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/session/store', () => ({
  useCourse: () => state.course,
  useHydrated: () => true,
  useSession: () => ({
    studentId: 'student-1', studentName: '学生', user: { name: '学生' }, saveState: 'saved',
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
vi.mock('@/lib/browser/ai-event-outbox', () => ({ flushAiInteractionEvents: async () => undefined, queueAiInteractionEvent: vi.fn() }));
vi.mock('@/lib/ai-collaboration/document-version', () => ({ documentVersionDigest: state.digest }));
// Keep the actual lifecycle and transport; capture the props presented to the sidebar.
vi.mock('./ai-member-workspace', () => ({ AiMemberWorkspace: (props: WorkspaceProps) => {
  state.workspace = props;
  return <>
    <output aria-label="请求忙碌状态">{String(props.busy)}</output>
    <textarea aria-label="协作请求" value={props.draft} onChange={event => props.onChangeDraft(event.target.value)} />
    <button disabled={props.busy} onClick={props.onSubmit}>发送</button>
    {props.messages.map(message => <article key={message.id} data-testid={`${message.role}-message`}>
      <span>{message.content}</span><span>{message.requestStatus}</span>
      {message.requestId && <>
        <button onClick={() => props.onRetryMessage(message.requestId!)}>查询结果</button>
        <button onClick={() => props.onCancelMessage(message.requestId!)}>取消请求</button>
      </>}
    </article>)}
    {props.pendingDelivery && <>
      <button onClick={props.onAdoptDelivery}>确认交付</button>
      {props.pendingDelivery.error && <p role="alert">{props.pendingDelivery.error}</p>}
    </>}
  </>;
} }));
vi.mock('@/components/plate-document-editor', async () => {
  const { useImperativeHandle } = await import('react');
  return { PlateDocumentEditor: (props: ComponentProps<typeof PlateDocumentEditor>) => {
    state.editor = props;
    useImperativeHandle(props.ref, () => ({
      getBlockCandidates: () => [], resolveCommentSelection: () => null,
      replaceRange: vi.fn(), insertAtCursor: vi.fn(),
      applyDelegatedWorkPlan: state.apply, previewDelegatedWorkPlan: () => ({ ok: true, presentation: 'blocks' }), focus: vi.fn(),
      previewAiSuggestion: vi.fn(), resolveAiSuggestion: vi.fn(),
    }));
    return <>
      <div data-testid="document">{props.value}</div>
      <button onClick={() => props.onOpenAiMember?.()}>打开组员</button>
    </>;
  } };
});
import { DocumentAiCollaboration } from './document-ai-collaboration';

function discussion(requestId: string, message = '我可以帮你检查已有记录。') {
  return Response.json({ requestId, status: 'completed', conversationId: 'legacy', result: { kind: 'discussion', message, focus: '现有记录' } });
}
function delivery(requestId: string, title: string, content: string) {
  return Response.json({ requestId, status: 'completed', conversationId: 'legacy', result: {
    kind: 'work-delivery', message: `${title}已完成。`, focus: title, deliverable: {
      title, summary: '保留原始记录', content, documentActions: [{ operation: 'none' }], sources: [], researchMode: 'model',
    },
  } });
}
const snapshotKey = (courseId: string) => `openpbl:document-collaboration:requests:${courseId}:student-1:make:document`;
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function openWorkspace(message = '这些记录还需要核对什么？') {
  render(<DocumentAiCollaboration courseId="course-1" />);
  await tick();
  fireEvent.click(screen.getByRole('button', { name: '打开组员' }));
  fireEvent.change(screen.getByRole('textbox', { name: '协作请求' }), { target: { value: message } });
}
async function submit(message?: string) {
  await openWorkspace(message);
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear(); sessionStorage.clear();
  state.post.mockReset(); state.receipt.mockReset(); state.cancel.mockReset();
  state.history.mockReset(); state.digest.mockReset();
  state.persist.mockReset(); state.apply.mockReset(); state.confirm.mockReset(); state.decision.mockReset();
  state.course = {
    ...createPblTemplateCourse('course-1'), name: '校园用水观察', status: 'teaching', version: 1,
    stages: [{ key: 'make', label: '项目实践', view: 'project-making', description: '' }], currentStageIndex: 0, groups: [],
    submissions: [{ id: 'document-1', courseId: 'course-1', studentId: 'student-1', stageKey: 'make',
      studentName: '学生', title: '观察记录', type: 'document', content: initialHtml, version: 1,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
  };
  state.persist.mockImplementation(async input => ({ ...input, version: 2 }));
  state.post.mockImplementation(async body => discussion(body.requestId));
  state.receipt.mockImplementation(async requestId => discussion(requestId));
  state.cancel.mockImplementation(async body => Response.json({ requestId: body.requestId, status: 'cancelled' }));
  state.history.mockImplementation(async () => Response.json({ conversationId: 'legacy', messages: [], requests: [], commentThreads: [], proactiveReviewEnabled: false }));
  state.digest.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith('/api/ai-collaboration/document?')) {
      const query = new URL(String(url), 'http://localhost').searchParams;
      const requestId = query.get('requestId');
      return requestId ? state.receipt(requestId) : state.history(query.get('courseId'));
    }
    if (String(url) === '/api/ai-collaboration/document' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as RequestBody;
      return body.action === 'cancel-request' ? state.cancel(body) : state.post(body);
    }
    throw new Error(`Unexpected request ${String(url)}`);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('keeps loading past the old deadline and retains a queryable question when the document wait window expires', async () => {
  state.post.mockReturnValue(new Promise<Response>(() => undefined));
  state.receipt.mockReturnValue(new Promise<Response>(() => undefined));
  await submit();
  expect(state.workspace.busy).toBe(true);
  await tick(120_000);
  expect(state.workspace.busy).toBe(true);
  await tick(DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS - 120_000);
  expect(state.workspace.busy).toBe(false);
  expect(state.workspace.messages).toEqual([expect.objectContaining({ role: 'user', requestStatus: 'unconfirmed', retryable: false, content: '这些记录还需要核对什么？' })]);
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '查询结果' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '取消请求' })).toBeEnabled();
  state.receipt.mockImplementation(async requestId => Response.json({ requestId, status: 'processing' }, { status: 202 }));
  fireEvent.click(screen.getByRole('button', { name: '查询结果' })); await tick();
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.workspace.messages[0].requestStatus).toBe('recovering');
  fireEvent.click(screen.getByRole('button', { name: '取消请求' })); await tick();
  expect(state.workspace.busy).toBe(false);
  expect(state.workspace.messages[0].requestStatus).toBe('cancelled');
  expect(state.cancel).toHaveBeenCalledTimes(1);
});

it('recovers a committed reply after POST 503 without executing another POST', async () => {
  state.post.mockImplementation(async () => Response.json({ error: 'UPSTREAM_DISCONNECTED' }, { status: 503 }));
  await submit();
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.receipt).toHaveBeenCalledTimes(1);
  expect(state.workspace.busy).toBe(false);
  expect(state.workspace.messages.filter(message => message.role === 'assistant')).toEqual([
    expect.objectContaining({ content: '我可以帮你检查已有记录。' }),
  ]);
  expect(state.workspace.messages[0].requestStatus).toBeUndefined();
  expect(state.workspace.messages.some(message => message.requestStatus === 'failed')).toBe(false);
});

it('admits only one POST when submit is invoked twice before React renders the busy state', async () => {
  const pending = deferredResponse(); state.post.mockReturnValue(pending.promise);
  await openWorkspace();
  const sameFrameSubmit = state.workspace.onSubmit;
  act(() => { sameFrameSubmit(); sameFrameSubmit(); });
  await tick();
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.workspace.messages.filter(message => message.role === 'user')).toHaveLength(1);
  await act(async () => { pending.resolve(discussion(state.post.mock.calls[0][0].requestId)); });
  await tick();
  expect(state.workspace.busy).toBe(false);
});

it('recovers the saved answer when completion wins cancellation and ignores the late original response', async () => {
  const pending = deferredResponse(); state.post.mockReturnValue(pending.promise);
  state.cancel.mockImplementation(async body => Response.json({ requestId: body.requestId, status: 'completed' }));
  await submit();
  const requestId = state.post.mock.calls[0][0].requestId;
  fireEvent.click(screen.getByRole('button', { name: '取消请求' })); await tick(); await tick(1);
  expect(state.receipt).toHaveBeenCalledWith(requestId);
  expect(state.workspace.busy).toBe(false);
  expect(state.workspace.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  await act(async () => { pending.resolve(discussion(requestId, '不应追加的迟到答复')); }); await tick();
  expect(state.workspace.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  expect(state.workspace.messages.some(message => message.content === '不应追加的迟到答复')).toBe(false);
  expect(state.post).toHaveBeenCalledTimes(1);
});

it('keeps cancellation terminal when the original successful response arrives later', async () => {
  const pending = deferredResponse(); state.post.mockReturnValue(pending.promise);
  await submit();
  const requestId = state.post.mock.calls[0][0].requestId;
  fireEvent.click(screen.getByRole('button', { name: '取消请求' })); await tick();
  expect(state.workspace.messages[0].requestStatus).toBe('cancelled');
  await act(async () => { pending.resolve(discussion(requestId)); }); await tick();
  expect(state.workspace.messages[0].requestStatus).toBe('cancelled');
  expect(state.workspace.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
  expect(state.workspace.busy).toBe(false);
});

it('leaves loading after an eight-second hung cancellation and preserves the original request for querying', async () => {
  state.post.mockImplementation(() => new Promise(() => {}));
  state.cancel.mockImplementation(() => new Promise(() => {}));
  await submit();
  const requestId = state.post.mock.calls[0][0].requestId;
  act(() => state.workspace.onCancelMessage(requestId)); await tick(8_000);
  expect(state.workspace.busy).toBe(false);
  expect(state.workspace.messages.find(message => message.requestId === requestId)).toMatchObject({
    requestStatus: 'unconfirmed', retryable: false, content: '这些记录还需要核对什么？',
  });
  expect(sessionStorage.getItem(snapshotKey('course-1'))).toContain(requestId);
  state.receipt.mockImplementation(async id => discussion(id, '取消未确认，原请求已经完成。'));
  act(() => state.workspace.onRetryMessage(requestId)); await tick();
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.workspace.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
});

it('blocks adoption after the document changes while a delivery waits for confirmation', async () => {
  state.post.mockImplementation(async body => Response.json({ requestId: body.requestId, status: 'completed', conversationId: 'legacy', result: {
    kind: 'work-delivery', message: '已经排好记录表。', focus: '原始记录表',
    deliverable: { title: '原始记录表', summary: '按日期整理已有记录。', content: '| 周一 | 3.5 升 |\\n| 周二 | 8 升 |',
      documentActions: [{ operation: 'replace', targetText: '周一记录了 3.5 升，周二记录了 8 升。', content: '记录表', description: '整理原始记录格式' }], sources: [], researchMode: 'model' },
  } }));
  await submit('请把已有原始记录排成表格，保留所有数值，先给我审阅，不要直接应用。');
  expect(state.workspace.pendingDelivery).not.toBeNull();
  const newer = '<p>学生新增了周三记录，不能被旧交付覆盖。</p>';
  act(() => state.editor.onChange(newer));
  fireEvent.click(screen.getByRole('button', { name: '确认交付' })); await tick();
  expect(state.workspace.pendingDelivery?.error).toContain('文稿已更新');
  expect(state.apply).not.toHaveBeenCalled();
  expect(state.confirm).not.toHaveBeenCalled();
  expect(state.decision).not.toHaveBeenCalled();
  expect(screen.getByTestId('document')).toHaveTextContent(newer);
});

it('resubmits a returned delivery through boundary assessment with the original revision context', async () => {
  const content = '| 周一 | 3.5 升 |';
  state.post.mockImplementationOnce(async body => Response.json({ requestId: body.requestId, status: 'completed', conversationId: 'legacy', result: {
    kind: 'work-delivery', message: '记录表已整理。', focus: '原始记录', deliverable: {
      title: '记录表', summary: '保留数据', content, documentActions: [{ operation: 'none' }], sources: [], researchMode: 'none',
    },
  } }));
  await submit('请把原始记录排成表格。');
  expect(state.workspace.pendingDelivery).not.toBeNull();
  act(() => state.workspace.onReviseDelivery());
  expect(state.workspace.pendingDelivery).toBeNull();
  expect(state.workspace.draft).toContain('请修改这份交付：记录表');
  act(() => state.workspace.onChangeDraft(`${state.workspace.draft}只保留原有列，不增加解释。`));
  act(() => state.workspace.onSubmit()); await tick();
  expect(state.post).toHaveBeenCalledTimes(2);
  expect(state.post.mock.calls[1][0]).toMatchObject({ intent: 'delegate', revisionOf: { title: '记录表', content } });
  expect(state.apply).not.toHaveBeenCalled();
});

it('keeps the full delivery readable without creating a preview after the draft changes in flight', async () => {
  const pending = deferredResponse(); state.post.mockReturnValue(pending.promise);
  await submit('请把已有原始记录排成表格，保留所有数值。');
  const requestId = state.post.mock.calls[0][0].requestId;
  act(() => state.editor.onChange('<p>新的记录正在编辑。</p>'));
  await act(async () => pending.resolve(Response.json({ requestId, status: 'completed', conversationId: 'legacy', result: {
    kind: 'work-delivery', message: '排表完成。', focus: '记录', deliverable: {
      title: '记录表', summary: '保留数据', content: '| 周一 | 3.5 升 |', documentActions: [{ operation: 'none' }], sources: [], researchMode: 'none',
    },
  } })));
  await tick();
  expect(state.workspace.pendingDelivery).toBeNull();
  expect(state.workspace.messages.find(message => message.role === 'assistant')?.content).toContain('| 周一 | 3.5 升 |');
  expect(state.workspace.messages.find(message => message.role === 'assistant')?.content).toContain('仅供参考');
  expect(state.apply).not.toHaveBeenCalled();
});

it('releases an aborted request busy state when the component switches to another course', async () => {
  const pending = deferredResponse(); state.post.mockReturnValueOnce(pending.promise);
  const { rerender } = render(<DocumentAiCollaboration courseId="course-1" />);
  await tick(); fireEvent.click(screen.getByRole('button', { name: '打开组员' }));
  act(() => state.workspace.onChangeDraft('解释原始记录'));
  act(() => state.workspace.onSubmit()); await tick();
  expect(state.workspace.busy).toBe(true);
  state.course = { ...state.course, id: 'course-2', submissions: [] };
  rerender(<DocumentAiCollaboration courseId="course-2" />); await tick();
  expect(state.workspace.busy).toBe(false);
  act(() => state.workspace.onChangeDraft('解释新的记录'));
  act(() => state.workspace.onSubmit()); await tick();
  expect(state.post).toHaveBeenCalledTimes(2);
  expect(state.post.mock.calls[1][0].courseId).toBe('course-2');
  await act(async () => pending.resolve(discussion('old-request', '旧课堂的迟到答复'))); await tick();
  expect(state.workspace.messages.some(message => message.content === '旧课堂的迟到答复')).toBe(false);
});

it('queries an unconfirmed delegation beside a pending delivery without replacing its review', async () => {
  state.post.mockImplementationOnce(() => new Promise(() => {}));
  state.receipt.mockImplementation(() => new Promise(() => {}));
  await submit('请把已有原始记录排成表格，保留所有数值。');
  const firstRequestId = state.post.mock.calls[0][0].requestId;
  await tick(DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS);
  expect(state.workspace.messages.find(message => message.requestId === firstRequestId)?.requestStatus).toBe('unconfirmed');

  state.post.mockImplementation(async body => delivery(body.requestId, '仍待审阅的第二份表格', '| 周二 | 8 升 |'));
  act(() => state.workspace.onChangeDraft('请把周二已有记录排成表格。'));
  act(() => state.workspace.onSubmit()); await tick();
  expect(state.workspace.pendingDelivery?.title).toBe('仍待审阅的第二份表格');
  const pendingDelivery = state.workspace.pendingDelivery;

  state.receipt.mockImplementation(async requestId => delivery(requestId, '恢复的第一份表格', '| 周一 | 3.5 升 |'));
  act(() => state.workspace.onRetryMessage(firstRequestId)); await tick();
  expect(state.receipt).toHaveBeenLastCalledWith(firstRequestId);
  expect(state.workspace.messages.find(message => message.requestId === firstRequestId)?.requestStatus).toBeUndefined();
  expect(state.workspace.messages.filter(message => message.role === 'assistant').some(message => message.content.includes('| 周一 | 3.5 升 |'))).toBe(true);
  expect(state.workspace.pendingDelivery).toEqual(pendingDelivery);
  expect(state.post).toHaveBeenCalledTimes(2);
  expect(state.apply).not.toHaveBeenCalled();
});

it('ignores a late cancellation after switching courses and keeps each course snapshot isolated', async () => {
  state.post.mockImplementation(() => new Promise(() => {}));
  const cancel = deferredResponse(); state.cancel.mockReturnValue(cancel.promise);
  const { rerender } = render(<DocumentAiCollaboration courseId="course-1" />);
  await tick(); fireEvent.click(screen.getByRole('button', { name: '打开组员' }));
  act(() => state.workspace.onChangeDraft('解释第一门课的记录'));
  act(() => state.workspace.onSubmit()); await tick();
  const firstRequestId = state.post.mock.calls[0][0].requestId;
  const firstSnapshot = sessionStorage.getItem(snapshotKey('course-1'));
  expect(firstSnapshot).toContain(firstRequestId);
  act(() => state.workspace.onCancelMessage(firstRequestId)); await tick();

  state.course = { ...state.course, id: 'course-2', submissions: [] };
  rerender(<DocumentAiCollaboration courseId="course-2" />); await tick();
  act(() => state.workspace.onChangeDraft('解释第二门课的记录'));
  act(() => state.workspace.onSubmit()); await tick();
  const secondRequestId = state.post.mock.calls[1][0].requestId;
  const secondSnapshot = sessionStorage.getItem(snapshotKey('course-2'));
  expect(secondSnapshot).toContain(secondRequestId);
  await act(async () => cancel.resolve(Response.json({ requestId: firstRequestId, status: 'cancelled' }))); await tick();

  expect(sessionStorage.getItem(snapshotKey('course-1'))).toBe(firstSnapshot);
  expect(sessionStorage.getItem(snapshotKey('course-2'))).toBe(secondSnapshot);
  expect(state.workspace.messages.some(message => message.requestId === firstRequestId)).toBe(false);
  expect(state.workspace.messages.find(message => message.requestId === secondRequestId)?.requestStatus).toBe('sending');
  expect(state.workspace.busy).toBe(true);
});

it('ignores a completed old answer when its document digest resolves after a course switch', async () => {
  let finishDigest!: (value: string) => void;
  state.digest.mockImplementationOnce(() => new Promise(resolve => { finishDigest = resolve; }));
  state.post.mockImplementationOnce(async body => Response.json({ requestId: body.requestId, status: 'completed', conversationId: 'legacy',
    documentVersion: 'old-digest', result: { kind: 'discussion', message: '计算摘要期间迟到的旧课堂回答', focus: '记录' },
  })).mockImplementation(() => new Promise(() => {}));
  const { rerender } = render(<DocumentAiCollaboration courseId="course-1" />);
  await tick(); fireEvent.click(screen.getByRole('button', { name: '打开组员' }));
  act(() => state.workspace.onChangeDraft('解释第一门课的记录'));
  act(() => state.workspace.onSubmit()); await tick();
  expect(state.digest).toHaveBeenCalledTimes(1);
  const firstSnapshot = sessionStorage.getItem(snapshotKey('course-1'));

  state.course = { ...state.course, id: 'course-2', submissions: [] };
  rerender(<DocumentAiCollaboration courseId="course-2" />); await tick();
  act(() => state.workspace.onChangeDraft('解释第二门课的记录'));
  act(() => state.workspace.onSubmit()); await tick();
  const secondSnapshot = sessionStorage.getItem(snapshotKey('course-2'));
  await act(async () => finishDigest('old-digest')); await tick();

  expect(state.workspace.messages.some(message => message.content.includes('旧课堂回答'))).toBe(false);
  expect(sessionStorage.getItem(snapshotKey('course-1'))).toBe(firstSnapshot);
  expect(sessionStorage.getItem(snapshotKey('course-2'))).toBe(secondSnapshot);
  expect(state.workspace.busy).toBe(true);
});

it('deduplicates a completed question and answer already present in refresh history', async () => {
  const requestId = 'completed-before-refresh';
  const message = '解释原始记录';
  const storedMessages = [
    { id: 'persisted-student', role: 'student', content: message, createdAt: '2026-10-19T08:00:00Z' },
    { id: 'persisted-agent', role: 'agent', content: '已经核对已有记录。', createdAt: '2026-10-19T08:00:01Z' },
  ];
  sessionStorage.setItem(snapshotKey('course-1'), JSON.stringify([{
    requestId, messageId: 'optimistic-before-refresh', contributionId: 'contribution-before-refresh',
    createdAt: new Date().toISOString(), conversationId: 'legacy', intent: 'discuss', message,
    documentHtml: initialHtml, selection: null,
  }]));
  state.history.mockImplementation(async () => Response.json({ conversationId: 'legacy', messages: storedMessages,
    requests: [], commentThreads: [], proactiveReviewEnabled: false,
  }));
  state.receipt.mockImplementation(async () => Response.json({ requestId, status: 'completed', conversationId: 'legacy',
    messages: storedMessages, result: { kind: 'discussion', message: '已经核对已有记录。', focus: '记录' },
  }));
  render(<DocumentAiCollaboration courseId="course-1" />);
  await tick(); await tick(1);
  fireEvent.click(screen.getByRole('button', { name: '打开组员' }));
  expect(state.receipt).toHaveBeenCalledWith(requestId);
  expect(state.workspace.messages.map(item => item.id)).toEqual(['persisted-student', 'persisted-agent']);
  expect(screen.getAllByTestId('user-message')).toHaveLength(1);
  expect(screen.getAllByTestId('assistant-message')).toHaveLength(1);
  expect(state.post).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(snapshotKey('course-1')) ?? '[]')).toEqual([]);
});
