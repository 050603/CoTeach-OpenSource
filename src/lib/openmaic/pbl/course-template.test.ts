import { describe, expect, it } from "vitest";
import { checkPblStageCoverage, formatPblSceneContext, PBL_STAGE_KEYS } from "./course-template";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import { DEFAULT_PBL_COURSE_CONFIG } from "@/lib/pbl-course-config";

function outline(
  stageKey: string,
  audience: "student" | "teacher",
  type: SceneOutline["type"] = "slide",
): SceneOutline {
  return {
    id: stageKey,
    type,
    title: stageKey,
    description: stageKey,
    keyPoints: [],
    order: 0,
    stageKey,
    stageLabel: stageKey,
    audience,
    generationPurpose: audience === "student" ? "knowledge-teaching" : "teacher-resource",
  };
}

describe("PBL six-stage course template", () => {
  it("requires all six stages and critical teacher resources", () => {
    const result = checkPblStageCoverage([
      outline("launch", "teacher"),
      outline("ai-learning", "student", "quiz"),
      outline("proposal", "teacher", "interactive"),
      outline("make", "teacher"),
    ]);

    expect(result.missingStageKeys).toEqual(["showcase", "reflection"]);
    expect(result.missingTeacherResourceStageKeys).toEqual(["showcase"]);
    expect(result.missingStudentLearningStageKeys).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("accepts teacher facilitation support without requiring a PPT for every phase", () => {
    const result = checkPblStageCoverage([
      outline("launch", "teacher"),
      outline("ai-learning", "student"),
      outline("proposal", "teacher"),
      outline("make", "teacher"),
      outline("showcase", "teacher"),
      outline("reflection", "teacher"),
    ]);

    expect(result.missingStageKeys).toEqual([]);
    expect(result.missingTeacherResourceStageKeys).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("detects student content routed outside AI learning", () => {
    const result = checkPblStageCoverage([
      ...PBL_STAGE_KEYS.map((stageKey) => outline(stageKey, stageKey === "ai-learning" ? "student" : "teacher")),
      outline("make", "student"),
    ]);

    expect(result.routingViolations).toHaveLength(1);
    expect(result.routingViolations[0]).toContain("项目实践");
  });

  it("formats selected companions and evidence for concrete scene generation", () => {
    const text = formatPblSceneContext(
      {
        stageKey: "proposal",
        stageLabel: "方案构思与校准",
        audience: "teacher",
        generationPurpose: "facilitation-scaffold",
        companionIds: ["critic", "recorder"],
        companionPrompt: "提醒教师留出学生解释取舍的时间",
      },
      DEFAULT_PBL_COURSE_CONFIG,
    );

    expect(text).toContain("方案构思与校准");
    expect(text).toContain("critic、recorder");
    expect(text).toContain("记记");
    expect(text).toContain("方案修订记录");
    expect(text).toContain("阶段伴学服务契约");
    expect(text).toContain("替学生选定方向");
    expect(text).toContain("不能替学生做最终决策");
  });
});
