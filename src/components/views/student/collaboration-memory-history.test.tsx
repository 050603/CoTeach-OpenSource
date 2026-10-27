import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Course } from '@/lib/session/types';
import type { PlateDocumentEditor } from '@/components/plate-document-editor';
import type { useProjectMemory } from './use-project-memory';
import { createPblTemplateCourse } from '@/lib/platform/pbl-template';
import { createCodeArtifact } from '@/lib/ai-collaboration/code-artifact';
import type { CodeAiMemberWorkspace } from './code-ai-member-workspace';

const state = vi.hoisted(() => ({ course: undefined as unknown as Course, studentId: 'student', memory: undefined as unknown as ReturnType<typeof useProjectMemory>,
  background: vi.fn(), workspace: undefined as unknown as ComponentProps<typeof CodeAiMemberWorkspace> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/session/store', () => ({ useCourse: () => state.course, useHydrated: () => true,
  useSession: () => ({ studentId: state.studentId, user: { name: '学生' }, saveState: 'saved', persistSubmission: vi.fn() }),
}));
vi.mock('./use-project-memory', async original => {
  const actual = await original<typeof import('./use-project-memory')>();
  return { useProjectMemory: (input: Parameters<typeof useProjectMemory>[0]) => {
    state.memory = actual.useProjectMemory(input); return state.memory;
  } };
});
vi.mock('./use-code-draft', () => ({ useCodeDraft: () => ({ status: 'saved', save: vi.fn() }) }));
vi.mock('@monaco-editor/react', () => ({ default: () => null, DiffEditor: () => null }));
vi.mock('@/lib/browser/code-editor-runtime', () => ({ loadCodeEditorRuntime: async () => undefined }));
vi.mock('@/lib/browser/code-ai-request', async original => ({
  ...await original<typeof import('@/lib/browser/code-ai-request')>(),
  requestBackgroundCodeAi: state.background,
}));
vi.mock('@/hooks/use-course-presence', () => ({ useCoursePresence: vi.fn() }));
vi.mock('@/lib/resource-package/course-requirements', () => ({ getCourseStageRequirements: () => undefined }));
vi.mock('@/components/dashboard-shell', () => ({ DashboardTopBar: () => null }));
vi.mock('@/components/classroom/student-classroom-header-status', () => ({ StudentClassroomHeaderStatus: () => null }));
vi.mock('./collaboration-project-details', () => ({ CollaborationProjectDetails: () => null }));
vi.mock('./final-artifact-submission', () => ({ FinalArtifactSubmission: () => null }));
vi.mock('./external-artifact-submission', () => ({ ExternalArtifactSubmission: () => null }));
vi.mock('./ai-member-workspace', () => ({ AiMemberWorkspace: () => null }));
vi.mock('./code-ai-member-workspace', () => ({ CodeAiMemberWorkspace: (props: ComponentProps<typeof CodeAiMemberWorkspace>) => { state.workspace = props; return null; } }));
vi.mock('@/lib/browser/ai-event-outbox', () => ({ flushAiInteractionEvents: async () => undefined, queueAiInteractionEvent: vi.fn() }));
vi.mock('@/components/plate-document-editor', async () => {
  const { useImperativeHandle } = await import('react');
  return { PlateDocumentEditor: (props: ComponentProps<typeof PlateDocumentEditor>) => {
    useImperativeHandle(props.ref, () => ({ getBlockCandidates: () => [], resolveCommentSelection: () => null, focus: vi.fn(),
      replaceRange: vi.fn(), insertAtCursor: vi.fn(), previewDelegatedWorkPlan: vi.fn(), applyDelegatedWorkPlan: vi.fn(), previewAiSuggestion: vi.fn(), resolveAiSuggestion: vi.fn() }));
    return null;
  } };
});
import { CodeAiCollaboration } from './code-ai-collaboration';
import { DocumentAiCollaboration } from './document-ai-collaboration';

const entry = (content: string) => ({ id: content, content, kind: 'open-question', stageKey: 'make', sourceMessageIds: [], createdAt: '', updatedAt: '' });
const history = { messages: [], requests: [], commentThreads: [], proactiveReviewEnabled: false };
function fixture(id: string): Course {
  return { ...createPblTemplateCourse(id), status: 'teaching', currentStageIndex: 0, groups: [], submissions: [],
    stages: [{ key: 'make', label: '实践', description: '', view: 'project-making' }] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function body(value: unknown): ArrayBuffer { return new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer; }
function retainBackground(overrides: Record<string, unknown> = {}) {
  const input = { courseId: 'A', studentId: 'student', stageKey: 'make', language: 'c', action: 'code-task-starters',
    mode: 'discuss', artifact: createCodeArtifact('c'), run: { status: 'idle' }, requestId: 'original-background', ...overrides };
  const scope = JSON.stringify(['A', 'student', 'make', 'c']);
  localStorage.setItem(`openpbl:code-background:v1:${encodeURIComponent(scope)}:original-background`,
    JSON.stringify({ version: 1, scope, requestId: input.requestId, body: JSON.stringify(input), createdAt: Date.now() }));
  return input;
}
beforeEach(() => { vi.useFakeTimers(); state.course = fixture('A'); state.studentId = 'student'; state.background.mockReset().mockImplementation(async () => Response.json({ status: 'completed', commentThreads: [] })); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

describe('code background recovery reaches the current UI', () => {
  it.each(['review', 'starters'] as const)('rejects an old %s JSON body after same-code actor/course change and still requests the new scope', async kind => {
    const late = deferred<unknown>();
    state.background.mockResolvedValueOnce({ ok: true, json: () => late.promise });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...history, memories: [] })));
    const mounted = render(<CodeAiCollaboration courseId="A" language="c" />); await act(async () => undefined);
    if (kind === 'starters') fireEvent.click(screen.getByRole('button', { name: 'AI 组员' }));
    await act(async () => vi.advanceTimersByTimeAsync(kind === 'review' ? 9_000 : 1_600));
    expect(state.background).toHaveBeenCalledOnce();
    state.course = fixture('B'); state.studentId = 'other';
    await act(async () => mounted.rerender(<CodeAiCollaboration courseId="B" language="c" />));
    expect(state.background.mock.calls[0][1].aborted).toBe(true);
    await act(async () => late.resolve({ starters: ['old scope suggestion'], commentThreads: [{
      id: 'old-comment', filePath: 'main.c', startLine: 1, endLine: 1, title: 'old comment', quotedCode: '#include',
      comments: [{ role: 'assistant', content: 'old actor', createdAt: new Date().toISOString() }],
    }] }));
    expect(screen.queryByTitle('有未读的 AI 组员批注')).toBeNull();
    if (kind === 'starters') expect(state.workspace.starters).not.toContain('old scope suggestion');
    await act(async () => vi.advanceTimersByTimeAsync(kind === 'review' ? 9_000 : 1_600));
    expect(state.background).toHaveBeenCalledTimes(2);
    expect(state.background.mock.calls[1][0]).toMatchObject({ courseId: 'B', studentId: 'other' });
  });
  it('does not reuse a completed review fingerprint from another course with identical code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...history, memories: [] })));
    const mounted = render(<CodeAiCollaboration courseId="A" language="c" />); await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(9_000)); expect(state.background).toHaveBeenCalledOnce();
    state.course = fixture('B');
    await act(async () => mounted.rerender(<CodeAiCollaboration courseId="B" language="c" />));
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(state.background).toHaveBeenCalledTimes(2); expect(state.background.mock.calls[1][0].courseId).toBe('B');
  });
  it('refreshes persisted history after its initial load and restores matching starters', async () => {
    const original = retainBackground(); const late = deferred<Response>(); state.background.mockReturnValueOnce(late.promise);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...history, memories: [] }))
      .mockResolvedValueOnce(Response.json({ ...history, memories: [entry('committed review memory')] })); vi.stubGlobal('fetch', fetch);
    render(<CodeAiCollaboration courseId="A" language="c" />); await act(async () => undefined);
    expect(fetch).toHaveBeenCalledOnce(); expect(state.background.mock.calls[0][0]).toEqual(original);
    await act(async () => late.resolve(Response.json({ status: 'completed', starters: ['Recovered original task'] })));
    expect(fetch).toHaveBeenCalledTimes(2); expect(state.memory.memories).toEqual([entry('committed review memory')]);
    fireEvent.click(screen.getByRole('button', { name: 'AI 组员' }));
    expect(state.workspace.starters).toEqual(['Recovered original task']);
  });
  it('does not apply recovered suggestions to another artifact or run', async () => {
    retainBackground({ run: { status: 'failed', stderr: 'old failure' } });
    state.background.mockResolvedValueOnce(Response.json({ status: 'completed', starters: ['STALE suggestion'] }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...history, memories: [] })));
    render(<CodeAiCollaboration courseId="A" language="c" />); await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'AI 组员' }));
    expect(state.workspace.starters).not.toContain('STALE suggestion');
  });
  it('does not refresh a new actor/course when the old task receipt arrives late', async () => {
    retainBackground(); const late = deferred<Response>(); state.background.mockReturnValueOnce(late.promise);
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...history, memories: [] })); vi.stubGlobal('fetch', fetch);
    const mounted = render(<CodeAiCollaboration courseId="A" language="c" />); await act(async () => undefined);
    state.course = fixture('B'); state.studentId = 'other';
    await act(async () => mounted.rerender(<CodeAiCollaboration courseId="B" language="c" />));
    expect(state.background.mock.calls[0][1].aborted).toBe(true);
    const calls = fetch.mock.calls.length;
    await act(async () => late.resolve(Response.json({ status: 'completed', starters: ['old actor'] })));
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it('offers an explicit bounded retry for retained failures rather than automatically resetting their budget', async () => {
    retainBackground(); state.background.mockRejectedValueOnce(new Error('terminal failure'))
      .mockResolvedValueOnce(Response.json({ status: 'completed', starters: ['retry answer'] }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...history, memories: [] })));
    render(<CodeAiCollaboration courseId="A" language="c" />); await act(async () => undefined);
    expect(state.background.mock.calls[0][2]).toBeUndefined();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重试后台审阅' })));
    expect(state.background.mock.calls[1][2]).toEqual({ resume: true });
    expect(screen.queryByRole('button', { name: '重试后台审阅' })).toBeNull();
  });
});

for (const kind of ['code', 'document'] as const) describe(`${kind} history owns initial project memory`, () => {
  const view = () => kind === 'code' ? <CodeAiCollaboration courseId={state.course.id} language="c" /> : <DocumentAiCollaboration courseId={state.course.id} />;
  const mount = async () => { const mounted = render(view()); await act(async () => undefined); return mounted; };

  it.each([{ memories: [] }, { memories: [entry('history')] }])('seeds complete history (including empty) without another memory GET: %j', async ({ memories }) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...history, memories })); vi.stubGlobal('fetch', fetch);
    const mounted = await mount();
    expect(state.memory.memories).toEqual(memories);
    expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0][0])).toContain(`/api/ai-collaboration/${kind}?`);
    state.course = { ...state.course, version: (state.course.version ?? 0) + 1 };
    await act(async () => mounted.rerender(view()));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['old-server', 'http-error', 'network-error', 'bad-json'])('falls back to a real scoped memory GET on %s', async failure => {
    const fetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('/api/ai-collaboration/memory?')) return Response.json({ memories: [entry('fallback')] });
      if (failure === 'network-error') throw new TypeError('offline');
      if (failure === 'bad-json') return new Response('{');
      return Response.json(history, { status: failure === 'http-error' ? 503 : 200 });
    }); vi.stubGlobal('fetch', fetch);
    await mount();
    expect(state.memory.memories).toEqual([entry('fallback')]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toBe('/api/ai-collaboration/memory?courseId=A&studentId=student');
  });

  it('does not accept an old history body or start its fallback after changing course and actor', async () => {
    const late = deferred<ArrayBuffer>();
    const fetch = vi.fn().mockResolvedValueOnce({ status: 200, arrayBuffer: () => late.promise })
      .mockResolvedValueOnce(Response.json({ ...history, memories: [entry('new actor')] })); vi.stubGlobal('fetch', fetch);
    const mounted = await mount();
    state.course = fixture('B'); state.studentId = 'other';
    await act(async () => mounted.rerender(view()));
    await act(async () => late.resolve(body({ ...history, memories: [entry('old actor')] })));
    expect(state.memory.memories).toEqual([entry('new actor')]);
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('cancels an in-flight fallback on unmount and ignores a transport which resolves late', async () => {
    const late = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(history)).mockReturnValueOnce(late.promise); vi.stubGlobal('fetch', fetch);
    const mounted = await mount(); expect(fetch).toHaveBeenCalledTimes(2);
    mounted.unmount(); expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => late.resolve(Response.json({ memories: [entry('late')] })));
    expect(state.memory.memories).toEqual([]);
  });

  it('does not start a fallback for a cancelled history request', async () => {
    const late = deferred<Response>(); const fetch = vi.fn().mockReturnValue(late.promise); vi.stubGlobal('fetch', fetch);
    const mounted = await mount(); mounted.unmount();
    await act(async () => late.resolve(Response.json({ error: 'late failure' }, { status: 503 })));
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each(['fetch', 'body'])('bounds hanging history %s at the existing 10s read limit, then ignores late success', async hanging => {
    const lateFetch = deferred<Response>(), lateBody = deferred<ArrayBuffer>();
    const fetch = vi.fn().mockImplementationOnce(() => hanging === 'fetch' ? lateFetch.promise : Promise.resolve({ status: 200, arrayBuffer: () => lateBody.promise }))
      .mockResolvedValueOnce(Response.json({ memories: [entry('timeout fallback')] })); vi.stubGlobal('fetch', fetch);
    await mount(); expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(state.memory.memories).toEqual([entry('timeout fallback')]);
    await act(async () => {
      lateFetch.resolve(Response.json({ ...history, memories: [entry('late history')] }));
      lateBody.resolve(body({ ...history, memories: [entry('late history')] }));
    });
    expect(state.memory.memories).toEqual([entry('timeout fallback')]); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it('document history marked unavailable compensates with a separate real memory read', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...history, memories: [], memoriesAvailable: false }))
    .mockResolvedValueOnce(Response.json({ memories: [entry('recovered')] })); vi.stubGlobal('fetch', fetch);
  render(<DocumentAiCollaboration courseId="A" />); await act(async () => undefined);
  expect(state.memory.memories).toEqual([entry('recovered')]); expect(fetch).toHaveBeenCalledTimes(2);
});
