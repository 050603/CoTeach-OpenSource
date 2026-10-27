type StudentEventScope = {
  actionType?: string;
  targetStudentId?: string;
  actorId?: string;
  scope?: "course" | "student";
};

const STUDENT_SCOPED_ACTIONS = new Set([
  "UPDATE_STUDENT_PROGRESS",
]);

/**
 * High-frequency, student-specific mutations are useful to the teacher and
 * the affected student, but must not make every peer download course state.
 */
export function shouldDeliverMutationToStudent(
  event: StudentEventScope,
  studentId: string,
): boolean {
  if (event.scope === "student") {
    return (event.targetStudentId ?? event.actorId) === studentId;
  }
  if (!event.actionType || !STUDENT_SCOPED_ACTIONS.has(event.actionType)) {
    return true;
  }
  return (event.targetStudentId ?? event.actorId) === studentId;
}
