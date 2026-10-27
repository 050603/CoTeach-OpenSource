// @vitest-environment node
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_PROXY_ENDED_HEADER, ACTION_PROXY_STARTED_HEADER, isHttpEntryTimingRequest, isStaticMonacoTimingRequest,
  NODE_HTTP_REQUEST_ID_HEADER, readNativeHttpRequestId, NODE_CONNECTION_ID_HEADER, NODE_HTTP_LOCAL_PORT_HEADER, NODE_HTTP_RECEIVED_HEADER, NODE_SOCKET_ACCEPTED_HEADER, STATIC_MONACO_ROUTE } from "./action-entry-timing";
import { startNodeHttpIngressClock, stopNodeHttpIngressClock } from "./node-http-ingress";
import { staticResourceDurationSeconds, staticResourceRequestsTotal, httpRequestsTotal } from "./metrics";
import { withHttpMetrics } from "./http";
import { getRequestContext, withRequestContext } from "./request-id";
import { logger } from "./logger";
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));

const resource = `/_next/static/openpbl-runtime/monaco/0.56.0/${"a".repeat(64)}/vs/editor/editor.main.js`;
const trace = "acceptance-aabbccdd-123-1";
const nativeHeaders = [NODE_HTTP_REQUEST_ID_HEADER,NODE_HTTP_RECEIVED_HEADER, NODE_SOCKET_ACCEPTED_HEADER, NODE_HTTP_LOCAL_PORT_HEADER, NODE_CONNECTION_ID_HEADER];
const proxyHeaders = [ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER];
const servers: Server[] = [];
const rows = () => vi.mocked(logger.info).mock.calls.map(call => call[0] as Record<string, unknown>);
beforeEach(() => {
  vi.mocked(logger.info).mockReset();
  staticResourceRequestsTotal.reset(); staticResourceDurationSeconds.reset(); httpRequestsTotal.reset();
  startNodeHttpIngressClock();
});
afterEach(async () => {
  stopNodeHttpIngressClock();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected TCP server");
  return `http://127.0.0.1:${address.port}`;
}

describe("native static response measurement", () => {
  it("waits for a real delayed body finish, keeps status/headers/body, and emits exactly once without identity context", async () => {
    let response!: ServerResponse;
    let context: unknown;
    vi.mocked(logger.info).mockImplementation(() => { context = getRequestContext(); });
    const origin = await serve((_request, outgoing) => {
      response = outgoing;
      outgoing.setHeader("content-type", "text/plain"); outgoing.setHeader("cache-control", "public, max-age=31536000, immutable");
      outgoing.write("first-");
    });
    const before = Date.now();
    const received = await fetch(`${origin}${resource}?private=not-logged`, { headers: { "x-request-id": trace, connection: "close" } });
    expect(rows()).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 30));
    await withRequestContext({ traceId: "private-context", userId: "student-private", courseId: "course-private" }, () => response.end("last"));
    expect(await received.text()).toBe("first-last");
    expect(received.headers.get("cache-control")).toContain("immutable");
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0];
    expect(row).toMatchObject({ method: "GET", route: STATIC_MONACO_ROUTE, requestId: trace, status: 200,
      outcome: "completed", durationScope: "node-parsed-to-response-finish" });
    expect(Number(row.durationMs)).toBeGreaterThanOrEqual(25);
    expect(readNativeHttpRequestId(row.httpRequestId)).toBe(row.httpRequestId);
    expect(row.httpRequestId).toBeTruthy();
    expect(Number(row.nodeHttpReceivedAtMs)).toBeGreaterThanOrEqual(before);
    expect(Number(row.nodeResponseFinishedAtMs)).toBeGreaterThanOrEqual(Number(row.nodeHttpReceivedAtMs));
    expect(Number(row.nodeSocketAcceptedAtMs)).toBeLessThanOrEqual(Number(row.nodeHttpReceivedAtMs));
    expect(row.nodeHttpLocalPort).toBe(Number(new URL(origin).port));
    expect(context).toEqual({ traceId: trace });
    expect(JSON.stringify(row)).not.toMatch(/private|editor\.main|handlerEntered|handlerReturned|nextProxy/);
    expect((await staticResourceRequestsTotal.get()).values).toEqual([expect.objectContaining({ value: 1,
      labels: { method: "GET", route: STATIC_MONACO_ROUTE, outcome: "completed", status: "200" } })]);
    expect((await httpRequestsTotal.get()).values).toEqual([]);
    expect(response.listeners("finish").filter(listener => listener.name === "onFinish")).toHaveLength(0);
    expect(response.listeners("close").filter(listener => listener.name === "onClose")).toHaveLength(0);
  });

  it.each([200, 304, 404])("records real HEAD status %s without a body", async status => {
    const origin = await serve((_request, response) => { response.statusCode = status; response.end("not sent for HEAD"); });
    const response = await fetch(`${origin}${resource}`, { method: "HEAD", headers: { connection: "close" } });
    expect(response.status).toBe(status); expect(await response.text()).toBe("");
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ method: "HEAD", status, outcome: "completed" });
  });

  it("records transport abort separately with status 0, not HTTP success or a duplicate on later end", async () => {
    let response!: ServerResponse;
    let closed!: () => void;
    const close = new Promise<void>(resolve => { closed = resolve; });
    const origin = await serve((_request, outgoing) => {
      response = outgoing; outgoing.once("close", closed); outgoing.write("partial");
    });
    const request = httpRequest(`${origin}${resource}`, { headers: { "x-request-id": trace } }, incoming => {
      incoming.once("data", () => request.destroy());
    });
    request.on("error", () => undefined); request.end();
    await close;
    response.end("too late");
    expect(rows()).toHaveLength(1);
    expect(readNativeHttpRequestId(rows()[0].httpRequestId)).toBeTruthy();
    expect(rows()[0]).toMatchObject({ status: 0, receivedHttpStatus: 200, outcome: "aborted", nodeResponseClosedAtMs: expect.any(Number) });
    expect(rows()[0]).not.toHaveProperty("nodeResponseFinishedAtMs");
    const values = (await staticResourceDurationSeconds.get()).values;
    expect(values.every(row => row.labels.outcome === "aborted")).toBe(true);
    expect(values.find(row => row.metricName?.endsWith("_count"))?.value).toBe(1);
  });

  it("strips all forged native and Proxy clocks from all views before static dispatch", async () => {
    const origin = await serve((request, response) => response.end(JSON.stringify(Object.fromEntries([...nativeHeaders, ...proxyHeaders].map(name => [name, {
      value: request.headers[name] ?? null, distinct: request.headersDistinct[name] ?? null,
      raw: request.rawHeaders.flatMap((value, index) => index % 2 === 0 && value.toLowerCase() === name ? [request.rawHeaders[index + 1]] : []),
    }])))));
    const response = await fetch(`${origin}${resource}`, { headers: { ...Object.fromEntries([...nativeHeaders, ...proxyHeaders].map(name => [name, "1, 9999999999999"])), "x-request-id": "https://private.example/sensitive", connection: "close" } });
    const body = await response.json();
    for (const name of nativeHeaders) {
      if (name === NODE_HTTP_REQUEST_ID_HEADER) expect(readNativeHttpRequestId(body[name].value)).toBeTruthy();
      else expect(Number(body[name].value)).toBeGreaterThan(0);
      expect(body[name].distinct).toEqual([body[name].value]); expect(body[name].raw).toEqual([body[name].value]);
    }
    for (const name of proxyHeaders) expect(body[name]).toEqual({ value: null, distinct: null, raw: [] });
    expect(rows()).toHaveLength(1);
    expect(JSON.stringify(rows())).not.toContain("private.example");
    expect(rows()[0]).not.toHaveProperty("nextProxyStartedAtMs");
    const untimed = await fetch(`${origin}/api/uploads/private`, { headers: {
      ...Object.fromEntries([...nativeHeaders, ...proxyHeaders].map(name => [name, "1"])), connection: "close",
    } });
    expect(Object.values(await untimed.json())).toEqual([...nativeHeaders, ...proxyHeaders].map(() => ({ value: null, distinct: null, raw: [] })));
    expect(rows()).toHaveLength(1);
  });

  it("never invents an HTTP status if a client aborts before any response headers", async () => {
    let accepted!: () => void;
    let closed!: () => void;
    const arrived = new Promise<void>(resolve => { accepted = resolve; });
    const close = new Promise<void>(resolve => { closed = resolve; });
    const origin = await serve((_request, response) => { response.once("close", closed); accepted(); });
    const request = httpRequest(`${origin}${resource}`);
    request.on("error", () => undefined); request.end();
    await arrived; request.destroy(); await close;
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 0, outcome: "aborted" });
    expect(rows()[0]).not.toHaveProperty("receivedHttpStatus");
  });

  it("stopping removes stalled listeners and restarting never settles the old response", async () => {
    let held!: ServerResponse;
    let index = 0;
    const origin = await serve((_request, response) => {
      if (index++ === 0) { held = response; response.write("held"); } else response.end("new");
    });
    const first = await fetch(`${origin}${resource}`, { headers: { connection: "close" } });
    expect(held.listeners("finish").some(listener => listener.name === "onFinish")).toBe(true);
    stopNodeHttpIngressClock();
    expect(held.listeners("finish").some(listener => listener.name === "onFinish")).toBe(false);
    expect(held.listeners("close").some(listener => listener.name === "onClose")).toBe(false);
    startNodeHttpIngressClock();
    held.end(); await first.text(); expect(rows()).toHaveLength(0);
    const second = await fetch(`${origin}${resource}`, { headers: { connection: "close" } });
    expect(await second.text()).toBe("new"); expect(rows()).toHaveLength(1);
  });

  it("does not duplicate API handler measurement or measure unrelated/invalid static paths", async () => {
    const wrapped = withHttpMetrics("GET", "/api/server-providers", async () => new Response("api"));
    const origin = await serve((request, response) => {
      if (request.url === "/api/server-providers") void wrapped(new Request(`${origin}${request.url}`)).then(result => { response.statusCode = result.status; response.end("api"); });
      else response.end("other");
    });
    for (const path of ["/api/server-providers", "/_next/static/chunks/app.js", resource.replace("a".repeat(64), "a".repeat(63))]) {
      await (await fetch(`${origin}${path}`, { headers: { connection: "close" } })).text();
    }
    expect(rows()).toHaveLength(1); expect(rows()[0].route).toBe("/api/server-providers");
    expect((await staticResourceRequestsTotal.get()).values).toEqual([]);
    expect((await httpRequestsTotal.get()).values).toHaveLength(1);
  });

  it("keeps a rewritten resource's handler boundary separate from its native streamed body completion", async () => {
    let finishBody: (() => void) | undefined;
    const wrapped = withHttpMetrics("GET", "/api/openmaic/interactive-runtime/:runtime/:path", async () => {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("first-"));
        let finished = false;
        finishBody = () => {
          if (finished) return;
          finished = true;
          controller.enqueue(new TextEncoder().encode("last")); controller.close();
        };
      } });
      return new Response(body, { headers: { "Content-Type": "application/javascript" } });
    });
    const origin = await serve((incoming, outgoing) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      void wrapped(new Request(`${origin}${incoming.url}`, { headers })).then(async result => {
        result.headers.forEach((value, name) => outgoing.setHeader(name, value));
        outgoing.statusCode = result.status;
        const reader = result.body!.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          outgoing.write(next.value);
        }
        outgoing.end();
      }).catch(error => outgoing.destroy(error as Error));
    });
    try {
      const response = await fetch(`${origin}${resource}`, { headers: { "x-request-id": trace, connection: "close" } });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ durationScope: "handler", route: "/api/openmaic/interactive-runtime/:runtime/:path" });
      expect((await httpRequestsTotal.get()).values).toEqual([expect.objectContaining({ value: 1 })]);
      expect((await staticResourceRequestsTotal.get()).values).toEqual([]);
      await new Promise(resolve => setTimeout(resolve, 25));
      finishBody!();
      expect(await response.text()).toBe("first-last");
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      const [handler, delivery] = rows();
      expect(handler.httpRequestId).toBe(response.headers.get(NODE_HTTP_REQUEST_ID_HEADER));
      expect(delivery.httpRequestId).toBe(handler.httpRequestId);
      expect(delivery).toMatchObject({ durationScope: "node-parsed-to-response-finish", route: STATIC_MONACO_ROUTE, outcome: "completed", status: 200 });
      expect(Number(delivery.nodeResponseFinishedAtMs)).toBeGreaterThanOrEqual(Number(handler.handlerReturnedAtMs));
      expect(handler).not.toHaveProperty("nodeResponseFinishedAtMs");
      expect(delivery).not.toHaveProperty("handlerReturnedAtMs");
      expect((await staticResourceRequestsTotal.get()).values).toEqual([expect.objectContaining({ value: 1 })]);
      expect((await httpRequestsTotal.get()).values).toEqual([expect.objectContaining({ value: 1 })]);
    } finally { finishBody?.(); }
  });
});

describe("bounded timing allowlists", () => {
  it("accepts only pinned Monaco GET/HEAD and exact showcase GET shapes", () => {
    for (const method of ["GET", "HEAD"]) expect(isStaticMonacoTimingRequest(method, resource)).toBe(true);
    for (const path of [resource.replace("/monaco/", "/private/"), resource.replace("/0.56.0/", "/latest/"), resource.replace("a".repeat(64), "a".repeat(63)), resource.replace("/vs/editor/", "/vs/../"), resource.replace("/vs/editor/", "/vs/%2e%2e/"), `${resource}/`]) expect(isStaticMonacoTimingRequest("GET", path)).toBe(false);
    expect(isStaticMonacoTimingRequest("POST", resource)).toBe(false);
    for (const suffix of ["presentation", "artifacts/export", "artifacts/version-1"]) {
      expect(isHttpEntryTimingRequest("GET", `/api/courses/course/showcase/${suffix}`)).toBe(true);
      expect(isHttpEntryTimingRequest("POST", `/api/courses/course/showcase/${suffix}`)).toBe(false);
      expect(isHttpEntryTimingRequest("GET", `/api/courses/course/showcase/${suffix}/extra`)).toBe(false);
    }
  });
});
