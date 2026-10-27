import { isDeepStrictEqual } from "node:util";
import type { SessionAction } from "@/lib/session/actions";
import type { Course } from "@/lib/session/types";
import { evaluateStageGate } from "@/lib/classroom/stage-gates";
import { transitionClassroomStageTiming } from "@/lib/classroom/timing";

export class ClassroomStageTransitionError extends Error {
  readonly code = "CLASSROOM_STAGE_CONFLICT";
  readonly status = 409;
  constructor() { super("课堂阶段或切换记录已变化，请查看当前阶段后重试"); }
}

/** Rebase only the classroom UI's append-only stage command. Student progress
 * changes the aggregate version, but cannot change this command's source stage
 * or transition history. The caller holds the course lock throughout. Other
 * course patches retain the aggregate version check. */
export function rebaseClassroomStageTransition(
  before: Course, action: SessionAction, now = new Date().toISOString(),
): Extract<SessionAction, { type: "UPDATE_COURSE" }> | undefined {
  if (action.type !== "UPDATE_COURSE") return;
  const { patch } = action.payload;
  if (patch.currentStageIndex === undefined || !Array.isArray(patch.stageTransitions)) return;
  if (Object.keys(patch).some(key => !["currentStageIndex", "stageTransitions", "uiState"].includes(key))) return;
  // An unrelated UI edit must not silently disappear during rebasing.
  const transitionFields = new Set(["classroomTiming", "resourceProjection", "teacherResourceProjection", "projectionController", "projectionVersion", "projectionUpdatedAt"]);
  for (const [key, value] of Object.entries(patch.uiState ?? {})) {
    if (!transitionFields.has(key) && !isDeepStrictEqual(value, (before.uiState as Record<string, unknown> | undefined)?.[key])) return;
  }
  if (patch.uiState?.resourceProjection != null || patch.uiState?.teacherResourceProjection != null) return;
  const history = before.stageTransitions ?? [];
  const incoming = patch.stageTransitions;
  const transition = incoming.at(-1);
  // Older clients retain the original aggregate CAS. A fresh classroom token
  // is required before student-only version changes can be ignored.
  if (before.stageVersion === undefined || transition?.baseStageVersion === undefined) return;
  if (!Number.isSafeInteger(transition.baseStageVersion) || transition.baseStageVersion < 1
    || !incoming.every(row => row && typeof row === "object" && typeof row.id === "string" && row.id)) {
    throw new ClassroomStageTransitionError();
  }
  const index = patch.currentStageIndex;
  const previousIds = new Set(incoming.slice(0, -1).map(row => row.id));
  if (before.status !== "teaching" || action.payload.id !== before.id
    || !Number.isInteger(index) || index < 0 || index >= before.stages.length
    || index === before.currentStageIndex || incoming.length !== history.length + 1
    || transition.baseStageVersion !== before.stageVersion
    || previousIds.size !== history.length || history.some(row => !previousIds.has(row.id))
    || !transition || typeof transition.id !== "string" || !transition.id
    || history.some(row => row.id === transition.id)
    || transition.fromStageKey !== before.stages[before.currentStageIndex]?.key
    || transition.toStageKey !== before.stages[index]?.key
    || !Number.isFinite(Date.parse(transition.createdAt))) throw new ClassroomStageTransitionError();
  const gate = evaluateStageGate(before);
  const classroomTiming = before.uiState?.classroomTiming
    ? transitionClassroomStageTiming(before.uiState.classroomTiming, before.stages[index]!.key, now)
    : undefined;
  return { type: "UPDATE_COURSE", payload: { id: before.id, patch: {
    currentStageIndex: index,
    stageTransitions: [...history, { ...transition,
      gateStatus: index > before.currentStageIndex && !gate.canAdvance ? "overridden" : "passed",
      blockers: gate.blockers.map(item => item.message), warnings: gate.warnings.map(item => item.message),
    }],
    uiState: { ...before.uiState, teacherResourceProjection: null, resourceProjection: null, projectionController: null,
      ...(classroomTiming ? { classroomTiming } : {}) },
  } } };
}
