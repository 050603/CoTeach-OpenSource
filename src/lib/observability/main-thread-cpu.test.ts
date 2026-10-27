// @vitest-environment node
import { isMainThread } from "node:worker_threads";
import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import { registerMainThreadCpuMetrics, sampleMainThreadCpu } from "./main-thread-cpu";
import { parseResourceSample } from "../../../scripts/lib/classroom-acceptance-soak.mjs";

const source = (read: unknown = () => ({ user: 1_250_000, system: 250_000 })) => ({
  read, mainThread: true, epochMilliseconds: () => 1_700_000_000_123, monotonicMilliseconds: () => 12_345,
});

describe("native main-thread CPU sampling", () => {
  it("retains cumulative user/system readings and the original clocks in seconds", () => {
    const read = vi.fn(() => ({ user: 1_250_000, system: 250_000 }));
    expect(sampleMainThreadCpu(source(read))).toEqual({ supported: 1, available: 1,
      userSeconds: 1.25, systemSeconds: 0.25, sampleTimeSeconds: 1_700_000_000.123, sampleMonotonicSeconds: 12.345 });
    expect(read).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not substitute process CPU when the native API is absent or this is a worker thread", () => {
    for (const read of [undefined, null, 123]) {
      expect(sampleMainThreadCpu({ ...source(), read })).toEqual({ supported: 0, available: 0,
        userSeconds: null, systemSeconds: null, sampleTimeSeconds: null, sampleMonotonicSeconds: null });
    }
    const read = vi.fn(() => ({ user: 10, system: 1 }));
    expect(sampleMainThreadCpu({ ...source(read), mainThread: false })).toMatchObject({ supported: 1, available: 0, userSeconds: null });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { user: 1 }, { user: "1", system: 0 }, { user: NaN, system: 0 },
    { user: Infinity, system: 0 }, { user: -1, system: 0 }, { user: 0, system: -1 },
    { user: 0, system: 0.5 }, { user: Number.MAX_SAFE_INTEGER + 1, system: 0 }])("keeps invalid native output unknown (%j)", result => {
    expect(sampleMainThreadCpu(source(() => result))).toMatchObject({ supported: 1, available: 0,
      userSeconds: null, systemSeconds: null, sampleTimeSeconds: null, sampleMonotonicSeconds: null });
  });

  it("keeps native exceptions and invalid/throwing clocks unknown", () => {
    expect(sampleMainThreadCpu(source(() => { throw new Error("native failure"); }))).toMatchObject({ supported: 1, available: 0, userSeconds: null });
    for (const clock of [() => NaN, () => Infinity, () => -1, () => { throw new Error("clock failure"); }]) {
      expect(sampleMainThreadCpu({ ...source(), epochMilliseconds: clock })).toMatchObject({ available: 0, sampleTimeSeconds: null });
      expect(sampleMainThreadCpu({ ...source(), monotonicMilliseconds: clock })).toMatchObject({ available: 0, sampleMonotonicSeconds: null });
    }
  });

  it("distinguishes a real zero CPU reading from a missing sample", () => {
    expect(sampleMainThreadCpu(source(() => ({ user: 0, system: 0 })))).toMatchObject({ supported: 1, available: 1, userSeconds: 0, systemSeconds: 0 });
  });
});

describe("main-thread CPU metric collection", () => {
  const name = "openpbl_process_main_thread_cpu";
  it("uses one native probe per registry collection and updates all companion series together", async () => {
    const registry = new Registry();
    const read = vi.fn().mockReturnValueOnce({ user: 2_000_000, system: 250_000 })
      .mockReturnValueOnce({ user: 3_000_000, system: 500_000 });
    let now = 1000;
    const metrics = registerMainThreadCpuMetrics(registry, () => ({ ...source(read),
      epochMilliseconds: () => now * 1000, monotonicMilliseconds: () => now }));
    expect((await metrics.available.get()).values[0].value).toBeNaN();
    const first = await registry.getMetricsAsJSON();
    expect(read).toHaveBeenCalledTimes(1);
    expect(first.find(metric => metric.name === `${name}_seconds`)).toMatchObject({ type: "gauge", values: [
      { labels: { mode: "user" }, value: 2 }, { labels: { mode: "system" }, value: 0.25 },
    ] });
    expect(first.find(metric => metric.name === `${name}_sample_available`)?.values[0].value).toBe(1);
    expect(first.find(metric => metric.name === `${name}_sample_time_seconds`)?.values[0].value).toBe(1000);
    now = 2000;
    const second = await registry.getMetricsAsJSON();
    expect(read).toHaveBeenCalledTimes(2);
    expect(second.find(metric => metric.name === `${name}_seconds`)?.values.map(value => value.value)).toEqual([3, 0.5]);
    expect(second.find(metric => metric.name === `${name}_sample_time_seconds`)?.values[0].value).toBe(2000);
    expect(second.find(metric => metric.name === `${name}_sample_monotonic_seconds`)?.values[0].value).toBe(2);
  });

  it("removes old CPU values on exceptions, missing APIs and invalid results without stale successful metadata", async () => {
    const registry = new Registry();
    let read: unknown = () => ({ user: 1_000_000, system: 0 });
    const metrics = registerMainThreadCpuMetrics(registry, () => ({ ...source(), read }));
    await registry.metrics();
    for (const failure of [() => { throw new Error("native failure"); }, () => ({ user: NaN, system: 0 }), undefined]) {
      read = failure;
      const observed = await registry.getMetricsAsJSON();
      expect(observed.find(metric => metric.name === `${name}_seconds`)?.values).toEqual([]);
      expect(observed.find(metric => metric.name === `${name}_supported`)?.values[0].value).toBe(typeof failure === "function" ? 1 : 0);
      expect(observed.find(metric => metric.name === `${name}_sample_available`)?.values[0].value).toBe(0);
      expect(observed.find(metric => metric.name === `${name}_sample_time_seconds`)?.values[0].value).toBeNaN();
      expect(observed.find(metric => metric.name === `${name}_sample_monotonic_seconds`)?.values[0].value).toBeNaN();
      // Companion-only reads cannot resurrect the prior successful sample.
      expect((await metrics.available.get()).values[0].value).toBe(0);
    }
    read = () => ({ user: 2_000_000, system: 100_000 });
    expect(await registry.metrics()).toContain(`${name}_seconds{mode="user"} 2`);
  });

  it("reuses registration across module evaluations without taking a second probe", async () => {
    const registry = new Registry(); const read = vi.fn(() => ({ user: 1, system: 2 }));
    const first = registerMainThreadCpuMetrics(registry, () => source(read));
    const second = registerMainThreadCpuMetrics(registry, () => { throw new Error("duplicate collector"); });
    expect(second.usage).toBe(first.usage);
    expect(second.available).toBe(first.available);
    await registry.metrics();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps source factory/property failures unknown without failing the scrape or retaining old CPU values", async () => {
    const registry = new Registry();
    let provider = () => source();
    registerMainThreadCpuMetrics(registry, () => provider());
    await registry.metrics();
    for (const failure of [() => { throw new Error("source factory failure"); },
      () => ({ ...source(), get read() { throw new Error("native property inaccessible"); } })]) {
      provider = failure;
      const observed = await registry.getMetricsAsJSON();
      expect(observed.find(metric => metric.name === `${name}_seconds`)?.values).toEqual([]);
      expect(observed.find(metric => metric.name === `${name}_supported`)?.values[0].value).toBeNaN();
      expect(observed.find(metric => metric.name === `${name}_sample_available`)?.values[0].value).toBe(0);
      expect(observed.find(metric => metric.name === `${name}_sample_time_seconds`)?.values[0].value).toBeNaN();
      expect(observed.find(metric => metric.name === `${name}_sample_monotonic_seconds`)?.values[0].value).toBeNaN();
    }
    provider = () => source();
    expect(await registry.metrics()).toContain(`${name}_seconds{mode="user"} 1.25`);
  });

  it("uses actual runtime capability without a Node-version assumption or process-wide fallback", async () => {
    const registry = new Registry(); registerMainThreadCpuMetrics(registry);
    const observed = await registry.getMetricsAsJSON();
    expect(observed.find(metric => metric.name === `${name}_supported`)?.values[0].value).toBe(typeof process.threadCpuUsage === "function" ? 1 : 0);
    const usage = observed.find(metric => metric.name === `${name}_seconds`);
    if (typeof process.threadCpuUsage === "function" && isMainThread) {
      expect(usage?.values).toHaveLength(2);
      expect(usage?.values.every(value => Number.isFinite(value.value) && value.value >= 0)).toBe(true);
    } else expect(usage?.values).toEqual([]);
  });

  it("preserves original native readings/clocks through the existing resource-snapshot parser", async () => {
    const registry = new Registry();
    registerMainThreadCpuMetrics(registry, () => source());
    const values = parseResourceSample(await registry.metrics());
    expect(values.mainThreadCpu).toEqual({ status: "measured", supported: true, sampleAvailable: true,
      userSeconds: 1.25, systemSeconds: 0.25, sampleTimeSeconds: 1_700_000_000.123, sampleMonotonicSeconds: 12.345 });
    expect(values).toHaveProperty("process_start_time_seconds", null); // No invented identity from a CPU probe.
  });
});
