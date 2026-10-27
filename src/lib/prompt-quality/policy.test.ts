import { describe, expect, it } from "vitest";
import {
  buildPromptQualityContract,
  JSON_TEACHER_PROMPT_CONTRACT,
  promptStageLabel,
} from "./policy";

describe("prompt quality policy", () => {
  it("distinguishes missing evidence from a negative fact", () => {
    expect(JSON_TEACHER_PROMPT_CONTRACT).toContain("未知/未填写");
    expect(JSON_TEACHER_PROMPT_CONTRACT).toContain("绝不等于");
  });

  it("keeps structural codes out of user-facing prose", () => {
    const contract = buildPromptQualityContract({ mode: "teacher-facing", audience: "teacher" });
    expect(contract).toContain("不暴露内部字段名、枚举代码");
    expect(contract).toContain("事实依据");
    expect(contract).toContain("术语准确性");
  });

  it("provides canonical Chinese labels for internal PBL stages", () => {
    expect(promptStageLabel("ai-learning")).toBe("知识讲授");
    expect(promptStageLabel("proposal")).toBe("方案构思与校准");
    expect(promptStageLabel("unknown", "自定义阶段")).toBe("自定义阶段");
  });
});
