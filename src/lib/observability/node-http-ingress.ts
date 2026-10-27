import { randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER, isStaticMonacoTimingRequest, isHttpEntryTimingRequest, NODE_HTTP_RECEIVED_HEADER, NODE_SOCKET_ACCEPTED_HEADER,
  NODE_HTTP_LOCAL_PORT_HEADER, NODE_CONNECTION_ID_HEADER, NODE_HTTP_REQUEST_ID_HEADER } from "./action-entry-timing";
import { createStaticResourceTiming } from "./static-resource-timing";

type SocketEvidence = { connectionId: number; acceptedAtMs?: number };
type IngressState = {
  subscribed: boolean; listener: (message: unknown) => void; socketListener: (message: unknown) => void;
  sockets: WeakMap<Socket, SocketEvidence>; nextConnectionId: number;
  requestNonce: string; nextRequestId: number;
  staticTiming: ReturnType<typeof createStaticResourceTiming>;
};
declare global { var __openPblNodeHttpIngressClockV1: IngressState | undefined; }
const requestStart = channel("http.server.request.start");
const socketAccepted = channel("net.server.socket");
const diagnosticHeaders = [NODE_HTTP_RECEIVED_HEADER, NODE_SOCKET_ACCEPTED_HEADER,
  NODE_HTTP_LOCAL_PORT_HEADER, NODE_CONNECTION_ID_HEADER, NODE_HTTP_REQUEST_ID_HEADER, ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER];

/** Node 22/24 publish after synchronous server connection listeners. This is a
 * JS callback boundary, not kernel accept/first-byte time. Weak keys retain no
 * connection. Pre-subscription sockets get an ID later but no invented clock.
 */
function receiveSocket(message: unknown): void {
  const acceptedAtMs = Date.now();
  try {
    const socket = message && typeof message === "object" && "socket" in message ? message.socket : undefined;
    if (!(socket instanceof Socket)) return;
    const existing = state.sockets.get(socket);
    state.sockets.set(socket, { connectionId: existing?.connectionId ?? ++state.nextConnectionId, acceptedAtMs });
  } catch { /* Diagnostics must not affect the connection. */ }
}

/** Node 22/24 publish this after parsing HTTP headers, before the server's
 * request listener. This is NOT socket-first-byte or kernel-arrival time.
 * Replace caller-supplied diagnostic clocks before Next creates Web Requests.
 * No body, credential, identity or per-request entry is retained globally.
 */
function receiveHttpRequest(message: unknown): void {
  const receivedAtMs = Date.now();
  const started = performance.now();
  try {
    const request = message && typeof message === "object" && "request" in message
      ? message.request : undefined;
    if (!(request instanceof IncomingMessage)) return;
    const pathname = (request.url ?? "").split("?", 1)[0];
    const measured = isHttpEntryTimingRequest(request.method ?? "", pathname);
    const headers = request.headers;
    if (!measured && diagnosticHeaders.every(name => headers[name] === undefined)) return;
    // Materialize both lazy views before changing rawHeaders. Node's private
    // original header count is deliberately untouched; these public views then
    // remain canonical even for duplicate or differently cased forged headers.
    const distinct = request.headersDistinct;
    for (const name of diagnosticHeaders) { delete headers[name]; delete distinct[name]; }
    const raw = request.rawHeaders;
    const sanitized: string[] = [];
    for (let index = 0; index < raw.length; index += 2) {
      if (!diagnosticHeaders.includes(raw[index].toLowerCase())) {
        sanitized.push(raw[index], raw[index + 1]);
      }
    }
    raw.splice(0, raw.length, ...sanitized);
    if (measured) {
      let evidence = state.sockets.get(request.socket);
      if (!evidence) {
        evidence = { connectionId: ++state.nextConnectionId };
        state.sockets.set(request.socket, evidence);
      }
      const values: Array<[string, number]> = [[NODE_HTTP_RECEIVED_HEADER, receivedAtMs],
        [NODE_CONNECTION_ID_HEADER, evidence.connectionId]];
      if (evidence.acceptedAtMs !== undefined && evidence.acceptedAtMs <= receivedAtMs) {
        values.push([NODE_SOCKET_ACCEPTED_HEADER, evidence.acceptedAtMs]);
      }
      const port = request.socket.localPort;
      if (port !== undefined && port > 0 && port <= 65535) values.push([NODE_HTTP_LOCAL_PORT_HEADER, port]);
      for (const [name, number] of values) {
        if (!Number.isSafeInteger(number) || number <= 0) continue;
        const value = String(number);
        headers[name] = value; distinct[name] = [value]; raw.push(name, value);
      }
      const response = message && typeof message === "object" && "response" in message ? message.response : undefined;
      // Independent of business request IDs and socket reuse. No request map.
      if (state.nextRequestId >= Number.MAX_SAFE_INTEGER) {
        state.requestNonce = randomBytes(16).toString("hex"); state.nextRequestId = 0;
      }
      const httpRequestId = `http-${state.requestNonce}-${++state.nextRequestId}`;
      headers[NODE_HTTP_REQUEST_ID_HEADER] = httpRequestId;
      distinct[NODE_HTTP_REQUEST_ID_HEADER] = [httpRequestId];
      raw.push(NODE_HTTP_REQUEST_ID_HEADER, httpRequestId);
      if (response instanceof ServerResponse) response.setHeader(NODE_HTTP_REQUEST_ID_HEADER, httpRequestId);
      if (isStaticMonacoTimingRequest(request.method ?? "", pathname) && response instanceof ServerResponse) {
        state.staticTiming.observe(request, response, {
          httpRequestId, nodeHttpReceivedAtMs: receivedAtMs,
          nodeConnectionId: evidence.connectionId,
          ...(evidence.acceptedAtMs !== undefined && evidence.acceptedAtMs <= receivedAtMs ? { nodeSocketAcceptedAtMs: evidence.acceptedAtMs } : {}),
          ...(port !== undefined && port > 0 && port <= 65535 ? { nodeHttpLocalPort: port } : {}),
        }, started);
      }
    }
  } catch { /* A diagnostic subscriber must never fail an HTTP request. */ }
}

// Next instrumentation and route bundles can evaluate this module separately.
// A process owns just one native channel subscription, without a request map.
const state = globalThis.__openPblNodeHttpIngressClockV1 ??= {
  subscribed: false, listener: receiveHttpRequest, socketListener: receiveSocket,
  sockets: new WeakMap<Socket, SocketEvidence>(), nextConnectionId: 0,
  requestNonce: randomBytes(16).toString("hex"), nextRequestId: 0,
  staticTiming: createStaticResourceTiming(),
};
// Preserve the one process subscription when development reloads an older shape.
state.staticTiming ??= createStaticResourceTiming();
state.requestNonce ??= randomBytes(16).toString("hex");
state.nextRequestId ??= 0;

/** Return true only to the caller responsible for registering shutdown. */
export function startNodeHttpIngressClock(): boolean {
  if (state.subscribed) return false;
  socketAccepted.subscribe(state.socketListener);
  requestStart.subscribe(state.listener);
  state.subscribed = true;
  return true;
}

export function stopNodeHttpIngressClock(): void {
  if (!state.subscribed) return;
  requestStart.unsubscribe(state.listener);
  socketAccepted.unsubscribe(state.socketListener);
  state.staticTiming.stop();
  // A stopped interval may include unseen requests; never reuse its clocks.
  state.sockets = new WeakMap();
  state.subscribed = false;
}
