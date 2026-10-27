import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { getPlatformUser } from "@/lib/platform/access";
import { PlatformError } from "@/lib/platform/repository";

/** Legacy course URLs identify a classroom instance; JWT subjects identify V2 users. */
export async function authorizeLegacyAiScope(claims: AuthClaims, instanceId: string, studentId?: string, write = false) {
  const user = await getPlatformUser(claims);
  if (!user) throw new PlatformError("UNAUTHENTICATED", "请重新登录", 401);
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: { include: { offering: { include: { teachers: true } } } } } } } });
  if (!instance) throw new PlatformError("COURSE_NOT_FOUND", "课堂不存在", 404);
  const offering = instance.activity.chapter.offering;
  if (user.role === "teacher" && !offering.teachers.some(t => t.userId === user.id)) throw new PlatformError("FORBIDDEN", "无权访问该课堂", 403);
  if (user.role === "student" && studentId && studentId !== user.id) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "无权访问其他学生", 403);
  const subjectId = user.role === "student" ? user.id : studentId;
  const participation = subjectId ? await prisma.classroomParticipation.findFirst({ where: { instanceId, enrollment: { userId: subjectId, offeringId: offering.id, ...(user.role === "student" ? { status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } : {}) } }, include: { enrollment: true } }) : null;
  if (subjectId && !participation) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "未加入该课堂", 403);
  if (write && (instance.status.toUpperCase() !== "TEACHING" || offering.status.toUpperCase() !== "OPEN" || instance.activity.archivedAt || (participation && participation.enrollment.status.toUpperCase() !== "ACTIVE"))) throw new PlatformError("COURSE_LOCKED", "课堂当前不可写入", 409);
  return { user, instance, offering, participation, studentId: subjectId };
}

export function legacyAiError(error: unknown) {
  if (error instanceof PlatformError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  return Response.json({ error: "DATABASE_UNAVAILABLE", message: "课堂数据暂时不可用，请重试" }, { status: 503 });
}

/** A fresh authorization read, not an access cache. Student collaboration
 * only needs its participation ID; do not assemble the offering's teachers and
 * complete instance hierarchy on every history/status/memory poll. Keep the
 * general teacher/export scope above for callers which need those records.
 */
async function studentParticipation(claims: AuthClaims, instanceId: string, requestedStudentId: string, write: boolean) {
  const [row] = await prisma.$queryRaw<Array<{
    id: string; role: string; status: string; sessionVersion: number;
    instanceId: string | null; instanceStatus: string | null; offeringStatus: string | null;
    archivedAt: Date | null; participationId: string | null; enrollmentStatus: string | null;
  }>>`SELECT u.id, u.role, u.status, u."sessionVersion", ci.id AS "instanceId",
      ci.status AS "instanceStatus", o.status AS "offeringStatus", a."archivedAt",
      p.id AS "participationId", e.status AS "enrollmentStatus"
    FROM "User" u
    LEFT JOIN "ClassroomInstance" ci ON ci.id = ${instanceId}
    LEFT JOIN "Activity" a ON a.id = ci."activityId"
    LEFT JOIN "Chapter" c ON c.id = a."chapterId"
    LEFT JOIN "CourseOffering" o ON o.id = c."offeringId"
    LEFT JOIN "Enrollment" e ON e."offeringId" = o.id AND e."userId" = u.id
      AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed')
    LEFT JOIN "ClassroomParticipation" p ON p."instanceId" = ci.id AND p."enrollmentId" = e.id
    WHERE u.id = ${claims.sub ?? ""}`;
  // Recheck the session in the same snapshot as membership. A revocation
  // between authenticateRequest and this query must not admit an old cookie.
  if (!row || row.role.toLowerCase() !== "student" || row.status.toLowerCase() !== "active"
    || row.sessionVersion !== claims.sv) throw new PlatformError("UNAUTHENTICATED", "请重新登录", 401);
  if (!row.instanceId) throw new PlatformError("COURSE_NOT_FOUND", "课堂不存在", 404);
  if (requestedStudentId && requestedStudentId !== row.id) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "无权访问其他学生", 403);
  if (!row.participationId) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "未加入该课堂", 403);
  if (write && (row.instanceStatus?.toUpperCase() !== "TEACHING" || row.offeringStatus?.toUpperCase() !== "OPEN"
    || row.archivedAt || row.enrollmentStatus?.toUpperCase() !== "ACTIVE")) throw new PlatformError("COURSE_LOCKED", "课堂当前不可写入", 409);
  return { studentId: row.id, participationId: row.participationId };
}

export async function authenticateLegacyAiStudent(request: Request, instanceId: string, requestedStudentId: string) {
  const write = !["GET", "HEAD"].includes(request.method);
  if (write) { const csrf = requireSameOrigin(request); if (csrf) return csrf; }
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "student") return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    return { claims: auth.claims, ...await studentParticipation(auth.claims, instanceId, requestedStudentId, write) };
  } catch (error) { return legacyAiError(error); }
}
