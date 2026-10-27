/** Focused native PostgreSQL regression. Only a disposable verification database
 * with the matching marker is accepted; no .env or production database lookup.
 * Run: OPENPBL_VERIFY_EVENTS_ONLY=1 pnpm test:db:research
 */
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

const marker = process.env.OPENPBL_VERIFICATION_MARKER;
assert.match(marker ?? '', /^openpbl-research-check-[0-9a-f-]{36}$/);
const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'postgres');
assert.equal(url.password, ''); assert.equal(url.pathname, '/postgres'); assert.ok(url.port);
const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const queries: string[] = [];
db.$on('query', event => { queries.push(event.query); });
globalThis.__openPblPrisma = db;
process.env.JWT_SECRET = 'isolated-course-event-read-regression-not-real-credentials';

async function main() {
  try {
    assert.equal((await db.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    const prisma = db;
    const { authenticateRequest } = await import('../src/lib/auth/request-guards');
    const { resolveLegacyCourseAccess } = await import('../src/lib/platform/access');
    const { decodeEventCursor, encodeEventCursor } = await import('../src/lib/realtime/event-cursor');
    const { resolveCourseEventScope } = await import('../src/lib/realtime/course-event-scope');
    const { shouldDeliverMutationToStudent } = await import('../src/lib/realtime/event-visibility');
    const { readCourseEvents } = await import('../src/lib/realtime/course-event-read');
    const { GET } = await import('../src/app/api/courses/[courseId]/events/route');
    const { signStudentToken, signTeacherToken } = await import('../src/lib/auth/session');
    // Frozen pre-projection HTTP oracle: full ORM payload, then the original
    // authorization, event visibility and cursor protocol, independent of SQL.
    const QuerySchema = z.object({
      after: z.string().max(80).refine((value) => value === '0' || Boolean(decodeEventCursor(value))).default('0'),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    });
    type Coverage = { protocol: string; after: string; through: string; ranges: [number, number][] };
    const rawCoverage = new WeakMap<Response, Coverage>();

    async function getCourseEvents(request: Request, context: { params: Promise<{ courseId: string }> }) {
      const auth = await authenticateRequest(request);
      if ('response' in auth) return auth.response;
      const { courseId } = await context.params;
      const access = await resolveLegacyCourseAccess(auth.claims, courseId, 'read');
      if (!access.accessible) return new Response(null, { status: 403 });
      const url = new URL(request.url);
      const parsed = QuerySchema.safeParse({ after: url.searchParams.get('after') ?? undefined, limit: url.searchParams.get('limit') ?? undefined });
      if (!parsed.success) return Response.json({ code: 'INVALID_CURSOR', message: 'Event cursor is invalid.' }, { status: 400 });
      // The authorized student-instance query already read these relations and
      // runtime version. Reuse only this request's result; all polls authorize anew.
      const scope = access.studentInstanceScope
        ? { where: { classroomInstanceId: courseId }, version: access.studentInstanceScope.version }
        : await resolveCourseEventScope(courseId);
      if (!scope) return new Response(null, { status: 404 });
      const after = decodeEventCursor(parsed.data.after);
      const events = await prisma.domainEvent.findMany({
        where: { AND: [scope.where, ...(after ? [{ OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }] : [])] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: parsed.data.limit,
        include: { participation: { select: { enrollment: { select: { userId: true } } } } },
      });
      const eventInfo = (event: typeof events[number]) => {
        const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
        const studentId = event.participation?.enrollment.userId ?? (typeof payload.studentId === 'string' ? payload.studentId : undefined);
        return { payload, studentId, scope: studentId || payload.scope === 'student' ? 'student' as const : 'course' as const };
      };
      const visible = auth.claims.role === 'student' ? events.filter((event) => {
        const info = eventInfo(event);
        return shouldDeliverMutationToStudent({ actionType: event.eventType, scope: info.scope, targetStudentId: info.studentId, actorId: event.actorId ?? undefined }, auth.claims.sub ?? '');
      }) : events;
      const response = Response.json({
        events: visible.map((event) => {
          const info = eventInfo(event);
          const projection = event.eventType === 'projection-changed'
            && info.payload.projection
            && typeof info.payload.projection === 'object'
            && !Array.isArray(info.payload.projection)
            ? info.payload.projection as Record<string, unknown>
            : null;
          return { cursor: encodeEventCursor(event), type: event.eventType, courseVersion: typeof info.payload.courseVersion === 'number' ? info.payload.courseVersion : scope.version,
            // Projection controls are safe, compact and latency-sensitive. Other
            // events remain invalidations whose canonical role-scoped state is read separately.
            payload: projection
              ? { ...projection, scope: info.scope, source: 'v2-domain-event' }
              : { scope: info.scope, ...(info.studentId ? { studentId: info.studentId } : {}), source: 'v2-domain-event' },
            createdAt: event.createdAt.toISOString() };
        }),
        nextCursor: events.length ? encodeEventCursor(events[events.length - 1]) : parsed.data.after,
        hasMore: events.length === parsed.data.limit, courseVersion: scope.version,
        // Client refreshes only when this canonical version exceeds its local snapshot.
        requiresReconciliation: true,
      });
      if (auth.claims.role === 'student' && scope.where.classroomInstanceId === courseId && Object.keys(scope.where).length === 1) {
        // Independent raw-row oracle: no SQL projection or production coverage
        // helper is used. Explicit producer policy plus ownership and exact
        // integer evidence; never infer intermediate versions from page bounds.
        const versions = new Set<number>();
        for (const event of events) {
          const info = eventInfo(event);
          const value = info.payload.courseVersion;
          const personal = ['UPDATE_STUDENT_PROGRESS', 'KNOWLEDGE_QUIZ_SUBMITTED', 'KNOWLEDGE_QUIZ_GRADED', 'KNOWLEDGE_TUTOR_COMPLETED'].includes(event.eventType)
            || (event.eventType === 'UPDATE_COURSE' && info.payload.source === 'learning-events');
          if (!visible.some(candidate => candidate.id === event.id) && info.scope === 'student' && info.studentId
            && event.actorId === info.studentId && personal && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) versions.add(value);
        }
        const ranges: [number, number][] = [];
        for (const value of [...versions].sort((a, b) => a - b)) {
          const previous = ranges.at(-1);
          if (previous && previous[1] === value - 1) previous[1] = value;
          else ranges.push([value, value]);
        }
        rawCoverage.set(response, { protocol: 'student-private-versions-v1', after: parsed.data.after,
          through: events.length ? encodeEventCursor(events[events.length - 1]) : parsed.data.after, ranges });
      }
      return response;
    }
    const teacher = await db.user.create({ data: { username: 'event-teacher', usernameKey: 'event-teacher', displayName: 'T', role: 'TEACHER', passwordHash: 'fixture' } });
    const student = await db.user.create({ data: { username: 'event-student', usernameKey: 'event-student', displayName: 'S', role: 'STUDENT', passwordHash: 'fixture' } });
    const peer = await db.user.create({ data: { username: 'event-peer', usernameKey: 'event-peer', displayName: 'P', role: 'STUDENT', passwordHash: 'fixture' } });
    const offering = await db.courseOffering.create({ data: { name: 'Event reads', status: 'OPEN' } });
    await db.courseTeacher.create({ data: { offeringId: offering.id, userId: teacher.id } });
    const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: 'Events', position: 0 } });
    const activity = await db.activity.create({ data: { chapterId: chapter.id, title: 'Events', type: 'CLASSROOM', position: 0 } });
    const template = await db.classroomTemplate.create({ data: { title: 'Template', ownerId: teacher.id, status: 'ACTIVE' } });
    const version = await db.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: 'PUBLISHED', snapshot: {} } });
    const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: 'TEACHING', runtimeConfig: { version: 7 } } });
    const enrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: student.id } });
    const peerEnrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: peer.id } });
    const participation = await db.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
    const peerParticipation = await db.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: peerEnrollment.id } });
    const large = 'private-large-raw-event-body'.repeat(100_000);
    const special = [Prisma.DbNull, Prisma.JsonNull, [], ['student'], false, 9, 'student', {},
      { scope: 'student', studentId: student.id, courseVersion: '9' },
      { scope: ['student'], studentId: { nested: 'wrong type' }, courseVersion: true },
      { scope: 'student', studentId: '', courseVersion: -2.75 },
      { projection: { courseId: instance.id, resourceProjection: null, nested: [null, { keep: null }], scope: 'overridden', source: 'overridden' }, courseVersion: 8 },
      { projection: [] }, { projection: null }, { projection: 'invalid' }, { projection: {} },
      { scope: 'student', studentId: peer.id, projection: { retained: true } },
      { scope: 'student', studentId: student.id, courseVersion: 0 },
      { privateDraft: large, scope: 'student', studentId: student.id, courseVersion: 11 },
    ];
    const at = new Date('2026-10-17T00:00:00Z');
    const id = (i: number) => `11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`;
    await db.domainEvent.createMany({ data: Array.from({ length: 513 }, (_, i) => ({
      id: id(i), idempotencyKey: `event-projection:${i}`, offeringId: offering.id, classroomInstanceId: instance.id,
      actorId: i % 3 === 0 ? student.id : teacher.id,
      participationId: i === 0 || i === 17 ? peerParticipation.id : i === 16 ? participation.id : null,
      eventType: i >= 11 && i <= 17 ? 'projection-changed' : i % 3 === 0 ? 'UPDATE_STUDENT_PROGRESS' : 'SET_STAGE',
      payload: i < special.length ? special[i] : { scope: i % 4 ? 'student' : 'course', studentId: i % 2 ? peer.id : student.id, courseVersion: i, secret: `private-${i}` },
      createdAt: new Date(at.getTime() + Math.floor(i / 170)),
    })) });
    const studentToken = await signStudentToken({ userId: student.id, studentName: student.displayName, sessionVersion: student.sessionVersion });
    const teacherToken = await signTeacherToken({ teacherId: teacher.id, username: teacher.username, displayName: teacher.displayName, sessionVersion: teacher.sessionVersion });
    const request = (role: 'student' | 'teacher', course = instance.id, query = '') => {
      const token = role === 'student' ? studentToken : teacherToken;
      return new Request(`http://localhost/api/courses/${course}/events${query}`, { headers: { cookie: `${token.cookieName}=${token.token}`, 'x-openpbl-role': role, 'x-request-id': 'native-event-read-fixture' } });
    };
    async function parity(role: 'student' | 'teacher', course = instance.id, query = '') {
      const context = { params: Promise.resolve({ courseId: course }) };
      const before = await getCourseEvents(request(role, course, query), context);
      const after = await GET(request(role, course, query), context);
      assert.equal(after.status, before.status);
      const oldText = await before.text(), newText = await after.text();
      const oldBody = oldText ? JSON.parse(oldText) : null;
      const newBody = newText ? JSON.parse(newText) : null;
      const expectedCoverage = rawCoverage.get(before);
      if (expectedCoverage) {
        const actual = newBody.privateVersionCoverage;
        assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual), 'Canonical student read must carry coverage metadata');
        assert.deepEqual(Object.keys(actual).sort(), ['after', 'protocol', 'ranges', 'through']);
        assert.equal(actual.protocol, 'student-private-versions-v1');
        assert.equal(typeof actual.after, 'string'); assert.equal(typeof actual.through, 'string');
        assert.ok(Array.isArray(actual.ranges));
        for (const range of actual.ranges) {
          assert.ok(Array.isArray(range) && range.length === 2 && range.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0));
          assert.ok(range[0] <= range[1]);
        }
        assert.deepEqual(actual, expectedCoverage, 'Metadata must equal the independent raw-page oracle, including every hole');
        const legacyBody = { ...newBody }; delete legacyBody.privateVersionCoverage;
        assert.deepEqual(legacyBody, oldBody, 'Only coverage metadata may differ from the old HTTP response');
      } else {
        assert.equal(newBody !== null && Object.hasOwn(newBody, 'privateVersionCoverage'), false, 'Teacher, template and rejected reads must not expose student-only metadata');
        assert.deepEqual(newBody, oldBody);
      }
      return { status: after.status, body: newBody };
    }
    for (const role of ['student', 'teacher'] as const) {
      for (const limit of [1, 7, 200, 500]) {
        let cursor = '0';
        for (let page = 0; page < (limit === 200 ? 4 : 3); page++) {
          const result = await parity(role, instance.id, `?limit=${limit}&after=${encodeURIComponent(cursor)}`);
          assert.equal(result.status, 200);
          if (role === 'student' && limit === 1 && page === 0) assert.deepEqual(result.body.events, []);
          cursor = result.body.nextCursor;
          if (!result.body.hasMore) break;
        }
        await parity(role, instance.id, `?limit=${limit}&after=${encodeURIComponent(encodeEventCursor({ id: id(511), createdAt: new Date(at.getTime() + 3) }))}`);
      }
      await parity(role, instance.id, '?after=99');
    }
    const coverageInstance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id,
      runNo: 2, status: 'TEACHING', runtimeConfig: { version: 1000 } } });
    const ownCoverageParticipation = await db.classroomParticipation.create({ data: { instanceId: coverageInstance.id, enrollmentId: enrollment.id } });
    const peerCoverageParticipation = await db.classroomParticipation.create({ data: { instanceId: coverageInstance.id, enrollmentId: peerEnrollment.id } });
    const coverageAt = new Date(at.getTime() + 100);
    const coverageRows: Array<{ type: string; value: Prisma.InputJsonValue | null; source?: Prisma.InputJsonValue;
      actor?: string; participation?: string | null; payloadStudent?: string | null }> = [
      { type: 'UPDATE_STUDENT_PROGRESS', value: 101 },
      { type: 'KNOWLEDGE_QUIZ_SUBMITTED', value: 102 },
      { type: 'KNOWLEDGE_QUIZ_GRADED', value: 104 }, // 103 is a shared action, not a private version.
      { type: 'KNOWLEDGE_TUTOR_COMPLETED', value: 105 },
      { type: 'UPDATE_COURSE', value: 106, source: 'learning-events' },
      { type: 'COURSE_ACTION', value: 103 },
      { type: 'UPSERT_SUBMISSION', value: 107 },
      { type: 'UPDATE_COURSE', value: 108 },
      { type: 'UPDATE_COURSE', value: 109, source: 'teacher-edit' },
      { type: 'UPDATE_COURSE', value: 110, source: ['learning-events'] },
      { type: 'UPDATE_COURSE', value: 111, source: { kind: 'learning-events' } },
      { type: 'UPDATE_STUDENT_PROGRESS', value: 112, actor: teacher.id },
      { type: 'UPDATE_STUDENT_PROGRESS', value: 113, participation: ownCoverageParticipation.id },
      { type: 'UPDATE_STUDENT_PROGRESS', value: 114, payloadStudent: student.id }, // Canonical relation wins over stale payload owner.
      { type: 'UPDATE_COURSE', value: 115, source: 'learning-events', participation: null }, // Legacy payload owner fallback.
      { type: 'UPDATE_STUDENT_PROGRESS', value: 116, participation: null, payloadStudent: 'different-owner' },
      { type: 'UPDATE_STUDENT_PROGRESS', value: 117, participation: null, payloadStudent: null },
      { type: 'UPDATE_STUDENT_PROGRESS', value: 118, actor: student.id, participation: ownCoverageParticipation.id, payloadStudent: student.id },
      ...['119', 120.5, -1, 0, Number.MAX_SAFE_INTEGER + 1, null, true, { value: 121 }, [122]].map(value => ({ type: 'UPDATE_STUDENT_PROGRESS', value })),
      { type: 'KNOWLEDGE_QUIZ_GRADED', value: 104 }, // Duplicates are compressed, not counted twice.
      { type: 'KNOWLEDGE_TUTOR_COMPLETED', value: Number.MAX_SAFE_INTEGER },
    ];
    const coverageId = (i: number) => `22222222-2222-4222-8222-${i.toString(16).padStart(12, '0')}`;
    await db.domainEvent.createMany({ data: coverageRows.map((row, i) => ({
      id: coverageId(i), idempotencyKey: `private-version-coverage:${i}`, offeringId: offering.id, classroomInstanceId: coverageInstance.id,
      actorId: row.actor ?? peer.id, participationId: row.participation === undefined ? peerCoverageParticipation.id : row.participation,
      eventType: row.type, createdAt: coverageAt,
      payload: { scope: 'student', ...(row.payloadStudent === null ? {} : { studentId: row.payloadStudent ?? peer.id }),
        courseVersion: row.value, ...(row.source === undefined ? {} : { source: row.source }),
        // Retain private/shared payloads in the database, never in coverage.
        privateDraft: `coverage-private-${i}`, ...(row.type === 'COURSE_ACTION' ? { action: { type: 'UPDATE_GROUP_WORK', groupId: 'shared-group' } } : {}) },
    })) });
    const wholeCoverage = await parity('student', coverageInstance.id, '?limit=500');
    assert.deepEqual(wholeCoverage.body.privateVersionCoverage.ranges, [[101, 102], [104, 106], [114, 115], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]);
    assert.equal(JSON.stringify(wholeCoverage.body).includes('coverage-private-'), false);
    assert.equal(JSON.stringify(wholeCoverage.body.privateVersionCoverage).includes(peer.id), false);
    assert.equal(wholeCoverage.body.events.length, 2, 'Only canonical self events remain visible');
    for (const limit of [1, 3, 7, 500]) {
      let cursor = '0';
      const seen: number[] = [];
      for (let page = 0; page <= coverageRows.length; page++) {
        const result = await parity('student', coverageInstance.id, `?limit=${limit}&after=${encodeURIComponent(cursor)}`);
        const coverage = result.body.privateVersionCoverage;
        assert.equal(coverage.after, cursor); assert.equal(coverage.through, result.body.nextCursor);
        for (const [start, end] of coverage.ranges as [number, number][]) {
          // All fixture ranges are tiny, even the single MAX_SAFE_INTEGER.
          for (let offset = 0; offset <= end - start; offset++) seen.push(start + offset);
        }
        cursor = result.body.nextCursor;
        if (!result.body.hasMore) break;
      }
      assert.deepEqual([...new Set(seen)].sort((a, b) => a - b), [101, 102, 104, 105, 106, 114, 115, Number.MAX_SAFE_INTEGER]);
      const empty = await parity('student', coverageInstance.id, `?limit=${limit}&after=${encodeURIComponent(cursor)}`);
      assert.deepEqual(empty.body.privateVersionCoverage, { protocol: 'student-private-versions-v1', after: cursor, through: cursor, ranges: [] });
    }
    const tiedAfter = encodeEventCursor({ id: coverageId(1), createdAt: coverageAt });
    assert.deepEqual((await parity('student', coverageInstance.id, `?limit=3&after=${encodeURIComponent(tiedAfter)}`)).body.privateVersionCoverage.ranges, [[104, 106]]);
    assert.equal(Object.hasOwn((await parity('teacher', coverageInstance.id, '?limit=500')).body, 'privateVersionCoverage'), false);
    const fallback = await readCourseEvents({ AND: [{ classroomInstanceId: coverageInstance.id }] }, null, 500, db);
    assert.deepEqual(fallback.find(event => event.id === coverageId(14))?.payload,
      (await db.domainEvent.findUniqueOrThrow({ where: { id: coverageId(14) } })).payload, 'Noncanonical helper fallback retains the raw source and payload');
    const storedShared = await db.domainEvent.findUniqueOrThrow({ where: { id: coverageId(5) } });
    assert.deepEqual((storedShared.payload as { action: unknown }).action, { type: 'UPDATE_GROUP_WORK', groupId: 'shared-group' });
    assert.equal(await db.domainEvent.count({ where: { classroomInstanceId: coverageInstance.id } }), coverageRows.length);
    console.log('PASS exact raw private-version coverage, shared-action holes, canonical owner precedence, source fallback/types, unsafe numbers, duplicate versions and tied-ID pagination', JSON.stringify({ node: process.versions.node, coverageRows: coverageRows.length }));
    queries.length = 0;
    const projected = await readCourseEvents({ classroomInstanceId: instance.id }, null, 500, db);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(queries.length, 1, 'Canonical projection must be one SQL statement');
    const raw = await db.domainEvent.findMany({ where: { classroomInstanceId: instance.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 });
    const beforeBytes = Buffer.byteLength(JSON.stringify(raw.map(r => r.payload)));
    const afterBytes = Buffer.byteLength(JSON.stringify(projected.map(r => r.payload)));
    assert.ok(afterBytes < beforeBytes / 10);
    assert.equal((raw.find(r => r.id === id(18))!.payload as { privateDraft: string }).privateDraft, large);
    assert.equal(JSON.stringify(projected).includes(large), false);
    assert.deepEqual((await db.domainEvent.findUniqueOrThrow({ where: { id: id(18) } })).payload, raw.find(r => r.id === id(18))!.payload);
    console.log('PASS exact old/new HTTP parity for teacher/student, JSON null/scalars/arrays/types, full nested projection, membership precedence, hidden pages, tied cursors and limits; synthetic selected payload bytes', JSON.stringify({ beforeBytes, afterBytes }));
    // Template event scope must retain its JSON predicate and complete projection.
    await db.domainEvent.create({ data: { idempotencyKey: 'template-event', actorId: teacher.id, payload: { templateId: template.id, projection: { keep: null } }, eventType: 'projection-changed' } });
    assert.equal((await parity('teacher', template.id)).body.events.length, 1);
    const collision = await db.classroomTemplate.create({ data: { id: instance.id, title: 'Collision', ownerId: teacher.id, status: 'ACTIVE' } });
    assert.equal((await parity('student')).status, 403);
    assert.equal((await parity('teacher')).body.events.length > 0, true);
    await db.classroomTemplate.delete({ where: { id: collision.id } });
    await db.classroomInstance.update({ where: { id: instance.id }, data: { status: 'FINISHED' } });
    await db.courseOffering.update({ where: { id: offering.id }, data: { status: 'CLOSED' } });
    await db.enrollment.update({ where: { id: enrollment.id }, data: { status: 'COMPLETED' } });
    assert.equal((await parity('student')).status, 200);
    for (const change of [{ status: 'DISABLED' }, { role: 'TEACHER' }, { sessionVersion: student.sessionVersion + 1 }]) {
      await db.user.update({ where: { id: student.id }, data: change });
      assert.equal((await parity('student')).status, 401);
      await db.user.update({ where: { id: student.id }, data: { role: student.role, status: student.status, sessionVersion: student.sessionVersion } });
    }
    await db.enrollment.update({ where: { id: enrollment.id }, data: { status: 'WITHDRAWN' } });
    assert.equal((await parity('student')).status, 403);
    await db.courseTeacher.deleteMany({ where: { offeringId: offering.id, userId: teacher.id } });
    assert.equal((await parity('teacher')).status, 403);
    assert.equal(await db.domainEvent.count({ where: { classroomInstanceId: instance.id } }), 513);
    console.log('PASS unchanged raw event storage, template fallback/collision, closed history and live role/status/SV/membership revocation; isolated database only');
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
