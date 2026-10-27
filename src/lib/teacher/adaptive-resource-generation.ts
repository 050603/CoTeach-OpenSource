import type { AdaptiveBranchOutline } from "@/lib/session/types";

export function adaptiveBranchGenerationSignature(
  branch: AdaptiveBranchOutline,
): string {
  return JSON.stringify({
    kind: branch.kind,
    title: branch.title.trim(),
    objective: branch.objective.trim(),
    keyPoints: branch.keyPoints.map((item) => item.trim()),
    anchorKnowledgePointIds: branch.anchorKnowledgePointIds,
    prerequisiteKnowledgePointIds: branch.prerequisiteKnowledgePointIds,
    noveltyStatement: branch.noveltyStatement.trim(),
    sceneType: branch.sceneType,
    targetDurationSec: branch.targetDurationSec,
    generationGuidance: branch.generationGuidance?.trim() ?? "",
  });
}

export function hasReusableAdaptiveResource(
  branch: AdaptiveBranchOutline,
): boolean {
  return Boolean(
    branch.preparedResource?.status === "ready"
    && branch.preparedResource.classroomId?.trim(),
  );
}

export function selectAdaptiveBranchesForGeneration(
  branches: readonly AdaptiveBranchOutline[],
): AdaptiveBranchOutline[] {
  return branches.filter(
    (branch) =>
      branch.enabled !== false
      &&
      branch.status === "teacher-confirmed"
      && !hasReusableAdaptiveResource(branch),
  );
}
