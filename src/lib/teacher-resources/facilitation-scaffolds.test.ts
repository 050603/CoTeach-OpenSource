import { describe, expect, it } from "vitest";
import {
  buildFacilitationScaffold,
  classifyTeacherResourceGeneration,
  normalizeFacilitationScaffolds,
} from "./facilitation-scaffolds";

describe("teacher resource generation modes", () => {
  it("keeps predictable teaching content pre-generated", () => {
    expect(classifyTeacherResourceGeneration("项目导入与驱动问题")).toEqual({ mode: "predictable" });
    expect(classifyTeacherResourceGeneration("课后延伸与价值升华")).toEqual({ mode: "predictable" });
  });

  it("turns unpredictable conclusions into empty facilitation scaffolds", () => {
    expect(classifyTeacherResourceGeneration("学生方案点评")).toMatchObject({ mode: "dynamic-scaffold", kind: "proposal-critique" });
    const scaffold = buildFacilitationScaffold({ courseId: "course-1", stageKey: "showcase", title: "汇报总结", kind: "presentation-summary" });
    expect(scaffold.status).toBe("template");
    expect(scaffold.filledContent).toBeUndefined();
    expect(scaffold.sections.every((section) => section.evidenceSlots.length > 0)).toBe(true);
  });

  it("generates globally unique scaffold ids for different courses", () => {
    const first = buildFacilitationScaffold({
      courseId: "course-1",
      stageKey: "proposal",
      title: "方案点评",
      kind: "proposal-critique",
    });
    const second = buildFacilitationScaffold({
      courseId: "course-2",
      stageKey: "proposal",
      title: "方案点评",
      kind: "proposal-critique",
    });

    expect(first.id).not.toBe(second.id);
    expect(first.id).toBe("course-1:facilitation:proposal:proposal-critique");
  });

  it("upgrades legacy ids and deduplicates a generated scaffold batch", () => {
    const older = {
      ...buildFacilitationScaffold({
        courseId: "course-1",
        stageKey: "proposal",
        title: "旧方案点评",
        kind: "proposal-critique",
      }),
      id: "facilitation-proposal-proposal-critique",
      updatedAt: "2026-07-23T10:00:00.000Z",
    };
    const newer = {
      ...older,
      title: "新方案点评",
      updatedAt: "2026-07-23T11:00:00.000Z",
    };

    expect(normalizeFacilitationScaffolds([older, newer])).toEqual([
      expect.objectContaining({
        id: "course-1:facilitation:proposal:proposal-critique",
        title: "新方案点评",
      }),
    ]);
  });
});
