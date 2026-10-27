import { describe, expect, it } from "vitest";
import { buildPBLSystemPrompt } from "./pbl-system-prompt";

describe("personal-project PBL design prompt", () => {
  it("frames the legacy PBL orchestration as virtual support for one student", () => {
    const prompt = buildPBLSystemPrompt({
      projectTopic: "校园节能",
      projectDescription: "设计一份有证据支持的节能方案",
      targetSkills: ["数据分析"],
      issueCount: 4,
      languageDirective: "简体中文",
    });

    expect(prompt).toContain("one complete personal project");
    expect(prompt).toContain("virtual AI companions");
    expect(prompt).toContain("not a group collaboration board");
    expect(prompt).toContain("artifact, presentation, and reflection");
  });
});
