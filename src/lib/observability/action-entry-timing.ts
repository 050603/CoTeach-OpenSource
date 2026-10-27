// Diagnostic metadata only. It never participates in authentication or access.
export const ACTION_PROXY_STARTED_HEADER = "x-openpbl-action-proxy-started";
export const ACTION_PROXY_ENDED_HEADER = "x-openpbl-action-proxy-ended";
export const NODE_HTTP_RECEIVED_HEADER = "x-openpbl-http-received-at";
export const NODE_SOCKET_ACCEPTED_HEADER = "x-openpbl-socket-accepted-at";
export const NODE_HTTP_LOCAL_PORT_HEADER = "x-openpbl-http-local-port";
export const NODE_CONNECTION_ID_HEADER = "x-openpbl-connection-id";
export const NODE_HTTP_REQUEST_ID_HEADER = "x-openpbl-http-request-id";

/** Native per-attempt correlation only; never an identity or authorization token. */
export function readNativeHttpRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^http-[a-f0-9]{32}-[1-9][0-9]{0,15}$(?![\s\S])/.test(value)) return undefined;
  return Number.isSafeInteger(Number(value.slice(38))) ? value : undefined;
}

export const STATIC_MONACO_ROUTE = "/_next/static/openpbl-runtime/monaco/:version/:fingerprint/:path";

export function isStaticMonacoTimingRequest(method: string, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") && pathname.length <= 2048
    && /^\/_next\/static\/openpbl-runtime\/monaco\/\d{1,6}\.\d{1,6}\.\d{1,6}\/[a-f0-9]{64}\/vs\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(pathname);
}

export function isActionTimingRequest(method: string, pathname: string): boolean {
  return method === "POST" && /^\/api\/courses\/[^/]+\/actions\/?$/.test(pathname);
}

/** Bound diagnostic scope. These are Next routing/auth Proxy clocks, not the
 * acceptance HTTP reverse proxy. This allowlist grants no access.
 */
export function isHttpEntryTimingRequest(method: string, pathname: string): boolean {
  if (isActionTimingRequest(method, pathname)) return true;
  if (isStaticMonacoTimingRequest(method, pathname)) return true;
  if (method === "GET" && /^\/api\/courses\/[^/]+\/showcase\/(presentation|artifacts\/export|artifacts\/[^/]+)\/?$/.test(pathname)) return true;
  if (method === "GET" && /^\/api\/openmaic\/interactive-runtime\/(monaco|codemirror|katex|pyodide|three)\/.+/.test(pathname)) return true;
  if (["PUT", "DELETE"].includes(method) && /^\/api\/courses\/[^/]+\/presence\/?$/.test(pathname)) return true;
  if (method === "GET" && /^\/api\/courses\/[^/]+\/public-discussion\/?$/.test(pathname)) return true;
  // Media timing stops when its Response is returned, before stream consumption.
  if (method === "GET" && /^\/api\/openmaic\/classroom-media\/[^/]+\/.+/.test(pathname)) return true;
  if (pathname === "/api/openmaic/progress") return method === "GET" || method === "POST";
  if (pathname === "/api/learning-events" || pathname === "/api/project-practice/submissions/finalize") return method === "POST";
  if (/^\/api\/ai-collaboration\/(document|code|memory)\/?$/.test(pathname)) return method === "GET" || method === "POST";
  return method === "GET" && (
    ["/api/server-providers", "/api/openmaic/classroom", "/api/courses"].includes(pathname)
    || /^\/api\/courses\/[^/]+\/(presence|state|events|projection)\/?$/.test(pathname)
  );
}

/** Node overwrites its clock and Proxy overwrites its pair. All are diagnostic
 * wall clocks only; performance.now remains the handler duration clock. Missing
 * or invalid boundaries stay absent, independently of other measured boundaries.
 */
export function actionEntryTimingEvidence(headers: Headers, routeEnteredAt: number): {
  epochs: { nodeHttpReceivedAtMs?: number; nodeSocketAcceptedAtMs?: number; nextProxyStartedAtMs?: number; nextProxyEndedAtMs?: number };
  connection?: { nodeHttpLocalPort?: number; nodeConnectionId?: number };
  timings: string[];
} | undefined {
  if (!Number.isSafeInteger(routeEnteredAt) || routeEnteredAt <= 0) return undefined;
  const start = Number(headers.get(ACTION_PROXY_STARTED_HEADER));
  const end = Number(headers.get(ACTION_PROXY_ENDED_HEADER));
  const validProxy = Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end > 0
    && end >= start && routeEnteredAt >= end && routeEnteredAt - start <= 120_000;
  const node = Number(headers.get(NODE_HTTP_RECEIVED_HEADER));
  const validNode = Number.isSafeInteger(node) && node > 0 && node <= routeEnteredAt
    && routeEnteredAt - node <= 120_000 && (!validProxy || node <= start);
  if (!validProxy && !validNode) return undefined;
  const accepted = Number(headers.get(NODE_SOCKET_ACCEPTED_HEADER));
  // A reused connection may predate this request by hours. Its age includes
  // idle time and earlier requests; it is not solely this request's queue wait.
  const validAccepted = validNode && Number.isSafeInteger(accepted) && accepted > 0 && accepted <= node;
  const port = Number(headers.get(NODE_HTTP_LOCAL_PORT_HEADER));
  const connectionId = Number(headers.get(NODE_CONNECTION_ID_HEADER));
  const validPort = validNode && Number.isSafeInteger(port) && port > 0 && port <= 65535;
  const validConnectionId = validNode && Number.isSafeInteger(connectionId) && connectionId > 0;
  const connection = {
    ...(validPort ? { nodeHttpLocalPort: port } : {}),
    ...(validConnectionId ? { nodeConnectionId: connectionId } : {}),
  };
  return {
    epochs: {
      ...(validNode ? { nodeHttpReceivedAtMs: node } : {}),
      ...(validAccepted ? { nodeSocketAcceptedAtMs: accepted } : {}),
      ...(validProxy ? { nextProxyStartedAtMs: start, nextProxyEndedAtMs: end } : {}),
    },
    ...(validPort || validConnectionId ? { connection } : {}),
    timings: [
      ...(validNode && validProxy ? [`node-dispatch;dur=${(start - node).toFixed(2)}`] : []),
      ...(validProxy ? [`proxy;dur=${(end - start).toFixed(2)}`, `dispatch;dur=${(routeEnteredAt - end).toFixed(2)}`] : []),
      ...(validPort || validConnectionId ? [`node-connection;desc="${[
        ...(validConnectionId ? [`id=${connectionId}`] : []), ...(validPort ? [`localPort=${port}`] : []),
      ].join(";")}"`] : []),
      ...(validAccepted ? [`socket-headers;dur=${(node - accepted).toFixed(2)};desc="includesIdle=1"`] : []),
    ],
  };
}

export function actionEntryTimings(headers: Headers, routeEnteredAt: number): string[] {
  return actionEntryTimingEvidence(headers, routeEnteredAt)?.timings ?? [];
}
