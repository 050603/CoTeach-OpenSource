import { encodeEventCursor } from '@/lib/realtime/event-cursor';
const receiptCursor = encodeEventCursor({ createdAt: new Date('2026-10-16T00:00:00.000Z'), id: '11111111-1111-4111-8111-111111111111' });
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { PlateDocumentEditor } from '@/components/plate-document-editor';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';
import { documentDraftKey, readDocumentDrafts, writeDocumentDraft } from '@/lib/browser/document-draft';
import { readSubmissionSaves, retainSubmissionSave, type SubmissionAction } from '@/lib/browser/submission-save-outbox';
import { SessionProvider } from '@/lib/session/store';

const state = vi.hoisted(() => ({ editor: undefined as unknown as ComponentProps<typeof PlateDocumentEditor> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/student/ai-collaboration/course', useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/hooks/use-course-presence', () => ({ useCoursePresence: vi.fn() }));
vi.mock('./use-project-memory', () => {
  const memory = { memories: [], replaceMemories: vi.fn(), refresh: vi.fn(async () => undefined) };
  return { useProjectMemory: () => memory };
});
vi.mock('@/lib/resource-package/course-requirements', () => ({ getCourseStageRequirements: () => undefined }));
vi.mock('@/components/dashboard-shell', () => ({ DashboardTopBar: ({ saveStatus }: { saveStatus: { state: string; onRetry?: () => void } }) => <><span data-testid="save-status">{saveStatus.state}</span><button onClick={saveStatus.onRetry}>重试保存</button></> }));
vi.mock('@/components/classroom/student-classroom-header-status', () => ({ StudentClassroomHeaderStatus: () => null }));
vi.mock('./collaboration-project-details', () => ({ CollaborationProjectDetails: () => null }));
vi.mock('./final-artifact-submission', () => ({ FinalArtifactSubmission: () => null }));
vi.mock('./external-artifact-submission', () => ({ ExternalArtifactSubmission: () => null }));
vi.mock('./ai-member-workspace', () => ({ AiMemberWorkspace: () => null }));
vi.mock('@/lib/browser/ai-event-outbox', () => ({ flushAiInteractionEvents: async () => undefined, queueAiInteractionEvent: vi.fn() }));
vi.mock('@/components/plate-document-editor', async () => {
  const { useImperativeHandle } = await import('react');
  return { PlateDocumentEditor: (props: ComponentProps<typeof PlateDocumentEditor>) => {
    state.editor = props;
    useImperativeHandle(props.ref, () => ({ getBlockCandidates: () => [], resolveCommentSelection: () => null,
      replaceRange: vi.fn(), insertAtCursor: vi.fn(), previewDelegatedWorkPlan: vi.fn(), applyDelegatedWorkPlan: vi.fn(), focus: vi.fn(), previewAiSuggestion: vi.fn(), resolveAiSuggestion: vi.fn() }));
    return <div data-testid="document">{props.value}</div>;
  } };
});
import { DocumentAiCollaboration } from './document-ai-collaboration';

const scope = 'course:student:make:document';
const original = { id: 'draft', courseId: 'course', studentId: 'student', studentName: '学生', stageKey: 'make', type: 'document' as const,
  title: '项目成果协作文档', content: '<p>旧快照</p>', status: 'draft' as const, version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const submitted = { ...original, content: '<p>已提交但旧页面丢失回执的新正文</p>', version: 2 };
const oldAction: SubmissionAction = { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', submission: submitted, expectedSubmissionVersion: 1 } };
type Envelope = { requestId: string; action: SubmissionAction };
async function mountWithOldSnapshot() {
  const draftKey = documentDraftKey(scope);
  writeDocumentDraft({ key: draftKey, scope, submissionId: 'draft', expectedVersion: 1, content: submitted.content, updatedAt: Date.now() });
  retainSubmissionSave({ requestId: 'original-request', actorId: 'student', draftKey, action: oldAction, createdAt: Date.now(), state: 'pending' });
  const staleCourse = { ...createPblTemplateCourse('course'), name: '课堂', status: 'teaching', version: 1, students: [], groups: [],
    stages: [{ key: 'make', label: '项目实践', view: 'ai-collaboration', description: '' }], currentStageIndex: 0, submissions: [original] };
  const sent: Envelope[] = [];
  let acknowledge!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Response.json({ courses: [staleCourse], user: { role: 'student', name: '学生' }, studentId: 'student', studentName: '学生', joinedCourseId: 'course' });
    if (url.startsWith('/api/ai-collaboration/document?')) return Response.json({ messages: [], requests: [], commentThreads: [], proactiveReviewEnabled: false });
    if (url.endsWith('/actions')) {
      const body = JSON.parse(String(options?.body)); sent.push(body);
      if (body.requestId === 'original-request') return new Promise<Response>(resolve => { acknowledge = resolve; });
      return Response.json({ requestId: body.requestId, courseVersion: 3, submissionVersion: 3, eventCursor: receiptCursor });
    }
    throw new Error(`Unexpected ${url}`);
  }));
  await act(async () => { render(<SessionProvider><DocumentAiCollaboration courseId="course" /></SessionProvider>); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(sent).toHaveLength(1); expect(sent[0].requestId).toBe('original-request'); expect(sent[0].action).toEqual(oldAction);
  expect(screen.getByTestId('document').textContent).toBe(submitted.content);
  await act(async () => { acknowledge(Response.json({ requestId: 'original-request', courseVersion: 2, submissionVersion: 2, eventCursor: receiptCursor })); });
  return sent;
}
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); window.history.replaceState({}, '', '/student/ai-collaboration/course'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });
it('replays the original receipt after a stale first GET and lets the real editor autosave timer settle without a second write', async () => {
  const sent = await mountWithOldSnapshot();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(sent).toHaveLength(1);
  expect(screen.getByTestId('document').textContent).toBe(submitted.content);
  expect(screen.getByTestId('save-status').textContent).toBe('saved');
  expect(readSubmissionSaves('student', 'course')).toEqual([]);
  expect(readDocumentDrafts(scope)).toEqual([]);
});
it('still sends a new request for new typing after restoring the old receipt', async () => {
  const sent = await mountWithOldSnapshot();
  act(() => state.editor.onChange('<p>恢复回执后继续编辑</p>'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(sent).toHaveLength(2); expect(sent[1].requestId).not.toBe('original-request');
  expect(sent[1].action.payload).toMatchObject({ expectedSubmissionVersion: 2, submission: { content: '<p>恢复回执后继续编辑</p>' } });
});
it('keeps the latest editing draft when an older queued save starts and fails', async () => {
  const course = { ...createPblTemplateCourse('course'), name: '课堂', status: 'teaching', version: 1, students: [], groups: [],
    stages: [{ key: 'make', label: '项目实践', view: 'ai-collaboration', description: '' }], currentStageIndex: 0, submissions: [original] };
  const sent: Envelope[] = [];
  let rejectFirst!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Response.json({ courses: [course], user: { role: 'student', name: '学生' }, studentId: 'student', studentName: '学生', joinedCourseId: 'course' });
    if (url.startsWith('/api/ai-collaboration/document?')) return Response.json({ messages: [], requests: [], commentThreads: [], proactiveReviewEnabled: false });
    if (url.endsWith('/actions')) {
      sent.push(JSON.parse(String(options?.body)) as Envelope);
      if (sent.length === 1) return new Promise<Response>(resolve => { rejectFirst = resolve; });
      return Response.json({ error: '保存失败' }, { status: 400 });
    }
    throw new Error(`Unexpected ${url}`);
  }));
  await act(async () => { render(<SessionProvider><DocumentAiCollaboration courseId="course" /></SessionProvider>); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  act(() => state.editor.onChange('<p>正在发送的正文 A</p>'));
  await act(async () => { fireEvent.click(screen.getByText('重试保存')); });
  expect(sent).toHaveLength(1);
  act(() => state.editor.onChange('<p>已经排队的正文 B</p>'));
  await act(async () => { fireEvent.click(screen.getByText('重试保存')); });
  act(() => state.editor.onChange('<p>排队之后继续输入的正文 C</p>'));
  expect(readDocumentDrafts(scope)[0]?.content).toBe('<p>排队之后继续输入的正文 C</p>');
  await act(async () => {
    rejectFirst(Response.json({ error: '保存失败' }, { status: 400 }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(sent).toHaveLength(2);
  expect(screen.getByTestId('save-status').textContent).toBe('error');
  expect(screen.getByTestId('document').textContent).toBe('<p>排队之后继续输入的正文 C</p>');
  expect(readDocumentDrafts(scope)).toEqual([expect.objectContaining({ content: '<p>排队之后继续输入的正文 C</p>', expectedVersion: 1 })]);
  expect(readSubmissionSaves('student', 'course')).toEqual([expect.objectContaining({ action: sent[0].action, requestId: sent[0].requestId })]);
});

function captureRecoveryDownloads() {
  const downloads: string[] = [];
  const NativeBlob = globalThis.Blob;
  vi.stubGlobal('Blob', class extends NativeBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options); downloads.push((parts ?? []).join(''));
    }
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:recovery-fixture'; }
    static revokeObjectURL() {}
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return { downloads, click };
}

async function mountStorageRecoveryDocument() {
  const course = { ...createPblTemplateCourse('course'), name: '课堂', status: 'teaching', version: 1, students: [], groups: [],
    stages: [{ key: 'make', label: '项目实践', view: 'ai-collaboration', description: '' }], currentStageIndex: 0, submissions: [original] };
  const sent: Envelope[] = [];
  let acknowledge!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Response.json({ courses: [course], user: { role: 'student', name: '学生' }, studentId: 'student', studentName: '学生', joinedCourseId: 'course' });
    if (url.startsWith('/api/ai-collaboration/document?')) return Response.json({ messages: [], requests: [], commentThreads: [], proactiveReviewEnabled: false });
    if (url.endsWith('/actions')) { sent.push(JSON.parse(String(options?.body))); return new Promise<Response>(resolve => { acknowledge = resolve; }); }
    throw new Error(`Unexpected ${url}`);
  }));
  await act(async () => { render(<SessionProvider><DocumentAiCollaboration courseId="course" /></SessionProvider>); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return { sent, acknowledge: () => acknowledge(Response.json({ requestId: sent[0].requestId, courseVersion: 2, submissionVersion: 2, eventCursor: receiptCursor })) };
}

for (const storage of ['empty', 'older', 'unreadable'] as const) {
  it(`downloads current document memory when ${storage} local storage cannot retain typing`, async () => {
    await mountStorageRecoveryDocument();
    const capture = captureRecoveryDownloads();
    if (storage !== 'empty') writeDocumentDraft({ key: documentDraftKey(scope), scope,
      submissionId: 'draft', expectedVersion: 1, content: '<p>较早持久正文 B</p>', updatedAt: 1 });
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const denied = storage === 'unreadable' ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); }) : undefined;
    try {
      act(() => state.editor.onChange('<p>当前内存正文 C</p>'));
      fireEvent.click(screen.getByRole('button', { name: /^下载本机草稿$/ }));
      const recovery = JSON.parse(capture.downloads.at(-1)!);
      expect(recovery).toMatchObject({ schemaVersion: 1, current: { source: 'memory', scope,
        submissionId: 'draft', expectedVersion: 1, content: '<p>当前内存正文 C</p>' } });
      expect(recovery.persisted).toEqual(storage === 'older'
        ? [expect.objectContaining({ source: 'local-storage', content: '<p>较早持久正文 B</p>', expectedVersion: 1 })] : []);
      expect(capture.click).toHaveBeenCalledOnce();
    } finally { denied?.mockRestore(); quota.mockRestore(); capture.click.mockRestore(); }
  });
}

it('keeps document storage failure visible after an old ACK and downloads the live newer content', async () => {
  const fixture = await mountStorageRecoveryDocument();
  const capture = captureRecoveryDownloads();
  act(() => state.editor.onChange('<p>发送正文 A</p>'));
  await act(async () => { fireEvent.click(screen.getByText('重试保存')); });
  expect(fixture.sent).toHaveLength(1);
  const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  try {
    act(() => state.editor.onChange('<p>仅在内存的正文 C</p>'));
    await act(async () => { fixture.acknowledge(); });
    expect(screen.getByTestId('save-status').textContent).toBe('error');
    fireEvent.click(screen.getByRole('button', { name: /^下载本机草稿$/ }));
    expect(JSON.parse(capture.downloads.at(-1)!)).toMatchObject({ current: { source: 'memory', scope,
      submissionId: 'draft', expectedVersion: 2, content: '<p>仅在内存的正文 C</p>' } });
    expect(screen.getByTestId('save-status').textContent).toBe('error');
    expect(screen.getByText(/浏览器未能保存本机草稿/)).toBeVisible();
    expect(screen.getByTestId('document').textContent).toBe('<p>仅在内存的正文 C</p>');
    expect(fixture.sent).toHaveLength(1);
  } finally { quota.mockRestore(); capture.click.mockRestore(); }
});

async function mountRevertedPendingDraft(options: { marked?: boolean; snapshotVersion?: number; pending?: boolean;
  recovered?: ReturnType<typeof readDocumentDrafts>[number]; seed?: boolean;
  serverDocument?: SubmissionAction['payload']['submission'] } = {}) {
  const recovered = options.recovered ?? { key: documentDraftKey(scope), scope, submissionId: 'draft', expectedVersion: 1,
    content: original.content, updatedAt: Date.now(), requiresConfirmation: options.marked ?? true };
  if (options.seed !== false) writeDocumentDraft(recovered);
  if (options.pending !== false) retainSubmissionSave({ requestId: 'revert-predecessor', actorId: 'student',
    draftKey: recovered.key, action: oldAction, createdAt: Date.now(), state: 'pending' });
  const serverDocument = options.serverDocument ?? (options.snapshotVersion === 2 ? submitted : original);
  const course = { ...createPblTemplateCourse('course'), name: '课堂', status: 'teaching', version: serverDocument.version,
    students: [], groups: [], stages: [{ key: 'make', label: '项目实践', view: 'ai-collaboration', description: '' }],
    currentStageIndex: 0, submissions: [serverDocument] };
  const sent: Envelope[] = [];
  const replies = new Map<string, (response: Response) => void>();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Response.json({ courses: [course], user: { role: 'student', name: '学生' },
      studentId: 'student', studentName: '学生', joinedCourseId: 'course' });
    if (url.startsWith('/api/ai-collaboration/document?')) return Response.json({ messages: [], requests: [], commentThreads: [], proactiveReviewEnabled: false });
    if (url.endsWith('/actions')) {
      const envelope = JSON.parse(String(options?.body)) as Envelope; sent.push(envelope);
      return new Promise<Response>(resolve => { replies.set(envelope.requestId, resolve); });
    }
    throw new Error(`Unexpected ${url}`);
  }));
  await act(async () => { render(<SessionProvider><DocumentAiCollaboration courseId="course" /></SessionProvider>); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return { recovered, sent, async replyResponse(requestId: string, response: Response) {
    expect(replies.has(requestId)).toBe(true);
    await act(async () => { replies.get(requestId)!(response); });
  }, async reply(requestId: string, version: number, ackRequestId = requestId) {
    expect(replies.has(requestId)).toBe(true);
    await act(async () => { replies.get(requestId)!(Response.json({ requestId: ackRequestId,
      courseVersion: version, submissionVersion: version, eventCursor: receiptCursor })); });
  } };
}

it('restores marked A equal to a stale GET, drains exact old B, and persists A only against its own B receipt', async () => {
  const fixture = await mountRevertedPendingDraft();
  expect(screen.getByTestId('document').textContent).toBe(original.content);
  expect(readDocumentDrafts(scope)).toContainEqual(fixture.recovered);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0]).toMatchObject({ requestId: 'revert-predecessor', action: oldAction });
  await fixture.reply('revert-predecessor', 2);
  expect(fixture.sent).toHaveLength(2);
  const latest = fixture.sent[1];
  expect(latest.requestId).not.toBe('revert-predecessor');
  expect(latest.action.payload).toMatchObject({ expectedSubmissionVersion: 2, submission: { id: 'draft', content: original.content } });
  expect(readDocumentDrafts(scope)).toContainEqual(fixture.recovered);
  expect(screen.getByTestId('save-status').textContent).not.toBe('saved');
  await fixture.reply(latest.requestId, 3);
  expect(readDocumentDrafts(scope)).toEqual([]);
  expect(readSubmissionSaves('student', 'course')).toEqual([]);
  expect(screen.getByTestId('document').textContent).toBe(original.content);
  expect(screen.getByTestId('save-status').textContent).toBe('saved');
});

it('does not borrow a newer GET version to resolve a marked older draft without its own receipt', async () => {
  const fixture = await mountRevertedPendingDraft({ snapshotVersion: 2, pending: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fixture.sent).toHaveLength(0);
  expect(readDocumentDrafts(scope)).toContainEqual(fixture.recovered);
  expect(screen.getByTestId('document').textContent).toBe(submitted.content);
  expect(screen.getByText(/与服务器版本冲突的草稿/)).toBeVisible();
});

it.each([true, false])('reconciles retained A2 after actual B ACK and refresh into stale A1 with marker=%s', async marker => {
  const first = await mountStorageRecoveryDocument();
  act(() => state.editor.onChange(submitted.content));
  await act(async () => { fireEvent.click(screen.getByText('重试保存')); });
  expect(first.sent).toHaveLength(1);
  act(() => state.editor.onChange(original.content));
  await act(async () => { first.acknowledge(); });
  const retained = readDocumentDrafts(scope)[0];
  expect(retained).toMatchObject({ content: original.content, expectedVersion: 2, requiresConfirmation: true });
  expect(readSubmissionSaves('student', 'course')).toEqual([]);
  expect(first.sent).toHaveLength(1); // A's debounce has not fired yet.
  cleanup();
  // false also exercises records written by an older editor which did not
  // preserve the uncertainty marker. Its own retained version remains proof.
  const recovered = { ...retained, requiresConfirmation: marker };
  const refreshed = await mountRevertedPendingDraft({ pending: false, recovered });
  expect(screen.getByTestId('document').textContent).toBe(original.content);
  expect(readDocumentDrafts(scope)).toContainEqual(recovered);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(refreshed.sent).toHaveLength(1);
  expect(refreshed.sent[0].action.payload).toMatchObject({ expectedSubmissionVersion: 2,
    submission: { id: 'draft', content: original.content } });
  expect(readDocumentDrafts(scope)).toContainEqual(recovered);
  await refreshed.reply(refreshed.sent[0].requestId, 3);
  expect(readDocumentDrafts(scope)).toEqual([]);
  expect(screen.getByTestId('save-status').textContent).toBe('saved');
});

it('serially skips the second same-B manual click after the first B is actually confirmed', async () => {
  const fixture = await mountStorageRecoveryDocument();
  act(() => state.editor.onChange(submitted.content));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
  });
  expect(fixture.sent).toHaveLength(1);
  expect(readDocumentDrafts(scope)).toEqual([expect.objectContaining({ content: submitted.content, requiresConfirmation: true })]);
  await act(async () => { fixture.acknowledge(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0].action.payload.expectedSubmissionVersion).toBe(1);
  expect(readSubmissionSaves('student', 'course')).toEqual([]);
  expect(readDocumentDrafts(scope)).toEqual([]);
  expect(screen.getByTestId('save-status').textContent).toBe('saved');
});

it('does not let a skipped duplicate B clear newer reverted A before refresh', async () => {
  const fixture = await mountStorageRecoveryDocument();
  act(() => state.editor.onChange(submitted.content));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
  });
  act(() => state.editor.onChange(original.content));
  await act(async () => { fixture.acknowledge(); });
  expect(fixture.sent).toHaveLength(1);
  const retained = readDocumentDrafts(scope)[0];
  expect(retained).toMatchObject({ content: original.content, expectedVersion: 2, requiresConfirmation: true });
  expect(screen.getByTestId('save-status').textContent).toBe('unsaved');
  cleanup();
  const refreshed = await mountRevertedPendingDraft({ pending: false, recovered: retained });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(refreshed.sent).toHaveLength(1);
  expect(refreshed.sent[0].action.payload).toMatchObject({ expectedSubmissionVersion: 2, submission: { content: original.content } });
  await refreshed.reply(refreshed.sent[0].requestId, 3);
  expect(readDocumentDrafts(scope)).toEqual([]);
});

it('adopts an equivalent canonical server revision at the same version without inventing an ACK or reviving the recovered draft', async () => {
  const fixture = await mountRevertedPendingDraft({ pending: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fixture.sent).toHaveLength(1);
  const attempted = fixture.sent[0];
  const remote = { ...attempted.action.payload.submission, id: 'canonical-document', version: 1 };
  await fixture.replyResponse(attempted.requestId, Response.json({ code: 'DRAFT_VERSION_CONFLICT',
    details: { currentVersion: 1, currentSubmission: remote } }, { status: 409 }));
  expect(readSubmissionSaves('student', 'course')).toEqual([]);
  expect(readDocumentDrafts(scope)).toEqual([]);
  expect(screen.getByTestId('save-status').textContent).toBe('saved');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fixture.sent).toHaveLength(1); // A read reconciliation adds no write/version.
  act(() => state.editor.onChange('<p>规范 ID 后继续编辑</p>'));
  await act(async () => { fireEvent.click(screen.getByText('重试保存')); });
  expect(fixture.sent).toHaveLength(2);
  expect(fixture.sent[1].action.payload).toMatchObject({ expectedSubmissionVersion: 1,
    submission: { id: remote.id, content: '<p>规范 ID 后继续编辑</p>' } });
  await fixture.reply(fixture.sent[1].requestId, 2);
  const saved = { ...fixture.sent[1].action.payload.submission, version: 2 };
  cleanup();
  const refreshed = await mountRevertedPendingDraft({ pending: false, seed: false, serverDocument: saved });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(refreshed.sent).toHaveLength(0);
  expect(readDocumentDrafts(scope)).toEqual([]);
  expect(screen.getByTestId('document').textContent).toBe(saved.content);
});

it('keeps a recovered original changed by another tab even when its content and timestamp match the ACK snapshot', async () => {
  const fixture = await mountRevertedPendingDraft();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await fixture.reply('revert-predecessor', 2);
  const changed = { ...fixture.recovered, expectedVersion: 9, requiresConfirmation: false };
  writeDocumentDraft(changed);
  await fixture.reply(fixture.sent[1].requestId, 3);
  expect(readDocumentDrafts(scope)).toContainEqual(changed);
  expect(screen.getByTestId('save-status').textContent).toBe('saved');
});

it('does not clear a marked recovered original on a mismatched ACK', async () => {
  const fixture = await mountRevertedPendingDraft();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await fixture.reply('revert-predecessor', 2);
  await fixture.reply(fixture.sent[1].requestId, 3, 'another-request');
  expect(readDocumentDrafts(scope)).toContainEqual(fixture.recovered);
  expect(readSubmissionSaves('student', 'course')).toEqual([expect.objectContaining({ requestId: fixture.sent[1].requestId })]);
  expect(screen.getByTestId('save-status').textContent).toBe('error');
});

it('retains typing after restored A while late B and A receipts settle in order', async () => {
  const fixture = await mountRevertedPendingDraft();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  act(() => state.editor.onChange('<p>恢复后继续输入 C</p>'));
  await fixture.reply('revert-predecessor', 2);
  expect(fixture.sent[1].action.payload.submission.content).toBe(original.content);
  await fixture.reply(fixture.sent[1].requestId, 3);
  expect(localStorage.getItem(fixture.recovered.key)).toBeNull();
  expect(readDocumentDrafts(scope)).toEqual([expect.objectContaining({ content: '<p>恢复后继续输入 C</p>',
    expectedVersion: 3, requiresConfirmation: true })]);
  expect(screen.getByTestId('document').textContent).toBe('<p>恢复后继续输入 C</p>');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fixture.sent).toHaveLength(3);
  expect(fixture.sent[2].action.payload).toMatchObject({ expectedSubmissionVersion: 3, submission: { content: '<p>恢复后继续输入 C</p>' } });
  await fixture.reply(fixture.sent[2].requestId, 4);
  expect(readDocumentDrafts(scope)).toEqual([]);
});

it('marks the A revert before pending B can commit and retains A when rebasing its own ACK hits storage failure', async () => {
  const fixture = await mountStorageRecoveryDocument();
  act(() => state.editor.onChange(submitted.content));
  await act(async () => { fireEvent.click(screen.getByText('重试保存')); });
  expect(fixture.sent).toHaveLength(1);
  act(() => state.editor.onChange(original.content));
  const reverted = readDocumentDrafts(scope)[0];
  expect(reverted).toMatchObject({ content: original.content, expectedVersion: 1, requiresConfirmation: true });
  const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  try {
    await act(async () => { fixture.acknowledge(); });
    expect(readDocumentDrafts(scope)).toContainEqual(reverted);
    expect(screen.getByTestId('document').textContent).toBe(original.content);
    expect(screen.getByTestId('save-status').textContent).toBe('error');
    expect(screen.getByText(/浏览器未能保存本机草稿/)).toBeVisible();
  } finally { quota.mockRestore(); }
});

it('does not add a write/version for an unsent B edit reverted to saved A', async () => {
  const fixture = await mountStorageRecoveryDocument();
  act(() => state.editor.onChange(submitted.content));
  expect(readDocumentDrafts(scope)[0]?.requiresConfirmation).not.toBe(true);
  act(() => state.editor.onChange(original.content));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fixture.sent).toHaveLength(0);
  expect(screen.getByTestId('save-status').textContent).toBe('saved');
  expect(readDocumentDrafts(scope)[0]?.requiresConfirmation).not.toBe(true);
});

it('does not consume another identity or stage draft while confirming the restored scope', async () => {
  const foreign = { scope: 'course:other:make:document', key: documentDraftKey('course:other:make:document'),
    submissionId: 'foreign', expectedVersion: 1, content: original.content, updatedAt: Date.now(), requiresConfirmation: true };
  const otherStage = { ...foreign, scope: 'course:student:proposal:document', key: documentDraftKey('course:student:proposal:document') };
  writeDocumentDraft(foreign); writeDocumentDraft(otherStage);
  const fixture = await mountRevertedPendingDraft();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await fixture.reply('revert-predecessor', 2);
  await fixture.reply(fixture.sent[1].requestId, 3);
  expect(readDocumentDrafts(foreign.scope)).toEqual([foreign]);
  expect(readDocumentDrafts(otherStage.scope)).toEqual([otherStage]);
});
