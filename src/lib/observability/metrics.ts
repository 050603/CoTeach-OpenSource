// Prometheus metrics (prom-client) for the CoTeach app.
//
// The default Registry is exported for /api/metrics. Custom metrics must be
// reused across Next.js development-module evaluations because prom-client's
// process registry survives Turbopack hot reloads.

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  type Metric,
  Registry,
  register,
} from "prom-client";
import { registerMainThreadCpuMetrics } from "./main-thread-cpu";
import { isMainThread } from "node:worker_threads";
import { registerCourseReadWorkerMetrics } from "./course-read-worker-metrics";

declare global {
  var __openPblDefaultMetricsInitialized: boolean | undefined;
}

if (isMainThread && !globalThis.__openPblDefaultMetricsInitialized) {
  collectDefaultMetrics({
    register: register as Registry,
    eventLoopMonitoringPrecision: 10,
  });
  globalThis.__openPblDefaultMetricsInitialized = true;
}

/**
 * Return the process metric when it already exists, otherwise create it.
 *
 * Without this guard, a Turbopack hot reload can evaluate this module again
 * while prom-client retains its registry. Its constructors then throw
 * "metric ... has already been registered", preventing API routes from loading.
 */
export function getOrCreateRegisteredMetric<T extends Metric>(
  registry: Registry,
  name: string,
  create: () => T,
): T {
  return (registry.getSingleMetric(name) as T | undefined) ?? create();
}

export const httpRequestsTotal = getOrCreateRegisteredMetric(
  register,
  "http_requests_total",
  () =>
    new Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests handled.",
      labelNames: ["method", "route", "status"] as const,
    }),
);

export const httpRequestDurationSeconds = getOrCreateRegisteredMetric(
  register,
  "http_request_duration_seconds",
  () =>
    new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency in seconds.",
      labelNames: ["method", "route"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10],
    }),
);

// Native static responses complete after body transmission to Node's stream,
// unlike the API handler Response-return metrics. Keep the populations separate.
export const staticResourceRequestsTotal = getOrCreateRegisteredMetric(register,
  "openpbl_static_resource_requests_total", () => new Counter({
    name: "openpbl_static_resource_requests_total",
    help: "Pinned static browser resource responses by fixed route and completion outcome; status 0 denotes transport abort, not an HTTP status.",
    labelNames: ["method", "route", "outcome", "status"] as const,
  }));
export const staticResourceDurationSeconds = getOrCreateRegisteredMetric(register,
  "openpbl_static_resource_duration_seconds", () => new Histogram({
    name: "openpbl_static_resource_duration_seconds",
    help: "Monotonic Node parsed-request to native response finish/close seconds. Excludes pre-Node waiting and browser receipt/rendering. Aborted responses have a separate outcome.",
    labelNames: ["method", "route", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 30, 60, 120],
  }));

export const httpOperationDurationSeconds = getOrCreateRegisteredMetric(
  register,
  "openpbl_http_operation_duration_seconds",
  () => new Histogram({
    name: "openpbl_http_operation_duration_seconds",
    help: "Handler response-boundary latency by fixed operation and route; excludes streaming body and client render time.",
    labelNames: ["method", "route", "operation"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 30, 60, 120],
  }),
);

// The native event occurs after HTTP header parsing. These observations do
// not include proxy-to-Node waiting, streaming body transfer or client render.
export const httpApplicationEntryDurationSeconds = getOrCreateRegisteredMetric(register,
  "openpbl_http_application_entry_duration_seconds", () => new Histogram({
    name: "openpbl_http_application_entry_duration_seconds",
    help: "Node parsed HTTP request to Response return: ingress-to-handler wall interval plus monotonic handler duration. Excludes pre-Node waiting, body streaming and client rendering; only validated clocks observed.",
    labelNames: ["method", "route", "operation"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 30, 60, 120],
  }));
export const httpApplicationEntryMeasurementsTotal = getOrCreateRegisteredMetric(register,
  "openpbl_http_application_entry_measurements_total", () => new Counter({
    name: "openpbl_http_application_entry_measurements_total",
    help: "Clock availability for completed handlers on explicitly timed routes, measured or unknown. Untimed routes emit nothing; absent/reset/zero-traffic coverage is unknown, never a zero-latency observation.",
    labelNames: ["method", "route", "operation", "measurement"] as const,
  }));

// prom-client reports external memory on supported Node releases; keep explicit
// samples for the classroom diagnosis, including ArrayBuffer-backed file bodies.
export const processExternalMemoryBytes = getOrCreateRegisteredMetric(register, "openpbl_process_external_memory_bytes",
  () => new Gauge({ name: "openpbl_process_external_memory_bytes", help: "Main Node.js thread external memory at scrape time; worker allocations are sampled separately.",
    collect() { this.set(process.memoryUsage().external); } }));
export const processArrayBufferBytes = getOrCreateRegisteredMetric(register, "openpbl_process_array_buffer_bytes",
  () => new Gauge({ name: "openpbl_process_array_buffer_bytes", help: "Main Node.js thread ArrayBuffer and Buffer memory at scrape time (a subset of external memory); worker allocations are sampled separately.",
    collect() { this.set(process.memoryUsage().arrayBuffers); } }));

registerMainThreadCpuMetrics(register);
registerCourseReadWorkerMetrics(register);

export const documentReviewLeaseRecoveriesTotal = getOrCreateRegisteredMetric(register, "openpbl_document_review_lease_recoveries_total",
  () => new Counter({ name: "openpbl_document_review_lease_recoveries_total", help: "Expired durable review leases successfully returned to the execution queue." }));

const documentReviewLifecycleEvents = ['enqueued', 'resumed', 'prepared_commit_retry', 'prepared_commit_failed', 'completed', 'completed_recovered'] as const;
const documentReviewLifecycleTotal = getOrCreateRegisteredMetric(register, 'openpbl_document_review_lifecycle_total', () => {
  const counter = new Counter({ name: 'openpbl_document_review_lifecycle_total',
    help: 'Durable review lifecycle: enqueue/resume/completion count after commit; prepared commit retry/failure count execution boundaries. completed_recovered is a completed subset with attemptCount > 1, not a model retry count.',
    labelNames: ['event'] as const });
  for (const event of documentReviewLifecycleEvents) counter.inc({ event }, 0);
  return counter;
});
export function recordDocumentReviewLifecycle(event: typeof documentReviewLifecycleEvents[number]): void {
  try { documentReviewLifecycleTotal.inc({ event }); } catch { /* Diagnostics cannot trigger another execution. */ }
}

export const llmCallsTotal = getOrCreateRegisteredMetric(
  register,
  "llm_calls_total",
  () =>
    new Counter({
      name: "llm_calls_total",
      help: "Total number of LLM API calls.",
      labelNames: ["provider", "model", "status"] as const,
    }),
);

export const llmCallDurationSeconds = getOrCreateRegisteredMetric(
  register,
  "llm_call_duration_seconds",
  () =>
    new Histogram({
      name: "llm_call_duration_seconds",
      help: "LLM API call latency in seconds.",
      labelNames: ["provider", "model"] as const,
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    }),
);

export const llmTokensTotal = getOrCreateRegisteredMetric(
  register,
  "llm_tokens_total",
  () =>
    new Counter({
      name: "llm_tokens_total",
      help: "Total tokens consumed by LLM calls.",
      labelNames: ["provider", "model", "type"] as const,
    }),
);

export const ttsRequestsTotal = getOrCreateRegisteredMetric(
  register,
  "tts_requests_total",
  () =>
    new Counter({
      name: "tts_requests_total",
      help: "Total number of TTS requests.",
      labelNames: ["provider", "status"] as const,
    }),
);

export const websocketConnectionsActive = getOrCreateRegisteredMetric(
  register,
  "websocket_connections_active",
  () =>
    new Gauge({
      name: "websocket_connections_active",
      help: "Number of currently active WebSocket connections.",
    }),
);

export const classroomActiveTotal = getOrCreateRegisteredMetric(
  register,
  "classroom_active_total",
  () =>
    new Gauge({
      name: "classroom_active_total",
      help: "Number of currently active classrooms.",
    }),
);

export const studentsOnlineTotal = getOrCreateRegisteredMetric(
  register,
  "students_online_total",
  () =>
    new Gauge({
      name: "students_online_total",
      help: "Number of students currently online.",
    }),
);

export const dbQueryDurationSeconds = getOrCreateRegisteredMetric(
  register,
  "db_query_duration_seconds",
  () =>
    new Histogram({
      name: "db_query_duration_seconds",
      help: "Database query latency in seconds.",
      labelNames: ["operation"] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    }),
);

export { register };
