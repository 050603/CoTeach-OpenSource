import { describe, expect, it } from "vitest";
import { readJsonResponse } from "./read-json-response";

describe("readJsonResponse", () => {
  it("parses a JSON response", async () => {
    await expect(readJsonResponse<{ ok: boolean }>(new Response('{"ok":true}')))
      .resolves.toEqual({ ok: true });
  });

  it("turns an empty response into a readable error", async () => {
    await expect(readJsonResponse(new Response(null), "快速生成服务没有返回内容。"))
      .rejects.toThrow("快速生成服务没有返回内容。");
  });

  it("does not expose a JSON parser error", async () => {
    await expect(readJsonResponse(new Response("not-json", { status: 500 })))
      .rejects.toThrow("请求未完成（500）");
  });
});
