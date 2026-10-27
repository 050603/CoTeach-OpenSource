// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signTeacherToken } from "@/lib/auth/session";
import { proxy } from "@/proxy";
import { NODE_HTTP_RECEIVED_HEADER, NODE_SOCKET_ACCEPTED_HEADER, NODE_HTTP_LOCAL_PORT_HEADER, NODE_CONNECTION_ID_HEADER,
  readNativeHttpRequestId, ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER, actionEntryTimings, actionEntryTimingEvidence, isActionTimingRequest, isHttpEntryTimingRequest } from "./action-entry-timing";
vi.mock("./metrics", () => ({ httpApplicationEntryDurationSeconds: { labels: () => ({ observe: vi.fn() }) }, httpApplicationEntryMeasurementsTotal: { labels: () => ({ inc: vi.fn() }) }, httpRequestsTotal: { labels: () => ({ inc: vi.fn() }) }, httpRequestDurationSeconds: { labels: () => ({ observe: vi.fn() }) }, httpOperationDurationSeconds: { labels: () => ({ observe: vi.fn() }) } }));
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));
import { withHttpMetrics } from "./http";
const secret = process.env.JWT_SECRET;
afterEach(() => { vi.useRealTimers(); if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; });

describe("action entry timing without auth bypass", () => {
  it("only instruments POST action routes", () => {
    expect(isActionTimingRequest("POST", "/api/courses/course/actions")).toBe(true);
    expect(isActionTimingRequest("GET", "/api/courses/course/actions")).toBe(false);
    expect(isActionTimingRequest("POST", "/api/uploads")).toBe(false);
    expect(isActionTimingRequest("POST", "/api/courses/course/actions/extra")).toBe(false);
  });
  it("overwrites forged clocks and preserves authentication, request headers and CSP", async () => {
    process.env.JWT_SECRET = "action-timing-unit-secret-with-at-least-32-characters";
    const signed = await signTeacherToken({ teacherId: "teacher", username: "teacher", displayName: "Teacher", sessionVersion: 1 });
    const headers = { cookie: `${signed.cookieName}=${signed.token}`, "content-type": "application/json", "x-openpbl-role": "teacher", [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "9999999999999" };
    const request = new NextRequest("http://localhost/api/courses/course/actions", { method: "POST", headers, body: "{}" });
    const before = Date.now(); const response = await proxy(request); const after = Date.now();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    const started = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_STARTED_HEADER}`));
    const ended = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_ENDED_HEADER}`));
    expect(started).toBeGreaterThanOrEqual(before); expect(ended).toBeGreaterThanOrEqual(started); expect(ended).toBeLessThanOrEqual(after);
    expect(response.headers.get("x-middleware-request-content-type")).toBe("application/json");
    expect(response.headers.get("x-middleware-request-cookie")).toBe(headers.cookie);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src");
    const denied = await proxy(new NextRequest(request.url, { method: "POST", headers: { [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "2" } }));
    expect(denied.status).toBe(401); expect(denied.headers.get("x-middleware-next")).toBeNull();
  });
  it("appends paired outer durations without replacing existing phase, cache or response headers", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const wrapped = withHttpMetrics("POST", "/api/courses/:courseId/actions", async () => Response.json({ ok: true }, { headers: { "Server-Timing": "write;dur=5", "Cache-Control": "no-store", "X-Test": "preserved" } }));
    const response = await wrapped(new Request("http://localhost/api/courses/course/actions", { method: "POST", headers: { [ACTION_PROXY_STARTED_HEADER]: "9900", [ACTION_PROXY_ENDED_HEADER]: "9920" } }));
    expect(response.headers.get("Server-Timing")).toMatch(/^write;dur=5, proxy;dur=20\.00, dispatch;dur=80\.00, handler;dur=/);
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Test")).toBe("preserved");
    expect(await response.json()).toEqual({ ok: true });
  });
  it("does not fabricate missing, reversed or implausibly old clock measurements", () => {
    expect(actionEntryTimings(new Headers(), 1000)).toEqual([]);
    expect(actionEntryTimings(new Headers({ [ACTION_PROXY_STARTED_HEADER]: "200", [ACTION_PROXY_ENDED_HEADER]: "100" }), 1000)).toEqual([]);
    expect(actionEntryTimings(new Headers({ [ACTION_PROXY_STARTED_HEADER]: "100", [ACTION_PROXY_ENDED_HEADER]: "200" }), 200000)).toEqual([]);
  });
});


describe("classroom read and progress entry timing", () => {
  const routes = [
    ["GET", "/api/server-providers", "/api/server-providers"],
    ["GET", "/api/openmaic/classroom", "/api/openmaic/classroom"],
    ["GET", "/api/courses/course/presence", "/api/courses/:courseId/presence"],
    ["PUT", "/api/courses/course/presence", "/api/courses/:courseId/presence"],
    ["DELETE", "/api/courses/course/presence", "/api/courses/:courseId/presence"],
    ["GET", "/api/courses/course/public-discussion", "/api/courses/:courseId/public-discussion"],
    ["GET", "/api/openmaic/classroom-media/classroom/audio/voice.wav", "/api/openmaic/classroom-media/:classroomId/:path"],
    ["GET", "/api/courses/course/state", "/api/courses/:courseId/state"],
    ["GET", "/api/courses/course/events", "/api/courses/:courseId/events"],
    ["GET", "/api/courses/course/projection", "/api/courses/:courseId/projection"],
    ["GET", "/api/openmaic/progress", "/api/openmaic/progress"],
    ["POST", "/api/openmaic/progress", "/api/openmaic/progress"],
    ["GET", "/api/courses", "/api/courses"],
    ["GET", "/api/ai-collaboration/document", "/api/ai-collaboration/document"],
    ["GET", "/api/ai-collaboration/code", "/api/ai-collaboration/code"],
    ["GET", "/api/ai-collaboration/memory", "/api/ai-collaboration/memory"],
    ["POST", "/api/learning-events", "/api/learning-events"],
    ["POST", "/api/project-practice/submissions/finalize", "/api/project-practice/submissions/finalize"],
  ];

  it.each(routes)("overwrites forged clocks without bypassing auth for %s %s", async (method, path) => {
    process.env.JWT_SECRET = "entry-timing-unit-secret-with-at-least-32-characters";
    const signed = await signTeacherToken({ teacherId: "teacher", username: "teacher", displayName: "Teacher", sessionVersion: 1 });
    const headers = { cookie: `${signed.cookieName}=${signed.token}`, "x-openpbl-role": "teacher",
      [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "9999999999999" };
    const before = Date.now();
    const response = await proxy(new NextRequest(`http://localhost${path}`, { method, headers }));
    const after = Date.now();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    const started = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_STARTED_HEADER}`));
    const ended = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_ENDED_HEADER}`));
    expect(started).toBeGreaterThanOrEqual(before);
    expect(ended).toBeGreaterThanOrEqual(started);
    expect(ended).toBeLessThanOrEqual(after);
    expect(response.headers.get("x-middleware-request-cookie")).toBe(headers.cookie);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src");
    const denied = await proxy(new NextRequest(`http://localhost${path}`, { method,
      headers: { [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "2" } }));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("x-middleware-next")).toBeNull();
  });

  it.each(routes)("preserves body and reports paired Next durations for %s %s", async (method, path, route) => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const wrapped = withHttpMetrics(method, route, async () => Response.json({ ok: true },
      { headers: { "Cache-Control": "no-store", "Server-Timing": "read;dur=5" } }));
    const response = await wrapped(new Request(`http://localhost${path}`, { method,
      headers: { [ACTION_PROXY_STARTED_HEADER]: "9900", [ACTION_PROXY_ENDED_HEADER]: "9920" } }));
    expect(response.headers.get("Server-Timing")).toMatch(/^read;dur=5, proxy;dur=20\.00, dispatch;dur=80\.00, handler;dur=/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("keeps diagnostic request scope narrow", () => {
    for (const [method, path] of routes) expect(isHttpEntryTimingRequest(method, path)).toBe(true);
    for (const [method, path] of [
      ["POST", "/api/server-providers"], ["POST", "/api/openmaic/classroom"],
      ["POST", "/api/courses/course/presence"], ["GET", "/api/openmaic/progress/extra"],
      ["POST", "/api/uploads"], ["GET", "/api/courses/extra"],
      ["POST", "/api/courses/course/projection"], ["POST", "/api/courses/course/state"],
      ["GET", "/api/courses/course/events/extra"],
      ["POST", "/api/courses/course/public-discussion"], ["GET", "/api/courses/course/public-discussion/extra"],
      ["POST", "/api/openmaic/classroom-media/classroom/audio/voice.wav"],
    ]) expect(isHttpEntryTimingRequest(method, path)).toBe(false);
  });
});


describe("shared entry clock evidence", () => {
  it("uses the same validated boundaries for absolute clocks and duration headers", () => {
    const headers = new Headers({
      [ACTION_PROXY_STARTED_HEADER]: "10000",
      [ACTION_PROXY_ENDED_HEADER]: "10025",
      authorization: "private-header-must-not-be-copied",
    });
    expect(actionEntryTimingEvidence(headers, 10100)).toEqual({
      epochs: { nextProxyStartedAtMs: 10000, nextProxyEndedAtMs: 10025 },
      timings: ["proxy;dur=25.00", "dispatch;dur=75.00"],
    });
    expect(actionEntryTimings(headers, 10100)).toEqual(["proxy;dur=25.00", "dispatch;dur=75.00"]);
    expect(actionEntryTimingEvidence(headers, 130000)).toBeDefined();
    expect(actionEntryTimingEvidence(headers, 130001)).toBeUndefined();
  });

  it.each([
    ["", "10025", 10100], ["10000", "", 10100],
    ["NaN", "10025", 10100], ["10000", "Infinity", 10100],
    ["-10000", "-9999", 10100], ["10000.5", "10025", 10100],
    ["9007199254740992", "9007199254740992", 9007199254740992],
    ["10025", "10000", 10100], ["10000", "10101", 10100],
    ["10000", "10025", Number.NaN], ["10000", "10025", 10100.5],
  ])("does not turn invalid boundaries (%s, %s, %s) into measured clocks", (start, end, entered) => {
    const headers = new Headers({ [ACTION_PROXY_STARTED_HEADER]: String(start), [ACTION_PROXY_ENDED_HEADER]: String(end) });
    expect(actionEntryTimingEvidence(headers, Number(entered))).toBeUndefined();
    expect(actionEntryTimings(headers, Number(entered))).toEqual([]);
  });

  it("leaves absent clock evidence unknown", () => {
    expect(actionEntryTimingEvidence(new Headers(), 10100)).toBeUndefined();
    expect(actionEntryTimings(new Headers(), 10100)).toEqual([]);
  });
});


describe("Node receipt boundary validation", () => {
  const proxyHeaders = { [ACTION_PROXY_STARTED_HEADER]: "10000", [ACTION_PROXY_ENDED_HEADER]: "10025" };
  it("adds the measured Node -> Next interval and keeps the existing Proxy/handler intervals", () => {
    expect(actionEntryTimingEvidence(new Headers({ ...proxyHeaders, [NODE_HTTP_RECEIVED_HEADER]: "9950" }), 10100)).toEqual({
      epochs: { nodeHttpReceivedAtMs: 9950, nextProxyStartedAtMs: 10000, nextProxyEndedAtMs: 10025 },
      timings: ["node-dispatch;dur=50.00", "proxy;dur=25.00", "dispatch;dur=75.00"],
    });
    expect(actionEntryTimingEvidence(new Headers({ ...proxyHeaders, [NODE_HTTP_RECEIVED_HEADER]: "10000" }), 10100)?.timings[0])
      .toBe("node-dispatch;dur=0.00");
  });
  it.each([undefined, "", "0", "-1", "NaN", "Infinity", "9999.5", "9007199254740992", "10001", "10101", "1, 9950"])("keeps invalid or reversed Node boundary %s unknown while retaining valid Proxy evidence", node => {
    const headers = new Headers(proxyHeaders);
    if (node !== undefined) headers.set(NODE_HTTP_RECEIVED_HEADER, node);
    expect(actionEntryTimingEvidence(headers, 10100)).toEqual({
      epochs: { nextProxyStartedAtMs: 10000, nextProxyEndedAtMs: 10025 },
      timings: ["proxy;dur=25.00", "dispatch;dur=75.00"],
    });
  });
  it("keeps a measured Node receipt when Proxy is missing, without synthesizing a Proxy clock or interval", () => {
    expect(actionEntryTimingEvidence(new Headers({ [NODE_HTTP_RECEIVED_HEADER]: "10000" }), 10100))
      .toEqual({ epochs: { nodeHttpReceivedAtMs: 10000 }, timings: [] });
    expect(actionEntryTimingEvidence(new Headers({ [NODE_HTTP_RECEIVED_HEADER]: "10000" }), 130001)).toBeUndefined();
    expect(actionEntryTimingEvidence(new Headers({ [NODE_HTTP_RECEIVED_HEADER]: "10000" }), Number.NaN)).toBeUndefined();
  });
});

describe("native socket callback metadata", () => {
  const native = { [NODE_HTTP_RECEIVED_HEADER]: "200000", [NODE_SOCKET_ACCEPTED_HEADER]: "1000",
    [NODE_HTTP_LOCAL_PORT_HEADER]: "3197", [NODE_CONNECTION_ID_HEADER]: "12" };
  it("retains old keep-alive acceptance separately from the fresh per-request parse clock", () => {
    expect(actionEntryTimingEvidence(new Headers(native), 200050)).toEqual({
      epochs: { nodeHttpReceivedAtMs: 200000, nodeSocketAcceptedAtMs: 1000 },
      connection: { nodeHttpLocalPort: 3197, nodeConnectionId: 12 },
      timings: ['node-connection;desc="id=12;localPort=3197"', 'socket-headers;dur=199000.00;desc="includesIdle=1"'],
    });
  });
  it.each([undefined, "", "0", "-1", "1000.5", "200001", "1, 1000"])(
    "keeps a missing or invalid accept callback (%s) unknown without discarding valid listener evidence", value => {
      const headers = new Headers(native); headers.delete(NODE_SOCKET_ACCEPTED_HEADER);
      if (value !== undefined) headers.set(NODE_SOCKET_ACCEPTED_HEADER, value);
      const evidence = actionEntryTimingEvidence(headers, 200050);
      expect(evidence?.epochs).toEqual({ nodeHttpReceivedAtMs: 200000 });
      expect(evidence?.connection).toEqual({ nodeHttpLocalPort: 3197, nodeConnectionId: 12 });
      expect(evidence?.timings).toEqual(['node-connection;desc="id=12;localPort=3197"']);
    },
  );
  it("validates each fixed metadata field and never measures it without a valid Node clock", () => {
    for (const [name, value] of [[NODE_HTTP_LOCAL_PORT_HEADER, "65536"], [NODE_HTTP_LOCAL_PORT_HEADER, "0"],
      [NODE_HTTP_LOCAL_PORT_HEADER, "3197.5"], [NODE_CONNECTION_ID_HEADER, "0"],
      [NODE_CONNECTION_ID_HEADER, "1, 12"], [NODE_CONNECTION_ID_HEADER, "9007199254740992"]]) {
      const headers = new Headers(native); headers.set(name, value);
      const evidence = actionEntryTimingEvidence(headers, 200050);
      expect(evidence?.connection).not.toHaveProperty(name === NODE_HTTP_LOCAL_PORT_HEADER ? "nodeHttpLocalPort" : "nodeConnectionId");
      expect(evidence?.epochs.nodeSocketAcceptedAtMs).toBe(1000);
    }
    const headers = new Headers({ ...native, [ACTION_PROXY_STARTED_HEADER]: "200000", [ACTION_PROXY_ENDED_HEADER]: "200010" });
    headers.delete(NODE_HTTP_RECEIVED_HEADER);
    expect(actionEntryTimingEvidence(headers, 200050)).toEqual({
      epochs: { nextProxyStartedAtMs: 200000, nextProxyEndedAtMs: 200010 },
      timings: ["proxy;dur=10.00", "dispatch;dur=40.00"],
    });
  });
});


describe("public fixed runtime timing without widening private access", () => {
  it.each(["monaco/0.56.0/loader.js", "codemirror/5.65.16/lib/codemirror.js", "katex/0.18.2/katex.min.js", "pyodide/0.25.0/pyodide.js", "three/0.160.0/build/three.module.js"])("times public GET %s without identity or asset-path metric labels", async asset => {
    const pathname=`/api/openmaic/interactive-runtime/${asset}`;
    expect(isHttpEntryTimingRequest("GET", pathname)).toBe(true);expect(isHttpEntryTimingRequest("POST", pathname)).toBe(false);
    process.env.JWT_SECRET="public-runtime-timing-secret-with-at-least-32-characters";
    const response=await proxy(new NextRequest(`http://localhost${pathname}`, { headers: { [ACTION_PROXY_STARTED_HEADER]:"1", [ACTION_PROXY_ENDED_HEADER]:"9999999999999" } }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_STARTED_HEADER}`))).toBeGreaterThan(1);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src");
    const result=await withHttpMetrics("GET", "/api/openmaic/interactive-runtime/:runtime/:path", async () => new Response("asset", { headers: { "Cache-Control":"public, max-age=31536000, immutable", "Access-Control-Allow-Origin":"*" } }))(new Request(`http://localhost${pathname}`));
    expect(await result.text()).toBe("asset");expect(result.headers.get("Cache-Control")).toContain("immutable");expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(result.headers.get("Server-Timing")).toContain("handler;dur=");
    expect(isHttpEntryTimingRequest("POST", "/api/openmaic/classroom-media/private/audio.wav")).toBe(false);
    expect(isHttpEntryTimingRequest("GET", "/api/uploads/private")).toBe(false);
  });
});

it("accepts only bounded native attempt IDs, with safe positive sequence numbers", () => {
  for (const sequence of ["1", String(Number.MAX_SAFE_INTEGER)]) {
    const id = `http-${"a".repeat(32)}-${sequence}`; expect(readNativeHttpRequestId(id)).toBe(id);
  }
  for (const value of [undefined, null, [], "private-business-id", `http-${"a".repeat(32)}-0`,
    `http-${"a".repeat(32)}-01`, `http-${"a".repeat(32)}-9007199254740992`, `http-${"a".repeat(32)}-1\n`]) {
    expect(readNativeHttpRequestId(value)).toBeUndefined();
  }
});
