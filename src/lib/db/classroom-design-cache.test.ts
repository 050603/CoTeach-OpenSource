// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({ classroomTemplateVersion: { findUnique: vi.fn() } }));
vi.mock("./client", () => ({ prisma: database }));
import { createClassroomDesignCache, readClassroomDesign } from "./classroom-design-cache";
import type { Prisma } from "@prisma/client";

const snapshot = (name: string) => ({ schemaVersion: 2, kind: "pbl-course", design: { name, stages: [], content: { knowledgePoints: [{ id: "k", name }] } } });
describe("bounded published classroom designs", () => {
  it("loads a published version once, coalesces misses and isolates every caller's nested objects", async () => {
    const cache = createClassroomDesignCache();
    const query = vi.fn(async () => snapshot("original"));
    const [a, b] = await Promise.all([cache.read("v", query), cache.read("v", query)]);
    expect(query).toHaveBeenCalledOnce();
    a!.content.knowledgePoints[0].name = "changed";
    expect(b!.content.knowledgePoints[0].name).toBe("original");
    expect((await cache.read("v", query))!.content.knowledgePoints[0].name).toBe("original");
    expect(query).toHaveBeenCalledOnce();
  });
  it("evicts by LRU and byte capacity and never caches failures", async () => {
    const cache = createClassroomDesignCache(2, 2048);
    await cache.read("one", async () => snapshot("one"));
    await cache.read("two", async () => snapshot("two"));
    await cache.read("one", async () => { throw new Error("must hit"); });
    await cache.read("three", async () => snapshot("three"));
    const missing = vi.fn(async () => snapshot("two"));
    await cache.read("two", missing); expect(missing).toHaveBeenCalledOnce();
    expect(cache.snapshot().entries).toBe(2);
    const oversized = snapshot("x".repeat(4096));
    await cache.read("big", async () => oversized);
    expect(cache.snapshot().bytes).toBeLessThanOrEqual(2048);
    const broken = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(snapshot("recovered"));
    await expect(cache.read("broken", broken)).rejects.toThrow("db down");
    expect((await cache.read("broken", broken))!.name).toBe("recovered");
  });
  it("always reads drafts freshly and never shares transaction snapshots", async () => {
    const query = vi.fn(async () => ({ snapshot: snapshot(`draft-${query.mock.calls.length}`) }));
    const tx = { classroomTemplateVersion: { findUnique: query } } as unknown as Prisma.TransactionClient;
    const a = await readClassroomDesign(tx, { id: "draft", status: "DRAFT" });
    const b = await readClassroomDesign(tx, { id: "draft", status: "DRAFT" });
    expect(a!.name).not.toBe(b!.name);
    await readClassroomDesign(tx, { id: "published", status: "PUBLISHED" });
    await readClassroomDesign(tx, { id: "published", status: "PUBLISHED" });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("keeps byte accounting bounded when an expired query completes after its replacement", async () => {
    vi.useFakeTimers();
    try {
      const cache = createClassroomDesignCache(2, 4096);
      let finish!: (value: unknown) => void;
      const original = cache.read("version", () => new Promise(resolve => { finish = resolve; }));
      await vi.advanceTimersByTimeAsync(2001);
      await cache.read("version", async () => snapshot("immutable"));
      const before = cache.snapshot();
      finish(snapshot("immutable"));
      await original;
      expect(cache.snapshot()).toEqual(before);
      expect(before.entries).toBe(1);
      expect(before.bytes).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });
});
