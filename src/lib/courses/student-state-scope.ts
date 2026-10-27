import type { Prisma } from '@prisma/client';

/** One fresh joined read for a student's classroom-instance permission.
 * null retains the established template/offering precedence and fallback.
 * Read access alone never grants a write: completed enrolments and finished
 * runs remain readable, while writes require an active teaching enrolment.
 */
export async function resolveStudentStateScope(db: Prisma.TransactionClient, courseId: string, studentId: string,
  options: { mode?: 'read' | 'write'; sessionVersion?: number } = {}) {
  const [row] = await db.$queryRaw<Array<{ accessible: boolean; offeringId: string; runtimeVersion: Prisma.JsonValue }>>`
    SELECT EXISTS (
      SELECT 1 FROM "ClassroomParticipation" p
      JOIN "Enrollment" e ON e.id = p."enrollmentId"
      JOIN "User" u ON u.id = e."userId"
      WHERE p."instanceId" = ci.id AND e."userId" = ${studentId}
        AND e."offeringId" = c."offeringId"
        AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed')
        AND lower(u.role) = 'student' AND lower(u.status) = 'active'
        AND (${options.sessionVersion === undefined} OR u."sessionVersion" = ${options.sessionVersion ?? -1})
        AND (${options.mode !== 'write'} OR (
          upper(ci.status) = 'TEACHING' AND upper(e.status) = 'ACTIVE' AND upper(o.status) = 'OPEN'
        ))
    ) AS accessible, c."offeringId" AS "offeringId", ci."runtimeConfig"->'version' AS "runtimeVersion"
    FROM "ClassroomInstance" ci JOIN "Activity" a ON a.id = ci."activityId"
    JOIN "Chapter" c ON c.id = a."chapterId"
    JOIN "CourseOffering" o ON o.id = c."offeringId"
    WHERE ci.id = ${courseId}
      AND NOT EXISTS (SELECT 1 FROM "ClassroomTemplate" t WHERE t.id = ${courseId})
      AND NOT EXISTS (SELECT 1 FROM "CourseOffering" o WHERE o.id = ${courseId})
  `;
  if (!row) return null;
  // Match resolveCourseEventScope's number-only fallback without coercing a
  // persisted string version. Permission and version come from this one read.
  return { accessible: row.accessible, offeringId: row.offeringId,
    version: typeof row.runtimeVersion === 'number' ? row.runtimeVersion : 1 };
}
