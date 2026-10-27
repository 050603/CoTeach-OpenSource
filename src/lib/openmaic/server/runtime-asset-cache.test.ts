// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
vi.mock("node:fs/promises", { spy: true });
import {
  coalesceRuntimeAssetRead, createRuntimeAssetBodyCache, locateLocalRuntimeAsset,
  readSmallRuntimeAsset, runtimeAssetEtag, runtimeAssetMatchesIfNoneMatch, SMALL_RUNTIME_ASSET_MAX_BYTES,
} from "./runtime-asset-cache";

describe("immutable runtime inflight reads", () => {
  it("shares a single read among simultaneous requests and releases completed bytes", async () => {
    let finish!: (bytes: Uint8Array) => void;
    const read = vi.fn(() => new Promise<Uint8Array>(resolve => { finish = resolve; }));
    const requests = Array.from({ length: 30 }, () => coalesceRuntimeAssetRead("asset-coalescing", read));
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    const bytes = new Uint8Array([1, 2, 3]); finish(bytes);
    expect(await Promise.all(requests)).toEqual(Array(30).fill(bytes));
    const next = vi.fn(async () => new Uint8Array([4]));
    expect(await coalesceRuntimeAssetRead("asset-coalescing", next)).toEqual(new Uint8Array([4]));
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not retain a rejected read or cross runtime/path keys", async () => {
    const error = new Error("temporarily unavailable");
    const fail = vi.fn(async () => { throw error; });
    await expect(coalesceRuntimeAssetRead("asset-failure", fail)).rejects.toBe(error);
    const success = vi.fn(async () => new Uint8Array([9]));
    expect(await coalesceRuntimeAssetRead("asset-failure", success)).toEqual(new Uint8Array([9]));
    await Promise.all([coalesceRuntimeAssetRead("monaco/path", success), coalesceRuntimeAssetRead("pyodide/path", success)]);
    expect(success).toHaveBeenCalledTimes(3);
  });

  it("shares package file metadata lookups and releases them before a later request", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpbl-runtime-location-"));
    const inspect = vi.mocked(fs.stat); inspect.mockClear();
    try {
      await fs.writeFile(path.join(directory, "large.js"), Buffer.alloc(600_000));
      const pending = Array.from({ length: 30 }, () => locateLocalRuntimeAsset(directory, ["large.js"]));
      const assets = await Promise.all(pending);
      expect(assets).toEqual(Array(30).fill(assets[0]));
      expect(assets[0]).toEqual({ filePath: path.join(directory, "large.js"), size: 600_000, identity: expect.any(String) });
      expect(inspect).toHaveBeenCalledOnce();
      expect(await locateLocalRuntimeAsset(directory, ["large.js"])).toEqual(assets[0]);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(await locateLocalRuntimeAsset(directory, ["..", "outside.js"])).toBeNull();
      expect(inspect).toHaveBeenCalledTimes(2);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

describe("bounded public runtime body cache", () => {
  it("shares concurrent reads, retains an exact allocation, and retries failures", async () => {
    const cache = createRuntimeAssetBodyCache({ maxEntries: 2, maxBytes: 16, maxAssetBytes: 8 });
    let complete!: (value: Uint8Array) => void;
    const load = vi.fn(() => new Promise<Uint8Array>(resolve => { complete = resolve; }));
    const requests = Array.from({ length: 30 }, () => cache.read("version/file/identity", load));
    await Promise.resolve(); expect(load).toHaveBeenCalledOnce();
    expect(cache.snapshot().inFlight).toBe(1);
    const slab = new Uint8Array(100); slab.set([1, 2, 3], 50);
    complete(slab.subarray(50, 53));
    const values = await Promise.all(requests);
    expect(values.every(value => value === values[0])).toBe(true);
    expect(values[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(values[0].buffer.byteLength).toBe(3);
    expect(await cache.read("version/file/identity", load)).toBe(values[0]);
    expect(load).toHaveBeenCalledOnce();
    await expect(cache.read("failure", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(await cache.read("failure", async () => new Uint8Array([4]))).toEqual(new Uint8Array([4]));
    expect(cache.snapshot()).toEqual({ entries: 2, bytes: 4, inFlight: 0 });
  });

  it("evicts by recency at the byte bound and separately enforces the entry bound", async () => {
    const cache = createRuntimeAssetBodyCache({ maxEntries: 3, maxBytes: 5, maxAssetBytes: 4 });
    const load = vi.fn(async () => new Uint8Array([1, 2]));
    await cache.read("a", load); await cache.read("b", load); await cache.read("a", load);
    await cache.read("c", async () => new Uint8Array([3, 4, 5]));
    expect(cache.snapshot()).toEqual({ entries: 2, bytes: 5, inFlight: 0 });
    await cache.read("a", load); expect(load).toHaveBeenCalledTimes(2);
    await cache.read("b", load); expect(load).toHaveBeenCalledTimes(3);
    const countBound = createRuntimeAssetBodyCache({ maxEntries: 1, maxBytes: 20, maxAssetBytes: 8 });
    await countBound.read("a", load); await countBound.read("b", load);
    expect(countBound.snapshot()).toEqual({ entries: 1, bytes: 2, inFlight: 0 });
  });

  it("does not retain files exceeding the per-file or aggregate byte limit", async () => {
    for (const limits of [{ maxBytes: 4, maxAssetBytes: 3 }, { maxBytes: 3, maxAssetBytes: 4 }]) {
      const cache = createRuntimeAssetBodyCache({ maxEntries: 5, ...limits });
      const load = vi.fn(async () => new Uint8Array(4));
      await cache.read("too-large", load); await cache.read("too-large", load);
      expect(load).toHaveBeenCalledTimes(2);
      expect(cache.snapshot()).toEqual({ entries: 0, bytes: 0, inFlight: 0 });
    }
  });

  it("keys real file reads by fresh identity and version, across module evaluations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpbl-runtime-body-"));
    const inspect = vi.mocked(fs.open); inspect.mockClear();
    try {
      await fs.writeFile(path.join(directory, "small.js"), "old");
      const first = (await locateLocalRuntimeAsset(directory, ["small.js"]))!;
      const bodies = await Promise.all(Array.from({ length: 30 }, () => readSmallRuntimeAsset(first, "v1")));
      expect(bodies.every(bytes => bytes === bodies[0])).toBe(true); expect(inspect).toHaveBeenCalledOnce();
      vi.resetModules();
      const otherBundle = await import("./runtime-asset-cache");
      expect(await otherBundle.readSmallRuntimeAsset(first, "v1")).toBe(bodies[0]);
      expect(inspect).toHaveBeenCalledOnce();
      expect(await readSmallRuntimeAsset(first, "v2")).not.toBe(bodies[0]);
      expect(runtimeAssetEtag(first, "v1")).not.toBe(runtimeAssetEtag(first, "v2"));
      await fs.writeFile(path.join(directory, "replacement.js"), "new");
      await fs.rename(path.join(directory, "replacement.js"), path.join(directory, "small.js"));
      const second = (await locateLocalRuntimeAsset(directory, ["small.js"]))!;
      expect(second.size).toBe(first.size); expect(second.identity).not.toBe(first.identity);
      expect(runtimeAssetEtag(second, "v1")).not.toBe(runtimeAssetEtag(first, "v1"));
      expect(new TextDecoder().decode(await readSmallRuntimeAsset(second, "v1"))).toBe("new");
      expect(inspect).toHaveBeenCalledTimes(3);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("does not cache changed files under stale metadata and leaves large files to streaming", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpbl-runtime-change-"));
    try {
      await fs.writeFile(path.join(directory, "small.js"), "before");
      const stale = (await locateLocalRuntimeAsset(directory, ["small.js"]))!;
      await fs.writeFile(path.join(directory, "small.js"), "after");
      await expect(readSmallRuntimeAsset(stale, "v1")).rejects.toMatchObject({ code: "RUNTIME_ASSET_CHANGED" });
      const fresh = (await locateLocalRuntimeAsset(directory, ["small.js"]))!;
      expect(new TextDecoder().decode(await readSmallRuntimeAsset(fresh, "v1"))).toBe("after");
      expect(() => readSmallRuntimeAsset({ ...fresh, size: SMALL_RUNTIME_ASSET_MAX_BYTES + 1 }, "v1")).toThrow(RangeError);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

describe("runtime If-None-Match weak comparison", () => {
  it.each([
    '*', ' \t*\t ', 'W/"current"', '"current"', '"other", W/"current"',
    'W/"quoted,comma", "current"', ', , W/"current",',
  ])("matches a valid conditional field %s", header => {
    expect(runtimeAssetMatchesIfNoneMatch(header, 'W/"current"')).toBe(true);
  });
  it.each([
    null, '', '"other"', 'w/"current"', 'current', 'W/ "current"', '"current" extra',
    '"current", *', '*, "current"', '"current", "unterminated', '"current", "control\x01"',
    '"current"\r\n', '"quoted,comma"',
  ])("does not accept an absent, different, or malformed field %s", header => {
    expect(runtimeAssetMatchesIfNoneMatch(header, 'W/"current"')).toBe(false);
  });
  it("compares a quoted comma inside a complete entity tag", () => {
    expect(runtimeAssetMatchesIfNoneMatch('"other", W/"has,comma"', 'W/"has,comma"')).toBe(true);
  });
});
