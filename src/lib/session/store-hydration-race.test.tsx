import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ pathname: '/student/classroom/course-1' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { SessionProvider, useHydrated, useSession } from './store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const course = {
  id: 'course-1', name: '课堂', status: 'teaching', updatedAt: '2026-09-25T00:00:00Z',
  students: [], stages: [], currentStageIndex: 0, resources: [], groups: [],
  submissions: [], activityLog: [], uiState: {},
  content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
};

function StudentProbe({ courseId = 'course-1' }: { courseId?: string }) {
  const session = useSession();
  const hydrated = useHydrated();
  useEffect(() => {
    session.connectWebSocket(courseId);
    return () => session.disconnectWebSocket();
    // The provider owns transport callbacks; only mount/unmount matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);
  return <><span>{session.studentId ?? 'missing-student'}</span>
    <span data-testid="course-version">{session.courses.find(item => item.id === courseId)?.version ?? 0}</span>
    <span data-testid="hydrated">{String(hydrated)}</span><span data-testid="joined-course">{session.joinedCourseId ?? ''}</span>
    <span data-testid="save-state">{session.saveState}</span>
    <button onClick={() => void session.refresh()}>refresh</button>
    <button onClick={() => session.updateStudentProgress('knowledge', 100)}>save progress</button></>;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); navigation.pathname = '/student/classroom/course-1'; window.history.replaceState({}, '', '/'); });

it('keeps authenticated student identity when the first course snapshot races session hydration', async () => {
  window.history.replaceState({}, '', '/student/classroom/course-1');
  const session = deferred<Response>();
  const state = deferred<Response>();
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return session.promise;
    if (url.endsWith('/state')) return state.promise;
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({
      courseId: course.id, courseVersion: 0, projectionVersion: 0,
      projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt,
    }));
    if (url.endsWith('/events?after=0')) return Promise.resolve(Response.json({ events: [], nextCursor: '0' }));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  inactiveSocket();

  render(<SessionProvider><StudentProbe /></SessionProvider>);
  requestIndependentSnapshot();
  await waitFor(() => {
    expect(fetcher).toHaveBeenCalledWith('/api/courses?courseId=course-1', expect.anything());
    expect(fetcher).toHaveBeenCalledWith('/api/courses/course-1/state', expect.anything());
  });

  await act(async () => {
    session.resolve(Response.json({
      courses: [course], user: { role: 'student', name: '学生' },
      studentId: 'student-1', studentName: '学生', joinedCourseId: course.id,
      updatedAt: course.updatedAt,
    }));
    await Promise.resolve();
    await Promise.resolve();
    state.resolve(Response.json({ course, eventCursor: '0' }));
    await Promise.resolve();
  });
  expect(screen.getByText('student-1')).toBeTruthy();
});


it('preserves the newer realtime course when initial authenticated hydration arrives late', async () => {
  window.history.replaceState({}, '', '/student/classroom/course-1');
  const session = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return session.promise;
    if (url.endsWith('/state')) return Promise.resolve(Response.json({ course: { ...course, version: 3 }, eventCursor: '0' }));
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: course.id, courseVersion: 3, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt }));
    if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [], nextCursor: '0' }));
    throw new Error(`Unexpected request: ${url}`);
  }));
  inactiveSocket();
  render(<SessionProvider><StudentProbe /></SessionProvider>);
  requestIndependentSnapshot();
  await waitFor(() => expect(screen.getByTestId('course-version').textContent).toBe('3'));
  await act(async () => {
    session.resolve(Response.json({ courses: [{ ...course, version: 1 }], user: { role: 'student', name: '学生' }, studentId: 'student-1', studentName: '学生', joinedCourseId: course.id, updatedAt: course.updatedAt }));
  });
  expect(screen.getByTestId('course-version').textContent).toBe('3');
  expect(screen.getByText('student-1')).toBeTruthy();
});

function pendingIdentityFetch(session: ReturnType<typeof deferred<Response>>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/courses?')) return session.promise;
    if (url.endsWith('/state')) return Promise.resolve(Response.json({ course: { ...course, version: 3 }, eventCursor: '0' }));
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId: course.id, courseVersion: 3, projectionVersion: 1,
      projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt, resourceProjection: null, teacherResourceProjection: null }));
    if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [], nextCursor: '0' }));
    throw new Error(`Unexpected request: ${url}`);
  });
}
const reconciliationSockets: Array<{ onmessage?: (event: { data: string }) => void }> = [];
function inactiveSocket() {
  vi.stubGlobal('WebSocket', class {
    static CONNECTING = 0; static OPEN = 1; readyState = 0;
    onmessage?: (event: { data: string }) => void;
    constructor() { reconciliationSockets.push(this); }
    close() { this.readyState = 3; }
  });
}
function requestIndependentSnapshot(courseId = 'course-1') {
  // A real socket invalidation remains independent of identity hydration. This
  // preserves the race coverage without requiring a duplicate initial /state.
  act(() => reconciliationSockets.at(-1)?.onmessage?.({ data: JSON.stringify({ type: 'course-event', courseId,
    event: { type: 'course-updated', payload: { actionType: 'SET_STAGE' } } }) }));
}

it('does not expose cached previous-classroom identity as hydrated when realtime arrives before authentication', async () => {
  navigation.pathname = '/student/ai-collaboration/course-1';
  window.history.replaceState({}, '', navigation.pathname);
  localStorage.setItem('openpbl.identity.student.v1', JSON.stringify({ user: { role: 'student', name: '学生' },
    studentId: 'student-1', studentName: '学生', joinedCourseId: 'previous-python-classroom' }));
  const session = deferred<Response>(); vi.stubGlobal('fetch', pendingIdentityFetch(session)); inactiveSocket();
  render(<SessionProvider><StudentProbe /></SessionProvider>);
  requestIndependentSnapshot();
  await waitFor(() => expect(screen.getByTestId('course-version').textContent).toBe('3'));
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
  expect(screen.getByTestId('joined-course').textContent).toBe('previous-python-classroom');
  expect(localStorage.getItem('openpbl.identity.student.v1')).toContain('previous-python-classroom');
  await act(async () => { session.resolve(Response.json({ courses: [course], user: { role: 'student', name: '学生' },
    studentId: 'student-1', studentName: '学生', joinedCourseId: course.id, updatedAt: course.updatedAt })); });
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  expect(screen.getByTestId('joined-course').textContent).toBe(course.id);
  expect(screen.getByTestId('course-version').textContent).toBe('3');
});

it('authenticates a standalone player with its course query instead of its native classroom ID', async () => {
  navigation.pathname = '/student/ai-learning/native-player';
  window.history.replaceState({}, '', `${navigation.pathname}?courseId=course-1`);
  const session = deferred<Response>();
  const fetcher = pendingIdentityFetch(session);
  vi.stubGlobal('fetch', fetcher); inactiveSocket();
  render(<SessionProvider><StudentProbe /></SessionProvider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/courses?courseId=course-1', expect.anything()));
  expect(fetcher).not.toHaveBeenCalledWith('/api/courses?courseId=native-player', expect.anything());
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
  await act(async () => { session.resolve(Response.json({ courses: [course], user: { role: 'student', name: '学生' },
    studentId: 'student-1', studentName: '学生', joinedCourseId: course.id, updatedAt: course.updatedAt })); });
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  expect(screen.getByTestId('joined-course').textContent).toBe(course.id);
});

it('reauthenticates a query-only player course change and rejects the previous course response', async () => {
  navigation.pathname = '/student/ai-learning/native-player';
  window.history.replaceState({}, '', `${navigation.pathname}?courseId=course-1`);
  const oldRefresh = deferred<Response>();
  const nextIdentity = deferred<Response>();
  let refreshingOld = false;
  const otherRequests = progressSaveFetch(deferred<Response>());
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/courses?courseId=course-1' && refreshingOld) return oldRefresh.promise;
    if (url === '/api/courses?courseId=course-2') return nextIdentity.promise;
    return otherRequests(input);
  });
  vi.stubGlobal('fetch', fetcher); inactiveSocket();
  const view = render(<SessionProvider search="courseId=course-1"><StudentProbe /></SessionProvider>);
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  refreshingOld = true;
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/courses?courseId=course-1')).toHaveLength(2));
  window.history.replaceState({}, '', `${navigation.pathname}?courseId=course-2`);
  view.rerender(<SessionProvider search="courseId=course-2"><StudentProbe courseId="course-2" /></SessionProvider>);
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/courses?courseId=course-2', expect.anything()));
  await act(async () => { nextIdentity.resolve(Response.json({ courses: [{ ...course, id: 'course-2' }],
    user: { role: 'student', name: '学生' }, studentId: 'student-1', studentName: '学生', joinedCourseId: 'course-2', updatedAt: course.updatedAt })); });
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  await act(async () => { oldRefresh.resolve(Response.json({ courses: [{ ...course, version: 99 }],
    user: { role: 'student', name: '学生' }, studentId: 'student-1', studentName: '学生', joinedCourseId: course.id, updatedAt: course.updatedAt })); });
  expect(screen.getByTestId('joined-course').textContent).toBe('course-2');
  expect(screen.getByTestId('hydrated').textContent).toBe('true');
});

it('keeps a standalone player unready when authentication returns another course identity', async () => {
  navigation.pathname = '/student/ai-learning/native-player';
  window.history.replaceState({}, '', `${navigation.pathname}?courseId=course-1`);
  const session = deferred<Response>(); vi.stubGlobal('fetch', pendingIdentityFetch(session)); inactiveSocket();
  render(<SessionProvider search="courseId=course-1"><StudentProbe /></SessionProvider>);
  await act(async () => { session.resolve(Response.json({ courses: [course], user: { role: 'student', name: '学生' },
    studentId: 'student-1', studentName: '学生', joinedCourseId: 'another-course', updatedAt: course.updatedAt })); });
  await waitFor(() => expect(screen.getByText('student-1')).toBeTruthy());
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
});

it('requires a fresh authenticated identity when the mounted provider navigates to another classroom', async () => {
  navigation.pathname = '/student/ai-collaboration/previous-python-classroom';
  window.history.replaceState({}, '', navigation.pathname);
  const nextIdentity = deferred<Response>();
  const pending = pendingIdentityFetch(nextIdentity);
  const previous = { ...course, id: 'previous-python-classroom', version: 1 };
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/courses?courseId=previous-python-classroom') return Promise.resolve(Response.json({ courses: [previous],
      user: { role: 'student', name: '学生' }, studentId: 'student-1', studentName: '学生', joinedCourseId: previous.id, updatedAt: previous.updatedAt }));
    if (url === '/api/courses/previous-python-classroom/state') return Promise.resolve(Response.json({ course: previous, eventCursor: '0' }));
    return pending(input);
  })); inactiveSocket();
  const view = render(<SessionProvider><StudentProbe courseId={previous.id} /></SessionProvider>);
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  navigation.pathname = '/student/ai-collaboration/course-1'; window.history.replaceState({}, '', navigation.pathname);
  view.rerender(<SessionProvider><StudentProbe /></SessionProvider>);
  requestIndependentSnapshot();
  await waitFor(() => expect(screen.getByTestId('course-version').textContent).toBe('3'));
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
  await act(async () => { nextIdentity.resolve(Response.json({ courses: [course], user: { role: 'student', name: '学生' },
    studentId: 'student-1', studentName: '学生', joinedCourseId: course.id, updatedAt: course.updatedAt })); });
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  expect(screen.getByTestId('joined-course').textContent).toBe(course.id);
});

it('does not turn cached identity or an early snapshot into readiness when authentication is denied', async () => {
  navigation.pathname = '/student/ai-collaboration/course-1'; window.history.replaceState({}, '', navigation.pathname);
  localStorage.setItem('openpbl.identity.student.v1', JSON.stringify({ user: { role: 'student', name: '学生' },
    studentId: 'student-1', studentName: '学生', joinedCourseId: course.id }));
  const session = deferred<Response>(); vi.stubGlobal('fetch', pendingIdentityFetch(session)); inactiveSocket();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<SessionProvider><StudentProbe /></SessionProvider>);
  requestIndependentSnapshot();
  await waitFor(() => expect(screen.getByTestId('course-version').textContent).toBe('3'));
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
  await act(async () => { session.resolve(Response.json({ code: 'FORBIDDEN' }, { status: 403 })); });
  await waitFor(() => expect(error).toHaveBeenCalled());
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
});

it('keeps an already authenticated classroom ready during a transient refresh failure', async () => {
  navigation.pathname = '/student/ai-collaboration/course-1'; window.history.replaceState({}, '', navigation.pathname);
  const session = deferred<Response>(); const fetch = pendingIdentityFetch(session);
  vi.stubGlobal('fetch', fetch); inactiveSocket();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<SessionProvider><StudentProbe /></SessionProvider>);
  requestIndependentSnapshot();
  await act(async () => { session.resolve(Response.json({ courses: [course], user: { role: 'student', name: '学生' },
    studentId: 'student-1', studentName: '学生', joinedCourseId: course.id, updatedAt: course.updatedAt })); });
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  fetch.mockImplementation(() => Promise.resolve(Response.json({ error: 'temporarily unavailable' }, { status: 503 })));
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
  await waitFor(() => expect(error).toHaveBeenCalled());
  expect(screen.getByTestId('hydrated').textContent).toBe('true');
  expect(screen.getByTestId('joined-course').textContent).toBe(course.id);
});

function progressSaveFetch(save: ReturnType<typeof deferred<Response>>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/actions')) return save.promise;
    if (url.startsWith('/api/courses?')) {
      const courseId = new URL(url, 'http://localhost').searchParams.get('courseId');
      return Promise.resolve(Response.json({ courses: [{ ...course, id: courseId }],
        user: { role: 'student', name: '学生' }, studentId: 'student-1', studentName: '学生',
        joinedCourseId: courseId, updatedAt: course.updatedAt }));
    }
    const courseId = url.match(/^\/api\/courses\/([^/]+)/)?.[1];
    if (url.endsWith('/state')) return Promise.resolve(Response.json({ course: { ...course, id: courseId, version: 3 }, eventCursor: '0' }));
    if (url.endsWith('/projection')) return Promise.resolve(Response.json({ courseId, courseVersion: 3, projectionVersion: 0,
      projectionUpdatedAt: course.updatedAt, serverTime: course.updatedAt, resourceProjection: null, teacherResourceProjection: null }));
    if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [], nextCursor: '0' }));
    throw new Error(`Unexpected request: ${url}`);
  });
}

it('keeps the same classroom ready when its stage route changes during a pending progress save', async () => {
  navigation.pathname = '/student/classroom/course-1'; window.history.replaceState({}, '', navigation.pathname);
  const save = deferred<Response>(); const fetch = progressSaveFetch(save);
  vi.stubGlobal('fetch', fetch); inactiveSocket();
  const view = render(<SessionProvider><StudentProbe /></SessionProvider>);
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: 'save progress' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/courses/course-1/actions', expect.anything()));
  navigation.pathname = '/student/ai-collaboration/course-1'; window.history.replaceState({}, '', navigation.pathname);
  view.rerender(<SessionProvider><StudentProbe /></SessionProvider>);
  expect(screen.getByTestId('save-state').textContent).toBe('saving');
  expect(screen.getByTestId('hydrated').textContent).toBe('true');
  await act(async () => { save.resolve(Response.json({ courseVersion: 4, eventCursor: '4' })); });
  await waitFor(() => expect(screen.getByTestId('save-state').textContent).toBe('saved'));
  expect(screen.getByTestId('hydrated').textContent).toBe('true');
  expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/courses?'))).toHaveLength(1);
});

it.each([200, 403])('authenticates a new classroom after the old classroom progress save drains with status %i', async (status) => {
  navigation.pathname = '/student/classroom/previous-python-classroom'; window.history.replaceState({}, '', navigation.pathname);
  const save = deferred<Response>(); const fetch = progressSaveFetch(save);
  vi.stubGlobal('fetch', fetch); inactiveSocket();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const view = render(<SessionProvider><StudentProbe courseId="previous-python-classroom" /></SessionProvider>);
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: 'save progress' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/courses/previous-python-classroom/actions', expect.anything()));
  navigation.pathname = '/student/ai-collaboration/course-1'; window.history.replaceState({}, '', navigation.pathname);
  view.rerender(<SessionProvider><StudentProbe /></SessionProvider>);
  expect(screen.getByTestId('hydrated').textContent).toBe('false');
  expect(fetch).not.toHaveBeenCalledWith('/api/courses?courseId=course-1', expect.anything());
  await act(async () => { save.resolve(Response.json(status === 200 ? { courseVersion: 4, eventCursor: '4' } : { code: 'FORBIDDEN' }, { status })); });
  await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
  expect(fetch).toHaveBeenCalledWith('/api/courses?courseId=course-1', expect.anything());
  expect(screen.getByTestId('joined-course').textContent).toBe('course-1');
});
