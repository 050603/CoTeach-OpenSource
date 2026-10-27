// @vitest-environment node
import { expect, it } from "vitest";
import { screeningThinkingBody } from "./screening-request";
it("disables reasoning through the existing Alibaba adapter including deployment model suffixes", () => {
  expect(screeningThinkingBody("deepseek-v4.1-flash-1017", "https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).toEqual({ enable_thinking: false });
  expect(screeningThinkingBody("deepseek-v4.1-flash", "https://api.deepseek.com/v1")).toEqual({ thinking: { type: "disabled" } });
  expect(screeningThinkingBody("unknown-model", "https://example.test/v1")).toEqual({});
});
