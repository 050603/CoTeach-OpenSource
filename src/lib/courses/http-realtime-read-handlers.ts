// Pure GET cores. Each invocation authenticates and reads live scope; no route wrappers or writer imports.
import { z } from 'zod';
import { authenticateRequest } from '@/lib/auth/request-guards';
import { prisma } from '@/lib/db/client';
import { resolveLegacyCourseAccess } from '@/lib/platform/access';
import { projectionSnapshotFromUiState } from '@/lib/realtime/projection-state';
import type { CourseUiState } from '@/lib/session/types';
import { shouldDeliverMutationToStudent } from '@/lib/realtime/event-visibility';
import { decodeEventCursor, encodeEventCursor } from '@/lib/realtime/event-cursor';
import { resolveCourseEventScope } from '@/lib/realtime/course-event-scope';
import { readCourseEvents } from '@/lib/realtime/course-event-read';
import { courseVersionRanges, isPersonalVersionEvent, PRIVATE_VERSION_COVERAGE_PROTOCOL } from '@/lib/realtime/course-version-coverage';
import { timeProgress } from '@/lib/observability/progress-request-timing';

export async function getProjectionState(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await timeProgress("courses-auth", () => authenticateRequest(request));
  if ("response" in auth) return auth.response;
  const { courseId } = await context.params;
  const instance = await timeProgress("courses-scope", () => prisma.classroomInstance.findFirst({
    where: {
      id: courseId,
      ...(auth.claims.role === "teacher"
        ? {
            activity: {
              chapter: {
                offering: { teachers: { some: { userId: auth.claims.sub } } },
              },
            },
          }
        : {
            participations: {
              some: {
                enrollment: {
                  userId: auth.claims.sub,
                  status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
                },
              },
            },
          }),
    },
    select: { runtimeConfig: true },
  }));
  if (!instance) return new Response(null, { status: 403 });
  const runtime = asRecord(instance.runtimeConfig);
  const uiState = asRecord(runtime.uiState) as CourseUiState;
  const courseVersion = finiteVersion(runtime.version, 1);
  return Response.json(
    projectionSnapshotFromUiState({ courseId, courseVersion, uiState }),
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteVersion(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}


const QuerySchema = z.object({
  after: z.string().max(80).refine((value) => value === '0' || Boolean(decodeEventCursor(value))).default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function getCourseEvents(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const auth = await timeProgress("courses-auth", () => authenticateRequest(request));
  if ('response' in auth) return auth.response;
  const { courseId } = await context.params;
  const access = await timeProgress("courses-scope", () => resolveLegacyCourseAccess(auth.claims, courseId, 'read'));
  if (!access.accessible) return new Response(null, { status: 403 });
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ after: url.searchParams.get('after') ?? undefined, limit: url.searchParams.get('limit') ?? undefined });
  if (!parsed.success) return Response.json({ code: 'INVALID_CURSOR', message: 'Event cursor is invalid.' }, { status: 400 });
  // The authorized student-instance query already read these relations and
  // runtime version. Reuse only this request's result; all polls authorize anew.
  const scope = access.studentInstanceScope
    ? { where: { classroomInstanceId: courseId }, version: access.studentInstanceScope.version }
    : await timeProgress("courses-read", () => resolveCourseEventScope(courseId));
  if (!scope) return new Response(null, { status: 404 });
  const after = decodeEventCursor(parsed.data.after);
  const events = await timeProgress("courses-read", () => readCourseEvents(scope.where, after, parsed.data.limit));
  const eventInfo = (event: typeof events[number]) => {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
    const studentId = event.participation?.enrollment.userId ?? (typeof payload.studentId === 'string' ? payload.studentId : undefined);
    return { payload, studentId, scope: studentId || payload.scope === 'student' ? 'student' as const : 'course' as const };
  };
  const visible = auth.claims.role === 'student' ? events.filter((event) => {
    const info = eventInfo(event);
    return shouldDeliverMutationToStudent({ actionType: event.eventType, scope: info.scope, targetStudentId: info.studentId, actorId: event.actorId ?? undefined }, auth.claims.sub ?? '');
  }) : events;
  const canonicalStudentRead = auth.claims.role === 'student'
    && scope.where.classroomInstanceId === courseId && Object.keys(scope.where).length === 1;
  const visibleIds = new Set(visible.map(event => event.id));
  const privateVersions = canonicalStudentRead ? events.flatMap(event => {
    const info = eventInfo(event);
    const version = info.payload.courseVersion;
    return !visibleIds.has(event.id) && info.scope === 'student'
      && Boolean(info.studentId) && event.actorId === info.studentId
      && isPersonalVersionEvent(event.eventType, info.payload.source)
      && typeof version === 'number' && Number.isSafeInteger(version) && version > 0
      ? [version] : [];
  }) : [];
  return Response.json({
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
    ...(canonicalStudentRead ? { privateVersionCoverage: {
      protocol: PRIVATE_VERSION_COVERAGE_PROTOCOL,
      after: parsed.data.after,
      through: events.length ? encodeEventCursor(events[events.length - 1]) : parsed.data.after,
      ranges: courseVersionRanges(privateVersions),
    } } : {}),
  });
}
