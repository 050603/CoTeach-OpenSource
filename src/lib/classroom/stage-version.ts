import type { Course } from "@/lib/session/types";

const equal = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

/** Student writes never advance the teacher's stage/timing consistency token. */
export function nextClassroomStageVersion(before: Course, after: Course): number {
  const changed = before.status !== after.status || before.currentStageIndex !== after.currentStageIndex
    || !equal(before.stageTransitions ?? [], after.stageTransitions ?? [])
    || !equal(before.uiState?.classroomTiming, after.uiState?.classroomTiming);
  return (before.stageVersion ?? 1) + (changed ? 1 : 0);
}
