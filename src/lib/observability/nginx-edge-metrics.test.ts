import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Histogram } from "prom-client";
import { register } from "./metrics";
import { closeNginxEdgeMetrics, initializeNginxEdgeMetrics, refreshNginxEdgeMetrics } from "./nginx-edge-metrics";

test("initializes fixed empty series and preserves the whole first thirty-request burst before any scrape", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpbl-edge-first-scrape-"));
  const file = path.join(directory, "current.ndjson"); const previous = process.env.OPENPBL_NGINX_EDGE_LOG;
  assert.equal(globalThis.__openPblNginxEdgeReader, undefined);
  process.env.OPENPBL_NGINX_EDGE_LOG = file; await writeFile(file, "");
  const histogram = register.getSingleMetric("openpbl_edge_request_duration_seconds") as Histogram<"method" | "route" | "operation" | "outcome">;
  const sample = async (metricName: string, le?: string) => (await histogram.get()).values.find(value =>
    value.metricName === metricName && value.labels.route === "/api/server-providers"
      && value.labels.method === "GET" && value.labels.outcome === "success"
      && (le === undefined || String("le" in value.labels ? value.labels.le : undefined) === le));
  try {
    await initializeNginxEdgeMetrics();
    // Zero counts describe no observations, never a fabricated0-second latency.
    assert.equal((await sample("openpbl_edge_request_duration_seconds_count"))?.value, 0);
    assert.equal((await sample("openpbl_edge_request_duration_seconds_bucket", "1"))?.value, 0);
    const baseline = await register.getSingleMetric("openpbl_edge_log_scope_started_seconds")!.get();
    assert.ok(Number.isFinite(baseline.values[0].value));
    const row = JSON.stringify({ version: 1, atSeconds: (Date.now() / 1000).toFixed(3), requestSeconds: "1.800",
      method: "GET", route: "/api/server-providers", status: 200 }) + "\n";
    await appendFile(file, row.repeat(30));
    // No Prometheus scrape has happened before this whole completed burst.
    await refreshNginxEdgeMetrics();
    assert.equal((await sample("openpbl_edge_request_duration_seconds_count"))?.value, 30);
    assert.equal((await sample("openpbl_edge_request_duration_seconds_bucket", "1"))?.value, 0);
    assert.ok(Math.abs((await sample("openpbl_edge_request_duration_seconds_sum"))!.value - 54) < 0.00001);
    await initializeNginxEdgeMetrics(); await refreshNginxEdgeMetrics();
    assert.equal((await sample("openpbl_edge_request_duration_seconds_count"))?.value, 30);
  } finally {
    await closeNginxEdgeMetrics(); delete globalThis.__openPblNginxEdgeReader;
    if (previous === undefined) delete process.env.OPENPBL_NGINX_EDGE_LOG; else process.env.OPENPBL_NGINX_EDGE_LOG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
