import { describe, expect, it } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { createClassroomTimingState, pauseClassroomTiming } from "@/lib/classroom/timing";
import type { Course } from "@/lib/session/types";
import type { SessionAction } from "@/lib/session/actions";
import { applySessionAction, initialSessionState } from "@/lib/session/actions";
import { rebaseClassroomStageTransition } from "./classroom-stage-transition";

const started = "2026-10-16T00:00:00.000Z";
const accepted = "2026-10-16T00:10:00.000Z";
function course() {
  const result = createPblTemplateCourse("course");
  result.status = "teaching"; result.version = 900; result.stageVersion = 4; result.currentStageIndex = 1;
  result.stageTransitions = [];
  result.uiState = { classroomTiming: createClassroomTimingState({ stages: result.stages, totalMinutes: 90,
    activeStageKey: result.stages[1]!.key, now: started }) };
  return result;
}
function command(before: Course, index = 2): Extract<SessionAction, { type: "UPDATE_COURSE" }> {
  return { type: "UPDATE_COURSE", payload: { id: before.id, patch: { currentStageIndex: index,
    stageTransitions: [...(before.stageTransitions ?? []), { id: "transition", baseStageVersion: before.stageVersion, fromStageKey: before.stages[before.currentStageIndex]!.key,
      toStageKey: before.stages[index]!.key, gateStatus: "passed", blockers: [], warnings: [], actor: "教师", createdAt: started }],
    uiState: { ...before.uiState, resourceProjection: null, teacherResourceProjection: null },
  } } };
}

describe("classroom stage intent under concurrent student writes", () => {
  it("uses fresh timing and state without carrying a stale course projection into the write", () => {
    const before = course(); const action = command(before);
    before.uiState!.classroomTiming = pauseClassroomTiming(before.uiState!.classroomTiming!, "2026-10-16T00:05:00.000Z");
    before.students.push({ id: "student", name: "学生", joinedAt: started, stageProgress: { [before.stages[1]!.key]: 100 } });
    const snapshot = structuredClone(before); const original = structuredClone(action);
    const result = rebaseClassroomStageTransition(before, action, accepted)!;
    expect(result.payload.patch).not.toHaveProperty("students");
    expect(result.payload.patch.uiState?.classroomTiming?.status).toBe("paused");
    expect(result.payload.patch.uiState?.classroomTiming?.activeStageKey).toBe(before.stages[2]!.key);
    expect(result.payload.patch.stageTransitions?.at(-1)?.createdAt).toBe(started);
    expect(before).toEqual(snapshot); expect(action).toEqual(original);
  });
  it.each(["stage", "history", "closed", "target", "id", "index"])("rejects a conflicting %s rather than rebasing another teacher's change", change => {
    const before = course(); const action = command(before);
    if (change === "stage") before.currentStageIndex = 0;
    if (change === "history") before.stageTransitions = [{ ...action.payload.patch.stageTransitions![0]!, id: "other" }];
    if (change === "closed") before.status = "finished";
    if (change === "target") action.payload.patch.stageTransitions![0]!.toStageKey = "another-stage";
    if (change === "id") action.payload.id = "other-course";
    if (change === "index") action.payload.patch.currentStageIndex = 50;
    expect(() => rebaseClassroomStageTransition(before, action, accepted)).toThrow("课堂阶段或切换记录已变化");
  });
  it("keeps ordinary or combined edits subject to their existing version guard", () => {
    const before = course(); const action = command(before); action.payload.patch.name = "课程编辑";
    expect(rebaseClassroomStageTransition(before, action)).toBeUndefined();
    expect(rebaseClassroomStageTransition(before, { type: "UPDATE_COURSE", payload: { id: before.id, patch: { currentStageIndex: 2 } } })).toBeUndefined();
  });
  it("does not discard an unrelated UI edit or accept a new projection as a stage command", () => {
    const before = course(); const action = command(before);
    action.payload.patch.uiState = { ...action.payload.patch.uiState, presentingGroupId: "different" } as Course["uiState"];
    expect(rebaseClassroomStageTransition(before, action)).toBeUndefined();
    action.payload.patch.uiState = { resourceProjection: { resourceId: "resource", stageKey: "make", title: "资料", startedAt: started } };
    expect(rebaseClassroomStageTransition(before, action)).toBeUndefined();
  });
  it("records current gate evidence rather than the stale dialog's gate result", () => {
    const before = course(); before.currentStageIndex = before.stages.findIndex(stage => stage.key === "make");
    before.students = [{ id: "student", name: "学生", joinedAt: started, stageProgress: {} }];
    const action = command(before, before.currentStageIndex + 1);
    const result = rebaseClassroomStageTransition(before, action, accepted)!;
    expect(result.payload.patch.stageTransitions?.at(-1)).toMatchObject({ gateStatus: "overridden", blockers: expect.arrayContaining([expect.stringContaining("尚未保存")]) });
  });
  it("rejects returning to the same source after another teacher's intervening transitions", () => {
    const before = course(); const action = command(before);
    before.stageTransitions = [{ ...action.payload.patch.stageTransitions![0]!, id: "away" },
      { ...action.payload.patch.stageTransitions![0]!, id: "back", fromStageKey: before.stages[2]!.key, toStageKey: before.stages[1]!.key }];
    expect(() => rebaseClassroomStageTransition(before, action, accepted)).toThrow("课堂阶段或切换记录已变化");
  });
  it.each(["SET_STAGE", "ADVANCE_STAGE"] as const)("rejects actual legacy %s away/back even with unchanged history", type => {
    const before = course(); const action = command(before);
    const state = { ...initialSessionState(), courses: [before] };
    const away = applySessionAction(state, type === "SET_STAGE" ? { type, payload: { id: before.id, index: 2 } }
      : { type, payload: { id: before.id, direction: 1 } });
    const back = applySessionAction(away, type === "SET_STAGE" ? { type, payload: { id: before.id, index: 1 } }
      : { type, payload: { id: before.id, direction: -1 } }).courses[0]!;
    expect(back.stageTransitions).toEqual(before.stageTransitions);
    expect(() => rebaseClassroomStageTransition(back, action, accepted)).toThrow("课堂阶段或切换记录已变化");
  });
  it("accepts the next confirmed transition before canonical history metadata has refreshed", () => {
    const before = course(); const action = command(before);
    const optimistic = applySessionAction({ ...initialSessionState(), courses: [before] }, action).courses[0]!;
    const next = command(optimistic, 3); next.payload.patch.stageTransitions!.at(-1)!.id = "next";
    const fresh = structuredClone(optimistic);
    fresh.stageTransitions![0] = { ...fresh.stageTransitions![0]!, createdAt: accepted, warnings: ["fresh server gate"] };
    const result = rebaseClassroomStageTransition(fresh, next, accepted)!;
    expect(result.payload.patch.stageTransitions?.[0]).toEqual(fresh.stageTransitions![0]);
    expect(result.payload.patch.currentStageIndex).toBe(3);
  });
  it("requires an explicit stage token to bypass the aggregate guard", () => {
    const before = course(); const action = command(before);
    delete action.payload.patch.stageTransitions![0]!.baseStageVersion;
    expect(rebaseClassroomStageTransition(before, action)).toBeUndefined();
  });
  it("returns a controlled conflict for malformed historical entries instead of a server error", () => {
    const before = course();
    before.stageTransitions = [{ ...command(before).payload.patch.stageTransitions![0]!, id: "previous" }];
    const action = command(before);
    action.payload.patch.stageTransitions![0] = null as unknown as NonNullable<Course["stageTransitions"]>[number];
    expect(() => rebaseClassroomStageTransition(before, action)).toThrow("课堂阶段或切换记录已变化");
  });
});
