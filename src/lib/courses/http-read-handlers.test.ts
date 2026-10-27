// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), load: vi.fn(), all: vi.fn(), latest: vi.fn(), participants: vi.fn(), studentScope: vi.fn(), eventScope: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: mocks.auth }));
vi.mock('@/lib/platform/access', () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock('@/lib/auth/course-scope', () => ({ scopeCourseForClaims: (course: unknown) => course }));
vi.mock('@/lib/courses/student-state-scope', () => ({ resolveStudentStateScope: mocks.studentScope }));
vi.mock('@/lib/realtime/course-event-scope', () => ({ resolveCourseEventScope: mocks.eventScope }));
vi.mock('@/lib/db/session-read-repository', () => ({ loadCourse: mocks.load, loadSessionState: mocks.all, stateFor: (courses: unknown) => ({ courses, updatedAt: new Date().toISOString() }) }));
vi.mock('@/lib/db/client', () => ({ prisma: { domainEvent: { findFirst: mocks.latest }, classroomParticipation: { findMany: mocks.participants } } }));
import { getCourses, getCourseState } from './http-read-handlers';
const context = { params: Promise.resolve({ courseId: 'course' }) };
const state = (etag?: string) => getCourseState(new Request('http://localhost/api/courses/course/state', { headers: etag ? { 'If-None-Match': etag } : {} }), context);
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ claims: { role: 'student', sub: 'student', studentName: 'Name' } });
  mocks.access.mockResolvedValue(true); mocks.studentScope.mockResolvedValue({ accessible: true });
  mocks.eventScope.mockResolvedValue({ where: { classroomInstanceId: 'course' } });
  mocks.participants.mockResolvedValue([{ instanceId: 'course' }]);
  mocks.latest.mockResolvedValue(null); mocks.load.mockResolvedValue({ id: 'course', version: 1, companionTasks: [] });
  mocks.all.mockResolvedValue({ courses: [] });
});
describe('shared HTTP read cores', () => {
  it('keeps every failed authentication response and its independent cookies', async () => {
    const denied = () => { const headers = new Headers(); headers.append('Set-Cookie', 'first=; Max-Age=0'); headers.append('Set-Cookie', 'second=; Max-Age=0'); return new Response('expired', { status: 401, headers }); };
    mocks.auth.mockImplementation(async () => ({ response: denied() }));
    for (const response of [await getCourses(new Request('http://localhost/api/courses')), await state()]) {
      expect(response.status).toBe(401); expect(response.headers.getSetCookie()).toHaveLength(2);
    }
    expect(mocks.auth).toHaveBeenCalledTimes(2); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.participants).not.toHaveBeenCalled();
  });
  it('captures the bootstrap before the authorized student snapshot and keeps original scope', async () => {
    const response = await getCourses(new Request('http://localhost/api/courses?courseId=course'));
    const body = await response.json(); expect(body).toMatchObject({ studentId: 'student', bootstrap: { courseId: 'course', eventCursor: '0' }, courses: [{ id: 'course' }] });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.latest.mock.invocationCallOrder[0]).toBeLessThan(mocks.load.mock.invocationCallOrder[0]);
    expect(mocks.load).toHaveBeenCalledWith('course', expect.anything(), { studentId: 'student' });
    expect(mocks.participants).toHaveBeenCalledWith(expect.objectContaining({ where: { instanceId: 'course', enrollment: { userId: 'student', status: { in: ['ACTIVE', 'active', 'COMPLETED', 'completed'] } } } }));
  });
  it('keeps teacher all-courses and selected-course permission behavior', async () => {
    mocks.auth.mockResolvedValue({ claims: { role: 'teacher', sub: 'teacher', displayName: 'Teacher' } });
    expect((await getCourses(new Request('http://localhost/api/courses'))).status).toBe(200);
    expect(mocks.all).toHaveBeenCalledWith('teacher'); expect(mocks.participants).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue(false); expect((await getCourses(new Request('http://localhost/api/courses?courseId=course'))).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('only considers ETag after fresh authentication, scope, cursor and full representation', async () => {
    const first = await state(); const etag = first.headers.get('etag')!;
    expect((await state(etag)).status).toBe(304); expect(mocks.auth).toHaveBeenCalledTimes(2);
    expect(mocks.latest.mock.invocationCallOrder[0]).toBeLessThan(mocks.load.mock.invocationCallOrder[0]);
    mocks.load.mockResolvedValue({ id: 'course', version: 1, companionTasks: [{ id: 'new' }] });
    const changed = await state(etag); expect(changed.status).toBe(200); expect(changed.headers.get('etag')).not.toBe(etag);
    mocks.studentScope.mockResolvedValue({ accessible: false }); expect((await state(etag)).status).toBe(403); expect(mocks.load).toHaveBeenCalledTimes(3);
  });
  it('preserves courses 503 and state failure propagation without caching errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.load.mockRejectedValue(new Error('read unavailable'));
    try { expect((await getCourses(new Request('http://localhost/api/courses'))).status).toBe(503); await expect(state()).rejects.toThrow('read unavailable'); }
    finally { log.mockRestore(); }
  });
});
