import { describe, expect, it } from "vitest";
import { DEFAULT_PBL_RUBRIC, emptyPblAnswers, pblWeightedScore } from "./pbl-contract";
import { pblAssignmentPairs, pblConfig, pblReportView, validatePblAnswers } from "./pbl-policy";
describe("PBL evaluation policy", () => {
  it("keeps missing evidence unscored instead of assigning zero or redistributing its weight", () => {
    expect(pblWeightedScore(DEFAULT_PBL_RUBRIC, { knowledge: 80, "problem-solving": 60, evidence: null, reflection: 90 })).toBeNull();
    expect(pblWeightedScore(DEFAULT_PBL_RUBRIC, { knowledge: 80, "problem-solving": 60, evidence: 0, reflection: 100 })).toBe(60);
  });
  it("defaults peer evaluation off and respects the persisted, frozen rubric", () => {
    const initial = pblConfig({}, null);
    expect(initial.peerMode).toBe("off"); expect(initial.reviewsPerStudent).toBe(2);
    const custom = { ...initial, version: 2, rubric: [{ id: "x", name: "X", description: "X", weight: 100 }] };
    expect(pblConfig({ pblEvaluationConfig: custom }, null)).toEqual(custom);
  });
  it("distributes two non-self reviews evenly and reduces count for small classes", () => {
    const pairs = pblAssignmentPairs(["a", "b", "c", "d"], ["a", "b", "c", "d"], 2);
    expect(pairs).toHaveLength(8);
    for (const id of ["a", "b", "c", "d"]) { expect(pairs.filter(p => p.targetParticipationId === id)).toHaveLength(2); expect(pairs.filter(p => p.reviewerParticipationId === id)).toHaveLength(2); }
    expect(pairs.every(p => p.reviewerParticipationId !== p.targetParticipationId)).toBe(true);
    expect(pblAssignmentPairs(["a", "b"], ["a", "b"], 2)).toHaveLength(2);
    expect(pblAssignmentPairs(["a"], ["a"], 2)).toEqual([]);
  });
  it("includes reviewers without work and allows no eligible presenters", () => {
    expect(pblAssignmentPairs(["a", "b"], ["a"], 2)).toEqual([{ reviewerParticipationId: "b", targetParticipationId: "a" }]);
    expect(pblAssignmentPairs(["a"], [], 2)).toEqual([]);
  });
  it("requires reflection/feedback on submit and permits unknown dimensions", () => {
    const answers = emptyPblAnswers(DEFAULT_PBL_RUBRIC);
    expect(() => validatePblAnswers("self", answers, DEFAULT_PBL_RUBRIC, false)).not.toThrow();
    expect(() => validatePblAnswers("self", answers, DEFAULT_PBL_RUBRIC, true)).toThrow("作品依据");
    expect(() => validatePblAnswers("self", { ...answers, evidence: "作品", learning: "收获", plan: "改进" }, DEFAULT_PBL_RUBRIC, true)).not.toThrow();
    expect(() => validatePblAnswers("peer", answers, DEFAULT_PBL_RUBRIC, true)).toThrow("具体优点");
  });
  it("only teachers can override and an explicit adjustment needs a reason", () => {
    const answers = { ...emptyPblAnswers(DEFAULT_PBL_RUBRIC), finalScore: 75 };
    expect(() => validatePblAnswers("self", answers, DEFAULT_PBL_RUBRIC, false)).toThrow("只有教师");
    expect(() => validatePblAnswers("teacher", answers, DEFAULT_PBL_RUBRIC, false)).toThrow("理由");
    expect(() => validatePblAnswers("teacher", { ...answers, overrideReason: "现场证据" }, DEFAULT_PBL_RUBRIC, false)).not.toThrow();
  });
  it("projects cited original evidence and preserves no-score/gap explanations", () => {
    const report = pblReportView({ id: "r", generatedAt: "now", summary: "summary", evidence: [{ id: "e", title: "保存的版本", content: "修改前后" }], dimensions: [{ dimensionId: "x", name: "X", score: null, rationale: "不足", evidenceIds: ["e", "fake"], evidenceGaps: ["缺少现场记录"], improvements: ["补充验证"] }] });
    expect(report?.dimensions[0]).toEqual({ id: "x", name: "X", score: null, judgment: "不足", evidence: [{ id: "e", label: "保存的版本", detail: "修改前后" }], gaps: ["缺少现场记录"], suggestion: "补充验证" });
  });
});
