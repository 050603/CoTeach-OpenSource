import { Gauge, type Registry } from "prom-client";
import { isMainThread } from "node:worker_threads";
import { getCourseReadWorkerPool } from "@/lib/courses/course-read-worker-pool";

/** RSS already covers every thread. Worker heaps/external allocations are separate samples, never added to RSS. */
export function registerCourseReadWorkerMetrics(registry: Registry): void {
  if (!isMainThread || registry.getSingleMetric("openpbl_course_read_worker_state")) return;
  new Gauge({ name: "openpbl_course_read_worker_state", help: "Read pool state at scrape time; fixed state labels only.",
    labelNames: ["state"] as const, registers: [registry], collect() {
      const state = getCourseReadWorkerPool().health();
      for (const key of ["target", "ready", "queued", "active", "restarts", "failures"] as const) this.set({ state: key }, state[key]);
      this.set({ state: "enabled" }, state.enabled ? 1 : 0); this.set({ state: "healthy" }, state.ok ? 1 : 0);
    } });
  new Gauge({ name: "openpbl_course_read_queue_oldest_seconds", help: "Oldest locally queued course read; only accepted in-process reads are counted.",
    registers: [registry], collect() { this.set(getCourseReadWorkerPool().health().oldestSeconds); } });
  new Gauge({ name: "openpbl_course_read_worker_generation", help: "Current worker generation per fixed slot. CPU differences across generation changes are unknown.",
    labelNames: ["slot"] as const, registers: [registry], async collect() {
      const pool = getCourseReadWorkerPool(); const values = await pool.sample(); this.reset();
      for (let index = 0; index < pool.config.count; index++) this.set({ slot: String(index) }, values[index]?.generation ?? Number.NaN);
    } });
  new Gauge({ name: "openpbl_course_read_worker_sample_time_seconds", help: "Wall clock of the same worker stats sample as generation and cumulative CPU. Missing samples are NaN; this is not a scrape or request timestamp.",
    labelNames: ["slot"] as const, registers: [registry], async collect() {
      const pool = getCourseReadWorkerPool(); const values = await pool.sample(); this.reset();
      for (let index = 0; index < pool.config.count; index++) {
        const time = values[index]?.sampledAtMs;
        this.set({ slot: String(index) }, typeof time === "number" && Number.isFinite(time) && time > 0 ? time / 1000 : Number.NaN);
      }
    } });
  new Gauge({ name: "openpbl_course_read_worker_sample_monotonic_seconds", help: "Native monotonic clock of the same worker stats sample as generation and cumulative CPU. Differences require unchanged app process and worker generation; missing samples are NaN.",
    labelNames: ["slot"] as const, registers: [registry], async collect() {
      const pool = getCourseReadWorkerPool(); const values = await pool.sample(); this.reset();
      for (let index = 0; index < pool.config.count; index++) {
        const text = values[index]?.monotonicNs;
        const time = typeof text === "string" && /^\d+$/.test(text) ? Number(text) / 1e9 : Number.NaN;
        this.set({ slot: String(index) }, Number.isFinite(time) && time >= 0 ? time : Number.NaN);
      }
    } });
  new Gauge({ name: "openpbl_course_read_worker_memory_bytes", help: "Per-thread V8 heap and external allocations; arrayBuffers is a subset of external. Failed or missing samples are NaN. Process RSS must not be summed across threads.",
    labelNames: ["slot", "kind"] as const, registers: [registry], async collect() {
      const pool = getCourseReadWorkerPool();
      const values = await pool.sample(); this.reset();
      for (let index = 0; index < pool.config.count; index++) {
        for (const kind of ["heapUsed", "heapTotal", "external", "arrayBuffers"] as const) {
          this.set({ slot: String(index), kind }, values[index]?.memory[kind] ?? Number.NaN);
        }
      }
    } });
  new Gauge({ name: "openpbl_course_read_worker_cpu_microseconds", help: "Per-thread cumulative native CPU counters; unsupported or missing samples are NaN, not zero. Counter differences need a stable worker generation.",
    labelNames: ["slot", "kind"] as const, registers: [registry], async collect() {
      const pool = getCourseReadWorkerPool();
      const values = await pool.sample(); this.reset();
      for (let index = 0; index < pool.config.count; index++) {
        for (const kind of ["user", "system"] as const) this.set({ slot: String(index), kind }, values[index]?.threadCpu?.[kind] ?? Number.NaN);
      }
    } });
}
