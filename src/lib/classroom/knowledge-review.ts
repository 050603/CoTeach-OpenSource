import type { Scene } from "@openmaic/lib/types/stage";
import type { PlaybackSyncState } from "@openmaic/components/stage-experience";
import { aggregateKnowledgePointMastery, type KnowledgePointMasteryRow } from "@/lib/knowledge-lecture";
import { aggregateCommonIssues, isLearningSignalRelevant } from "@/lib/learning-analytics/analyzer";
import type { ClassCommonIssue, Course, OpenMaicSceneOutlineSnapshot, TeacherResourceProjection } from "@/lib/session/types";

export function teachingOutlines(course: Course): OpenMaicSceneOutlineSnapshot[] {
  return (course.content._openmaicSceneOutlines ?? [])
    .filter((outline) => outline.stageKey === "ai-learning" && outline.audience !== "teacher" && outline.type !== "quiz")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function strategyFor(code?: string): string {
  if (code === "concept") return "重新界定概念，用正反例对比后安排一道快速检查题。";
  if (code === "interpretation") return "标出题目条件和关键词，示范如何把题意转换为判断依据。";
  if (code === "calculation") return "定位共同出错步骤，示范校验方法后让学生独立复核。";
  if (code === "evidence") return "先给出结论，再补充能够支撑结论的证据或理由。";
  if (code === "method") return "拆解关键步骤，完整示范一题后安排同结构迁移练习。";
  if (code === "unanswered") return "先确认题意与作答要求，再用口头提问帮助学生启动作答。";
  return "澄清核心判断依据，用原页面例子重新验证后进行快速检查。";
}

export function knowledgeReviewCommonIssues(course: Course): ClassCommonIssue[] {
  const signals = course.students.flatMap((student) => {
    const events = (course.learningEvents ?? []).filter((event) => event.studentId === student.id && event.stageKey === "ai-learning");
    return (course.learningSignals ?? []).filter((signal) => signal.studentId === student.id
      && signal.stageKey === "ai-learning" && signal.status === "open"
      && isLearningSignalRelevant(signal, events, ["completed", "mastered"].includes(course.aiLearningProgress?.[student.id]?.masteryLevel ?? "")));
  });
  return aggregateCommonIssues(signals, course.students.length);
}

export function knowledgeReviewDetail(course: Course, row: KnowledgePointMasteryRow, issues: ClassCommonIssue[]) {
  const pages = teachingOutlines(course).flatMap((outline, index) => outline.knowledgePointIds?.includes(row.knowledgePointId)
    ? [{ outline, pageNumber: index + 1 }] : []);
  const point = course.content.knowledgePoints.find((item) => item.id === row.knowledgePointId);
  const first = pages[0]?.outline;
  return {
    ...row, id: row.knowledgePointId, pages,
    explanation: point?.description || first?.teachingObjective || first?.description || first?.keyPoints?.join("、")
      || `重新梳理“${row.name}”的判断依据与应用步骤。`,
    teachingStrategy: strategyFor(row.misconceptionGroups[0]?.code),
    issues: issues.filter((issue) => issue.content?.knowledgePointIds?.includes(row.knowledgePointId)),
  };
}

export function knowledgeRecommendations(course: Course, issues: ClassCommonIssue[]) {
  return aggregateKnowledgePointMastery(course).filter((row) => row.status === "confirmed")
    .map((row) => knowledgeReviewDetail(course, row, issues));
}

/** Keep confirmed priorities first, and all remaining points in teaching order. */
export function initialKnowledgeReviewOrder(course: Course): string[] {
  const confirmed = aggregateKnowledgePointMastery(course).filter((row) => row.status === "confirmed").map((row) => row.knowledgePointId);
  return [...confirmed, ...course.content.knowledgePoints.map((point) => point.id).filter((id) => !confirmed.includes(id))];
}

export function masteryStatusLabel(row: KnowledgePointMasteryRow): string {
  if (!row.answeredStudents) return "暂无有效作答";
  if (row.status === "confirmed") return "建议补讲";
  if (row.status === "observing" || row.status === "collecting") return "样本不足";
  return "暂未发现共性问题";
}

/** Legacy title matching is safe only when it identifies exactly one page. */
export function findTeachingScene(scenes: Scene[], outline: OpenMaicSceneOutlineSnapshot): Scene | undefined {
  const exact = scenes.find((scene) => scene.outlineId === outline.id);
  if (exact) return exact;
  const legacy = scenes.filter((scene) => !scene.outlineId && scene.title === outline.title);
  return legacy.length === 1 ? legacy[0] : undefined;
}

export function knowledgeProjection(classroomId: string, scene: Scene, mode: "forced" | "optional", previous?: TeacherResourceProjection | null): TeacherResourceProjection {
  const now = new Date().toISOString();
  return { classroomId, sceneId: scene.id, stageKey: "ai-learning", title: `全班补讲 · ${scene.title}`, sceneType: scene.type,
    startedAt: now, mode, version: (previous?.version ?? 0) + 1, updatedAt: now, engineMode: "idle",
    playback: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: scene.id }, interactionState: null };
}

export function knowledgeProjectionPlayback(projection: TeacherResourceProjection, state: Omit<PlaybackSyncState, "version">): TeacherResourceProjection {
  return { ...projection, version: (projection.version ?? 0) + 1, updatedAt: new Date().toISOString(), engineMode: state.engineMode, playback: state.snapshot };
}
