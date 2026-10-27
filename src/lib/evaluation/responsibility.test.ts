import { describe, expect, it } from "vitest";
import {
  getTeacherEvaluationDimensions,
  hasBothScoredRoles,
  resolveDimensionRole,
} from "./responsibility";

describe("evaluation responsibility", () => {
  it("keeps explicit ownership and infers legacy professional dimensions as AI-owned", () => {
    expect(resolveDimensionRole({ id: "1", name: "专业知识准确性", weight: 50, description: "概念与方法" })).toBe("ai");
    expect(resolveDimensionRole({ id: "2", name: "现场答辩", weight: 50, description: "回应追问" })).toBe("teacher");
    expect(resolveDimensionRole({ id: "3", name: "专业知识", weight: 50, description: "", responsibleRole: "teacher" })).toBe("teacher");
  });

  it("supplies a teacher-only legacy rubric when old courses contain no presentation dimension", () => {
    const result = getTeacherEvaluationDimensions([
      { id: "1", name: "知识理解", weight: 100, description: "专业概念" },
    ]);
    expect(result).toHaveLength(3);
    expect(result.every((dimension) => dimension.responsibleRole === "teacher")).toBe(true);
    expect(result.reduce((sum, dimension) => sum + dimension.weight, 0)).toBe(100);
  });

  it("requires confirmed dimensions for both scored roles", () => {
    expect(hasBothScoredRoles([
      { id: "1", name: "专业性", weight: 50, description: "", responsibleRole: "ai" },
      { id: "2", name: "现场表达", weight: 50, description: "", responsibleRole: "teacher" },
    ])).toBe(true);
    expect(hasBothScoredRoles([
      { id: "1", name: "专业性", weight: 100, description: "", responsibleRole: "ai" },
    ])).toBe(false);
  });
});
