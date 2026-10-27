import { describe, expect, it, vi } from "vitest";
import { DURABLE_GENERATION_TRANSIENT_RETRIES } from "@/lib/llm/request-policy";
import {
  buildCourseDesignStageEditMessages,
  editCourseDesignStage,
} from "@/lib/course-design/stage-editor";

describe("course design stage editor", () => {
  it("asks the Agent to edit the current snapshot instead of regenerating a stage", () => {
    const messages = buildCourseDesignStageEditMessages({
      label: "成功标准",
      current: { dimensions: [{ id: "ev-1", name: "概念理解" }] },
      issues: ["缺少成果证据对应"],
      fixedConstraints: { hours: 2 },
      outputSchema: { dimensions: "完整修订后的数组" },
    });
    const content = messages.map((message) => message.content).join("\n");

    expect(content).toContain("直接编辑当前阶段数据");
    expect(content).toContain("保留稳定 ID");
    expect(content).toContain("缺少成果证据对应");
    expect(content).toContain("概念理解");
    expect(content).toContain("不能只返回意见");
  });

  it("returns the complete revised snapshot on the standard edit policy", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      revised: { id: "stable-id", value: "已修订" },
      summary: "已补齐问题",
    }));

    const result = await editCourseDesignStage({
      label: "项目成果",
      current: { id: "stable-id", value: "原稿" },
      issues: ["描述不完整"],
      fixedConstraints: {},
      outputSchema: { id: "string", value: "string" },
      modelCall,
      parse: (value) => value as { id: string; value: string },
    });

    expect(result).toEqual({ id: "stable-id", value: "已修订" });
    expect(modelCall.mock.calls[0][1]).toMatchObject({
      jsonMode: true,
      requestClass: "standard",
      maxTransientRetries: DURABLE_GENERATION_TRANSIENT_RETRIES,
    });
  });

  it("repairs an incomplete edited payload locally instead of failing the course job", async () => {
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        summary: "已调整评价描述",
        revised: { overallRubric: "根据学习证据综合判断" },
      }))
      .mockResolvedValueOnce(JSON.stringify({
        summary: "已补回完整评价维度",
        revised: {
          dimensions: [{ id: "ev-1", name: "概念理解", weight: 100 }],
          overallRubric: "根据学习证据综合判断",
        },
      }));

    const result = await editCourseDesignStage({
      label: "成功标准",
      current: { dimensions: [{ id: "ev-1", name: "概念理解", weight: 100 }] },
      issues: ["评价描述需要更具体"],
      fixedConstraints: { learningObjectives: ["解释机器学习基本过程"] },
      outputSchema: { dimensions: "至少一项完整评价维度", overallRubric: "string" },
      modelCall,
      parse: (value) => {
        const revised = value as { dimensions?: unknown[] };
        if (!Array.isArray(revised.dimensions) || revised.dimensions.length === 0) {
          throw new Error("评价方案生成失败：AI 未返回评价维度。");
        }
        return revised;
      },
    });

    expect(result.dimensions).toHaveLength(1);
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(modelCall.mock.calls[1][0][0].content).toContain("上一次编辑结果未通过结构解析");
    expect(modelCall.mock.calls[1][0][1].content).toContain("AI 未返回评价维度");
    expect(modelCall.mock.calls[1][0][1].content).toContain("概念理解");
  });

  it("keeps the valid current snapshot when repeated edit responses are malformed", async () => {
    const current = { dimensions: [{ id: "ev-1", name: "概念理解" }] };
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({ revised: {} }));

    const result = await editCourseDesignStage({
      label: "成功标准",
      current,
      preserveValueOnMalformedEdit: current,
      issues: ["建议让描述更具体"],
      fixedConstraints: {},
      outputSchema: { dimensions: "完整数组" },
      maxAttempts: 2,
      modelCall,
      parse: () => {
        throw new Error("AI 未返回评价维度");
      },
    });

    expect(result).toBe(current);
    expect(modelCall).toHaveBeenCalledTimes(2);
  });
});
