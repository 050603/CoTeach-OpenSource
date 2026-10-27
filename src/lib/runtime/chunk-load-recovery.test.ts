import { beforeEach, describe, expect, it } from "vitest";
import {
  CHUNK_RECOVERY_COOLDOWN_MS,
  claimChunkRecovery,
  isChunkLoadError,
  releaseChunkRecovery,
} from "@/lib/runtime/chunk-load-recovery";

describe("chunk load recovery", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("recognises Turbopack and dynamic import chunk failures", () => {
    expect(
      isChunkLoadError(
        new Error(
          "ChunkLoadError: Failed to load chunk /_next/static/chunks/src_components_teacher.js",
        ),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError("TypeError: Failed to fetch dynamically imported module"),
    ).toBe(true);
    expect(isChunkLoadError(new Error("课堂数据尚未保存"))).toBe(false);
  });

  it("allows one automatic refresh and prevents a reload loop", () => {
    expect(claimChunkRecovery(window.sessionStorage, 1_000)).toBe(true);
    expect(claimChunkRecovery(window.sessionStorage, 1_001)).toBe(false);
    expect(
      claimChunkRecovery(
        window.sessionStorage,
        1_000 + CHUNK_RECOVERY_COOLDOWN_MS + 1,
      ),
    ).toBe(true);
  });

  it("allows future recovery after the reloaded page becomes stable", () => {
    expect(claimChunkRecovery(window.sessionStorage, 1_000)).toBe(true);

    releaseChunkRecovery(window.sessionStorage);

    expect(claimChunkRecovery(window.sessionStorage, 1_001)).toBe(true);
  });
});
