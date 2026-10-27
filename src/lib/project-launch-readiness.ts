import type { Course, CourseTodo, ProjectGroup, Stage } from "@/lib/session/types";
import { resourcesForStage } from "@/lib/classroom/stage-resources";

export type LaunchTodoKind = "resources" | "personal-space" | "topic" | "other";

const PROJECT_LAUNCH_KEYS = new Set([
  "launch",
  "project-launch",
  "project-start",
  "start",
  "introduction",
]);

export function isProjectLaunchStage(
  stage: Pick<Stage, "key" | "view"> | undefined,
): boolean {
  return Boolean(
    stage &&
      (stage.view === "project-launch" || PROJECT_LAUNCH_KEYS.has(stage.key)),
  );
}

export function isProjectLaunchTodo(todo: Pick<CourseTodo, "stageKey">): boolean {
  return !todo.stageKey || PROJECT_LAUNCH_KEYS.has(todo.stageKey);
}

export function projectLaunchProgress(
  todos: readonly CourseTodo[],
  studentId: string,
): number {
  const launchTodos = todos.filter(isProjectLaunchTodo);
  if (launchTodos.length === 0) return 100;
  const completed = launchTodos.filter((todo) =>
    todo.completedBy.includes(studentId),
  ).length;
  return Math.round((completed / launchTodos.length) * 100);
}

export function getLaunchTodoKind(todo: CourseTodo): LaunchTodoKind {
  const text = `${todo.id} ${todo.title}`.toLowerCase();
  if (text.includes("read-brief") || text.includes("阅读项目说明")) return "resources";
  if (text.includes("join-group") || text.includes("个人项目空间")) return "personal-space";
  if (
    text.includes("pick-direction") ||
    text.includes("兴趣方向") ||
    text.includes("研究方向") ||
    text.includes("研究主题")
  ) {
    return "topic";
  }
  return "other";
}

export function hasSelectedProjectTopic(
  project?: ProjectGroup,
  inquiryQuestions?: string[],
): boolean {
  const topic = project?.topic.trim();
  if (!topic || /^待(确定|选择).*(选题|方向|主题)$/.test(topic)) return false;
  return inquiryQuestions ? inquiryQuestions.includes(topic) : true;
}

export function buildCourseTopicOptions(course: Course): Array<{
  value: string;
  description?: string;
}> {
  const value = (course.drivingQuestion || course.pblConfig?.inquiryQuestions?.[0] || "").trim();
  return value ? [{
    value,
    description: "本课程唯一的项目核心驱动问题",
  }] : [];
}

export function haveAllResourcesBeenViewed(course: Course, studentId?: string): boolean {
  const resources = resourcesForStage(course.resources, "launch");
  if (resources.length === 0) return true;
  if (!studentId) return false;
  return resources.every((resource) => resource.downloadedBy.includes(studentId));
}
