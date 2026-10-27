import { describe, expect, it } from "vitest";
import type { Course, RubricScore } from "@/lib/session/types";
import { courseEvaluationPlan, normalizeCourseRubricScore } from "./course-rubric";

const rubric = { id: "rubric", version: 2, dimensions: [{ id: "theory", name: "理论适切性", weight: 30, description: "有理论依据" }, { id: "activity", name: "活动可行性", weight: 70, description: "可实施" }], sourceWeights: { teacher: 70, ai: 30 } };
const course = { content: { stagePlan: { evaluationRubric: rubric }, evaluationPlan: { dimensions: [], overallRubric: "" } }, rubricScores: [] } as unknown as Course;
const score = { id: "score", status: "submitted", dimensionScores: { theory: 100, activity: 80 }, aiDimensionScores: { theory: 80, activity: 60 }, total: 1, createdAt: "2026-09-12T10:00:00Z" } as unknown as RubricScore;
describe("confirmed course rubric", () => {
  it("uses confirmed dimensions and source weights and recalculates submitted scores", () => {
    expect(courseEvaluationPlan(course).dimensions.map((d) => d.name)).toEqual(["理论适切性", "活动可行性"]);
    expect(courseEvaluationPlan(course).flows?.find((f) => f.sourceRole === "teacher")?.weight).toBe(70);
    const result = normalizeCourseRubricScore(course, score);
    expect(result).toMatchObject({ teacherTotal: 86, aiTotal: 66, finalTotal: 80, total: 80, rubricSnapshot: rubric });
  });
  it("rejects incomplete scores and freezes the original rubric when the template changes", () => {
    expect(() => normalizeCourseRubricScore(course, { ...score, aiDimensionScores: undefined })).toThrow();
    const previous = normalizeCourseRubricScore(course, score);
    const changed = { ...course, content: { ...course.content, stagePlan: { ...course.content.stagePlan!, evaluationRubric: { ...rubric, version: 3, sourceWeights: { teacher: 50, ai: 50 } } } }, rubricScores: [previous] };
    expect(normalizeCourseRubricScore(changed, score).finalTotal).toBe(80);
    expect(normalizeCourseRubricScore(changed, score).rubricSnapshot?.version).toBe(2);
    expect(normalizeCourseRubricScore({ ...changed, rubricScores: [score] }, score)).toBe(score);
  });
});

describe("teacher-final classroom rubric", () => {
  it("preserves original weights as history while new grading needs only teacher evidence", () => {
    const current = { ...course, evaluationContractVersion: 2 as const };
    const plan = courseEvaluationPlan(current);
    expect(plan.scoringMode).toBe("teacher-final");
    expect(plan.flows?.find(f => f.sourceRole === "ai")).toMatchObject({ weight: 0, scored: false });
    expect(plan.flows?.find(f => f.sourceRole === "peer")).toMatchObject({ enabled: false, scored: false });
    const result = normalizeCourseRubricScore(current, { ...score, aiDimensionScores: undefined });
    expect(result).toMatchObject({ teacherTotal: 86, aiTotal: null, finalTotal: 86, rubricSnapshot: { sourceWeights: { teacher: 70, ai: 30 }, scoringMode: "teacher-final" } });
    expect(course.content.stagePlan?.evaluationRubric?.sourceWeights).toEqual({ teacher: 70, ai: 30 });
  });
  it("does not reinterpret an existing weighted score when the surrounding contract changes", () => {
    const previous = normalizeCourseRubricScore(course, score);
    const current = { ...course, evaluationContractVersion: 2 as const, rubricScores: [previous] };
    expect(normalizeCourseRubricScore(current, score).finalTotal).toBe(80);
  });
});
