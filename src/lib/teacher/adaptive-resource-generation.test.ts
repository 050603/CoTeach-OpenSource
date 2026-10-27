import { describe, expect, it } from "vitest";
import type { AdaptiveBranchOutline } from "@/lib/session/types";
import {
  adaptiveBranchGenerationSignature,
  hasReusableAdaptiveResource,
  selectAdaptiveBranchesForGeneration,
} from "@/lib/teacher/adaptive-resource-generation";

function branch(
  id: string,
  patch: Partial<AdaptiveBranchOutline> = {},
): AdaptiveBranchOutline {
  return {
    id,
    kind: "prerequisite",
    title: id,
    objective: "巩固核心概念",
    keyPoints: ["核心概念"],
    anchorKnowledgePointIds: ["kp-1"],
    prerequisiteKnowledgePointIds: ["kp-1"],
    noveltyStatement: "只回顾主课没有完整讲授的必要先决知识。",
    mainCourseOverlapSceneIds: [],
    sceneType: "slide",
    targetDurationSec: 120,
    status: "teacher-confirmed",
    ...patch,
  };
}

describe("adaptive resource generation selection", () => {
  it("reuses a ready classroom instead of regenerating it", () => {
    const ready = branch("ready", {
      preparedResource: {
        status: "ready",
        classroomId: "classroom-ready",
        scenesCount: 1,
      },
    });

    expect(hasReusableAdaptiveResource(ready)).toBe(true);
    expect(selectAdaptiveBranchesForGeneration([ready])).toEqual([]);
  });

  it("selects confirmed branches whose resources are missing or failed", () => {
    const missing = branch("missing");
    const failed = branch("failed", {
      preparedResource: { status: "failed", error: "provider error" },
    });
    const invalidated = branch("invalidated", {
      preparedResource: undefined,
    });

    expect(
      selectAdaptiveBranchesForGeneration([missing, failed, invalidated]).map(
        (item) => item.id,
      ),
    ).toEqual(["missing", "failed", "invalidated"]);
  });

  it("never generates an unconfirmed branch", () => {
    const draft = branch("draft", { status: "draft" });

    expect(selectAdaptiveBranchesForGeneration([draft])).toEqual([]);
  });

  it("marks a changed branch signature without coupling it to placement-only edits", () => {
    const original = branch("signature");
    expect(adaptiveBranchGenerationSignature({
      ...original,
      trigger: { placement: "before-main-course", evidenceRule: "pretest-gap", minimumRemainingSec: 240 },
    })).toBe(adaptiveBranchGenerationSignature(original));
    expect(adaptiveBranchGenerationSignature({ ...original, objective: "新的教学目标" }))
      .not.toBe(adaptiveBranchGenerationSignature(original));
  });

  it("does not reuse a stale classroom but keeps it identifiable for preview", () => {
    const stale = branch("stale", {
      preparedResource: { status: "stale", classroomId: "classroom-old" },
    });
    expect(hasReusableAdaptiveResource(stale)).toBe(false);
    expect(selectAdaptiveBranchesForGeneration([stale])).toEqual([stale]);
  });
});
