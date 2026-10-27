import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { Gauge, type Registry } from "prom-client";

type CpuSource = {
  read: unknown;
  mainThread: boolean;
  epochMilliseconds: () => number;
  monotonicMilliseconds: () => number;
};

export type MainThreadCpuSample = {
  supported: 0 | 1 | null;
  available: 0 | 1;
  userSeconds: number | null;
  systemSeconds: number | null;
  sampleTimeSeconds: number | null;
  sampleMonotonicSeconds: number | null;
};

function unknownSample(): MainThreadCpuSample {
  return { supported: null, available: 0, userSeconds: null, systemSeconds: null,
    sampleTimeSeconds: null, sampleMonotonicSeconds: null };
}

/** One current-thread native probe; never substitute process-wide CPU usage. */
export function sampleMainThreadCpu(source: CpuSource): MainThreadCpuSample {
  const missing = unknownSample();
  try {
    const read = source.read;
    missing.supported = typeof read === "function" ? 1 : 0;
    if (!missing.supported || !source.mainThread) return missing;
    const result: unknown = (read as () => unknown).call(process);
    if (!result || typeof result !== "object") return missing;
    const { user, system } = result as { user?: unknown; system?: unknown };
    if (typeof user !== "number" || !Number.isSafeInteger(user) || user < 0
      || typeof system !== "number" || !Number.isSafeInteger(system) || system < 0) return missing;
    const epoch = source.epochMilliseconds();
    const monotonic = source.monotonicMilliseconds();
    if (!Number.isFinite(epoch) || epoch <= 0 || !Number.isFinite(monotonic) || monotonic < 0) return missing;
    return { supported: 1, available: 1, userSeconds: user / 1e6, systemSeconds: system / 1e6,
      sampleTimeSeconds: epoch / 1000, sampleMonotonicSeconds: monotonic / 1000 };
  } catch {
    return missing;
  }
}

const prefix = "openpbl_process_main_thread_cpu";

/** The usage gauge's synchronous collect updates all companion series together.
 * It is registered first, so a registry scrape observes the same probe for all
 * five families. No timer, process-wide CPU call or per-request observation.
 */
export function registerMainThreadCpuMetrics(
  registry: Registry,
  source: () => CpuSource = () => ({ read: process.threadCpuUsage, mainThread: isMainThread,
    epochMilliseconds: Date.now, monotonicMilliseconds: () => performance.now() }),
) {
  const usage = (registry.getSingleMetric(`${prefix}_seconds`) as Gauge<"mode"> | undefined)
    ?? new Gauge({ name: `${prefix}_seconds`,
      help: "Cumulative native main-thread CPU seconds since process start, by fixed mode. Gauge snapshot, not process-wide CPU or request ownership. Unsupported/failed probes emit no CPU samples; difference only within the same PID/start and advancing sample clock.",
      labelNames: ["mode"] as const, registers: [registry],
      collect() {
        let sample = unknownSample();
        try { sample = sampleMainThreadCpu(source()); }
        catch { /* A diagnostic source must not break the metrics scrape. */ }
        this.reset(); // A failed collect must remove an earlier successful value.
        supported.set(sample.supported ?? Number.NaN);
        available.set(sample.available);
        time.set(sample.sampleTimeSeconds ?? Number.NaN);
        monotonic.set(sample.sampleMonotonicSeconds ?? Number.NaN);
        if (sample.available) {
          this.set({ mode: "user" }, sample.userSeconds!);
          this.set({ mode: "system" }, sample.systemSeconds!);
        }
      },
    });
  const metadata = (suffix: string, help: string) => {
    const name = `${prefix}_${suffix}`;
    const existing = registry.getSingleMetric(name) as Gauge | undefined;
    if (existing) return existing;
    const gauge = new Gauge({ name, help, registers: [registry] });
    gauge.set(Number.NaN); // No collect yet is unknown, never an observed zero.
    return gauge;
  };
  const supported = metadata("supported", "Native process.threadCpuUsage capability at this collection (1/0); missing or uncollected is unknown. Capability does not imply a valid main-thread sample.");
  const available = metadata("sample_available", "Valid current main-thread CPU probe at this collection (1/0). Zero denotes an unknown CPU sample, not zero CPU usage.");
  const time = metadata("sample_time_seconds", "Original Unix time of a successful native main-thread CPU probe; NaN on unsupported/failed probes. Wall time is not the CPU interval denominator.");
  const monotonic = metadata("sample_monotonic_seconds", "Original process-local performance.now seconds of a successful native main-thread CPU probe; NaN on failure. Compare only with the same PID/process start and nondecreasing CPU counters.");
  return { usage, supported, available, time, monotonic };
}
