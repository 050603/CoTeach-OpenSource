import { describe, expect, it } from "vitest";
import { normalizePreparationResult, preparationMissingFields, preparationMutationSchema, preparationPlanSchema } from "./schema";
import { preparationPlanFixture } from "./fixtures.test-support";

describe("collaborative preparation contracts", () => {
  it("keeps a 45 minute lesson and the full knowledge depth and teaching approach", () => {
    const plan = preparationPlanSchema.parse(preparationPlanFixture());
    expect(plan.totalMinutes / 60).toBe(0.75);
    expect(plan.knowledgePoints[0]).toMatchObject({ depth: expect.stringContaining("不要求粒子"), teachingApproach: expect.stringContaining("湿手帕") });
    expect(preparationMissingFields(plan)).toEqual([]);
  });
  it("allows incomplete initial plans and conservatively labels missing provenance", () => {
    const result = normalizePreparationResult({ message: "先明确授课对象。", plan: { courseName: "蒸发" }, question: { id: "grade", prompt: "面对哪个年级？", options: [{ id: "a", label: "小学四年级", description: "采用生活观察与简单实验" }, { id: "b", label: "初中", description: "讨论蒸发条件与实验变量" }] } });
    expect(result.fieldOrigins).toEqual({ courseName: "ai-proposed" });
    expect(result.suggestions).toEqual([]);
    expect(result.readyToConfirm).toBe(false);
    expect(preparationMissingFields(result.plan)).toContain("课程总分钟数");
  });
  it("cannot confirm missing essentials merely because the model says ready", () => {
    expect(() => normalizePreparationResult({ message: "可以生成。", plan: { courseName: "蒸发" }, question: null, readyToConfirm: true })).toThrow("下一步问题");
  });
  it("rejects inconsistent stage minutes and incomplete instructional stages", () => {
    const plan = preparationPlanFixture();
    plan.stagePlan.stages[1].durationMin = 20;
    expect(preparationMissingFields(plan)).toContain("五阶段分钟数之和须等于课程总时长。");
    plan.stagePlan.stages[1].durationMin = 15;
    plan.stagePlan.stages[1].requirements = "";
    expect(preparationPlanSchema.safeParse(plan).success).toBe(false);
  });
  it("does not accept invented textbook evidence fields or missing primary selections", () => {
    expect(preparationMutationSchema.safeParse({ revision: 0, requestId: "a", message: "蒸发", textbookSelections: [{ revisionId: "12345678-1234-4234-8234-123456789012", primary: false, sectionIds: [] }] }).success).toBe(false);
    const result = preparationPlanSchema.parse({ ...preparationPlanFixture(), evidenceStatus: "SUPPORTED" });
    expect(result).not.toHaveProperty("evidenceStatus");
  });
});
