// @vitest-environment node
import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createAiRevisionSource } from "./ai-revision-source";
afterEach(() => vi.unstubAllGlobals());
it("captures exact content hashes and only public source identifiers", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const withExtra = { requestId: "r", action: "adopted" as const, before: "private before" };
  const result = await createAiRevisionSource("before", "after", withExtra);
  expect(result).toEqual({ requestId: "r", action: "adopted", beforeContentHash: createHash("sha256").update("before").digest("hex"), afterContentHash: createHash("sha256").update("after").digest("hex") });
});
it("does not guess provenance when crypto or an explicit source is absent", async () => {
  vi.stubGlobal("crypto", {});
  expect(await createAiRevisionSource("a", "b", { requestId: "r", action: "undo" })).toBeUndefined();
  expect(await createAiRevisionSource("a", "b", { action: "adopted" })).toBeUndefined();
});
