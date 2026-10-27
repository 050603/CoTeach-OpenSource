import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Counter, Gauge, Histogram } from "prom-client";
import { getOrCreateRegisteredMetric, register } from "./metrics";
import { EdgeLogReader, edgeOperation, waitForEdgeOperation, type EdgeObservation } from "./edge-log-reader";

const duration = getOrCreateRegisteredMetric(register, "openpbl_edge_request_duration_seconds", () => {
  const histogram = new Histogram({
  name: "openpbl_edge_request_duration_seconds",
  help: "Nginx first client bytes to log after last response bytes, from trusted local logs. Includes pre-Node wait/upload/send; excludes browser pre-send/render. Known samples only; port3000 bypass and missing logs remain unknown.",
  labelNames: ["method", "route", "operation", "outcome"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 30, 60, 120, 600],
});
  // Preinitialize only fixed successful SLO series. zero() must run only in
  // this registry-creation factory: calling it on a reused metric loses data.
  const readRoutes = ["/api/server-providers", "/api/courses", "/api/openmaic/classroom", "/api/openmaic/progress",
    "/api/ai-collaboration/code", "/api/ai-collaboration/document", "/api/ai-collaboration/memory",
    ...["state", "events", "projection", "presence", "public-discussion"].map(name => `/api/courses/:courseId/${name}`)];
  const series = readRoutes.flatMap(route => ["GET", "HEAD"].map(method => ({ route, method })));
  series.push(...["/api/openmaic/progress", "/api/learning-events", "/api/courses/:courseId/actions"]
    .map(route => ({ route, method: "POST" })),
  ...["PUT", "DELETE"].map(method => ({ route: "/api/courses/:courseId/presence", method })));
  for (const { route, method } of series) histogram.zero({ route, method, operation: edgeOperation(method, route), outcome: "success" });
  return histogram;
});
const requests = getOrCreateRegisteredMetric(register, "openpbl_edge_requests_total", () => new Counter({
  name: "openpbl_edge_requests_total", help: "Observed Nginx log completions by bounded route/method/operation/outcome/status class; no route coverage is inferred from absence.",
  labelNames: ["method", "route", "operation", "outcome", "status_class"] as const,
}));
const metric = (name: string, help: string) => getOrCreateRegisteredMetric(register, name, () => new Gauge({ name, help }));
const configured = metric("openpbl_edge_log_configured", "1 when the app has an explicit edge log path, 0 when unconfigured. This does not prove all clients traverse Nginx.");
const available = metric("openpbl_edge_log_collection_available", "1 when local log collection has caught up with no known recent gap/incomplete line;0 means incomplete/failed;NaN means unconfigured. No-traffic latency and direct3000 coverage remain unknown.");
const backlog = metric("openpbl_edge_log_backlog_bytes", "Unconsumed bytes in the held local log file;NaN when unconfigured/unavailable. Not a traffic count.");
const started = metric("openpbl_edge_log_scope_started_seconds", "EOF-baseline initialization began at this epoch (conservative lower bound);earlier history is outside scope. NaN until initialized.");
const refreshed = metric("openpbl_edge_log_last_refresh_seconds", "Last completed local-file refresh epoch;NaN before a usable refresh. Independent of whether traffic exists.");
const gaps = metric("openpbl_edge_log_known_gaps", "Process-lifetime known collection discontinuities, including conservative rename/reopen uncertainty. Resets on app restart;not lost-request cardinality.");
const invalid = metric("openpbl_edge_log_invalid_records", "Process-lifetime rejected bounded log lines, never coerced into zero duration.");
const maintenance = metric("openpbl_edge_log_maintenance_available", "1 for a fresh valid local rotation heartbeat,0 missing/stale/failed,NaN when edge logging is unconfigured. Does not replace filesystem free-space monitoring.");

function observe(row: EdgeObservation): void {
  const outcome = row.status === 499 ? "client-abort" : row.status >= 200 && row.status < 400 ? "success" : "http-error";
  duration.labels(row.method, row.route, row.operation, outcome).observe(row.seconds);
  requests.labels(row.method, row.route, row.operation, outcome, `${Math.floor(row.status / 100)}xx`).inc();
}
declare global {
  var __openPblNginxEdgeReader: EdgeLogReader | undefined;
  var __openPblNginxEdgeMaintenanceRefresh: Promise<void> | undefined;
}
function reader(): EdgeLogReader {
  return globalThis.__openPblNginxEdgeReader ??= new EdgeLogReader(process.env.OPENPBL_NGINX_EDGE_LOG?.trim(), observe);
}
function publish(): void {
  const s = reader().snapshot();
  configured.set(s.configured ? 1 : 0); available.set(s.collectionAvailable);
  backlog.set(s.configured && s.initialized ? s.backlogBytes : Number.NaN);
  started.set(s.startedAtMs === null ? Number.NaN : s.startedAtMs / 1000);
  refreshed.set(s.refreshedAtMs === null ? Number.NaN : s.refreshedAtMs / 1000);
  gaps.set(s.gaps); invalid.set(s.invalidRecords);
}
async function collectMaintenance(): Promise<void> {
  const file = process.env.OPENPBL_NGINX_EDGE_LOG?.trim();
  if (!file) { maintenance.set(Number.NaN); return; }
  let handle;
  try {
    handle = await open(path.join(path.dirname(file), "maintenance.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > 4096) throw new Error("invalid_maintenance_file");
    const bytes = Buffer.alloc(stats.size); const result = await handle.read(bytes, 0, bytes.length, 0);
    const data = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8"));
    const age = Date.now() - data.updatedAtMs;
    maintenance.set(data.version === 1 && data.ok === true && data.maxBytes === 52428800
      && data.retained === 5 && Number.isSafeInteger(data.updatedAtMs) && age >= 0 && age < 90_000 ? 1 : 0);
  } catch { maintenance.set(0); }
  finally { await handle?.close().catch(() => undefined); }
}
function refreshMaintenance(): Promise<void> {
  return globalThis.__openPblNginxEdgeMaintenanceRefresh ??= collectMaintenance()
    .finally(() => { globalThis.__openPblNginxEdgeMaintenanceRefresh = undefined; });
}
export async function initializeNginxEdgeMetrics(): Promise<void> {
  await waitForEdgeOperation(reader().initialize(), () => reader().markUnavailable()); publish();
}
export async function refreshNginxEdgeMetrics(): Promise<void> {
  // Monitoring must never invalidate a completed save or the rest of /metrics.
  try {
    await waitForEdgeOperation(Promise.all([reader().refresh(), refreshMaintenance()]), () => reader().markUnavailable());
    publish();
  }
  catch { available.set(0); }
}
export async function closeNginxEdgeMetrics(): Promise<void> {
  await waitForEdgeOperation(reader().close(), () => {});
}
