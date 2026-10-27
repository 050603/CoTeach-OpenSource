import type { LearningContentReference } from "@/lib/session/types";
import { isOpaqueInternalId } from "@/lib/user-facing-labels";

export function formatLearningContentReference(
  content?: LearningContentReference,
  fallback?: string,
): string {
  if (!content) return fallback ?? "未定位到具体内容";
  const scenePrefix = content.sceneIndex ? `第 ${content.sceneIndex} 页` : undefined;
  const sceneTitle = content.sceneTitle?.trim();
  const readableSceneTitle = sceneTitle && !isOpaqueInternalId(sceneTitle) ? sceneTitle : undefined;
  const scene = readableSceneTitle
    ? [scenePrefix, `《${readableSceneTitle}》`].filter(Boolean).join(" ")
    : scenePrefix
      ?? (content.sceneType === "quiz" ? "当前测验" : undefined);
  const activityTitle = content.activityTitle?.trim();
  const stageLabel = content.stageLabel?.trim();
  const primaryLocation = scene
    ?? (activityTitle && !isOpaqueInternalId(activityTitle) ? activityTitle : undefined)
    ?? (stageLabel && !isOpaqueInternalId(stageLabel) ? stageLabel : undefined);
  const knowledgePoints = (content.knowledgePointLabels ?? []).filter((label) =>
    label.trim() && !isOpaqueInternalId(label),
  );
  const knowledge = knowledgePoints.length
    ? `${knowledgePoints[0]}${knowledgePoints.length > 1 ? `等 ${knowledgePoints.length} 个知识点` : ""}`
    : undefined;
  return [primaryLocation, knowledge].filter(Boolean).join(" · ") || fallback || "当前学习内容";
}
