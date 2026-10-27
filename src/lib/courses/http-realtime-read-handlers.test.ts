// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), projection: vi.fn(), raw: vi.fn(), claims: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  readAuthFromRequest: mocks.claims,
  getRequestedAuthRole: () => 'student',
  isAuthConfigured: () => true,
  clearAuthCookies: () => [
    { name: 'student', path: '/', sameSite: 'lax', secure: false },
    { name: 'legacy-student', path: '/', sameSite: 'lax', secure: false },
  ],
}));
vi.mock('@/lib/db/client', () => ({ prisma: {
  user: { findUnique: mocks.user },
  classroomInstance: { findFirst: mocks.projection },
  $queryRaw: mocks.raw,
} }));
// This unrelated media lookup is not part of either read core.
vi.mock('@/lib/course-generation/generation-preview', () => ({ findCourseGenerationPreviewCourseId: vi.fn() }));
import { getCourseEvents, getProjectionState } from './http-realtime-read-handlers';
import { courseReadResponseMessage, courseReadResultToResponse } from './course-read-worker-protocol';

const context = { params: Promise.resolve({ courseId: 'course' }) };
const instant = '2026-10-17T12:00:00.000Z';
const eventId = '11111111-1111-4111-8111-111111111111';
const controls = {
  projectionController: { teacherId: 'teacher', clientId: 'controller' },
  resourceProjection: { resourceId: 'resource', stageKey: 'make', title: 'Synthetic control', startedAt: instant,
    viewState: { page: 3, scrollRatio: 0.5, mediaTime: 12, mediaPlaying: true, mediaPlaybackRate: 1, updatedAt: instant, revision: 3 } },
  teacherResourceProjection: { classroomId: 'design', sceneId: 'scene', stageKey: 'make', title: 'Synthetic scene',
    sceneType: 'interactive', startedAt: instant, mode: 'forced', version: 3, updatedAt: instant, engineMode: 'playing',
    playback: { sceneIndex: 2, actionIndex: 1, consumedDiscussions: ['discussion'], sceneId: 'scene' },
    interactionState: { counter: 4, nested: [null, { selected: true }] } },
};
const handlers = { events: getCourseEvents, projection: getProjectionState };
const request = (operation: keyof typeof handlers) => new Request(`https://class.test/api/courses/course/${operation}`, {
  headers: { 'x-request-id': 'business-id', 'x-openpbl-role': 'student' },
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant)); vi.resetAllMocks();
  mocks.claims.mockResolvedValue({ sub: 'student', role: 'student', sv: 7 });
  mocks.user.mockResolvedValue({ role: 'STUDENT', status: 'ACTIVE', sessionVersion: 7 });
  mocks.projection.mockResolvedValue({ runtimeConfig: { version: 8, secret: 'private', uiState: {
    projectionVersion: 3, projectionUpdatedAt: instant, ...controls,
  } } });
  // Actual access/session helpers run; only the DB transport is stubbed.
  mocks.raw.mockImplementation(async (query: unknown) => Array.isArray(query)
    ? [{ accessible: true, offeringId: 'offering', runtimeVersion: 8 }]
    : [{ id: eventId, createdAt: new Date(instant), eventType: 'UPDATE_STUDENT_PROGRESS', actorId: 'peer',
      participation: { enrollment: { userId: 'peer' } }, payload: { courseVersion: 8, secret: 'private' } }]);
});
afterEach(() => vi.useRealTimers());

describe('realtime read cores retain request-local authorization through the worker wire', () => {
  it.each(['projection', 'events'] as const)('%s checks live role/status/SV on every execution', async operation => {
    const get = () => handlers[operation](request(operation), context);
    expect((await get()).status).toBe(200);
    const dataReads = mocks.projection.mock.calls.length + mocks.raw.mock.calls.length;
    for (const user of [null, { role: 'STUDENT', status: 'DISABLED', sessionVersion: 7 },
      { role: 'TEACHER', status: 'ACTIVE', sessionVersion: 7 },
      { role: 'STUDENT', status: 'ACTIVE', sessionVersion: 8 }]) {
      mocks.user.mockResolvedValue(user);
      const response = await get();
      const wire = await courseReadResponseMessage(1, response, [], 1);
      const decoded = courseReadResultToResponse(structuredClone(wire, { transfer: [wire.body!] }));
      expect(decoded.status).toBe(401);
      expect(decoded.headers.get('cache-control')).toBe('no-store');
      expect(decoded.headers.getSetCookie()).toHaveLength(2);
      expect(await decoded.json()).toEqual({ code: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录。', requestId: 'business-id' });
      expect(mocks.projection.mock.calls.length + mocks.raw.mock.calls.length).toBe(dataReads);
    }
    expect(mocks.user).toHaveBeenCalledTimes(5);
  });

  it('checks fresh membership, retaining canonical event version coverage without leaking peers', async () => {
    const response = await getCourseEvents(request('events'), context);
    const expected = { events: [], nextCursor: `${instant}~${eventId}`, hasMore: false, courseVersion: 8,
      requiresReconciliation: true, privateVersionCoverage: {
        protocol: 'student-private-versions-v1', after: '0', through: `${instant}~${eventId}`, ranges: [[8, 8]],
      } };
    expect(await response.clone().json()).toEqual(expected);
    const wire = await courseReadResponseMessage(1, response, [], 1);
    expect(await courseReadResultToResponse(wire).json()).toEqual(expected);
    mocks.raw.mockResolvedValue([{ accessible: false, offeringId: 'offering', runtimeVersion: 9 }]);
    const count = mocks.raw.mock.calls.length;
    expect((await getCourseEvents(request('events'), context)).status).toBe(403);
    expect(mocks.raw).toHaveBeenCalledTimes(count + 1); // authorization only; no event query
  });

  it('preserves complete projection controls and no-store headers while denying a revoked membership', async () => {
    const response = await getProjectionState(request('projection'), context);
    const expected = await response.clone().text();
    const wire = await courseReadResponseMessage(1, response, [], 1);
    const reconstructed = courseReadResultToResponse(wire);
    expect(await reconstructed.text()).toBe(expected);
    expect([...reconstructed.headers]).toEqual([...response.headers]);
    expect(JSON.parse(expected)).toEqual({ courseId: 'course', courseVersion: 8, projectionVersion: 3,
      projectionUpdatedAt: instant, serverTime: instant, ...controls });
    expect(expected).not.toContain('private');
    expect(mocks.projection).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'course', participations: { some: { enrollment: { userId: 'student', status: { in: ['ACTIVE', 'active', 'COMPLETED', 'completed'] } } } },
    } }));
    mocks.projection.mockResolvedValue(null);
    expect((await getProjectionState(request('projection'), context)).status).toBe(403);
    expect(mocks.projection).toHaveBeenCalledTimes(2);
  });
});
