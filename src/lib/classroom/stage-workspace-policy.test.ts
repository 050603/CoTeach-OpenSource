import { describe, expect, it } from "vitest";
import {
  getStageWorkspacePolicy,
  normalizeStageWorkspacePolicy,
  resolveStageWorkspaceMode,
  stageSupportsCompanionWorkspace,
  updateStageWorkspacePolicy,
} from "./stage-workspace-policy";

describe("stage workspace policy", () => {
  it("uses companion immersion only for proposal and making", () => {
    ["proposal", "make"].forEach((stageKey) => {
      expect(stageSupportsCompanionWorkspace(stageKey)).toBe(true);
      expect(getStageWorkspacePolicy(undefined, stageKey)).toEqual({
        access: "companions-only",
        defaultMode: "companions",
      });
    });
    ["launch", "ai-learning", "showcase", "reflection"].forEach((stageKey) => {
      expect(stageSupportsCompanionWorkspace(stageKey)).toBe(false);
      expect(getStageWorkspacePolicy(undefined, stageKey)).toEqual({
        access: "task-only",
        defaultMode: "task",
      });
    });
  });

  it("normalizes each teacher-controlled access mode", () => {
    expect(
      normalizeStageWorkspacePolicy({
        access: "task-only",
        defaultMode: "companions",
      }),
    ).toEqual({ access: "task-only", defaultMode: "task" });
    expect(
      normalizeStageWorkspacePolicy({
        access: "companions-only",
        defaultMode: "task",
      }),
    ).toEqual({ access: "companions-only", defaultMode: "companions" });
    expect(
      normalizeStageWorkspacePolicy({
        access: "student-choice",
        defaultMode: "task",
      }),
    ).toEqual({ access: "student-choice", defaultMode: "task" });
  });

  it("lets enforced teacher policy override the saved student preference", () => {
    expect(
      resolveStageWorkspaceMode(
        { access: "task-only", defaultMode: "task" },
        "companions",
      ),
    ).toBe("task");
    expect(
      resolveStageWorkspaceMode(
        { access: "companions-only", defaultMode: "companions" },
        "task",
      ),
    ).toBe("companions");
    expect(
      resolveStageWorkspaceMode(
        { access: "student-choice", defaultMode: "companions" },
        "task",
      ),
    ).toBe("task");
  });

  it("refuses companion policies for every fixed task stage", () => {
    const policies = updateStageWorkspacePolicy(undefined, "showcase", {
      access: "companions-only",
    });
    expect(policies.showcase).toEqual({
      access: "task-only",
      defaultMode: "task",
    });
  });

  it("does not let legacy teacher settings disable a companion stage", () => {
    const policies = updateStageWorkspacePolicy(undefined, "make", {
      access: "task-only",
    });
    expect(policies.make).toEqual({
      access: "companions-only",
      defaultMode: "companions",
    });
  });
});
