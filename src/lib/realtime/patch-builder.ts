// Patch builder: derives RealtimeEvent(s) from a SessionAction.
//
// We intentionally avoid a full JSON-Patch diff of the SessionState (which
// would require deep equality over large nested objects on every dispatch).
// Instead we infer the affected event type from the action.type, plus the
// courseId extracted from the action payload. This is enough for the
// WebSocket server to broadcast a "you should refetch" signal to the room,
// and clients re-pull only the affected course state after cursor catch-up.
// endpoint. A future optimisation can swap this for true incremental patches
// without changing the public RealtimePatch shape.

import type { SessionAction, SessionState } from "@/lib/session/actions";
import type { RealtimeEvent, RealtimeEventType } from "./event-bus";

export interface RealtimePatch {
  courseId: string;
  events: RealtimeEvent[];
  updatedAt: string;
}

/**
 * Maps a SessionAction type to a realtime event type. Returns undefined for
 * actions that should not trigger a realtime broadcast (e.g. HYDRATE which
 * is client-only, or SET_USER which is session-scoped rather than course-
 * scoped).
 */
function actionToEventType(
  actionType: SessionAction["type"],
): RealtimeEventType | undefined {
  switch (actionType) {
    case "CREATE_COURSE":
    case "UPDATE_COURSE":
    case "SET_COURSE_CONTENT":
    case "SET_COURSE_STAGES":
    case "PUBLISH_COURSE":
    case "START_TEACHING":
    case "END_TEACHING":
    case "RESTART_TEACHING":
    case "UPDATE_STUDENT_PROGRESS":
    case "UPSERT_TODO":
    case "SET_STUDENT_TODO_COMPLETION":
    case "UPSERT_ANNOUNCEMENT":
    case "DELETE_ANNOUNCEMENT":
    case "ADD_ANNOUNCEMENT_REPLY":
    case "MARK_RESOURCE_DOWNLOADED":
    case "UPSERT_GROUP":
    case "JOIN_GROUP":
    case "LEAVE_GROUP":
    case "SET_GROUP_TOPIC":
    case "UPSERT_GROUP_ANNOUNCEMENT":
    case "UPSERT_WORK_PLAN_ITEM":
    case "DELETE_WORK_PLAN_ITEM":
    case "UPSERT_WHITEBOARD_NODE":
    case "DELETE_WHITEBOARD_NODE":
    case "UPSERT_GROUP_BOARD":
    case "UPSERT_UPLOAD":
    case "DELETE_UPLOAD":
    case "SET_PREVIEW_UPLOAD":
    case "UPSERT_TEAM_CONTRIBUTION":
    case "UPSERT_AI_SUPPORT":
    case "ADD_OFFLINE_INTERVENTION":
    case "RESOLVE_INTERVENTION_SIGNALS":
    case "UPSERT_TEACHER_AGENT_DIRECTIVE":
    case "UPSERT_COMPANION_TASK":
    case "UPSERT_COMPANION_CONFIRMATION":
    case "RESOLVE_COMPANION_CONFIRMATION":
    case "ADD_COMPANION_PROCESS_RECORD":
    case "REQUEST_TEACHER_HELP":
    case "UPSERT_LEARNING_EVIDENCE":
    case "REVIEW_LEARNING_EVIDENCE":
    case "UPSERT_ARTIFACT_SNAPSHOT":
    case "UPSERT_AI_CONTRIBUTION":
    case "RECORD_STUDENT_AI_DECISION":
    case "UPSERT_AI_ASSESSMENT_SUGGESTION":
    case "SET_UI_STATE":
    case "ADD_ACTIVITY":
    case "SET_PRESENTING_GROUP":
      return "course-updated";
    case "ADVANCE_STAGE":
    case "SET_STAGE":
      return "stage-changed";
    case "JOIN_CLASS":
      return "student-joined";
    case "LEAVE_CLASS":
      return "student-left";
    case "HEARTBEAT":
    case "MARK_STUDENTS_OFFLINE":
      return "presence-update";
    case "UPSERT_SUBMISSION":
      return "submission-updated";
    case "ADD_FEEDBACK":
    case "UPSERT_RUBRIC_SCORE":
    case "UPSERT_REFLECTION":
      return "feedback-added";
    case "HYDRATE":
    case "SET_USER":
    case "DELETE_COURSE":
      // HYDRATE/SET_USER are client-only; DELETE_COURSE means there is no
      // room left to broadcast to.
      return undefined;
    default: {
      // Exhaustiveness check — if a new action is added without a mapping,
      // fall back to a generic course-updated event.
      const _exhaustive: never = actionType;
      void _exhaustive;
      return "course-updated";
    }
  }
}

function courseIdFromAction(action: SessionAction): string | undefined {
  switch (action.type) {
    case "CREATE_COURSE":
      return action.payload.id;
    case "UPDATE_COURSE":
    case "DELETE_COURSE":
    case "SET_COURSE_CONTENT":
    case "SET_COURSE_STAGES":
    case "PUBLISH_COURSE":
    case "START_TEACHING":
    case "END_TEACHING":
    case "RESTART_TEACHING":
    case "ADVANCE_STAGE":
    case "SET_STAGE":
      return action.payload.id;
    case "JOIN_CLASS":
    case "LEAVE_CLASS":
    case "HEARTBEAT":
    case "MARK_STUDENTS_OFFLINE":
    case "UPDATE_STUDENT_PROGRESS":
    case "UPSERT_SUBMISSION":
    case "ADD_FEEDBACK":
    case "UPSERT_RUBRIC_SCORE":
    case "UPSERT_REFLECTION":
    case "ADD_ACTIVITY":
    case "SET_PRESENTING_GROUP":
    case "UPSERT_ANNOUNCEMENT":
    case "DELETE_ANNOUNCEMENT":
    case "ADD_ANNOUNCEMENT_REPLY":
    case "UPSERT_TODO":
    case "SET_STUDENT_TODO_COMPLETION":
    case "MARK_RESOURCE_DOWNLOADED":
    case "UPSERT_GROUP":
    case "JOIN_GROUP":
    case "LEAVE_GROUP":
    case "SET_GROUP_TOPIC":
    case "UPSERT_GROUP_ANNOUNCEMENT":
    case "UPSERT_WORK_PLAN_ITEM":
    case "DELETE_WORK_PLAN_ITEM":
    case "UPSERT_WHITEBOARD_NODE":
    case "DELETE_WHITEBOARD_NODE":
    case "UPSERT_GROUP_BOARD":
    case "UPSERT_UPLOAD":
    case "DELETE_UPLOAD":
    case "SET_PREVIEW_UPLOAD":
    case "UPSERT_TEAM_CONTRIBUTION":
    case "UPSERT_AI_SUPPORT":
    case "ADD_OFFLINE_INTERVENTION":
    case "RESOLVE_INTERVENTION_SIGNALS":
    case "UPSERT_TEACHER_AGENT_DIRECTIVE":
    case "UPSERT_COMPANION_TASK":
    case "UPSERT_COMPANION_CONFIRMATION":
    case "RESOLVE_COMPANION_CONFIRMATION":
    case "ADD_COMPANION_PROCESS_RECORD":
    case "REQUEST_TEACHER_HELP":
    case "UPSERT_LEARNING_EVIDENCE":
    case "REVIEW_LEARNING_EVIDENCE":
    case "UPSERT_ARTIFACT_SNAPSHOT":
    case "UPSERT_AI_CONTRIBUTION":
    case "RECORD_STUDENT_AI_DECISION":
    case "UPSERT_AI_ASSESSMENT_SUGGESTION":
    case "SET_UI_STATE":
      return action.payload.courseId;
    case "HYDRATE":
    case "SET_USER":
      return undefined;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return undefined;
    }
  }
}

/**
 * Build a RealtimePatch describing what changed between `before` and `after`,
 * given the action that produced `after`. The `before` argument is accepted
 * for API completeness and forward compatibility with true diffing, but the
 * simplified implementation derives the event solely from `action`.
 */
export function buildPatch(
  _before: SessionState,
  after: SessionState,
  action: SessionAction,
): RealtimePatch {
  const courseId = courseIdFromAction(action);
  const eventType = actionToEventType(action.type);
  const updatedAt = after.updatedAt ?? new Date().toISOString();

  if (!courseId || !eventType) {
    return { courseId: "", events: [], updatedAt };
  }

  const event: RealtimeEvent = {
    type: eventType,
    courseId,
    at: updatedAt,
    payload: { actionType: action.type },
  };

  return {
    courseId,
    events: [event],
    updatedAt,
  };
}
