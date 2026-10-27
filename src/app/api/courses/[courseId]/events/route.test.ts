import { beforeEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), query: vi.fn(), access: vi.fn(), scope: vi.fn(), authenticate: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: mocks.authenticate }));
vi.mock('@/lib/platform/access', () => ({ resolveLegacyCourseAccess: mocks.access }));
vi.mock('@/lib/realtime/course-event-scope', () => ({ resolveCourseEventScope: mocks.scope }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.query, domainEvent: { findMany: mocks.findMany } } }));
vi.mock('@/lib/observability/http', () => ({ withHttpMetrics: (_a: string, _b: string, handler: unknown) => handler }));
vi.mock('@/lib/courses/course-read-worker-pool', () => ({ dispatchCourseRead: vi.fn(async () => null) }));
import { GET } from './route';
const id = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-09-08T00:00:00.000Z';
const context = { params: Promise.resolve({ courseId: 'instance' }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ claims: { role: 'student', sub: 'student-2', studentId: 'stale', sv: 7 } });
  mocks.access.mockResolvedValue({ accessible: true });
  mocks.scope.mockResolvedValue({ where: { classroomInstanceId: 'instance' }, version: 2 });
});
it('advances across filtered peer events while delivering only scoped invalidations', async () => {
  mocks.query.mockResolvedValue([
    { id, createdAt: new Date(timestamp), eventType: 'UPDATE_STUDENT_PROGRESS', actorId: 'student-1', participation: { enrollment: { userId: 'student-1' } }, payload: { answer: 'private' } },
    { id: id.replace(/^1/, '2'), createdAt: new Date(timestamp), eventType: 'SET_STAGE', actorId: 'teacher', participation: null, payload: { stage: 2, secretTeacherNote: 'private' } },
  ]);
  const response = await GET(new Request('http://localhost/api/courses/instance/events?after=0'), context);
  const body = await response.json();
  expect(body.events).toHaveLength(1); expect(body.events[0].type).toBe('SET_STAGE');
  expect(JSON.stringify(body)).not.toContain('"private"'); expect(body.nextCursor).toBe(`${timestamp}~${id.replace(/^1/, '2')}`);
});

it('explains only exact hidden personal versions without covering shared drafts, unknown changes or version holes', async () => {
  const event = (number: number, eventType: string, courseVersion: unknown, source?: string, owner = 'student-1') => ({
    id: `11111111-1111-4111-8111-${number.toString().padStart(12, '0')}`, createdAt: new Date(timestamp),
    actorId: owner, participation: { enrollment: { userId: owner } }, eventType,
    payload: { scope: 'student', studentId: 'forged-peer', courseVersion, source, privateBody: 'secret' },
  });
  mocks.query.mockResolvedValue([
    event(1, 'UPDATE_STUDENT_PROGRESS', 2), event(2, 'UPDATE_COURSE', 3, 'learning-events'),
    event(3, 'KNOWLEDGE_QUIZ_SUBMITTED', 4), event(4, 'COURSE_ACTION', 5),
    event(5, 'KNOWLEDGE_QUIZ_GRADED', 6), event(6, 'KNOWLEDGE_TUTOR_COMPLETED', 7),
    event(7, 'UPDATE_COURSE', 8, 'server-course-update'), event(8, 'UPDATE_STUDENT_PROGRESS', '9'),
    event(9, 'UPDATE_STUDENT_PROGRESS', 10.5), event(10, 'UPDATE_STUDENT_PROGRESS', 11, undefined, 'student-2'),
    { ...event(11, 'UPDATE_STUDENT_PROGRESS', 12), actorId: 'different-author' },
  ]);
  const body = await (await GET(new Request('http://localhost/api/courses/instance/events'), context)).json();
  expect(body.privateVersionCoverage).toEqual({ protocol: 'student-private-versions-v1', after: '0', through: body.nextCursor,
    ranges: [[2, 4], [6, 7]] });
  expect(body.events).toHaveLength(1); expect(body.events[0].courseVersion).toBe(11);
  expect(JSON.stringify(body)).not.toContain('secret');
  for (const owner of ['student-1', 'student-2', 'forged-peer']) expect(JSON.stringify(body.privateVersionCoverage)).not.toContain(owner);
  mocks.authenticate.mockResolvedValue({ claims: { role: 'teacher', sub: 'teacher', sv: 7 } });
  expect(await (await GET(new Request('http://localhost/api/courses/instance/events'), context)).json()).not.toHaveProperty('privateVersionCoverage');
});

it('does not apply consecutive instance version semantics to legacy templates or extended scopes', async () => {
  mocks.scope.mockResolvedValue({ where: { classroomInstanceId: null, payload: { path: ['templateId'], equals: 'instance' } }, version: 1720000000000 });
  mocks.findMany.mockResolvedValue([]);
  const body = await (await GET(new Request('http://localhost/api/courses/instance/events'), context)).json();
  expect(body).not.toHaveProperty('privateVersionCoverage');
  expect(body.courseVersion).toBe(1720000000000);
});
it('uses a timestamp and ID seek predicate for equal-time events', async () => {
  mocks.query.mockResolvedValue([]);
  const cursor = `${timestamp}~${id}`;
  const response = await GET(new Request(`http://localhost/api/courses/instance/events?after=${encodeURIComponent(cursor)}`), context);
  expect(response.status).toBe(200);
  const query = mocks.query.mock.calls[0][0] as Prisma.Sql;
  expect(query.values).toEqual(['instance', new Date(timestamp), new Date(timestamp), id, 200]);
});
it('delivers the compact projection payload for direct client application', async () => {
  mocks.query.mockResolvedValue([{
    id,
    createdAt: new Date(timestamp),
    eventType: 'projection-changed',
    actorId: 'teacher',
    participation: null,
    payload: {
      fingerprint: 'private',
      ack: { requestId: 'private' },
      courseVersion: 5,
      projection: {
        courseId: 'instance',
        courseVersion: 5,
        projectionVersion: 3,
        projectionUpdatedAt: timestamp,
        serverTime: timestamp,
        resourceProjection: null,
        teacherResourceProjection: null,
      },
    },
  }]);
  const body = await (await GET(
    new Request('http://localhost/api/courses/instance/events?after=0'),
    context,
  )).json();
  expect(body.events[0]).toMatchObject({
    type: 'projection-changed',
    payload: { projectionVersion: 3, resourceProjection: null },
  });
  expect(JSON.stringify(body)).not.toContain('fingerprint');
  expect(JSON.stringify(body)).not.toContain('requestId');
});
it('rejects malformed legacy numeric cursors and denied access before data reads', async () => {
  expect((await GET(new Request('http://localhost/api/courses/instance/events?after=99'), context)).status).toBe(400);
  mocks.access.mockResolvedValue({ accessible: false });
  expect((await GET(new Request('http://localhost/api/courses/instance/events'), context)).status).toBe(403);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.findMany).not.toHaveBeenCalled();
});


it('returns identical visible events, cursor and pagination through the fresh student scope', async () => {
  mocks.query.mockResolvedValue([
    { id, createdAt: new Date(timestamp), eventType: 'UPDATE_STUDENT_PROGRESS', actorId: 'student-1',
      participation: { enrollment: { userId: 'student-1' } }, payload: { answer: 'private' } },
    { id: id.replace(/^1/, '2'), createdAt: new Date(timestamp), eventType: 'SET_STAGE', actorId: 'teacher',
      participation: null, payload: { stage: 2, secretTeacherNote: 'private' } },
  ]);
  const request = () => new Request('http://localhost/api/courses/instance/events?after=0&limit=2');
  const previousPath = await (await GET(request(), context)).json();
  mocks.scope.mockClear();
  mocks.access.mockResolvedValue({ accessible: true,
    studentInstanceScope: { accessible: true, offeringId: 'offering', version: 2 } });
  const reusedPath = await (await GET(request(), context)).json();
  expect(reusedPath).toEqual(previousPath);
  expect(reusedPath).toMatchObject({ hasMore: true, courseVersion: 2, requiresReconciliation: true });
  expect(mocks.scope).not.toHaveBeenCalled();
  expect(mocks.access).toHaveBeenLastCalledWith(expect.objectContaining({ sub: 'student-2', sv: 7 }), 'instance', 'read');
});

it('checks every poll freshly, observes newer versions, and denies revoked access before event reads', async () => {
  mocks.query.mockResolvedValue([]);
  mocks.access
    .mockResolvedValueOnce({ accessible: true, studentInstanceScope: { accessible: true, offeringId: 'offering', version: 7 } })
    .mockResolvedValueOnce({ accessible: true, studentInstanceScope: { accessible: true, offeringId: 'offering', version: 9 } })
    .mockResolvedValueOnce({ accessible: false, studentInstanceScope: { accessible: false, offeringId: 'offering', version: 9 } });
  const request = () => new Request('http://localhost/api/courses/instance/events');
  expect(await (await GET(request(), context)).json()).toMatchObject({ courseVersion: 7 });
  expect(await (await GET(request(), context)).json()).toMatchObject({ courseVersion: 9 });
  expect((await GET(request(), context)).status).toBe(403);
  expect(mocks.authenticate).toHaveBeenCalledTimes(3);
  expect(mocks.access).toHaveBeenCalledTimes(3);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.scope).not.toHaveBeenCalled();
});

it('advances past a full page of hidden peer events without returning their contents', async () => {
  mocks.access.mockResolvedValue({ accessible: true,
    studentInstanceScope: { accessible: true, offeringId: 'offering', version: 9 } });
  mocks.query.mockResolvedValue([{ id, createdAt: new Date(timestamp), eventType: 'UPDATE_STUDENT_PROGRESS',
    actorId: 'student-1', participation: { enrollment: { userId: 'student-1' } }, payload: { answer: 'private' } }]);
  const body = await (await GET(new Request('http://localhost/api/courses/instance/events?limit=1'), context)).json();
  expect(body).toEqual({ events: [], nextCursor: `${timestamp}~${id}`, hasMore: true,
    courseVersion: 9, requiresReconciliation: true, privateVersionCoverage: { protocol: 'student-private-versions-v1',
      after: '0', through: `${timestamp}~${id}`, ranges: [] } });
  expect(mocks.scope).not.toHaveBeenCalled();
});

it('retains authentication failure ahead of the fresh permission query', async () => {
  mocks.authenticate.mockResolvedValue({ response: new Response(null, { status: 401 }) });
  expect((await GET(new Request('http://localhost/api/courses/instance/events'), context)).status).toBe(401);
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.scope).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.findMany).not.toHaveBeenCalled();
});

it('retains the original teacher/legacy event scope resolver and not-found behavior', async () => {
  mocks.authenticate.mockResolvedValue({ claims: { role: 'teacher', sub: 'teacher', sv: 7 } });
  mocks.scope.mockResolvedValue(null);
  expect((await GET(new Request('http://localhost/api/courses/instance/events'), context)).status).toBe(404);
  expect(mocks.scope).toHaveBeenCalledExactlyOnceWith('instance');
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.findMany).not.toHaveBeenCalled();
});

it('keeps legacy template predicates and complete legal projection fields through the ORM fallback', async () => {
  mocks.authenticate.mockResolvedValue({ claims: { role: 'teacher', sub: 'teacher', sv: 7 } });
  const where = { classroomInstanceId: null, payload: { path: ['templateId'], equals: 'template' } };
  mocks.scope.mockResolvedValue({ where, version: 9 });
  mocks.findMany.mockResolvedValue([{ id, createdAt: new Date(timestamp), eventType: 'projection-changed',
    actorId: 'teacher', participation: null, payload: { templateId: 'template', secret: 'private',
      projection: { nested: [null, { keep: null }], scope: 'replace', source: 'replace' } } }]);
  const body = await (await GET(new Request('http://localhost/api/courses/template/events?limit=1'),
    { params: Promise.resolve({ courseId: 'template' }) })).json();
  expect(body.events[0].payload).toEqual({ nested: [null, { keep: null }], scope: 'course', source: 'v2-domain-event' });
  expect(body).toMatchObject({ hasMore: true, courseVersion: 9, nextCursor: `${timestamp}~${id}` });
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [where] }, take: 1 }));
});

it('rejects an over-limit request before either event read path', async () => {
  expect((await GET(new Request('http://localhost/api/courses/instance/events?limit=501'), context)).status).toBe(400);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.findMany).not.toHaveBeenCalled();
});
