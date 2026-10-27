import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const testRoute = vi.hoisted(() => ({ pathname: '/teacher/teach/course-1/classroom' }));
vi.mock('next/navigation', () => ({ usePathname: () => testRoute.pathname }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { SessionProvider, useSession } from './store';
import { PROJECTION_CONNECTED_CHECK_INTERVAL_MS, PROJECTION_POLL_INTERVAL_MS, PROJECTION_REQUEST_TIMEOUT_MS } from '@/lib/realtime/projection-state';
import { getStagesForSystemMode } from '@/lib/system-mode';
function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; }
function mockSocket() {
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static current: Socket;
    readyState = 0; onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
    constructor() { Socket.current = this; }
    send() {}
    close() { this.readyState = 3; }
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal('WebSocket', Socket);
  return Socket;
}
const course = { id: 'course-1', name: 'Course', status: 'teaching', version: 1, updatedAt: '2026-09-27T00:00:00Z', students: [], stages: [], currentStageIndex: 0, resources: [], groups: [], submissions: [], activityLog: [], uiState: {}, content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } } };
function Probe() {
  const session = useSession();
  useEffect(() => { session.connectWebSocket('course-1'); return () => session.disconnectWebSocket(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = session.courses.find(item => item.id === 'course-1');
  return <><span data-testid="version">{current?.version}</span><span data-testid="stage">{current?.currentStageIndex}</span><span data-testid="projection">{current?.uiState?.projectionVersion ?? 0}</span><span data-testid="saved">{session.saveState}</span><button onClick={() => session.setStage('course-1', 0)}>save</button><button onClick={() => session.connectWebSocket('course-1')}>recover</button></>;
}
async function flush() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); testRoute.pathname = '/teacher/teach/course-1/classroom'; });

it('serializes polling and WS invalidations while projection and save acknowledgements remain immediate', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  window.history.replaceState({}, '', '/teacher/teach/course-1/classroom');
  const first = deferred(); let snapshots = 0;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course], user: { role: 'teacher', name: 'teacher' }, updatedAt: course.updatedAt }));
    if (url.endsWith('/state')) {
      snapshots++;
      return snapshots === 1 ? first.promise : Promise.resolve(Response.json({ course: { ...course, version: 44 }, eventCursor: '44' }));
    }
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: course.id, courseVersion: 1, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
    if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [{ type: 'COURSE_ACTION', cursor: '2', courseVersion: 2 }], nextCursor: '2', hasMore: false }));
    if (url.endsWith('/actions')) return Promise.resolve(Response.json({ requestId: 'saved', courseVersion: 3, eventCursor: '3' }));
    throw new Error(`Unexpected ${url}`);
  }));
  const Socket = mockSocket();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>); await flush(); expect(snapshots).toBe(1);
  await act(async () => {
    Socket.current.readyState = 1; Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: course.id });
    for (let i = 4; i <= 44; i++) Socket.current.emit({ type: 'course-event', courseId: course.id, event: { type: 'course-updated', payload: { eventCursor: String(i), courseVersion: i, actionType: 'UPSERT_SUBMISSION' } } });
    Socket.current.emit({ type: 'course-event', courseId: course.id, event: { type: 'projection-changed', payload: { courseVersion: 2, projectionVersion: 7, resourceProjection: null, teacherResourceProjection: null, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt } } });
  });
  await flush(); expect(screen.getByTestId('projection').textContent).toBe('7');
  fireEvent.click(screen.getByText('save')); await flush();
  expect(screen.getByTestId('saved').textContent).toBe('saved'); expect(screen.getByTestId('version').textContent).toBe('3');
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); expect(snapshots).toBe(1);
  await act(async () => { first.resolve(Response.json({ course, eventCursor: '1' })); }); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(750); }); await flush();
  expect(snapshots).toBe(2); expect(screen.getByTestId('version').textContent).toBe('44'); expect(screen.getByTestId('projection').textContent).toBe('7');
  mounted.unmount();
});

function projectionTransport({ ignoreAbort = false }: { ignoreAbort?: boolean } = {}) {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  window.history.replaceState({}, '', '/teacher/teach/course-1/classroom');
  const reads: Array<{ url: string; resolve: (response: Response) => void; signal: AbortSignal }> = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course], user: { role: 'teacher', name: 'teacher' }, updatedAt: course.updatedAt }));
    if (url.endsWith('/state')) return Promise.resolve(Response.json({ course: { ...course, id: url.split('/')[3] }, eventCursor: '0' }));
    if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [], nextCursor: '0', hasMore: false }));
    if (url.endsWith('/projection')) return new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      reads.push({ url, resolve, signal });
      if (!ignoreAbort) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    throw new Error(`Unexpected ${url}`);
  }));
  const Socket = mockSocket();
  return { reads, Socket };
}

it('keeps the current projection read on socket open and collapses subscriptions into one fresh trailing read', async () => {
  const { reads, Socket } = projectionTransport();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  await act(async () => { Socket.current.readyState = 1; Socket.current.onopen?.(); });
  await flush();
  await act(async () => { Socket.current.emit({ type: 'subscribed', courseId: course.id }); });
  await flush();
  await act(async () => {
    for (let i = 0; i < 10; i++) Socket.current.emit({ type: 'subscribed', courseId: course.id });
  });
  await flush();
  expect(reads).toHaveLength(1);
  expect(reads[0].signal.aborted).toBe(false);
  reads[0].resolve(Response.json({ courseId: course.id, courseVersion: 1, projectionVersion: 4, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
  await flush();
  expect(reads).toHaveLength(2);
  expect(reads[1].signal.aborted).toBe(false);
  expect(screen.getByTestId('projection').textContent).toBe('4');
  reads[1].resolve(Response.json({ courseId: course.id, courseVersion: 1, projectionVersion: 7, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
  await flush();
  expect(screen.getByTestId('projection').textContent).toBe('7');
  expect(reads).toHaveLength(2);
  mounted.unmount();
  await flush();
  expect(errors).not.toHaveBeenCalled();
});

it('still reports a timeout after subscription and lets its fresh trailing read recover', async () => {
  const { reads, Socket } = projectionTransport();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  await act(async () => {
    Socket.current.readyState = 1;
    Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: course.id });
  });
  await flush();
  errors.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(PROJECTION_REQUEST_TIMEOUT_MS); });
  expect(errors).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0]?.[0]).toBe('[session] Course synchronization failed:');
  expect(reads).toHaveLength(2);
  expect(reads[0].signal.aborted).toBe(true);
  expect(reads[1].signal.aborted).toBe(false);
  reads[1].resolve(projectionResponse(7));
  await flush();
  expect(screen.getByTestId('projection').textContent).toBe('7');
  mounted.unmount();
});

function projectionResponse(version: number, courseId = course.id) {
  return Response.json({ courseId, courseVersion: 1, projectionVersion: version,
    projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt });
}

it('keeps the 500ms fallback ticks joined and retries after the same 750ms attempt timeout', async () => {
  const { reads } = projectionTransport();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(PROJECTION_POLL_INTERVAL_MS); });
  expect(reads).toHaveLength(1);
  expect(reads[0].signal.aborted).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(PROJECTION_REQUEST_TIMEOUT_MS - PROJECTION_POLL_INTERVAL_MS); });
  expect(reads).toHaveLength(1);
  expect(reads[0].signal.aborted).toBe(true);
  expect(errors).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2 * PROJECTION_POLL_INTERVAL_MS - PROJECTION_REQUEST_TIMEOUT_MS); });
  expect(reads).toHaveLength(2);
  expect(reads[1].signal.aborted).toBe(false);
  reads[1].resolve(projectionResponse(7));
  await flush();
  expect(screen.getByTestId('projection').textContent).toBe('7');
  mounted.unmount();
});

it('joins focus recovery during connection setup without aborting and preserves immediate WS version protection', async () => {
  const { reads, Socket } = projectionTransport();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  for (let i = 0; i < 10; i++) fireEvent.click(screen.getByText('recover'));
  await flush();
  expect(reads).toHaveLength(1);
  expect(reads[0].signal.aborted).toBe(false);
  await act(async () => {
    Socket.current.emit({ type: 'course-event', courseId: course.id, event: { type: 'projection-changed', payload: {
      courseVersion: 1, projectionVersion: 9, resourceProjection: null, teacherResourceProjection: null,
      projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt,
    } } });
  });
  expect(screen.getByTestId('projection').textContent).toBe('9');
  reads[0].resolve(projectionResponse(4));
  await flush();
  expect(reads).toHaveLength(2);
  expect(screen.getByTestId('projection').textContent).toBe('9');
  reads[1].resolve(projectionResponse(10));
  await flush();
  expect(screen.getByTestId('projection').textContent).toBe('10');
  expect(errors).not.toHaveBeenCalled();
  mounted.unmount();
});

it('retains the connected 15s watchdog after settling the initial and subscription reads', async () => {
  const { reads, Socket } = projectionTransport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  await act(async () => {
    Socket.current.readyState = 1; Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: course.id });
  });
  await flush();
  reads[0].resolve(projectionResponse(1)); await flush();
  reads[1].resolve(projectionResponse(2)); await flush();
  expect(reads).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(PROJECTION_CONNECTED_CHECK_INTERVAL_MS - 1); });
  expect(reads).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(reads).toHaveLength(3);
  expect(reads[2].signal.aborted).toBe(false);
  reads[2].resolve(projectionResponse(3)); await flush();
  mounted.unmount();
});

it('bounds response-body delivery at 750ms without poisoning the lane or applying a late body', async () => {
  const { reads, Socket } = projectionTransport({ ignoreAbort: true });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  reads[0].resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })));
  await flush();
  await act(async () => {
    Socket.current.readyState = 1; Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: course.id });
    await vi.advanceTimersByTimeAsync(PROJECTION_REQUEST_TIMEOUT_MS - 1);
  });
  expect(reads).toHaveLength(1);
  expect(reads[0].signal.aborted).toBe(false);
  expect(errors).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(errors).toHaveBeenCalledTimes(1);
  expect(reads).toHaveLength(2);
  expect(reads[1].signal.aborted).toBe(false);
  reads[1].resolve(projectionResponse(7)); await flush();
  body.enqueue(new TextEncoder().encode(JSON.stringify({ courseId: course.id, courseVersion: 99,
    projectionVersion: 99, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt })));
  body.close(); await flush();
  expect(screen.getByTestId('projection').textContent).toBe('7');
  mounted.unmount();
});

function ScopedProjectionProbe({ courseId }: { courseId: string }) {
  const session = useSession();
  useEffect(() => { session.connectWebSocket(courseId); return () => session.disconnectWebSocket(); }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = session.courses.find(item => item.id === courseId);
  return <span data-testid="scope-projection">{current?.uiState?.projectionVersion ?? 0}</span>;
}

it('cancels a retired course and fences its ignored abort and queued fresh read through unmount', async () => {
  const { reads, Socket } = projectionTransport({ ignoreAbort: true });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><ScopedProjectionProbe courseId="course-1" /></SessionProvider>);
  await flush();
  await act(async () => {
    Socket.current.readyState = 1; Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: 'course-1' });
  });
  await flush();
  mounted.rerender(<SessionProvider><ScopedProjectionProbe courseId="course-2" /></SessionProvider>);
  await flush();
  expect(reads).toHaveLength(2);
  expect(reads[0].signal.aborted).toBe(true);
  expect(reads[1].signal.aborted).toBe(false);
  reads[1].resolve(projectionResponse(7, 'course-2'));
  reads[0].resolve(projectionResponse(99)); await flush();
  expect(screen.getByTestId('scope-projection').textContent).toBe('7');
  expect(reads).toHaveLength(2);
  await act(async () => {
    Socket.current.readyState = 1; Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: 'course-2' });
  });
  await flush();
  expect(reads).toHaveLength(3);
  mounted.unmount(); await flush();
  expect(reads[2].signal.aborted).toBe(true);
  reads[2].resolve(projectionResponse(100, 'course-2')); await flush();
  expect(reads).toHaveLength(3);
  expect(errors).not.toHaveBeenCalled();
});

it('retires the projection lane when another student authenticates in the same classroom', async () => {
  const { reads } = projectionTransport({ ignoreAbort: true });
  testRoute.pathname = '/student/ai-collaboration/course-1';
  window.history.replaceState({}, '', testRoute.pathname);
  const fetchProjection = vi.mocked(fetch).getMockImplementation()!;
  let actor = 'student-a';
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course],
      user: { role: 'student', name: actor }, studentId: actor, joinedCourseId: course.id, updatedAt: course.updatedAt }));
    return fetchProjection(input, init);
  }));
  let session!: ReturnType<typeof useSession>;
  function IdentityProbe() {
    const current = useSession();
    useEffect(() => { session = current; }, [current]);
    useEffect(() => { current.connectWebSocket(course.id); return () => current.disconnectWebSocket(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <><span data-testid="actor">{current.studentId}</span><span data-testid="owner-projection">{current.courses[0]?.uiState?.projectionVersion ?? 0}</span></>;
  }
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><IdentityProbe /></SessionProvider>);
  await flush();
  expect(screen.getByTestId('actor').textContent).toBe('student-a');
  expect(reads).toHaveLength(1);
  actor = 'student-b';
  await act(async () => { await session.refresh(); }); await flush();
  expect(screen.getByTestId('actor').textContent).toBe('student-b');
  expect(reads).toHaveLength(2);
  expect(reads[0].signal.aborted).toBe(true);
  expect(reads[1].signal.aborted).toBe(false);
  reads[0].resolve(projectionResponse(99)); reads[1].resolve(projectionResponse(2)); await flush();
  expect(screen.getByTestId('owner-projection').textContent).toBe('2');
  expect(errors).not.toHaveBeenCalled();
  mounted.unmount(); await flush();
});

function courseEventsTransport() {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  window.history.replaceState({}, '', '/teacher/teach/course-1/classroom');
  const reads: AbortSignal[] = [];
  const pendingReads: Array<() => void> = [];
  let failCurrentRead = false;
  let holdReads = true;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course], user: { role: 'teacher', name: 'teacher' }, updatedAt: course.updatedAt }));
    if (url.endsWith('/state')) return Promise.resolve(Response.json({ course, eventCursor: '0' }));
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: course.id, courseVersion: 1, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
    if (url.includes('/events?')) {
      if (failCurrentRead) return Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
      if (!holdReads) return Promise.resolve(Response.json({ events: [], nextCursor: '0', hasMore: false }));
      return new Promise<Response>((resolve, reject) => {
        const signal = init!.signal!;
        reads.push(signal);
        pendingReads.push(() => resolve(Response.json({ events: [], nextCursor: '0', hasMore: false })));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    throw new Error(`Unexpected ${url}`);
  }));
  const Socket = mockSocket();
  return { reads, Socket, recover: () => { holdReads = false; }, fail: () => { failCurrentRead = true; }, finishPending: () => { pendingReads.splice(0).forEach(resolve => resolve()); } };
}

it('cancels old event catch-ups on reconnect without reporting a synchronization failure', async () => {
  const transport = courseEventsTransport();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  const oldSocket = transport.Socket.current;
  await act(async () => {
    oldSocket.readyState = 1;
    oldSocket.onopen?.();
    oldSocket.emit({ type: 'subscribed', courseId: course.id });
  });
  await flush();
  expect(transport.reads).toHaveLength(1);
  transport.recover();
  await act(async () => {
    oldSocket.readyState = 3;
    oldSocket.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await flush();
  expect(transport.Socket.current).not.toBe(oldSocket);
  expect(transport.reads.every(signal => signal.aborted)).toBe(true);
  expect(screen.getByTestId('version').textContent).toBe('1');
  mounted.unmount();
  await flush();
  expect(errors).not.toHaveBeenCalled();
});

it('still reports a real event endpoint failure in the current connection', async () => {
  const transport = courseEventsTransport();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  await act(async () => {
    transport.Socket.current.readyState = 1;
    transport.Socket.current.onopen?.();
    transport.Socket.current.emit({ type: 'subscribed', courseId: course.id });
  });
  await flush();
  // A second recovery while the first event query is in flight must query
  // again after that read, so a real failure is still observable once.
  transport.fail();
  await act(async () => {
    transport.Socket.current.emit({ type: 'subscribed', courseId: course.id });
    transport.finishPending();
  });
  await flush();
  expect(errors).toHaveBeenCalledWith('[session] Course synchronization failed:', expect.objectContaining({ message: 'COURSE_EVENTS_FAILED_503' }));
  mounted.unmount();
});


function bootstrapTransport() {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
  window.history.replaceState({}, '', '/teacher/teach/course-1/classroom');
  const first = deferred(); const stateReads: string[] = []; const eventAfters: string[] = [];
  const latest = { ...course, stages: getStagesForSystemMode(), version: 25 };
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course], user: { role: 'teacher', name: 'teacher' }, updatedAt: course.updatedAt }));
    if (url.endsWith('/state')) {
      stateReads.push(url);
      return stateReads.length === 1 ? first.promise : Promise.resolve(Response.json({ course: { ...latest, version: 26, currentStageIndex: 1 }, eventCursor: '26' }));
    }
    if (url.includes('/events?')) {
      const after = new URL(url, 'http://localhost').searchParams.get('after')!; eventAfters.push(after);
      return Promise.resolve(Response.json({ events: after === '0' ? [{ type: 'COURSE_ACTION', cursor: '25', courseVersion: 25 }] : [], nextCursor: after === '0' ? '25' : after, hasMore: false }));
    }
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: course.id, courseVersion: 1, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
    throw new Error(`Unexpected ${url}`);
  }));
  const Socket = mockSocket();
  return { first, latest, stateReads, eventAfters, Socket };
}

it('shares polling and subscription bootstrap instead of reconciling history before the seed cursor arrives', async () => {
  const transport = bootstrapTransport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>); await flush();
  expect(transport.stateReads).toHaveLength(1);
  await act(async () => {
    transport.Socket.current.readyState = 1; transport.Socket.current.onopen?.();
    transport.Socket.current.emit({ type: 'subscribed', courseId: course.id });
  }); await flush();
  expect(transport.eventAfters).toEqual([]);
  await act(async () => { transport.first.resolve(Response.json({ course: transport.latest, eventCursor: '25' })); }); await flush();
  expect(transport.eventAfters).toEqual(['25']); expect(transport.stateReads).toHaveLength(1);
  expect(screen.getByTestId('version').textContent).toBe('25'); mounted.unmount();
});

it('still reads a new snapshot for a real stage-control invalidation during bootstrap', async () => {
  const transport = bootstrapTransport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>); await flush();
  await act(async () => {
    transport.Socket.current.readyState = 1; transport.Socket.current.onopen?.();
    transport.Socket.current.emit({ type: 'subscribed', courseId: course.id });
    transport.Socket.current.emit({ type: 'course-event', courseId: course.id, event: { type: 'course-updated', payload: { eventCursor: '26', courseVersion: 26, actionType: 'SET_STAGE' } } });
    await vi.advanceTimersByTimeAsync(50);
    transport.first.resolve(Response.json({ course: transport.latest, eventCursor: '25' }));
  }); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await flush();
  expect(transport.stateReads).toHaveLength(2); expect(screen.getByTestId('version').textContent).toBe('26');
  expect(screen.getByTestId('stage').textContent).toBe('1');
  mounted.unmount();
});


function SwitchingCourseProbe({ courseId }: { courseId: string }) {
  const session = useSession();
  useEffect(() => { session.connectWebSocket(courseId); return () => session.disconnectWebSocket(); }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span data-testid="all-course-versions">{session.courses.map(item => `${item.id}:${item.version}`).sort().join('|')}</span>;
}

it('does not apply an old seed or start old catch-ups after a course and epoch change', async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/teacher/teach/course-1/classroom');
  const first = deferred(); const eventReads: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course], user: { role: 'teacher', name: 'teacher' }, updatedAt: course.updatedAt }));
    if (url === '/api/courses/course-1/state') return first.promise;
    if (url === '/api/courses/course-2/state') return Promise.resolve(Response.json({ course: { ...course, id: 'course-2', version: 99 }, eventCursor: '99' }));
    if (url.includes('/events?')) { eventReads.push(url); return Promise.resolve(Response.json({ events: [], nextCursor: '99', hasMore: false })); }
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: url.split('/')[3], courseVersion: 1, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
    throw new Error(`Unexpected ${url}`);
  }));
  vi.stubGlobal('WebSocket', class {
    static CONNECTING = 0; static OPEN = 1; readyState = 0;
    close() { this.readyState = 3; }
  });
  const mounted = render(<SessionProvider><SwitchingCourseProbe courseId="course-1" /></SessionProvider>); await flush();
  mounted.rerender(<SessionProvider><SwitchingCourseProbe courseId="course-2" /></SessionProvider>); await flush();
  expect(screen.getByTestId('all-course-versions').textContent).toContain('course-2:99');
  await act(async () => { first.resolve(Response.json({ course: { ...course, version: 88 }, eventCursor: '88' })); }); await flush();
  expect(screen.getByTestId('all-course-versions').textContent).not.toContain('course-1:88');
  expect(screen.getByTestId('all-course-versions').textContent).toContain('course-2:99');
  expect(eventReads.filter(url => url.startsWith('/api/courses/course-1/'))).toEqual([]);
  mounted.unmount();
});

it('keeps the connecting poll deadlines when a later open arrives after the initial reads completed', async () => {
  const { reads, Socket } = projectionTransport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  reads[0].resolve(projectionResponse(1)); await flush();
  const eventCount = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/events?')).length;
  const eventsBeforeOpen = eventCount();
  const send = vi.spyOn(Socket.current, 'send');
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await act(async () => { Socket.current.readyState = Socket.OPEN; Socket.current.onopen?.(); });
  await flush();
  expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', courseId: course.id }));
  expect(reads).toHaveLength(1);
  expect(eventCount()).toBe(eventsBeforeOpen);
  await act(async () => { await vi.advanceTimersByTimeAsync(PROJECTION_POLL_INTERVAL_MS - 201); });
  expect(reads).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(reads).toHaveLength(2);
  // Event polling also retains its original 1s deadline, not open + 1s.
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(eventCount()).toBe(eventsBeforeOpen + 1);
  expect(reads).toHaveLength(2);
  mounted.unmount(); await flush();
});

it('still immediately reconciles subscribed after idle open and retains a fresh read behind a pending response', async () => {
  const { reads, Socket } = projectionTransport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  reads[0].resolve(projectionResponse(1)); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await act(async () => { Socket.current.readyState = Socket.OPEN; Socket.current.onopen?.(); });
  await flush();
  expect(reads).toHaveLength(1);
  await act(async () => { Socket.current.emit({ type: 'subscribed', courseId: course.id }); });
  await flush();
  expect(reads).toHaveLength(2);
  await act(async () => {
    Socket.current.emit({ type: 'course-event', courseId: course.id, event: { type: 'projection-changed', payload: {
      courseVersion: 1, projectionVersion: 9, resourceProjection: null, teacherResourceProjection: null,
      projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt,
    } } });
    Socket.current.emit({ type: 'subscribed', courseId: course.id });
  });
  expect(screen.getByTestId('projection').textContent).toBe('9');
  expect(reads).toHaveLength(2);
  reads[1].resolve(projectionResponse(2)); await flush();
  expect(reads).toHaveLength(3);
  expect(screen.getByTestId('projection').textContent).toBe('9');
  reads[2].resolve(projectionResponse(10)); await flush();
  expect(screen.getByTestId('projection').textContent).toBe('10');
  expect(reads).toHaveLength(3);
  mounted.unmount(); await flush();
});

function DirectRoomSwitchProbe() {
  const session = useSession();
  useEffect(() => {
    session.connectWebSocket('course-1');
    return () => session.disconnectWebSocket();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <button onClick={() => session.connectWebSocket('course-2')}>switch-room-without-disconnect</button>
    <span data-testid="new-room-projection">{session.courses.find(item => item.id === 'course-2')?.uiState?.projectionVersion ?? 0}</span>
    <span data-testid="direct-room-mode">{session.realtimeMode}</span>
  </>;
}

it('starts a new connecting room in fast mode and fences the old connected room response', async () => {
  const { reads, Socket } = projectionTransport({ ignoreAbort: true });
  const mounted = render(<SessionProvider><DirectRoomSwitchProbe /></SessionProvider>);
  await flush();
  reads[0].resolve(projectionResponse(1)); await flush();
  await act(async () => {
    Socket.current.readyState = Socket.OPEN; Socket.current.onopen?.();
    Socket.current.emit({ type: 'subscribed', courseId: course.id });
  });
  await flush();
  expect(reads).toHaveLength(2);
  expect(screen.getByTestId('direct-room-mode').textContent).toBe('websocket');
  const oldSocket = Socket.current;
  fireEvent.click(screen.getByText('switch-room-without-disconnect')); await flush();
  expect(Socket.current).not.toBe(oldSocket);
  expect(Socket.current.readyState).toBe(Socket.CONNECTING);
  expect(reads).toHaveLength(3);
  expect(reads[1].signal.aborted).toBe(true);
  expect(screen.getByTestId('direct-room-mode').textContent).toBe('polling');
  reads[2].resolve(projectionResponse(7, 'course-2'));
  reads[1].resolve(projectionResponse(99)); await flush();
  expect(screen.getByTestId('new-room-projection').textContent).toBe('7');
  await act(async () => { await vi.advanceTimersByTimeAsync(PROJECTION_POLL_INTERVAL_MS - 1); });
  expect(reads).toHaveLength(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(reads).toHaveLength(4);
  expect(reads[3].url).toBe('/api/courses/course-2/projection');
  reads[3].resolve(projectionResponse(8, 'course-2')); await flush();
  expect(screen.getByTestId('new-room-projection').textContent).toBe('8');
  mounted.unmount(); await flush();
});
