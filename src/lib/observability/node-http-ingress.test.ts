// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import { channel } from "node:diagnostics_channel";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signTeacherToken } from "@/lib/auth/session";
import { proxy } from "@/proxy";
import { ACTION_PROXY_ENDED_HEADER, ACTION_PROXY_STARTED_HEADER, NODE_HTTP_RECEIVED_HEADER,
  NODE_SOCKET_ACCEPTED_HEADER, NODE_HTTP_LOCAL_PORT_HEADER, NODE_CONNECTION_ID_HEADER, NODE_HTTP_REQUEST_ID_HEADER, readNativeHttpRequestId } from "./action-entry-timing";
import { startNodeHttpIngressClock, stopNodeHttpIngressClock } from "./node-http-ingress";

vi.mock("./metrics", () => ({ httpApplicationEntryDurationSeconds: { labels: () => ({ observe: vi.fn() }) }, httpApplicationEntryMeasurementsTotal: { labels: () => ({ inc: vi.fn() }) }, httpRequestsTotal: { labels: () => ({ inc: vi.fn() }) },
  httpRequestDurationSeconds: { labels: () => ({ observe: vi.fn() }) },
  httpOperationDurationSeconds: { labels: () => ({ observe: vi.fn() }) } }));
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));
import { logger } from "./logger";
import { withHttpMetrics } from "./http";
import { withReadApiBoundary } from "@/lib/auth/read-api-boundary";

const servers: Server[] = [];
const agents: Agent[] = [];
const nativeHeaders = [NODE_HTTP_REQUEST_ID_HEADER,NODE_HTTP_RECEIVED_HEADER, NODE_SOCKET_ACCEPTED_HEADER, NODE_HTTP_LOCAL_PORT_HEADER, NODE_CONNECTION_ID_HEADER];
const secret = process.env.JWT_SECRET;
afterEach(async () => {
  stopNodeHttpIngressClock();
  for (const agent of agents.splice(0)) await agent.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
  if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
});

async function serve(handler: (request: IncomingMessage) => Response | Promise<Response>): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const reply = await handler(request);
      response.statusCode = reply.status;
      reply.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await reply.arrayBuffer()));
    })().catch(() => { response.statusCode = 500; response.end("test-server-handler-failed"); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}
function webHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

describe("native HTTP ingress clock", () => {
  it("uses the real channel before the request listener and overwrites forged clocks in every header view", async () => {
    startNodeHttpIngressClock();
    const origin = await serve(async request => {
      const enteredAt = Date.now();
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index].toLowerCase() === NODE_HTTP_RECEIVED_HEADER) raw.push(request.rawHeaders[index + 1]);
      }
      return Response.json({ enteredAt, received: request.headers[NODE_HTTP_RECEIVED_HEADER], raw,
        native: Object.fromEntries(nativeHeaders.map(name => [name, { value: request.headers[name], distinct: request.headersDistinct[name],
          raw: request.rawHeaders.flatMap((value, index) => index % 2 === 0 && value.toLowerCase() === name ? [request.rawHeaders[index + 1]] : []) }])),
        distinct: request.headersDistinct[NODE_HTTP_RECEIVED_HEADER], body: Buffer.concat(chunks).toString(),
        authorization: request.headers.authorization, cookie: request.headers.cookie, contentType: request.headers["content-type"] });
    });
    const before = Date.now();
    const response = await fetch(`${origin}/api/learning-events?not-collected=private`, { method: "POST",
      headers: { ...Object.fromEntries(nativeHeaders.map(name => [name, "1, 9999999999999"])), authorization: "Bearer fixture",
        cookie: "fixture=session", "content-type": "application/json", connection: "close" }, body: '{"fixture":"preserved"}' });
    const body = await response.json(); const after = Date.now();
    expect(response.status).toBe(200);
    expect(Number(body.received)).toBeGreaterThanOrEqual(before);
    expect(Number(body.received)).toBeLessThanOrEqual(body.enteredAt);
    expect(body.enteredAt).toBeLessThanOrEqual(after);
    expect(body.raw).toEqual([body.received]); expect(body.distinct).toEqual([body.received]);
    for (const name of nativeHeaders) {
      expect(body.native[name].raw).toEqual([body.native[name].value]);
      expect(body.native[name].distinct).toEqual([body.native[name].value]);
    }
    const acceptedAt = Number(body.native[NODE_SOCKET_ACCEPTED_HEADER].value);
    expect(acceptedAt).toBeGreaterThanOrEqual(before); expect(acceptedAt).toBeLessThanOrEqual(Number(body.received));
    expect(Number(body.native[NODE_HTTP_LOCAL_PORT_HEADER].value)).toBe(Number(new URL(origin).port));
    expect(Number(body.native[NODE_CONNECTION_ID_HEADER].value)).toBeGreaterThan(0);
    expect(body.body).toBe('{"fixture":"preserved"}'); expect(body.authorization).toBe("Bearer fixture");
    expect(body.cookie).toBe("fixture=session"); expect(body.contentType).toBe("application/json");
  });

  it("strips forged clocks outside the timing allowlist without generating a measurement", async () => {
    startNodeHttpIngressClock();
    const origin = await serve(request => Response.json(nativeHeaders.map(name => ({
      received: request.headers[name] ?? null, distinct: request.headersDistinct[name] ?? null,
      raw: request.rawHeaders.filter(value => value.toLowerCase() === name),
    }))));
    const response = await fetch(`${origin}/api/uploads`, {
      headers: { ...Object.fromEntries(nativeHeaders.map(name => [name, "1"])), connection: "close" },
    });
    expect(response.headers.get(NODE_HTTP_REQUEST_ID_HEADER)).toBeNull();
    expect(await response.json()).toEqual(nativeHeaders.map(() => ({ received: null, distinct: null, raw: [] })));
  });

  it("shares one native subscription across repeated registration and module evaluations, then removes and restarts it", async () => {
    expect(startNodeHttpIngressClock()).toBe(true); expect(startNodeHttpIngressClock()).toBe(false);
    expect(channel("net.server.socket").hasSubscribers).toBe(true);
    vi.resetModules();
    const reloaded = await import("./node-http-ingress");
    expect(reloaded.startNodeHttpIngressClock()).toBe(false);
    const origin = await serve(request => Response.json({ received: request.headers[NODE_HTTP_RECEIVED_HEADER] ?? null, id: request.headers[NODE_HTTP_REQUEST_ID_HEADER] ?? null }));
    const before = await fetch(`${origin}/api/server-providers`, { headers: { connection: "close" } });
    const first = await before.json();
    expect(Number(first.received)).toBeGreaterThan(0); expect(readNativeHttpRequestId(first.id)).toBeTruthy();
    reloaded.stopNodeHttpIngressClock(); stopNodeHttpIngressClock();
    expect(channel("net.server.socket").hasSubscribers).toBe(false);
    expect(channel("http.server.request.start").hasSubscribers).toBe(false);
    const stopped = await fetch(`${origin}/api/server-providers`, { headers: { connection: "close" } });
    expect(await stopped.json()).toEqual({ received: null, id: null });
    expect(stopped.headers.get(NODE_HTTP_REQUEST_ID_HEADER)).toBeNull();
    expect(startNodeHttpIngressClock()).toBe(true);
    const restarted = await fetch(`${origin}/api/server-providers`, { headers: { connection: "close" } });
    const last = await restarted.json();
    expect(Number(last.received)).toBeGreaterThan(0);
    expect(last.id.slice(0, 38)).toBe(first.id.slice(0, 38));
    expect(Number(last.id.slice(38))).toBe(Number(first.id.slice(38)) + 1);
  });

  it("keeps a real connection ID and accept callback clock across sequential native fetches", async () => {
    startNodeHttpIngressClock();
    const agent = new Agent({ connections: 1, pipelining: 1 }); agents.push(agent);
    const origin = await serve(request => Response.json(Object.fromEntries(nativeHeaders.map(name => [name, request.headers[name] ?? null]))));
    const init: RequestInit & { dispatcher: Agent } = { dispatcher: agent };
    const first = await (await fetch(`${origin}/api/server-providers`, init)).json();
    const second = await (await fetch(`${origin}/api/courses`, init)).json();
    expect(second[NODE_HTTP_REQUEST_ID_HEADER]).not.toBe(first[NODE_HTTP_REQUEST_ID_HEADER]);
    expect(second[NODE_CONNECTION_ID_HEADER]).toBe(first[NODE_CONNECTION_ID_HEADER]);
    expect(second[NODE_SOCKET_ACCEPTED_HEADER]).toBe(first[NODE_SOCKET_ACCEPTED_HEADER]);
    expect(Number(first[NODE_SOCKET_ACCEPTED_HEADER])).toBeGreaterThan(0);
    expect(Number(second[NODE_HTTP_RECEIVED_HEADER])).toBeGreaterThanOrEqual(Number(first[NODE_HTTP_RECEIVED_HEADER]));
    expect(Number(second[NODE_HTTP_LOCAL_PORT_HEADER])).toBe(Number(new URL(origin).port));
  });

  it("does not invent an accept clock for a reused socket opened before subscription", async () => {
    const agent = new Agent({ connections: 1, pipelining: 1 }); agents.push(agent);
    const origin = await serve(request => Response.json(Object.fromEntries(nativeHeaders.map(name => [name, request.headers[name] ?? null]))));
    const init: RequestInit & { dispatcher: Agent } = { dispatcher: agent };
    const first = await (await fetch(`${origin}/api/server-providers`, init)).json();
    expect(first[NODE_SOCKET_ACCEPTED_HEADER]).toBeNull();
    startNodeHttpIngressClock();
    const after = await (await fetch(`${origin}/api/server-providers`, { ...init, headers: {
      [NODE_SOCKET_ACCEPTED_HEADER]: "1", [NODE_CONNECTION_ID_HEADER]: "9999999999999", [NODE_HTTP_LOCAL_PORT_HEADER]: "65535",
    } })).json();
    const replay = await (await fetch(`${origin}/api/courses`, init)).json();
    expect(after[NODE_SOCKET_ACCEPTED_HEADER]).toBeNull(); expect(replay[NODE_SOCKET_ACCEPTED_HEADER]).toBeNull();
    expect(Number(after[NODE_HTTP_RECEIVED_HEADER])).toBeGreaterThan(0);
    expect(after[NODE_CONNECTION_ID_HEADER]).toBe(replay[NODE_CONNECTION_ID_HEADER]);
    expect(after[NODE_CONNECTION_ID_HEADER]).not.toBe("9999999999999");
    expect(Number(after[NODE_HTTP_LOCAL_PORT_HEADER])).toBe(Number(new URL(origin).port));
  });

  it("identifies the actual listener rather than the caller-supplied Host or diagnostic port", async () => {
    startNodeHttpIngressClock();
    const handle = (request: IncomingMessage) => Response.json(Object.fromEntries(nativeHeaders.map(name => [name, request.headers[name] ?? null])));
    const first = await serve(handle); const second = await serve(handle);
    const read = async (origin: string) => (await fetch(`${origin}/api/server-providers`, {
      headers: { host: "127.0.0.1:3000", [NODE_HTTP_LOCAL_PORT_HEADER]: "3000", connection: "close" },
    })).json();
    const left = await read(first); const right = await read(second);
    expect(Number(left[NODE_HTTP_LOCAL_PORT_HEADER])).toBe(Number(new URL(first).port));
    expect(Number(right[NODE_HTTP_LOCAL_PORT_HEADER])).toBe(Number(new URL(second).port));
    expect(left[NODE_HTTP_LOCAL_PORT_HEADER]).not.toBe(right[NODE_HTTP_LOCAL_PORT_HEADER]);
    expect(left[NODE_CONNECTION_ID_HEADER]).not.toBe(right[NODE_CONNECTION_ID_HEADER]);
  });

  it.each([
    ["GET", "/api/courses/course/state", "/api/courses/:courseId/state"],
    ["GET", "/api/courses/course/public-discussion", "/api/courses/:courseId/public-discussion"],
    ["PUT", "/api/courses/course/presence", "/api/courses/:courseId/presence"],
    ["DELETE", "/api/courses/course/presence", "/api/courses/:courseId/presence"],
    ["GET", "/api/openmaic/classroom-media/classroom/audio/voice.wav", "/api/openmaic/classroom-media/:classroomId/:path"],
  ])("passes real Node/Proxy clocks for authenticated %s %s without changing access or response", async (method, pathname, route) => {
    process.env.JWT_SECRET = "node-ingress-test-secret-with-at-least-32-characters";
    const signed = await signTeacherToken({ teacherId: "teacher", username: "teacher", displayName: "Teacher", sessionVersion: 1 });
    startNodeHttpIngressClock(); vi.mocked(logger.info).mockClear();
    const handler = vi.fn(async () => Response.json({ ok: true }, { headers: { "Server-Timing": "read;dur=5", "Cache-Control": "no-store" } }));
    const wrapped = withHttpMetrics(method, route, handler);
    const origin = await serve(async incoming => {
      const request = new NextRequest(`http://localhost${incoming.url}`, { method, headers: webHeaders(incoming) });
      const authorized = await proxy(request);
      if (authorized.headers.get("x-middleware-next") !== "1") return authorized;
      const forwarded = new Headers(request.headers);
      for (const key of (authorized.headers.get("x-middleware-override-headers") ?? "").split(",").map(value => value.trim()).filter(Boolean)) {
        const value = authorized.headers.get(`x-middleware-request-${key}`);
        if (value === null) forwarded.delete(key); else forwarded.set(key, value);
      }
      return wrapped(new Request(request.url, { method, headers: forwarded }));
    });
    const response = await fetch(`${origin}${pathname}`, { method, headers: {
      cookie: `${signed.cookieName}=${signed.token}`, "x-openpbl-role": "teacher", [NODE_HTTP_RECEIVED_HEADER]: "1",
      [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "9999999999999", connection: "close" } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toMatch(/^read;dur=5, node-dispatch;dur=[\d.]+, proxy;dur=[\d.]+, dispatch;dur=[\d.]+, node-connection;desc="id=\d+;localPort=\d+", socket-headers;dur=[\d.]+;desc="includesIdle=1", handler;dur=/);
    const logged = vi.mocked(logger.info).mock.calls.at(-1)?.[0] as Record<string, number>;
    expect(logged).toEqual(expect.objectContaining({ nodeHttpReceivedAtMs: expect.any(Number), nextProxyStartedAtMs: expect.any(Number), nextProxyEndedAtMs: expect.any(Number) }));
    expect(logged.nodeHttpReceivedAtMs).toBeGreaterThan(1);
    expect(logged.nodeSocketAcceptedAtMs).toBeGreaterThan(0);
    expect(logged.nodeSocketAcceptedAtMs).toBeLessThanOrEqual(logged.nodeHttpReceivedAtMs);
    expect(logged.nodeHttpLocalPort).toBe(Number(new URL(origin).port));
    expect(logged.nodeConnectionId).toBeGreaterThan(0);
    expect(logged.nodeHttpReceivedAtMs).toBeLessThanOrEqual(logged.nextProxyStartedAtMs);
    expect(logged.nextProxyStartedAtMs).toBeLessThanOrEqual(logged.nextProxyEndedAtMs);
    expect(logged.nextProxyEndedAtMs).toBeLessThanOrEqual(logged.handlerEnteredAtMs);
    const denied = await fetch(`${origin}${pathname}`, { method, headers: { [NODE_HTTP_RECEIVED_HEADER]: "1", connection: "close" } });
    expect(denied.status).toBe(401); await denied.arrayBuffer(); expect(handler).toHaveBeenCalledOnce();
  });

  it("retains genuine Node evidence without accepting a forged Proxy pair on a bypassed GET", async () => {
    process.env.JWT_SECRET = "node-ingress-test-secret-with-at-least-32-characters";
    const signed = await signTeacherToken({ teacherId: "teacher", username: "teacher", displayName: "Teacher", sessionVersion: 1 });
    startNodeHttpIngressClock(); vi.mocked(logger.info).mockClear();
    const wrapped = withReadApiBoundary(withHttpMetrics("GET", "/api/courses", async () => Response.json({ ok: true })));
    const origin = await serve(incoming => {
      for (const name of [ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER]) {
        expect(incoming.headers[name]).toBeUndefined();
        expect(incoming.headersDistinct[name]).toBeUndefined();
        expect(incoming.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === name)).toBe(false);
      }
      return wrapped(new Request(`${origin}${incoming.url}`, { headers: webHeaders(incoming) }));
    });
    const forged = String(Date.now() - 10);
    const response = await fetch(`${origin}/api/courses`, { headers: {
      cookie: `${signed.cookieName}=${signed.token}`, [NODE_HTTP_RECEIVED_HEADER]: "1",
      [ACTION_PROXY_STARTED_HEADER]: forged, [ACTION_PROXY_ENDED_HEADER]: forged, connection: "close" } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    const timing = response.headers.get("server-timing");
    expect(timing).toContain("handler;dur="); expect(timing).toContain("node-connection;");
    expect(timing).not.toContain("proxy;dur="); expect(timing).not.toContain("dispatch;dur=");
    const logged = vi.mocked(logger.info).mock.calls.at(-1)?.[0] as Record<string, number>;
    expect(logged.nodeHttpReceivedAtMs).toBeGreaterThan(1);
    expect(logged.nodeHttpLocalPort).toBe(Number(new URL(origin).port));
    expect(logged.nextProxyStartedAtMs).toBeUndefined(); expect(logged.nextProxyEndedAtMs).toBeUndefined();
  });

});

// Actual parser/channel proof, rather than fabricated Web Request headers.
it("correlates repeated business IDs independently across keepalive, concurrent attempts and framework errors", async () => {
  startNodeHttpIngressClock(); vi.mocked(logger.info).mockClear();
  const businessId = "document-review-private-business-id";
  const spoof = `http-${"b".repeat(32)}-1`;
  const origin = await serve(async incoming => {
    if (incoming.url?.includes("framework-error")) throw Error("framework failure fixture");
    const request = new Request(`http://localhost${incoming.url}`, { headers: webHeaders(incoming) });
    return withHttpMetrics("GET", "/api/ai-collaboration/document", async () => Response.json({
      businessId: incoming.headers["x-request-id"], httpRequestId: incoming.headers[NODE_HTTP_REQUEST_ID_HEADER],
      distinct: incoming.headersDistinct[NODE_HTTP_REQUEST_ID_HEADER],
      raw: incoming.rawHeaders.flatMap((value, index) => index % 2 === 0 && value.toLowerCase() === NODE_HTTP_REQUEST_ID_HEADER ? [incoming.rawHeaders[index + 1]] : []),
    }))(request);
  });
  const agent = new Agent({ connections: 1 }); agents.push(agent);
  const init: RequestInit & { dispatcher: Agent } = { dispatcher: agent,
    headers: { "x-request-id": businessId, [NODE_HTTP_REQUEST_ID_HEADER]: spoof } };
  const fetchOne = async (options: RequestInit = init) => {
    const response = await fetch(`${origin}/api/ai-collaboration/document`, options);
    const body = await response.json();
    const id = response.headers.get(NODE_HTTP_REQUEST_ID_HEADER);
    expect(readNativeHttpRequestId(id)).toBe(id); expect(id).not.toBe(spoof);
    expect(body).toEqual({ businessId, httpRequestId: id, distinct: [id], raw: [id] });
    return id;
  };
  const ids = [await fetchOne(), await fetchOne(), ...await Promise.all([
    fetchOne({ headers: init.headers }), fetchOne({ headers: init.headers }),
  ])];
  expect(new Set(ids).size).toBe(4);
  const records = vi.mocked(logger.info).mock.calls.map(call => call[0] as Record<string, unknown>);
  expect(records.map(row => row.httpRequestId).sort()).toEqual([...ids].sort());
  expect(records.every(row => row.requestId === businessId)).toBe(true);
  const failed = await fetch(`${origin}/api/ai-collaboration/document?framework-error`, init);
  expect(failed.status).toBe(500);
  expect(readNativeHttpRequestId(failed.headers.get(NODE_HTTP_REQUEST_ID_HEADER))).toBeTruthy();
  await failed.text();
});
