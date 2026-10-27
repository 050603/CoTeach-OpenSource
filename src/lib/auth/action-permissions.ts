// Action permission matrix — defines which SessionAction types each role can dispatch.
// Used by API routes to reject unauthorized actions before processing.

import type { SessionAction } from "@/lib/session/actions";

type ActionType = SessionAction["type"];

const TEACHER_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "CREATE_COURSE",
  "UPDATE_COURSE",
  "DELETE_COURSE",
  "SET_COURSE_CONTENT",
  "SET_COURSE_STAGES",
  "PUBLISH_COURSE",
  "START_TEACHING",
  "RESTART_TEACHING",
  "END_TEACHING",
  "ADVANCE_STAGE",
  "SET_STAGE",
  "ADD_FEEDBACK",
  "UPSERT_RUBRIC_SCORE",
  "SET_PRESENTING_GROUP",
  "UPSERT_ANNOUNCEMENT",
  "DELETE_ANNOUNCEMENT",
  "ADD_ANNOUNCEMENT_REPLY",
  "UPSERT_TODO",
  "UPSERT_GROUP",
  "SET_GROUP_TOPIC",
  "UPSERT_GROUP_ANNOUNCEMENT",
  "DELETE_WORK_PLAN_ITEM",
  "UPSERT_TEAM_CONTRIBUTION",
  "ADD_OFFLINE_INTERVENTION",
  "RESOLVE_INTERVENTION_SIGNALS",
  "UPSERT_TEACHER_AGENT_DIRECTIVE",
  "RESOLVE_COMPANION_CONFIRMATION",
  "SET_UI_STATE",
  "ADD_ACTIVITY",
  "UPSERT_AI_SUPPORT",
  "REVIEW_LEARNING_EVIDENCE",
  "UPSERT_AI_ASSESSMENT_SUGGESTION",
  "UPSERT_WHITEBOARD_NODE",
  "DELETE_WHITEBOARD_NODE",
  "UPSERT_GROUP_BOARD",
]);

const STUDENT_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "JOIN_CLASS",
  "LEAVE_CLASS",
  "HEARTBEAT",
  "UPDATE_STUDENT_PROGRESS",
  "UPSERT_SUBMISSION",
  "UPSERT_REFLECTION",
  "ADD_ANNOUNCEMENT_REPLY",
  "UPSERT_WHITEBOARD_NODE",
  "DELETE_WHITEBOARD_NODE",
  "UPSERT_GROUP_BOARD",
  "MARK_RESOURCE_DOWNLOADED",
  "JOIN_GROUP",
  "LEAVE_GROUP",
  "UPSERT_WORK_PLAN_ITEM",
  "DELETE_WORK_PLAN_ITEM",
  "SET_GROUP_TOPIC",
  "UPSERT_GROUP_ANNOUNCEMENT",
  "SET_STUDENT_TODO_COMPLETION",
  "UPSERT_UPLOAD",
  "SET_PREVIEW_UPLOAD",
  "UPSERT_AI_SUPPORT",
  "UPSERT_COMPANION_TASK",
  "ADD_COMPANION_PROCESS_RECORD",
  "REQUEST_TEACHER_HELP",
  "UPSERT_COMPANION_CONFIRMATION",
  "RESOLVE_COMPANION_CONFIRMATION",
  "UPSERT_LEARNING_EVIDENCE",
  "UPSERT_ARTIFACT_SNAPSHOT",
  "UPSERT_AI_CONTRIBUTION",
  "RECORD_STUDENT_AI_DECISION",
]);

const SYSTEM_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "HYDRATE",
  "MARK_STUDENTS_OFFLINE",
  "SET_USER",
]);

export type AuthRole = "teacher" | "student" | "system";

export function isActionAllowed(role: AuthRole, actionType: ActionType): boolean {
  if (SYSTEM_ACTIONS.has(actionType)) return role === "system";
  if (role === "teacher") return TEACHER_ACTIONS.has(actionType);
  if (role === "student") return STUDENT_ACTIONS.has(actionType);
  return false;
}

/**
 * For student actions that target a specific student (e.g., UPSERT_SUBMISSION),
 * verify the action's studentId matches the JWT's studentId.
 */
export function isStudentActionForSelf(
  action: SessionAction,
  studentId: string,
  courseId?: string,
): boolean {
  const actionRecord = action as unknown as Record<string, unknown>;
  const payload =
    typeof actionRecord.payload === "object" && actionRecord.payload !== null
      ? (actionRecord.payload as Record<string, unknown>)
      : {};

  if (typeof payload.studentId === "string" && payload.studentId !== studentId) {
    return false;
  }

  const nestedStudentIds = [
    "student",
    "submission",
    "reflection",
    "upload",
    "contribution",
    "support",
    "task",
    "record",
    "confirmation",
    "signal",
    "evidence",
    "snapshot",
    "contribution",
    "decision",
    "reply",
  ]
    .map((key) => payload[key])
    .filter((value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null,
    )
    .map((value) => value.studentId)
    .filter((value): value is string => typeof value === "string");
  if (nestedStudentIds.some((id) => id !== studentId)) return false;

  if (action.type === "JOIN_CLASS") {
    const student = payload.student as Record<string, unknown> | undefined;
    if (student?.id !== studentId) return false;
  }

  if (
    action.type === "RESOLVE_COMPANION_CONFIRMATION" &&
    payload.studentId !== studentId
  ) {
    return false;
  }

  if (
    action.type === "SET_STUDENT_TODO_COMPLETION" &&
    payload.studentId !== studentId
  ) {
    return false;
  }

  if (action.type === "SET_GROUP_TOPIC" && payload.studentId !== studentId) {
    return false;
  }

  if (
    (action.type === "UPSERT_GROUP_ANNOUNCEMENT" ||
      action.type === "UPSERT_WORK_PLAN_ITEM" ||
      action.type === "DELETE_WORK_PLAN_ITEM" ||
      action.type === "SET_PREVIEW_UPLOAD") &&
    payload.studentId !== studentId
  ) {
    return false;
  }

  if (action.type === "ADD_ANNOUNCEMENT_REPLY") {
    const reply = payload.reply as Record<string, unknown> | undefined;
    if (reply?.studentId !== studentId) return false;
  }

  if (action.type === "UPSERT_COMPANION_CONFIRMATION") {
    const confirmation = payload.confirmation as Record<string, unknown> | undefined;
    if (confirmation?.studentId !== studentId) return false;
  }

  if (courseId) {
    const targetedCourseId =
      typeof payload.courseId === "string"
        ? payload.courseId
        : typeof payload.id === "string"
          ? payload.id
          : undefined;
    if (targetedCourseId && targetedCourseId !== courseId) return false;
  }

  return true;
}
