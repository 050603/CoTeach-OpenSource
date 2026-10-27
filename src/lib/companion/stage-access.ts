import { getStageWorkspacePolicy } from "@/lib/classroom/stage-workspace-policy";
import type { Course } from "@/lib/session/types";

export function isCompanionStageEnabled(
  course: Pick<Course, "stageWorkspacePolicies">,
  stageKey: string | null | undefined,
): boolean {
  if (!stageKey) return false;
  return getStageWorkspacePolicy(course.stageWorkspacePolicies, stageKey).access !== "task-only";
}
