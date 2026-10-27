import { describe, expect, it } from "vitest";
import {
  generationTemplateForSystemMode,
  getStagesForSystemMode,
  mapStageKeyToSystemMode,
  resolveOpenPblSystemMode,
} from "./system-mode";
import { normalizeCourse } from "./session/actions";
import { createPblTemplateCourse } from "./platform/pbl-template";

describe("current system contract", () => {
  it("uses project evaluation for new templates while keeping historical runtime stages on the old contract", () => {
    const template = createPblTemplateCourse("template");
    expect(normalizeCourse(template).stages[4]).toMatchObject({ key: "reflection", view: "pbl-evaluation", label: "项目评价" });
    expect(normalizeCourse({ ...template, evaluationContractVersion: undefined }).stages[4]).toMatchObject({ key: "reflection", view: "experiment-posttest", label: "后测" });
  });
  it("always exposes the five supported stages", () => {
    expect(resolveOpenPblSystemMode()).toBe("new");
    expect(resolveOpenPblSystemMode("legacy")).toBe("new");
    expect(getStagesForSystemMode().map((stage) => stage.key)).toEqual([
      "launch",
      "ai-learning",
      "make",
      "showcase",
      "reflection",
    ]);
  });

  it("uses the current generation contract and maps removed stages to practice", () => {
    expect(generationTemplateForSystemMode()).toBe("new-ai-learning-only");
    expect(mapStageKeyToSystemMode("proposal")).toBe("make");
    expect(mapStageKeyToSystemMode("showcase")).toBe("showcase");
  });
});
