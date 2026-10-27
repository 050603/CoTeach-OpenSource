import { describe, expect, it } from "vitest";
import type { AiAssessmentSuggestion } from "@/lib/session/types";
import {
  aiAssessmentConfidenceLabel,
  aiAssessmentStatusLabel,
  calculateProcessSuggestionTotal,
  confirmedProcessScore,
  learningEvidenceKindLabel,
  learningEvidenceStatusLabel,
  learningStageLabel,
  localizeEvaluationText,
  uniqueEvidenceGaps,
} from "./process-assessment";

const suggestion: AiAssessmentSuggestion = {
  id: "suggestion-1",
  courseId: "course-1",
  studentId: "student-1",
  stageKey: "showcase",
  dimensions: [],
  evidenceIds: [],
  evidenceGaps: [],
  confidence: "low",
  suggestedTotal: 24,
  status: "pending-teacher-confirmation",
  createdAt: "2026-08-06T00:00:00.000Z",
};

describe("process assessment presentation", () => {
  it("does not turn missing evidence into a zero or a misleading total", () => {
    expect(calculateProcessSuggestionTotal([
      { score: 50 },
      { score: undefined },
      { score: null },
      { score: 0 },
      { score: 70 },
    ])).toBeNull();
    expect(calculateProcessSuggestionTotal([])).toBeNull();
    expect(calculateProcessSuggestionTotal([{ score: 0 }, { score: 80 }])).toBe(40);
  });

  it("only exposes a teacher-confirmed score to final scoring", () => {
    expect(confirmedProcessScore(suggestion)).toBeNull();
    expect(confirmedProcessScore({
      ...suggestion,
      status: "confirmed",
      teacherScore: 24,
    })).toBe(24);
    expect(confirmedProcessScore({
      ...suggestion,
      status: "adjusted",
      teacherScore: 80,
    })).toBe(80);
    expect(confirmedProcessScore({ ...suggestion, status: "rejected" })).toBeNull();
  });

  it("uses readable Chinese labels for status and confidence", () => {
    expect(aiAssessmentStatusLabel("pending-teacher-confirmation")).toBe("待教师确认");
    expect(aiAssessmentStatusLabel("adjusted")).toBe("教师已调整并确认");
    expect(aiAssessmentStatusLabel("insufficient-evidence")).toBe("证据不足");
    expect(aiAssessmentConfidenceLabel("low")).toBe("较低");
    expect(aiAssessmentConfidenceLabel("high")).toBe("较高");
  });

  it("removes repeated and blank evidence gaps", () => {
    expect(uniqueEvidenceGaps([
      "缺少测试结果",
      " 缺少测试结果 ",
      "",
      "缺少迭代记录",
    ])).toEqual(["缺少测试结果", "缺少迭代记录"]);
  });

  it("turns internal learning keys into teacher-facing Chinese labels", () => {
    expect(learningStageLabel("make")).toBe("项目实践");
    expect(learningStageLabel("showcase")).toBe("成果汇报与评价");
    expect(learningStageLabel("custom", [{ key: "custom", label: "自定义阶段" }])).toBe("自定义阶段");
    expect(learningEvidenceKindLabel("plan-version")).toBe("项目方案版本");
    expect(learningEvidenceStatusLabel("teacher-confirmed")).toBe("教师已确认");
    expect(localizeEvaluationText("学生在 make 阶段提交 plan-version，状态为 submitted。"))
      .toBe("学生在项目实践阶段提交项目方案版本，状态为已提交。");
  });
});
