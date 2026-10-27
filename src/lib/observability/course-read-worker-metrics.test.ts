// @vitest-environment node
import { Registry } from "prom-client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sample: vi.fn(), health: vi.fn() }));
vi.mock("@/lib/courses/course-read-worker-pool", () => ({ getCourseReadWorkerPool: () => ({
  config: { count: 2 }, sample: mocks.sample, health: mocks.health,
}) }));
import { registerCourseReadWorkerMetrics } from "./course-read-worker-metrics";
beforeEach(() => {
  mocks.health.mockReturnValue({ enabled: true, ok: false, target: 2, ready: 1, queued: 4, active: 16,
    oldestSeconds: 2.5, restarts: 1, failures: 1 });
  mocks.sample.mockResolvedValue([{ generation: 3, memory: { heapUsed: 100, heapTotal: 200, external: 50, arrayBuffers: 25 },
    threadCpu: { user: 1234, system: 456 }, sampledAtMs: 1700000000123, monotonicNs: "12500000000" }, null]);
});
it("publishes fixed slot labels and unknown samples without duplicating process RSS", async () => {
  const registry = new Registry(); registerCourseReadWorkerMetrics(registry); registerCourseReadWorkerMetrics(registry);
  const text = await registry.metrics();
  expect(text).toContain('openpbl_course_read_worker_memory_bytes{slot="0",kind="heapUsed"} 100');
  expect(text).toContain('openpbl_course_read_worker_memory_bytes{slot="1",kind="heapUsed"} Nan');
  expect(text).toContain('openpbl_course_read_worker_generation{slot="0"} 3');
  expect(text).toContain('openpbl_course_read_worker_sample_time_seconds{slot="0"} 1700000000.123');
  expect(text).toContain('openpbl_course_read_worker_sample_monotonic_seconds{slot="0"} 12.5');
  expect(text).toContain('openpbl_course_read_worker_sample_time_seconds{slot="1"} Nan');
  expect(text).toContain('openpbl_course_read_worker_sample_monotonic_seconds{slot="1"} Nan');
  expect(text).toContain('openpbl_course_read_worker_cpu_microseconds{slot="1",kind="user"} Nan');
  expect(text).toContain('openpbl_course_read_worker_state{state="queued"} 4');
  expect(text).not.toMatch(/userId|requestId|resident_memory|rss_bytes/);
});

it("updates clocks and CPU together and never retains a successful clock after a missing sample", async () => {
  const registry = new Registry(); registerCourseReadWorkerMetrics(registry);
  await registry.metrics();
  mocks.sample.mockResolvedValue([{ generation: 4, memory: { heapUsed: 90, heapTotal: 180, external: 40, arrayBuffers: 20 },
    threadCpu: { user: 10, system: 2 }, sampledAtMs: 1700000005123, monotonicNs: "17500000000" }, null]);
  const next = await registry.metrics();
  expect(next).toContain('openpbl_course_read_worker_generation{slot="0"} 4');
  expect(next).toContain('openpbl_course_read_worker_cpu_microseconds{slot="0",kind="user"} 10');
  expect(next).toContain('openpbl_course_read_worker_sample_time_seconds{slot="0"} 1700000005.123');
  expect(next).toContain('openpbl_course_read_worker_sample_monotonic_seconds{slot="0"} 17.5');
  mocks.sample.mockResolvedValue([null, null]);
  const missing = await registry.metrics();
  expect(missing).toContain('openpbl_course_read_worker_generation{slot="0"} Nan');
  expect(missing).toContain('openpbl_course_read_worker_cpu_microseconds{slot="0",kind="user"} Nan');
  expect(missing).toContain('openpbl_course_read_worker_sample_time_seconds{slot="0"} Nan');
  expect(missing).toContain('openpbl_course_read_worker_sample_monotonic_seconds{slot="0"} Nan');
});

it("keeps malformed and unsupported clock observations unknown rather than fabricating zero", async () => {
  const registry = new Registry(); registerCourseReadWorkerMetrics(registry);
  for (const [wall, monotonic] of [[undefined, undefined], [0, "-1"], [Number.NaN, "Infinity"], [Number.POSITIVE_INFINITY, "1e9"]]) {
    mocks.sample.mockResolvedValue([{ generation: 3, memory: { heapUsed: 100, heapTotal: 200, external: 50, arrayBuffers: 25 },
      threadCpu: null, sampledAtMs: wall, monotonicNs: monotonic }, null]);
    const text = await registry.metrics();
    expect(text).toContain('openpbl_course_read_worker_sample_time_seconds{slot="0"} Nan');
    expect(text).toContain('openpbl_course_read_worker_sample_monotonic_seconds{slot="0"} Nan');
    expect(text).toContain('openpbl_course_read_worker_cpu_microseconds{slot="0",kind="user"} Nan');
  }
});
