import { describe, expect, it } from "vitest";
import type { Scene } from "@openmaic/lib/types/stage";
import { classifyScenes } from "./scene-classifier";

function scene(input: Partial<Scene> & Pick<Scene, "id" | "type" | "title">): Scene {
  return {
    stageId: "stage-1",
    order: 0,
    actions: [],
    content: { type: input.type } as Scene["content"],
    ...input,
  } as Scene;
}

describe("classifyScenes", () => {
  it("keeps an explicitly marked interactive scene as a teacher resource", () => {
    const result = classifyScenes([
      scene({
        id: "interactive-1",
        type: "interactive",
        title: "【教师资源-课堂演示】【阶段:group】变量控制实验",
      }),
      scene({
        id: "student-slide-1",
        type: "slide",
        title: "核心知识讲解",
        order: 1,
      }),
    ]);

    expect(result.studentScenes).toHaveLength(1);
    expect(result.teacherScenes).toHaveLength(1);
    expect(result.teacherResourceMeta[0]).toMatchObject({
      id: "interactive-1",
      role: "teaching-aid",
      stageKey: "group",
      type: "interactive",
    });
  });

  it("routes explicit PBL audiences without relying on the title", () => {
    const result = classifyScenes([
      scene({
        id: "launch-resource",
        type: "slide",
        title: "项目启动脚本",
        stageKey: "launch",
        stageLabel: "项目启动",
        audience: "teacher",
        generationPurpose: "teacher-resource",
      }),
      scene({
        id: "proposal-scaffold",
        type: "interactive",
        title: "方案校准支架",
        stageKey: "proposal",
        stageLabel: "方案构思与校准",
        audience: "teacher",
        generationPurpose: "facilitation-scaffold",
        companionIds: ["critic", "recorder"],
        companionPrompt: "记录学生的关键修改",
        order: 1,
      }),
      scene({
        id: "learning-slide",
        type: "slide",
        title: "核心知识",
        stageKey: "ai-learning",
        stageLabel: "AI 授知",
        audience: "student",
        generationPurpose: "knowledge-teaching",
        order: 2,
      }),
    ]);

    expect(result.teacherScenes.map((item) => item.id)).toEqual([
      "launch-resource",
      "proposal-scaffold",
    ]);
    expect(result.studentScenes.map((item) => item.id)).toEqual(["learning-slide"]);
    expect(result.teacherResourceMeta[1]).toMatchObject({
      stageKey: "proposal",
      stageLabel: "方案构思与校准",
      generationMode: "dynamic-scaffold",
      companionIds: ["critic", "recorder"],
    });
  });

  it("fails closed when a later PBL phase is incorrectly marked as student", () => {
    const result = classifyScenes([
      scene({
        id: "showcase-ppt",
        type: "slide",
        title: "成果展示与评价",
        stageKey: "showcase",
        audience: "student",
        generationPurpose: "knowledge-teaching",
      }),
      scene({
        id: "knowledge",
        type: "slide",
        title: "知识讲解",
        stageKey: "ai-learning",
        audience: "student",
        generationPurpose: "knowledge-teaching",
        order: 1,
      }),
    ], { pblMode: true });

    expect(result.studentScenes.map((item) => item.id)).toEqual(["knowledge"]);
    expect(result.teacherScenes.map((item) => item.id)).toEqual(["showcase-ppt"]);
  });
});
