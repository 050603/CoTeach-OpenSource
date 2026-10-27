import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { STATIC_MONACO_ROUTE } from "./action-entry-timing";
import { logger } from "./logger";
import { staticResourceDurationSeconds, staticResourceRequestsTotal } from "./metrics";
import { withRequestContext } from "./request-id";

type NativeEvidence = {
  httpRequestId?: string;
  nodeHttpReceivedAtMs: number;
  nodeSocketAcceptedAtMs?: number;
  nodeHttpLocalPort?: number;
  nodeConnectionId: number;
};

/** Own only weak references while responses are active. finish/close removes
 * both listeners and the weak entry; stop removes listeners even on stalled
 * responses, so restarting cannot publish an old epoch or duplicate a sample.
 */
export function createStaticResourceTiming() {
  const pending = new Set<WeakRef<ServerResponse>>();
  const cleanups = new WeakMap<ServerResponse, () => void>();
  return {
    observe(request: IncomingMessage, response: ServerResponse, evidence: NativeEvidence, started: number) {
      if (cleanups.has(response)) return;
      const method = request.method === "HEAD" ? "HEAD" : "GET";
      const supplied = request.headers["x-request-id"];
      // A trace is a bounded identifier, never a URL, arbitrary header or body.
      const requestId = typeof supplied === "string" && /^(?:acceptance-[a-f0-9]{8}-\d{1,16}-\d{1,16}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(supplied)
        ? supplied : randomUUID();
      const weak = new WeakRef(response);
      let settled = false;
      function cleanup() {
        settled = true;
        response.off("finish", onFinish);
        response.off("close", onClose);
        pending.delete(weak);
        cleanups.delete(response);
      }
      function settle(outcome: "completed" | "aborted") {
        if (settled) return;
        const endedAt = Date.now();
        const durationSeconds = (performance.now() - started) / 1000;
        cleanup();
        const status = outcome === "completed" ? response.statusCode : 0;
        const record = {
          requestId, method, route: STATIC_MONACO_ROUTE, outcome, status,
          durationScope: "node-parsed-to-response-finish",
          durationMs: Math.round(durationSeconds * 1000), ...evidence,
          ...(outcome === "completed" ? { nodeResponseFinishedAtMs: endedAt }
            : { nodeResponseClosedAtMs: endedAt, ...(response.headersSent ? { receivedHttpStatus: response.statusCode } : {}) }),
        };
        try {
          staticResourceRequestsTotal.labels(method, STATIC_MONACO_ROUTE, outcome, String(status)).inc();
          if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
            staticResourceDurationSeconds.labels(method, STATIC_MONACO_ROUTE, outcome).observe(durationSeconds);
          }
        } catch { /* Monitoring must not interrupt the response lifecycle. */ }
        try {
          // A finish listener can run under a later handler's async context.
          // Do not inherit its student/course identity into a public asset log.
          withRequestContext({ traceId: requestId }, () => logger.info(record, "request completed"));
        } catch { /* Logging must not interrupt the response lifecycle. */ }
      }
      function onFinish() { settle("completed"); }
      function onClose() { settle(response.writableFinished ? "completed" : "aborted"); }
      pending.add(weak);
      cleanups.set(response, cleanup);
      response.once("finish", onFinish);
      response.once("close", onClose);
    },
    stop() {
      for (const reference of pending) {
        const response = reference.deref();
        if (response) cleanups.get(response)?.();
      }
      pending.clear();
    },
  };
}
