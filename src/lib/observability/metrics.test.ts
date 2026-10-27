import { Counter, Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import { getOrCreateRegisteredMetric, register } from "./metrics";

describe("getOrCreateRegisteredMetric", () => {
  it("reuses an existing process metric instead of registering it twice", () => {
    const registry = new Registry();
    const create = vi.fn(
      () =>
        new Counter({
          name: "openpbl_test_requests_total",
          help: "Test request total.",
          registers: [registry],
        }),
    );

    const first = getOrCreateRegisteredMetric(
      registry,
      "openpbl_test_requests_total",
      create,
    );
    const second = getOrCreateRegisteredMetric(
      registry,
      "openpbl_test_requests_total",
      create,
    );

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

it("registers the main-thread probe in the actual application metrics registry", async () => {
  const text = await register.getSingleMetricAsString("openpbl_process_main_thread_cpu_seconds");
  expect(text).toContain("# TYPE openpbl_process_main_thread_cpu_seconds gauge");
  const available = register.getSingleMetric("openpbl_process_main_thread_cpu_sample_available");
  const sample = await available!.get();
  expect([0, 1]).toContain(sample.values[0].value);
  if (sample.values[0].value === 0) expect(text).not.toMatch(/^openpbl_process_main_thread_cpu_seconds\{/m);
  else expect(text).toMatch(/^openpbl_process_main_thread_cpu_seconds\{mode="user"\} [\d.e+-]+$/m);
});
