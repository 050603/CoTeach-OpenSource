import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retainSubmissionSave, type SubmissionAction } from '@/lib/browser/submission-save-outbox';
import type { ClassroomSubmission } from './types';
const navigation = vi.hoisted(() => ({ pathname: '/student/ai-collaboration/course' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { SessionProvider, useSession } from './store';

let api: ReturnType<typeof useSession>;
const sockets: Socket[] = [];
const currentSocket = () => sockets.at(-1)!;
class Socket {
  static CONNECTING = 0; static OPEN = 1; readyState = 0;
  onmessage?: (event: { data: string }) => void;
  onopen?: () => void;
  constructor() { sockets.push(this); }
  send() {}
  close() { this.readyState = 3; }
}
function Probe({ courseId = 'course' }: { courseId?: string }) {
  const session = useSession();
  useEffect(() => { api = session; }, [session]);
  useEffect(() => { session.connectWebSocket(courseId); return () => session.disconnectWebSocket();
    // SessionProvider owns transport callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);
  return null;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const cursor = '2026-10-16T00:00:00.000Z~00000000-0000-0000-0000-000000000001';
const course = { id: 'course', name: '课堂', status: 'teaching', version: 1, updatedAt: '2026-10-16T00:00:00Z', students: [], stages: [], currentStageIndex: 0, resources: [], groups: [], submissions: [], activityLog: [], uiState: {}, content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } } };
function identity(id = 'course', bootstrap: unknown = { courseId: id, eventCursor: cursor }, studentId = 'student', version = 1) {
  return Response.json({ courses: [{ ...course, id, version }], user: { role: 'student', name: '学生' }, studentId, joinedCourseId: id, updatedAt: course.updatedAt, bootstrap });
}
function server(initial: (url: string) => Promise<Response> | Response, save?: (body: { requestId: string; action: SubmissionAction }) => Promise<Response> | Response) {
  const fetch = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    const id = url.match(/^\/api\/courses\/([^/]+)/)?.[1] ?? 'course';
    if (url.startsWith('/api/courses?')) return Promise.resolve(initial(url));
    if (url.endsWith('/state')) return Promise.resolve(Response.json({ course: { ...course, id }, eventCursor: cursor }));
    if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [], nextCursor: cursor }));
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: id, courseVersion: 1, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
    if (url.endsWith('/actions') && save) return Promise.resolve(save(JSON.parse(String(options?.body))));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const stateReads = (fetch: ReturnType<typeof server>) => fetch.mock.calls.filter(([url]) => String(url).endsWith('/state'));
const settle = async () => { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); }); };
beforeEach(() => { sockets.length = 0; localStorage.clear(); navigation.pathname = '/student/ai-collaboration/course'; window.history.replaceState({}, '', navigation.pathname); vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('shares the initial authenticated snapshot and still performs fresh subscription and recovery catch-up', async () => {
  const pending = deferred<Response>(); const fetch = server(() => pending.promise);
  render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/courses?courseId=course', expect.anything()));
  expect(stateReads(fetch)).toHaveLength(0);
  expect(api.hydrated).toBe(false);
  await act(async () => { pending.resolve(identity()); });
  await waitFor(() => expect(api.hydrated).toBe(true)); await settle();
  expect(stateReads(fetch)).toHaveLength(0);
  expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/courses?'))).toHaveLength(1);
  act(() => { currentSocket().readyState = Socket.OPEN; currentSocket().onopen?.(); currentSocket().onmessage?.({ data: JSON.stringify({ type: 'subscribed', courseId: 'course' }) }); });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/courses/course/events?after=${encodeURIComponent(cursor)}`, expect.anything()));
  await settle();
  const firstCount = fetch.mock.calls.filter(([url]) => String(url).includes('/events?')).length;
  act(() => { api.connectWebSocket('course'); });
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).includes('/events?')).length).toBeGreaterThan(firstCount));
  expect(stateReads(fetch)).toHaveLength(0);
  // A subsequent durable invalidation remains a real independent snapshot read.
  act(() => currentSocket().onmessage?.({ data: JSON.stringify({ type: 'course-event', courseId: 'course', event: { type: 'course-updated', payload: { actionType: 'SET_STAGE' } } }) }));
  await waitFor(() => expect(stateReads(fetch)).toHaveLength(1));
});

it.each([undefined, { courseId: 'other', eventCursor: cursor }, { courseId: 'course', eventCursor: 'malformed' }])('falls back to /state for missing or unusable optional bootstrap %#', async bootstrap => {
  const fetch = server(() => identity('course', bootstrap === undefined ? null : bootstrap));
  render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.hydrated).toBe(true));
  await waitFor(() => expect(stateReads(fetch)).toHaveLength(1));
});

it('does not allow an old path response to seed a new course or restore its old identity', async () => {
  const old = deferred<Response>();
  const fetch = server(url => url.endsWith('=course') ? old.promise : identity('next'));
  const page = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/courses?courseId=course', expect.anything()));
  navigation.pathname = '/student/ai-collaboration/next'; window.history.replaceState({}, '', navigation.pathname);
  page.rerender(<SessionProvider><Probe courseId="next" /></SessionProvider>);
  await waitFor(() => expect(api.joinedCourseId).toBe('next'));
  await act(async () => { old.resolve(identity()); }); await settle();
  expect(api.joinedCourseId).toBe('next'); expect(api.hydrated).toBe(true);
  expect(stateReads(fetch)).toHaveLength(0);
});

it('keeps original outbox replay and newer edits causal when the accepted bootstrap is an older snapshot', async () => {
  const submission: ClassroomSubmission = { id: 'draft', courseId: 'course', studentId: 'student', studentName: '学生', stageKey: 'make', type: 'document', title: '成果', content: 'old edit', status: 'draft', version: 1, createdAt: 'now', updatedAt: 'now' };
  const action: SubmissionAction = { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: 0, submission } };
  retainSubmissionSave({ requestId: 'original-request', actorId: 'student', draftKey: 'editor', action, createdAt: 1, state: 'pending' });
  const receipt = deferred<Response>(); const sent: Array<{ requestId: string; action: SubmissionAction }> = [];
  const fetch = server(() => identity(), body => { sent.push(body); return body.requestId === 'original-request' ? receipt.promise
    : Response.json({ requestId: body.requestId, eventCursor: cursor, courseVersion: 3, submissionVersion: 2 }); });
  render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(sent).toHaveLength(1));
  let saved!: Promise<ClassroomSubmission | undefined>;
  act(() => { saved = api.persistSubmission({ ...submission, content: 'new edit', expectedVersion: 0, draftKey: 'editor' }); });
  expect(sent).toHaveLength(1);
  await act(async () => { receipt.resolve(Response.json({ requestId: 'original-request', eventCursor: cursor, courseVersion: 2, submissionVersion: 1 })); await saved; });
  expect({ requestId: sent[0].requestId, action: sent[0].action }).toEqual({ requestId: 'original-request', action });
  expect(sent).toHaveLength(2);
  expect(sent[1].requestId).not.toBe('original-request');
  expect(sent[1].action.payload.expectedSubmissionVersion).toBe(1);
  expect(sent[1].action.payload.submission.content).toBe('new edit');
  expect(stateReads(fetch)).toHaveLength(0);
});


it.each([200, 403])('rejects the old A identity response after A→B→A even when its status is %i', async status => {
  const firstA = deferred<Response>(); let visitsToA = 0;
  const fetch = server(url => {
    if (url.endsWith('=course')) {
      visitsToA += 1;
      return visitsToA === 1 ? firstA.promise : identity('course', { courseId: 'course', eventCursor: cursor }, 'new-student', 3);
    }
    return identity('next');
  });
  const page = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(visitsToA).toBe(1));
  navigation.pathname = '/student/ai-collaboration/next'; window.history.replaceState({}, '', navigation.pathname);
  page.rerender(<SessionProvider><Probe courseId="next" /></SessionProvider>);
  await waitFor(() => expect(api.joinedCourseId).toBe('next'));
  navigation.pathname = '/student/ai-collaboration/course'; window.history.replaceState({}, '', navigation.pathname);
  page.rerender(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.studentId).toBe('new-student'));
  await act(async () => { firstA.resolve(status === 200
    ? identity('course', { courseId: 'course', eventCursor: cursor }, 'old-student', 1)
    : Response.json({ code: 'FORBIDDEN' }, { status })); });
  await settle();
  expect(api.hydrated).toBe(true);
  expect(api.studentId).toBe('new-student');
  expect(api.joinedCourseId).toBe('course');
  expect(api.courses.find(item => item.id === 'course')?.version).toBe(3);
  expect(stateReads(fetch)).toHaveLength(0);
});

it('lets a newer same-path hydration unblock fresh events without waiting for the older HTTP response', async () => {
  const slow = deferred<Response>(); let reads = 0;
  const fetch = server(() => ++reads === 1 ? slow.promise
    : identity('course', { courseId: 'course', eventCursor: cursor }, 'current-student', 2));
  render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(reads).toBe(1));
  await act(async () => { await api.refresh(); });
  await waitFor(() => expect(api.studentId).toBe('current-student'));
  act(() => { currentSocket().readyState = Socket.OPEN; currentSocket().onopen?.(); currentSocket().onmessage?.({ data: JSON.stringify({ type: 'subscribed', courseId: 'course' }) }); });
  // The old request is intentionally unresolved here. Fresh catch-up cannot
  // wait for its timeout or be satisfied by that older request later.
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/courses/course/events?after=${encodeURIComponent(cursor)}`, expect.anything()));
  expect(reads).toBe(2);
  expect(stateReads(fetch)).toHaveLength(0);
  await act(async () => { slow.resolve(identity('course', { courseId: 'course', eventCursor: '0' }, 'stale-student', 1)); });
  await settle();
  expect(api.studentId).toBe('current-student');
  expect(api.courses.find(item => item.id === 'course')?.version).toBe(2);
});

it('retires a previous account snapshot and its delayed reads even when its course version is higher', async () => {
  let actor = 'student-a';
  const oldState = deferred<Response>();
  const privateCourse = (studentId: string, version: number) => ({ ...course, version,
    submissions: [{ id: `private-${studentId}`, courseId: 'course', studentId, studentName: studentId,
      stageKey: 'make', type: 'document', title: '私有草稿', content: `private ${studentId}`,
      status: 'draft', version: 1, createdAt: course.updatedAt, updatedAt: course.updatedAt }],
  });
  const fetch = server(() => Response.json({ courses: [privateCourse(actor, actor === 'student-a' ? 7 : 1)],
    user: { role: 'student', name: actor }, studentId: actor, joinedCourseId: 'course',
    updatedAt: course.updatedAt, bootstrap: { courseId: 'course', eventCursor: cursor },
  }));
  const originalFetch = fetch.getMockImplementation()!;
  let stateAttempts = 0;
  fetch.mockImplementation((input, options) => {
    if (String(input).endsWith('/state')) return ++stateAttempts === 1 ? oldState.promise
      : Promise.resolve(Response.json({ course: privateCourse(actor, 1), eventCursor: cursor }));
    return originalFetch(input, options);
  });
  render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.studentId).toBe('student-a'));
  await settle();
  const previousSocket = currentSocket();
  act(() => previousSocket.onmessage?.({ data: JSON.stringify({ type: 'course-event', courseId: 'course',
    event: { type: 'course-updated', payload: { actionType: 'SET_STAGE' } },
  }) }));
  await waitFor(() => expect(stateAttempts).toBe(1));
  actor = 'student-b';
  await act(async () => { await api.refresh(); });
  await waitFor(() => expect(api.studentId).toBe('student-b'));
  expect(previousSocket.readyState).toBe(3);
  expect(currentSocket()).not.toBe(previousSocket);
  const assertCurrentAccount = () => {
    const current = api.courses.find(item => item.id === 'course')!;
    expect(current.version).toBe(1);
    expect(current.submissions!.map(item => item.studentId)).toEqual(['student-b']);
    expect(current.submissions![0].content).toBe('private student-b');
  };
  assertCurrentAccount();
  await act(async () => { oldState.resolve(Response.json({ course: privateCourse('student-a', 9), eventCursor: cursor })); });
  await settle();
  assertCurrentAccount();
});
