import { describe, expect, it } from "vitest";
import { buildCourseGenerationInput } from "./course-generation-input";

describe("buildCourseGenerationInput", () => {
  it("carries all teacher-confirmed course basics into downstream generation", () => {
    const input = buildCourseGenerationInput({
      name: "自然语言处理基础",
      subject: "人工智能通识",
      grade: "高二",
      hours: 2,
      summary: "基于校园语言数据完成文本分类项目。",
      drivingQuestion: "我们如何为校园社团设计有证据支持的文本分类方案？",
      learningObjectives: ["解释文本分类的基本流程"],
      learnerProfile: {
        priorKnowledge: "理解分类的直观含义",
        learningNeeds: "需要可视化案例",
        familiarContexts: "校园社团通知",
      },
      stages: [{ key: "launch", label: "项目启动", description: "理解任务" }],
      pblConfig: undefined,
    });

    expect(input).toMatchObject({
      grade: "高二",
      hours: 2,
      learningObjectives: ["解释文本分类的基本流程"],
      learnerProfile: {
        priorKnowledge: "理解分类的直观含义",
        learningNeeds: "需要可视化案例",
      },
    });
  });
});
