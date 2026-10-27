import { describe, expect, it } from "vitest";
import { computeFinalScore, validateScoredWeights } from "./scoring";

describe("evaluation scoring", () => {
  it("combines AI and teacher scores using configured weights", () => {
    expect(computeFinalScore({ aiScore: 82, aiWeight: 40, teacherScore: 90, teacherWeight: 60 })).toBe(86.8);
  });

  it("keeps final score pending while either scored source is missing", () => {
    expect(computeFinalScore({ aiScore: undefined, aiWeight: 40, teacherScore: 90, teacherWeight: 60 })).toBeNull();
    expect(computeFinalScore({ aiScore: 82, aiWeight: 40, teacherScore: undefined, teacherWeight: 60 })).toBeNull();
  });

  it("requires scored weights to total 100", () => {
    expect(validateScoredWeights([{ weight: 40, scored: true }, { weight: 60, scored: true }, { weight: 0, scored: false }])).toBe(true);
    expect(validateScoredWeights([{ weight: 30, scored: true }, { weight: 60, scored: true }])).toBe(false);
  });
});
