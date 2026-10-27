import { describe, expect, it } from "vitest";
import {
  PREPARATION_FLOW_STEPS,
  resolvePreparationStepStates,
} from "@/lib/teacher/preparation-flow";

describe("preparation flow", () => {
  it("orders the journey from course positioning to adaptive learning", () => {
    expect(PREPARATION_FLOW_STEPS.map((step) => step.key)).toEqual([
      "base",
      "knowledgePoints",
      "projectDesign",
      "evaluationPlan",
      "teachingOutline",
      "lessonOutline",
      "adaptiveLearning",
    ]);
    expect(PREPARATION_FLOW_STEPS.map((step) => step.phase)).toEqual([
      "定位",
      "定标",
      "立项",
      "评价",
      "架构",
      "深化",
      "适配",
    ]);
  });

  it("keeps future steps inspectable while distinguishing current and completed work", () => {
    const states = resolvePreparationStepStates({
      completedKeys: ["base", "knowledgePoints"],
      currentKey: "projectDesign",
    });

    expect(states).toEqual([
      "complete",
      "complete",
      "current",
      "available",
      "available",
      "available",
      "available",
    ]);
  });

  it("does not mark a later completed step as unavailable", () => {
    const states = resolvePreparationStepStates({
      completedKeys: ["base", "lessonOutline"],
      currentKey: "knowledgePoints",
    });

    expect(states[5]).toBe("complete");
  });
});
