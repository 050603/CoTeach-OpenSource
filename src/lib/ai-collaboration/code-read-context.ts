import type { Prisma } from "@prisma/client";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { readClassroomDesign } from "@/lib/db/classroom-design-cache";
import { loadPblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import { getCourse } from "@/lib/session/server-store";
import { getStagesForSystemMode } from "@/lib/system-mode";
import type { Course } from "@/lib/session/types";

export type CodeReadContext = { student?: { id: string }; currentStageKey?: string };

function fromCourse(course: Course | null | undefined, studentId: string): CodeReadContext | undefined {
  if (!course) return undefined;
  const student = course.students.find(item => item.id === studentId);
  return { student: student ? { id: student.id } : undefined,
    currentStageKey: course.stages[course.currentStageIndex]?.key };
}

/** Only the GET history/receipt guard needs these fields. Authentication and
 * fresh session/enrolment authorization remain mandatory in the route. This
 * is never a prompt, mutation snapshot, authorization cache or history cache.
 */
export async function loadCodeReadContext(courseId: string, studentId: string,
  db: Prisma.TransactionClient = prisma): Promise<CodeReadContext | undefined> {
  const [instance] = await db.$queryRaw<Array<{
    templateVersionId: string; templateStatus: string;
    currentStageIndex: Prisma.JsonValue; hasStudent: boolean;
  }>>`
    SELECT ci."templateVersionId", tv.status AS "templateStatus",
      ci."runtimeConfig"->'currentStageIndex' AS "currentStageIndex",
      EXISTS (SELECT 1 FROM "ClassroomParticipation" p
        JOIN "Enrollment" e ON e.id = p."enrollmentId"
        JOIN "User" u ON u.id = e."userId"
        WHERE p."instanceId" = ci.id AND e."userId" = ${studentId}) AS "hasStudent"
    FROM "ClassroomInstance" ci
    JOIN "ClassroomTemplateVersion" tv ON tv.id = ci."templateVersionId"
    WHERE ci.id = ${courseId}`;
  if (!instance) return undefined;
  // Use the same canonical design decoder/cache and default stages as the full
  // projection. An instance wins over a template with the same public ID.
  const design = await readClassroomDesign(db, { id: instance.templateVersionId, status: instance.templateStatus });
  const stages = design?.stages ?? getStagesForSystemMode();
  return { student: instance.hasStudent ? { id: studentId } : undefined,
    currentStageKey: stages[Number(instance.currentStageIndex ?? 0)]?.key };
}

export async function getCodeReadContext(courseId: string, studentId: string): Promise<CodeReadContext | undefined> {
  if (!isDatabaseConfigured()) return fromCourse(await getCourse(courseId, { studentId }), studentId);
  // Preserve getCourse's instance-first/template fallback, including collisions.
  return await loadCodeReadContext(courseId, studentId)
    ?? fromCourse(await loadPblTemplateCourse(courseId), studentId);
}
