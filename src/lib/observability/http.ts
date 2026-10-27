import { collectProgressTimings, progressServerTimings, type ProgressTimingSpan } from "./progress-request-timing";
import { actionEntryTimingEvidence, isActionTimingRequest, isHttpEntryTimingRequest, NODE_HTTP_REQUEST_ID_HEADER, readNativeHttpRequestId } from "./action-entry-timing";
import { httpOperation, type HttpOperation } from "./http-operation";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  httpOperationDurationSeconds,
  httpApplicationEntryDurationSeconds,
  httpApplicationEntryMeasurementsTotal,
} from "@/lib/observability/metrics";
import { logger } from "@/lib/observability/logger";

export function withHttpMetrics<Args extends [Request, ...unknown[]]>(
  method: string,
  route: string,
  handler: (...args: Args) => Promise<Response>,
  options?: { operation?: HttpOperation | ((request: Args[0], response: Response | undefined) => HttpOperation) },
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const started = performance.now();
    const handlerEnteredAtMs = Date.now();
    const pathname = new URL(args[0].url).pathname;
    const actionTiming = isActionTimingRequest(method, pathname);
    const classroomReadTiming = method === "GET" && [
      "/api/server-providers", "/api/openmaic/classroom", "/api/courses/:courseId/presence",
      "/api/courses/:courseId/state", "/api/courses/:courseId/events", "/api/courses/:courseId/projection",
    ].includes(route);
    const progressTiming = route === "/api/openmaic/progress" && (method === "GET" || method === "POST");
    const entryTiming = isHttpEntryTimingRequest(method, pathname);
    const entryEvidence = entryTiming
      ? actionEntryTimingEvidence(args[0].headers, handlerEnteredAtMs) : undefined;
    const phaseSpans: ProgressTimingSpan[] = [];
    let response: Response | undefined;
    let status = 500;
    try {
      response = await (entryTiming || progressTiming
        ? collectProgressTimings(started, phaseSpans, () => handler(...args))
        : handler(...args));
      status = response.status;
      return response;
    } finally {
      // Capture return/throw before metrics and Pino timestamp generation. This
      // is the Response boundary, not completion of a streamed response body.
      const handlerReturnedAtMs = Date.now();
      const durationSeconds = (performance.now() - started) / 1_000;
      httpRequestsTotal.labels(method, route, String(status)).inc();
      httpRequestDurationSeconds.labels(method, route).observe(durationSeconds);
      try {
        const operation = typeof options?.operation === "function"
          ? options.operation(args[0], response) : options?.operation ?? httpOperation(method, route, status);
        httpOperationDurationSeconds.labels(method, route, operation).observe(durationSeconds);
        if (entryTiming) {
          const nodeReceived = entryEvidence?.epochs.nodeHttpReceivedAtMs;
          // Do not turn an absent/reversed boundary or wall-clock jump into 0.
          // Keep the handler portion monotonic; this still excludes pre-Node wait.
          const measured = nodeReceived !== undefined && handlerReturnedAtMs >= handlerEnteredAtMs
            && Number.isFinite(durationSeconds) && durationSeconds >= 0;
          httpApplicationEntryMeasurementsTotal.labels(method, route, operation, measured ? "measured" : "unknown").inc();
          if (measured) httpApplicationEntryDurationSeconds.labels(method, route, operation)
            .observe((handlerEnteredAtMs - nodeReceived) / 1_000 + durationSeconds);
        }
      } catch { /* Monitoring cannot invalidate a completed save or AI result. */ }
      logger.info(
        {
          requestId: args[0].headers.get("x-request-id") ?? undefined,
          ...(entryTiming ? { httpRequestId: readNativeHttpRequestId(args[0].headers.get(NODE_HTTP_REQUEST_ID_HEADER)) } : {}),
          method,
          route,
          status,
          durationScope: "handler",
          durationMs: Math.round(durationSeconds * 1_000),
          ...(entryTiming ? {
            handlerEnteredAtMs,
            handlerReturnedAtMs,
            // Node receipt and the Next Proxy pair remain individually optional.
            ...entryEvidence?.epochs,
            ...entryEvidence?.connection,
          } : {}),
        },
        "request completed",
      );
      if ((entryTiming || actionTiming || classroomReadTiming || progressTiming) && response) {
        response.headers.append("Server-Timing", [
          ...(entryEvidence?.timings ?? []),
          ...progressServerTimings(phaseSpans),
          `handler;dur=${(durationSeconds * 1_000).toFixed(2)}`,
        ].join(", "));
      }
    }
  };
}
