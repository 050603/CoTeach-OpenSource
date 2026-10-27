export type CompanionTaskTransitionStatus =
  | "generating"
  | "ready"
  | "completed"
  | "failed";

export function claimCompanionTaskTransition(
  claimed: Set<string>,
  input: {
    taskId: string;
    lessonId: string;
    status: CompanionTaskTransitionStatus;
  },
): boolean {
  const key = `${input.taskId}:${input.lessonId}:${input.status}`;
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}
