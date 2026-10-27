import { describe, expect, it } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { applySessionAction, initialSessionState } from "@/lib/session/actions";
import { nextClassroomStageVersion } from "./stage-version";

describe("teacher stage consistency token", () => {
  it("does not advance for student progress, document state or aggregate version changes", () => {
    const before = { ...createPblTemplateCourse("course"), stageVersion: 4 };
    const after = { ...before, version: 999, students: [{ id: "student", name: "学生", joinedAt: "now", stageProgress: { make: 80 } }] };
    expect(nextClassroomStageVersion(before, after)).toBe(4);
  });
  it.each(["SET_STAGE", "ADVANCE_STAGE"] as const)("advances for an actual %s away and back, without relying on transition history", type => {
    const before = { ...createPblTemplateCourse("course"), stageVersion: 4, currentStageIndex: 1 };
    const initial = { ...initialSessionState(), courses: [before] };
    const away = applySessionAction(initial, type === "SET_STAGE" ? { type, payload: { id: before.id, index: 2 } }
      : { type, payload: { id: before.id, direction: 1 } });
    const back = applySessionAction(away, type === "SET_STAGE" ? { type, payload: { id: before.id, index: 1 } }
      : { type, payload: { id: before.id, direction: -1 } });
    expect(back.courses[0]!.currentStageIndex).toBe(1);
    expect(back.courses[0]!.stageVersion).toBe(6);
    expect(back.courses[0]!.stageTransitions).toEqual(before.stageTransitions ?? []);
  });
  it("treats authoritative snapshots and acknowledgement metadata as synchronization", () => {
    const before = { ...createPblTemplateCourse("course"), stageVersion: 4 };
    const state = { ...initialSessionState(), courses: [before] };
    const acknowledged = applySessionAction(state, { type: "UPDATE_COURSE", payload: { id: before.id, patch: { version: 200, stageVersion: 9 } } });
    expect(acknowledged.courses[0]!.stageVersion).toBe(9);
    expect(applySessionAction(state, { type: "HYDRATE", payload: { ...state, courses: [{ ...before, stageVersion: 12 }] } }).courses[0]!.stageVersion).toBe(12);
  });
  it("advances when teacher timing or recorded stage history changes", () => {
    const before = { ...createPblTemplateCourse("course"), stageVersion: 4 };
    expect(nextClassroomStageVersion(before, { ...before, stageTransitions: [{ id: "change", fromStageKey: "a", toStageKey: "b", gateStatus: "passed", actor: "教师", blockers: [], warnings: [], createdAt: "now" }] })).toBe(5);
    expect(nextClassroomStageVersion(before, { ...before, status: "finished" })).toBe(5);
  });
});
