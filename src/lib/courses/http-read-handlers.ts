// Shared GET cores: standard Request/Response only; authentication remains request-local.
import { encodeEventCursor } from "@/lib/realtime/event-cursor";
import { resolveCourseEventScope } from "@/lib/realtime/course-event-scope";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { scopeCourseForClaims } from "@/lib/auth/course-scope";
import { loadCourse, loadSessionState, stateFor } from "@/lib/db/session-read-repository";
import { prisma } from "@/lib/db/client";
import type { Course } from "@/lib/session/types";
import { timeProgress } from "@/lib/observability/progress-request-timing";
import { resolveStudentStateScope } from "@/lib/courses/student-state-scope";
import { createHash } from "node:crypto";

export async function getCourses(request: Request) {
  const auth = await timeProgress("courses-auth", () => authenticateRequest(request)); if ("response" in auth) return auth.response;
  try {
    const claims = auth.claims;
    const requested = new URL(request.url).searchParams.get("courseId");
    if (claims.role === "teacher") {
      if (requested) {
        if (!await timeProgress("courses-scope", () => canAccessLegacyCourse(claims, requested))) return Response.json({ code: "FORBIDDEN" }, { status: 403 });
        const bootstrap = await captureBootstrap(requested);
        const course = await timeProgress("courses-read", () => loadCourse(requested));
        return noStore({ ...stateFor(course ? [course] : []), ...(course && bootstrap ? { bootstrap } : {}), user: { role: "teacher", name: claims.displayName } });
      }
      return noStore({ ...await timeProgress("courses-read", () => loadSessionState(claims.sub)), user: { role: "teacher", name: claims.displayName } });
    }
    const participations = await timeProgress("courses-scope", () => prisma.classroomParticipation.findMany({ where: { ...(requested ? { instanceId: requested } : {}), enrollment: { userId: claims.sub, status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } }, orderBy: { lastEnteredAt: "desc" }, select: { instanceId: true } }));
    const bootstrap = requested && participations.some(p => p.instanceId === requested)
      ? await captureBootstrap(requested, true) : undefined;
    const courses = (await timeProgress("courses-read", () => Promise.all(participations.map(p => loadCourse(p.instanceId, prisma, { studentId: claims.sub! }))))).filter((course): course is Course => Boolean(course)).map(course => scopeCourseForClaims(course, claims));
    return noStore({ ...stateFor(courses), ...(bootstrap && courses.some(course => course.id === requested) ? { bootstrap } : {}), user: { role: "student", name: claims.studentName }, studentId: claims.sub, studentName: claims.studentName, joinedCourseId: requested ?? courses[0]?.id });
  } catch (error) {
    console.error("[v2-courses] projection read failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ code: "COURSES_UNAVAILABLE", message: "无法读取课堂，请稍后重试" }, { status: 503 });
  }
}
function noStore(value: unknown) { return Response.json(value, { headers: { "Cache-Control": "private, no-store" } }); }

// Called only after request-local authorization and BEFORE loading the snapshot.
// A later cursor could skip a concurrent commit absent from that snapshot.
async function captureBootstrap(courseId: string, studentInstance = false) {
  try {
    const scope = studentInstance ? { where: { classroomInstanceId: courseId } } : await resolveCourseEventScope(courseId);
    if (!scope) return undefined;
    const latest = await prisma.domainEvent.findFirst({ where: scope.where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, createdAt: true } });
    return { courseId, eventCursor: latest ? encodeEventCursor(latest) : "0" };
  } catch (error) {
    // Metadata is optional. Preserve authenticated hydration; clients fall back
    // to the existing /state bootstrap instead of inventing a cursor on failure.
    console.error("[v2-courses] bootstrap cursor unavailable", error instanceof Error ? error.message : "unknown");
    return undefined;
  }
}

export async function getCourseState(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await timeProgress("courses-auth", () => authenticateRequest(request));
  if ("response" in auth) return auth.response;
  const { courseId } = await context.params;
  const studentScope = auth.claims.role === "student" && auth.claims.sub
    ? await timeProgress("courses-scope", () => resolveStudentStateScope(prisma, courseId, auth.claims.sub!))
    : null;
  if (studentScope ? !studentScope.accessible : !(await timeProgress("courses-scope", () => canAccessLegacyCourse(auth.claims, courseId, "read")))) {
    return new Response(null, { status: 403 });
  }
  const scope = studentScope ? { where: { classroomInstanceId: courseId } } : await resolveCourseEventScope(courseId);
  if (!scope) return new Response(null, { status: 404 });
  const latestEvent = await prisma.domainEvent.findFirst({ where: scope.where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
  const course = await timeProgress("courses-read", () => loadCourse(courseId, prisma, auth.claims.role === "student" && auth.claims.sub ? { studentId: auth.claims.sub } : undefined));
  if (!course) return new Response(null, { status: 404 });
  const scoped = scopeCourseForClaims(course, auth.claims);
  // Some independently persisted collections (assessment drafts, companion
  // tasks, audit records) do not advance runtime.version. A version-only ETag
  // can hide their changes. Hash the actual authorized representation until
  // every collection has a shared durable revision; never cache authorization.
  const body = JSON.stringify({ course: scoped, courseVersion: course.version ?? 0,
    eventCursor: latestEvent ? encodeEventCursor(latestEvent) : "0" });
  const etag = `W/"${createHash("sha256").update(body).digest("hex")}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie, X-OpenPBL-Role" };
  const matches = request.headers.get("if-none-match")?.split(",").some(value => value.trim() === etag);
  return matches ? new Response(null, { status: 304, headers })
    : new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}


export { getProjectionState, getCourseEvents } from './http-realtime-read-handlers';
