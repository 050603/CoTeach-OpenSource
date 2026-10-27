import { describe, expect, it } from "vitest";
import { DEFAULT_STAGES } from "@/lib/session/types";
import { buildCourseSummaryPresentation } from "./course-summary";

const course = {
  id: "course-1",
  name: "校园节水",
  subject: "科学",
  grade: "六年级",
  hours: 2,
  summary: "",
  drivingQuestion: "如何减少校园用水浪费？",
  expectedOutcome: "一份可验证的节水方案",
  status: "teaching" as const,
  stages: DEFAULT_STAGES,
  currentStageIndex: 5,
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  students: [],
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

describe("course summary presentation", () => {
  it("displays unknown evidence as unknown instead of a zero score", () => {
    const deck = buildCourseSummaryPresentation(course, { summary: "证据有限", dimensions: [{ name: "AI协作", score: null, evidenceIds: [], evidenceGaps: ["未使用AI"] }], highlights: [], improvements: [] });
    expect(JSON.stringify(deck)).toContain("证据不足，无法判断");
    expect(JSON.stringify(deck)).not.toContain("AI协作：0");
  });
  it("creates an evidence-aware deck without inventing student conclusions", () => {
    const deck = buildCourseSummaryPresentation(course, {
      summary: "班级通过多轮测试改进方案。",
      dimensions: [{
        name: "过程推进",
        score: 84,
        evidenceIds: ["evidence-1"],
        evidenceGaps: [],
      }],
      highlights: ["完成两轮方案迭代"],
      improvements: ["补充长期验证计划"],
    });
    expect(deck.slides).toHaveLength(4);
    expect(deck.evidenceIds).toEqual(["evidence-1"]);
    expect(deck.slides[0].bullets[0]).toContain("如何减少");
    expect(deck.script).toContain("补充长期验证计划");
    expect(deck.status).toBe("draft");
  });
});
