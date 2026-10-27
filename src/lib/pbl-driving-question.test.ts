import { describe, expect, it } from "vitest";
import { evaluatePblDrivingQuestion, isStrongPblDrivingQuestion } from "./pbl-driving-question";

describe("PBL driving question quality", () => {
  it("accepts one authentic project challenge with audience, action and outcome", () => {
    expect(isStrongPblDrivingQuestion(
      "我们如何为学校图书馆设计一套有证据支持、可验证的图书分类方案？",
    )).toBe(true);
  });

  it("rejects a list of knowledge-check questions masquerading as a project question", () => {
    const result = evaluatePblDrivingQuestion(
      "如何确定关键词的权重？如果一本书同时包含多个类别关键词怎么办？如何验证分类规则的准确性？统计方法与规则方法相比有哪些优缺点？",
    );
    expect(result.passed).toBe(false);
    expect(result.issues.join("；")).toContain("一个核心问题");
  });

  it("rejects a technical subproblem without a real audience or project outcome", () => {
    const result = evaluatePblDrivingQuestion("如何确定关键词的权重？");
    expect(result.passed).toBe(false);
    expect(result.issues.join("；")).toContain("真实对象");
    expect(result.issues.join("；")).toContain("项目行动或成果");
  });
});
