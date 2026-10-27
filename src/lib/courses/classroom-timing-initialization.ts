import type { ClassroomTimingInitializationIntent, SessionAction } from "@/lib/session/actions";
import type { Course } from "@/lib/session/types";
import { createClassroomTimingState, resolveCourseTimingMinutes } from "@/lib/classroom/timing";
import { isDeepStrictEqual } from "node:util";

type UiAction = Extract<SessionAction, { type: "SET_UI_STATE" }>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A persisted initialization alone can explain this exact one-step token advance. */
function isSameInitialization(before: Course, action: UiAction, proof: unknown): boolean {
  const receipt = record(proof);
  const ack = record(receipt?.ack);
  const intent = classroomTimingInitializationIntent(action);
  if (!receipt || !ack || !intent || !before.uiState?.classroomTiming
    || (before.stageVersion ?? 1) !== intent.baseStageVersion + 1
    || receipt.scope !== "course" || record(receipt.timingInitialization)?.outcome !== "initialized"
    || !isDeepStrictEqual(receipt.requestedAction, action)
    || ack.stageVersion !== before.stageVersion || !Number.isSafeInteger(ack.courseVersion)
    || (ack.courseVersion as number) < 1 || (ack.courseVersion as number) > (before.version ?? 1)
    || typeof ack.requestId !== "string" || !ack.requestId) return false;
  return isDeepStrictEqual(receipt.action, { type: "SET_UI_STATE", payload: { courseId: before.id,
    patch: { classroomTiming: before.uiState.classroomTiming } } });
}

export class ClassroomTimingInitializationError extends Error {
  constructor(readonly code: "INVALID_TIMING_INITIALIZATION" | "CLASSROOM_STAGE_CONFLICT", message: string, readonly status: number) {
    super(message);
  }
}

/** Only this explicit, empty-patch command can bypass the aggregate teacher CAS. */
export function classroomTimingInitializationIntent(action: SessionAction): ClassroomTimingInitializationIntent | undefined {
  if (action.type !== "SET_UI_STATE" || action.payload.intent === undefined) return;
  const intent = action.payload.intent;
  if (!intent || typeof intent !== "object" || intent.type !== "initialize-classroom-timing"
    || Object.keys(intent).some(key => !["type", "baseStageVersion", "stageKey"].includes(key))
    || !Number.isSafeInteger(intent.baseStageVersion) || intent.baseStageVersion < 1
    || typeof intent.stageKey !== "string" || !intent.stageKey || intent.stageKey.length > 64
    || !action.payload.patch || typeof action.payload.patch !== "object" || Array.isArray(action.payload.patch)
    || Object.keys(action.payload.patch).length > 0 || action.payload.projectionControl !== undefined
    || Object.keys(action.payload).some(key => !["courseId", "patch", "intent"].includes(key))) {
    throw new ClassroomTimingInitializationError("INVALID_TIMING_INITIALIZATION", "计时初始化不能携带修改内容或投屏控制", 400);
  }
  return intent;
}

/** The caller holds the course lock. An existing clock is also stage guarded. */
export function resolveClassroomTimingInitialization(
  before: Course, action: UiAction, now: string, initializationProof?: unknown,
): UiAction | undefined {
  const intent = classroomTimingInitializationIntent(action);
  const stageVersion = before.stageVersion ?? 1;
  if (!intent || action.payload.courseId !== before.id || before.status !== "teaching"
    || !Number.isSafeInteger(stageVersion) || stageVersion < 1
    || (stageVersion !== intent.baseStageVersion && !isSameInitialization(before, action, initializationProof))
    || before.stages[before.currentStageIndex]?.key !== intent.stageKey) {
    throw new ClassroomTimingInitializationError("CLASSROOM_STAGE_CONFLICT", "课堂阶段已变化，请查看当前课堂后重试计时初始化", 409);
  }
  if (before.uiState?.classroomTiming) return;
  return { type: "SET_UI_STATE", payload: { courseId: before.id, patch: { classroomTiming: createClassroomTimingState({
    stages: before.stages,
    totalMinutes: resolveCourseTimingMinutes(before),
    projectMainline: before.content.projectMainline,
    moduleTimingPlan: before.content.moduleTimingPlan,
    stagePlan: before.content.stagePlan,
    activeStageKey: intent.stageKey,
    now,
  }) } } };
}
