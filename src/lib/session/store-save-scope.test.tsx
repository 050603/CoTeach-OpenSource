import { encodeEventCursor } from '@/lib/realtime/event-cursor';
const receiptCursor = encodeEventCursor({ createdAt: new Date('2026-10-16T00:00:00.000Z'), id: '11111111-1111-4111-8111-111111111111' });
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from './store';
import { readSubmissionSaves, type SubmissionAction } from '@/lib/browser/submission-save-outbox';

const navigation = vi.hoisted(() => ({ pathname: '/student/ai-collaboration/course-a' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
let api: ReturnType<typeof useSession>;
function Probe() { const value = useSession(); useEffect(() => { api = value; }, [value]); return null; }
const course = { id: 'course-a', name: '课堂', status: 'teaching', version: 1, updatedAt: '2026-10-16T00:00:00Z', students: [], stages: [], currentStageIndex: 0, resources: [], groups: [], submissions: [], activityLog: [], uiState: {}, content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } } };
type Identity = { studentId: string; courseId: string };
type Envelope = { requestId: string; action: SubmissionAction };
const first: Identity = { studentId: 'student-a', courseId: 'course-a' };
function submission(identity: Identity, content: string) {
  return { id: `draft-${identity.studentId}-${identity.courseId}`, ...identity, studentName: '学生', stageKey: 'make', type: 'document' as const,
    title: '成果', content, status: 'draft' as const, expectedVersion: 0, draftKey: `editor-${identity.studentId}-${identity.courseId}` };
}
beforeEach(() => { localStorage.clear(); navigation.pathname = '/student/ai-collaboration/course-a'; window.history.replaceState({}, '', navigation.pathname); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each([
  ['another classroom', { studentId: 'student-a', courseId: 'course-b' }],
  ['another account in the same classroom', { studentId: 'student-b', courseId: 'course-a' }],
] as const)('isolates failures in %s and replays the original request on return without deleting its draft', async (_label, second) => {
  let identity: Identity = first;
  let recoverFirst = false;
  let failSecond = false;
  const sent: Envelope[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({
      courses: [{ ...course, id: identity.courseId, submissions: [{ ...submission(identity, `private ${identity.studentId}`), version: 0 }] }], user: { role: 'student', name: '学生' },
      studentId: identity.studentId, joinedCourseId: identity.courseId, updatedAt: course.updatedAt,
    }));
    if (url.endsWith('/actions')) {
      const body = JSON.parse(String(options?.body)) as Envelope;
      sent.push(body);
      const own = body.action.payload.submission;
      const isFirst = own.studentId === first.studentId && own.courseId === first.courseId;
      if ((isFirst && !recoverFirst) || (!isFirst && failSecond)) return Promise.resolve(Response.json({ code: 'INVALID_ACTION' }, { status: 400 }));
      return Promise.resolve(Response.json({ requestId: body.requestId, courseVersion: 2, submissionVersion: 1, eventCursor: receiptCursor }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  const view = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.hydrated).toBe(true));
  await act(async () => { expect(await api.persistSubmission(submission(first, 'A pending'))).toBeUndefined(); });
  expect(api.saveState).toBe('error');
  expect(await api.flushSaves()).toBe(false);
  const retainedFirst = readSubmissionSaves(first.studentId, first.courseId);
  expect(retainedFirst).toHaveLength(1);
  const original = structuredClone(sent[0]);

  async function switchTo(next: Identity) {
    const oldPath = navigation.pathname;
    identity = next;
    navigation.pathname = `/student/ai-collaboration/${next.courseId}`;
    window.history.replaceState({}, '', navigation.pathname);
    if (navigation.pathname !== oldPath) view.rerender(<SessionProvider><Probe /></SessionProvider>);
    else await act(async () => { await api.refresh(); });
    await waitFor(() => {
      expect(api.hydrated).toBe(true);
      expect(api.studentId).toBe(next.studentId);
      expect(api.joinedCourseId).toBe(next.courseId);
      const ownCourse = api.courses.find(item => item.id === next.courseId)!;
      expect(ownCourse.submissions!.length).toBeGreaterThan(0);
      expect(ownCourse.submissions!.every(item => item.studentId === next.studentId)).toBe(true);
    });
  }
  await switchTo(second);
  await waitFor(() => expect(api.saveState).toBe('idle'));
  expect(await api.flushSaves()).toBe(true);
  await act(async () => { await api.retrySave(); });
  expect(sent).toHaveLength(1);
  expect(readSubmissionSaves(first.studentId, first.courseId)).toEqual(retainedFirst);

  failSecond = true;
  await act(async () => { expect(await api.persistSubmission(submission(second, 'B own pending'))).toBeUndefined(); });
  expect(api.saveState).toBe('error');
  expect(await api.flushSaves()).toBe(false);
  const secondRequest = structuredClone(sent[1]);
  failSecond = false;
  await act(async () => { await api.retrySave(); });
  expect(sent).toHaveLength(3);
  expect(sent[2]).toEqual(secondRequest);
  expect(api.saveState).toBe('saved');
  expect(await api.flushSaves()).toBe(true);
  expect(readSubmissionSaves(first.studentId, first.courseId)).toEqual(retainedFirst);
  expect(readSubmissionSaves(second.studentId, second.courseId)).toEqual([]);

  recoverFirst = true;
  await switchTo(first);
  await waitFor(() => expect(readSubmissionSaves(first.studentId, first.courseId)).toEqual([]));
  expect(sent).toHaveLength(4);
  expect(sent[3]).toEqual(original);
  expect(api.saveState).toBe('saved');
  expect(await api.flushSaves()).toBe(true);
});

it('does not attribute a delayed A receipt to B after navigation while keeping the real ACK', async () => {
  let release!: (response: Response) => void;
  const sent: Envelope[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.startsWith('/api/courses?')) {
      const courseId = new URL(url, 'http://localhost').searchParams.get('courseId')!;
      return Promise.resolve(Response.json({ courses: [{ ...course, id: courseId }], user: { role: 'student', name: '学生' },
        studentId: first.studentId, joinedCourseId: courseId, updatedAt: course.updatedAt }));
    }
    if (url.endsWith('/actions')) {
      sent.push(JSON.parse(String(options?.body)) as Envelope);
      return new Promise<Response>(resolve => { release = resolve; });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  const view = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.hydrated).toBe(true));
  let save!: ReturnType<typeof api.persistSubmission>;
  act(() => { save = api.persistSubmission(submission(first, 'A pending receipt')); });
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(readSubmissionSaves(first.studentId, first.courseId)).toHaveLength(1);
  navigation.pathname = '/student/ai-collaboration/course-b';
  window.history.replaceState({}, '', navigation.pathname);
  view.rerender(<SessionProvider><Probe /></SessionProvider>);
  expect(api.hydrated).toBe(false);
  await act(async () => {
    release(Response.json({ requestId: sent[0].requestId, courseVersion: 2, submissionVersion: 1, eventCursor: receiptCursor }));
    await save;
  });
  await waitFor(() => { expect(api.hydrated).toBe(true); expect(api.joinedCourseId).toBe('course-b'); });
  expect(api.lastSavedAt).toBeUndefined();
  expect(api.saveState).toBe('idle');
  expect(await api.flushSaves()).toBe(true);
  expect(readSubmissionSaves(first.studentId, first.courseId)).toEqual([]);
  expect(sent).toHaveLength(1);
});

it('does not display a previous role receipt after authenticating a student', async () => {
  let role: 'teacher' | 'student' = 'teacher';
  navigation.pathname = '/teacher/teach/course-a/classroom';
  window.history.replaceState({}, '', navigation.pathname);
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course],
      user: { role, name: role }, ...(role === 'student' ? { studentId: first.studentId, joinedCourseId: first.courseId } : {}),
      updatedAt: course.updatedAt,
    }));
    if (url.endsWith('/actions')) {
      const body = JSON.parse(String(options?.body)) as Envelope;
      return Promise.resolve(Response.json({ requestId: body.requestId, courseVersion: 2, eventCursor: 'teacher-receipt' }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  const view = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.hydrated).toBe(true));
  act(() => { api.updateCourse(first.courseId, { name: '教师更新' }); });
  await waitFor(() => expect(api.lastSavedAt).toEqual(expect.any(String)));
  role = 'student';
  navigation.pathname = '/student/ai-collaboration/course-a';
  window.history.replaceState({}, '', navigation.pathname);
  view.rerender(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => { expect(api.hydrated).toBe(true); expect(api.studentId).toBe(first.studentId); });
  expect(api.lastSavedAt).toBeUndefined();
  expect(api.saveState).toBe('idle');
});

it('retains a late invalid A receipt across navigation and replays the original operation on return', async () => {
  let release!: (response: Response) => void;
  const sent: Envelope[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.startsWith('/api/courses?')) {
      const courseId = new URL(url, 'http://localhost').searchParams.get('courseId')!;
      return Promise.resolve(Response.json({ courses: [{ ...course, id: courseId }], user: { role: 'student', name: '学生' },
        studentId: first.studentId, joinedCourseId: courseId, updatedAt: course.updatedAt }));
    }
    if (url.endsWith('/actions')) {
      const body = JSON.parse(String(options?.body)) as Envelope; sent.push(body);
      return sent.length === 1 ? new Promise<Response>(resolve => { release = resolve; })
        : Promise.resolve(Response.json({ requestId: body.requestId, courseVersion: 2, submissionVersion: 1, eventCursor: receiptCursor }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  const view = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.hydrated).toBe(true));
  let save!: ReturnType<typeof api.persistSubmission>;
  act(() => { save = api.persistSubmission(submission(first, 'A needs its own receipt')); });
  await waitFor(() => expect(sent).toHaveLength(1));
  const original = structuredClone(sent[0]);
  navigation.pathname = '/student/ai-collaboration/course-b'; window.history.replaceState({}, '', navigation.pathname);
  view.rerender(<SessionProvider><Probe /></SessionProvider>);
  await act(async () => {
    release(Response.json({ requestId: 'different-operation', courseVersion: 2, submissionVersion: 1, eventCursor: receiptCursor }));
    expect(await save).toBeUndefined();
  });
  await waitFor(() => { expect(api.hydrated).toBe(true); expect(api.joinedCourseId).toBe('course-b'); });
  expect(api.lastSavedAt).toBeUndefined(); expect(api.saveState).toBe('idle');
  expect(readSubmissionSaves(first.studentId, first.courseId)).toMatchObject([{ requestId: original.requestId, action: original.action }]);
  navigation.pathname = '/student/ai-collaboration/course-a'; window.history.replaceState({}, '', navigation.pathname);
  view.rerender(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(readSubmissionSaves(first.studentId, first.courseId)).toEqual([]));
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(original); expect(api.saveState).toBe('saved');
});
