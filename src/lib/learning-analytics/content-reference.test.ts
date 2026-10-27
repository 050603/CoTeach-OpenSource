import { describe, expect, it } from "vitest";
import { formatLearningContentReference } from "./content-reference";

describe("formatLearningContentReference", () => {
  it("turns a verbose runtime reference into a concise teacher-facing location", () => {
    expect(formatLearningContentReference({
      stageLabel: "AI 授知",
      sceneIndex: 5,
      sceneType: "slide",
      sceneTitle: "图像像素与流程探索",
      activityTitle: "AI授知：核心知识与方法建构",
      knowledgePointLabels: [
        "计算机视觉定义与核心任务",
        "计算机视觉的应用场景",
        "数字图像基础：像素、分辨率与颜色通道",
        "计算机视觉基本工作流程",
        "图像预处理：灰度化",
      ],
    })).toBe("第 5 页 《图像像素与流程探索》 · 计算机视觉定义与核心任务等 5 个知识点");
  });

  it("does not expose opaque scene or knowledge identifiers", () => {
    expect(formatLearningContentReference({
      sceneTitle: "scene-runtime-1",
      knowledgePointLabels: ["prereq-1"],
    })).toBe("当前学习内容");
  });
});
