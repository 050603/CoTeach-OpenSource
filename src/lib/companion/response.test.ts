import { describe, expect, it } from "vitest";
import { sanitizeCompanionResponse } from "./response";

describe("sanitizeCompanionResponse", () => {
  it("removes recorder stage directions from any companion response", () => {
    expect(sanitizeCompanionResponse("记记收束：当前唯一需要解决的是项目文档为空。"))
      .toBe("当前唯一需要解决的是项目文档为空。");
    expect(sanitizeCompanionResponse("记记记录：先保留已经验证的证据。"))
      .toBe("先保留已经验证的证据。");
  });

  it("removes stacked or bracketed speaker labels", () => {
    expect(sanitizeCompanionResponse("知知：记记收束：先核对颜色阈值。"))
      .toBe("先核对颜色阈值。");
    expect(sanitizeCompanionResponse("【策策建议】：先写一个最小步骤。"))
      .toBe("先写一个最小步骤。");
  });

  it("does not rewrite natural content in the middle of a response", () => {
    const text = "先核对已有证据，再由记记收束本轮讨论。";
    expect(sanitizeCompanionResponse(text)).toBe(text);
  });
});
