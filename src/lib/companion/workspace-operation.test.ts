import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import {
  applyWorkspacePatchToPayload,
  applyCompanionWorkspacePatch,
  appendCompanionContribution,
  buildWorkspaceEditInstruction,
  extractWorkspacePatch,
  requestsWorkspaceEdit,
  revertCompanionWorkspaceOperation,
  workspaceTargetsForStage,
} from "./workspace-operation";

describe("companion workspace operations", () => {
  it("recognizes direct field edits but not ordinary questions", () => {
    expect(requestsWorkspaceEdit("请把两条风险补充到工作台里")).toBe(true);
    expect(requestsWorkspaceEdit("这个概念是什么意思？")).toBe(false);
  });

  it("limits the edit contract to the current stage", () => {
    expect(workspaceTargetsForStage("proposal")).toContain("proposal.risks");
    expect(workspaceTargetsForStage("proposal")).not.toContain("make.result");
    expect(workspaceTargetsForStage("make")).toEqual(["make.processDraft"]);
    expect(workspaceTargetsForStage("make")).not.toContain("make.testMethod");
    expect(workspaceTargetsForStage("make")).not.toContain("make.testTarget");
    expect(workspaceTargetsForStage("make")).not.toContain("make.interpretation");
    expect(buildWorkspaceEditInstruction("proposal", "把风险补充到工作台"))
      .toContain("proposal.risks");
  });

  it("keeps pure text work results out of automatic workspace patches", () => {
    expect(buildWorkspaceEditInstruction(
      "make",
      "请整理我的作品记录；只输出纯文本工作结果，不生成工作台补丁",
    )).toBeUndefined();
  });

  it("refuses to enable document tools for cognitive outsourcing requests", () => {
    expect(buildWorkspaceEditInstruction("proposal", "帮我直接写一份完整方案到项目文档"))
      .toBeUndefined();
  });

  it("separates a sanitized, targeted patch from spoken feedback", () => {
    const result = extractWorkspacePatch(
      '我补充了一条风险，请在工作台核对。<workspace_patch>{"mode":"append","target":"proposal.risks","title":"补充风险","content":"<b>样本太少</b>","reviewInstruction":"核对是否符合你的真实情况","reason":"学生刚提到样本数量"}</workspace_patch>',
    );
    expect(result.speech).toBe("我补充了一条风险，请在工作台核对。");
    expect(result.patch).toEqual({
      mode: "append",
      target: "proposal.risks",
      title: "补充风险",
      content: "样本太少",
      reviewInstruction: "核对是否符合你的真实情况",
      reason: "学生刚提到样本数量",
    });
  });

  it("drops malformed or unsupported targets", () => {
    expect(extractWorkspacePatch('<workspace_patch>{"mode":"replace","target":"course.grade"}</workspace_patch>').patch)
      .toBeUndefined();
  });

  it("applies append and replace at field level without mutating the source", () => {
    const source = { risks: ["时间不足"], validationMethod: "访谈" };
    const appended = applyWorkspacePatchToPayload({
      payload: source,
      patch: {
        mode: "append",
        target: "proposal.risks",
        title: "补充风险",
        content: "样本太少\n时间不足",
        reviewInstruction: "核对风险",
      },
    });
    expect(appended.beforeValue).toEqual(["时间不足"]);
    expect(appended.afterValue).toEqual(["时间不足", "样本太少"]);
    expect(source.risks).toEqual(["时间不足"]);

    const replaced = applyWorkspacePatchToPayload({
      payload: appended.payload,
      patch: {
        mode: "replace",
        target: "proposal.validation",
        title: "改写方法",
        content: "让 5 名同学完成任务并记录耗时",
        reviewInstruction: "核对人数",
      },
    });
    expect(replaced.beforeValue).toBe("访谈");
    expect(replaced.afterValue).toBe("让 5 名同学完成任务并记录耗时");
  });

  it("appends an attributed contribution without allowing injected HTML", () => {
    const content = appendCompanionContribution({
      existingContent: "<p>学生原文</p>",
      patch: {
        mode: "append",
        target: "proposal.concept",
        title: "定义<script>",
        content: "A < B",
        reviewInstruction: "核对来源",
      },
      companionId: "knowledge",
      companionName: "知知",
      taskId: "task-1",
    });
    expect(content).toContain("<p>学生原文</p>");
    expect(content).toContain("定义&lt;script&gt;");
    expect(content).toContain("A &lt; B");
    expect(content).toContain('data-target="proposal.concept"');
    expect(content).not.toContain("<script>");
  });

  it("creates an immediately applicable evidence draft and a reversible operation", () => {
    const course = {
      id: "course-1",
      learningEvidence: [],
      uploads: [],
      groups: [],
    } as unknown as Course;
    const result = applyCompanionWorkspacePatch({
      course,
      studentId: "student-1",
      stageKey: "proposal",
      companionId: "critic",
      taskId: "task-1",
      taskCreatedAt: "2026-08-13T00:00:00.000Z",
      now: "2026-08-13T00:00:01.000Z",
      patch: {
        mode: "append",
        target: "proposal.risks",
        title: "补充风险",
        content: "样本太少",
        reviewInstruction: "核对样本情况",
      },
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect((result.evidence.payload as { risks: string[] }).risks).toEqual(["样本太少"]);
    expect(result.operation.beforeValue).toEqual([]);
    const reverted = revertCompanionWorkspaceOperation({
      course: { ...course, learningEvidence: [result.evidence] },
      operation: result.operation,
      now: "2026-08-13T00:00:02.000Z",
    });
    expect(reverted.status).toBe("applied");
    if (reverted.status === "applied") {
      expect((reverted.evidence.payload as { risks: string[] }).risks).toEqual([]);
    }
  });

  it("protects newer student content from replace and undo operations", () => {
    const course = {
      id: "course-1",
      uploads: [],
      groups: [],
      learningEvidence: [{
        id: "evidence-course-1-student-1-plan-version",
        kind: "plan-version",
        payload: { validationMethod: "学生的新方法" },
        updatedAt: "2026-08-13T00:00:02.000Z",
      }],
    } as unknown as Course;
    const result = applyCompanionWorkspacePatch({
      course,
      studentId: "student-1",
      stageKey: "proposal",
      companionId: "critic",
      taskId: "task-1",
      taskCreatedAt: "2026-08-13T00:00:01.000Z",
      patch: {
        mode: "replace",
        target: "proposal.validation",
        title: "改写验证方法",
        content: "AI 方法",
        reviewInstruction: "核对方法",
      },
    });
    expect(result.status).toBe("conflict");
  });
});
