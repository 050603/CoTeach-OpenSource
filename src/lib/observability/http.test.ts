// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
const metricSpies = vi.hoisted(() => ({ increment: vi.fn(), observe: vi.fn(), operationObserve: vi.fn(), operationLabels: vi.fn(), entryObserve: vi.fn(), entryLabels: vi.fn(), entryIncrement: vi.fn(), entryMeasurementLabels: vi.fn() }));
vi.mock("./metrics", () => ({
  httpApplicationEntryDurationSeconds: { labels: (...args: string[]) => { metricSpies.entryLabels(...args); return { observe: metricSpies.entryObserve }; } },
  httpApplicationEntryMeasurementsTotal: { labels: (...args: string[]) => { metricSpies.entryMeasurementLabels(...args); return { inc: metricSpies.entryIncrement }; } },
  httpRequestsTotal: { labels: vi.fn(() => ({ inc: metricSpies.increment })) },
  httpRequestDurationSeconds: { labels: vi.fn(() => ({ observe: metricSpies.observe })) },
  httpOperationDurationSeconds: { labels: (...args: string[]) => { metricSpies.operationLabels(...args); return { observe: metricSpies.operationObserve }; } },
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));
import { logger } from "./logger";
import { NODE_HTTP_RECEIVED_HEADER, ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER } from "./action-entry-timing";
import { withHttpMetrics } from "./http";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  metricSpies.increment.mockReset();
  metricSpies.observe.mockReset();
});

describe("HTTP operation SLO measurements", () => {
  it("records a fixed read route separately from an accepted review and allows explicit poll classification", async () => {
    await withHttpMetrics("GET", "/api/courses", async () => Response.json({ courses: [] }))(
      new Request("http://localhost/api/courses?courseId=private-student-course"));
    expect(metricSpies.operationLabels).toHaveBeenLastCalledWith("GET", "/api/courses", "read");
    await withHttpMetrics("POST", "/api/ai-collaboration/document", async () => Response.json({ pending: true }, { status: 202 }))(
      new Request("http://localhost/api/ai-collaboration/document", { method: "POST" }));
    expect(metricSpies.operationLabels).toHaveBeenLastCalledWith("POST", "/api/ai-collaboration/document", "ai-background");
    await withHttpMetrics("GET", "/api/ai-collaboration/document", async () => Response.json({ pending: true }),
      { operation: request => new URL(request.url).searchParams.has("requestId") ? "ai-background" : "read" })(
      new Request("http://localhost/api/ai-collaboration/document?requestId=private-request"));
    expect(metricSpies.operationLabels).toHaveBeenLastCalledWith("GET", "/api/ai-collaboration/document", "ai-background");
  });
});

describe("classroom read timing evidence", () => {
  it.each(["/api/server-providers", "/api/openmaic/classroom", "/api/courses/:courseId/presence"])(
    "reports actual handler duration for %s without replacing response contents", async route => {
      vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(350);
      const body = JSON.stringify({ saved: "真实正文", secret: "not-a-timing-label" });
      const original = new Response(body, { headers: { "Server-Timing": "cache;desc=miss", "Content-Type": "application/json" } });
      const response = await withHttpMetrics("GET", route, async () => original)(new Request("http://localhost/test"));
      expect(response).toBe(original);
      expect(response.headers.get("Server-Timing")).toBe("cache;desc=miss, handler;dur=250.00");
      expect(await response.text()).toBe(body);
    },
  );
  it("retains an authentication failure and times the actual rejected request", async () => {
    const response = await withHttpMetrics("GET", "/api/server-providers", async () =>
      Response.json({ error: "UNAUTHORIZED" }, { status: 401 }))(new Request("http://localhost/api/server-providers"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(response.headers.get("Server-Timing")).toMatch(/^handler;dur=\d+\.\d{2}$/);
  });
});


describe("native progress timing evidence", () => {
  it.each(["GET", "POST"])("times %s without consuming the request or replacing the response", async method => {
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(350);
    const body = JSON.stringify({ data: { progress: { studentId: "synthetic-student", completedScenes: ["scene-1"] } } });
    const original = new Response(body, { headers: { "Server-Timing": "cache;desc=miss", "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
    const request = new Request("http://localhost/api/openmaic/progress?courseId=synthetic-course", {
      method, ...(method === "POST" ? { body: JSON.stringify({ courseId: "synthetic-course" }) } : {}),
    });
    const handler = vi.fn(async (received: Request) => { expect(received).toBe(request); return original; });
    const response = await withHttpMetrics(method, "/api/openmaic/progress", handler)(request);
    expect(response).toBe(original);
    expect(response.status).toBe(200);
    expect(response.headers.get("Server-Timing")).toBe("cache;desc=miss, handler;dur=250.00");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(request.bodyUsed).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    expect(await response.text()).toBe(body);
  });

});


describe("selected HTTP boundary completion logs", () => {
  it("captures return before metrics/logging and preserves the monotonic duration and response", async () => {
    let wallClock = 10000;
    let wallClockAtLog: number | undefined;
    vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(350);
    metricSpies.increment.mockImplementationOnce(() => { wallClock += 2000; });
    vi.mocked(logger.info).mockImplementationOnce(() => { wallClockAtLog = wallClock; });
    const request = new Request("http://localhost/api/server-providers", { headers: {
      "x-request-id": "acceptance-synthetic",
      [ACTION_PROXY_STARTED_HEADER]: "9900", [ACTION_PROXY_ENDED_HEADER]: "9920",
      authorization: "private-header", "x-unrelated-diagnostic": "must-not-be-copied",
    } });
    const original = Response.json({ saved: "真实正文" }, { headers: { "Cache-Control": "no-store" } });
    const result = await withHttpMetrics("GET", "/api/server-providers", async () => {
      wallClock += 250;
      return original;
    })(request);
    expect(result).toBe(original);
    expect(await result.json()).toEqual({ saved: "真实正文" });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Server-Timing")).toBe("proxy;dur=20.00, dispatch;dur=80.00, handler;dur=250.00");
    expect(logger.info).toHaveBeenCalledExactlyOnceWith({
      requestId: "acceptance-synthetic", method: "GET", route: "/api/server-providers", status: 200,
      durationScope: "handler", durationMs: 250, handlerEnteredAtMs: 10000, handlerReturnedAtMs: 10250,
      nextProxyStartedAtMs: 9900, nextProxyEndedAtMs: 9920,
    }, "request completed");
    expect(wallClockAtLog).toBe(12250);
    expect(metricSpies.observe).toHaveBeenCalledExactlyOnceWith(0.25);
  });

  const invalidHeaders: Record<string, string>[] = [
    {}, { [ACTION_PROXY_STARTED_HEADER]: "10100", [ACTION_PROXY_ENDED_HEADER]: "10000" },
  ];
  it.each(invalidHeaders)(
    "keeps actual handler clocks but omits absent/invalid Next boundaries", async headers => {
      vi.spyOn(Date, "now").mockReturnValue(10000);
      await withHttpMetrics("GET", "/api/openmaic/classroom", async () => Response.json({ ok: true }))(
        new Request("http://localhost/api/openmaic/classroom", { headers }),
      );
      const fields = vi.mocked(logger.info).mock.calls[0][0];
      expect(fields).toMatchObject({ handlerEnteredAtMs: 10000, handlerReturnedAtMs: 10000 });
      expect(fields).not.toHaveProperty("nextProxyStartedAtMs");
      expect(fields).not.toHaveProperty("nextProxyEndedAtMs");
    },
  );

  it("does not expand boundary logging to untimed routes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    await withHttpMetrics("GET", "/api/health/live", async () => Response.json({ ok: true }))(
      new Request("http://localhost/api/health/live", { headers: {
        [ACTION_PROXY_STARTED_HEADER]: "9900", [ACTION_PROXY_ENDED_HEADER]: "9920",
      } }),
    );
    const fields = vi.mocked(logger.info).mock.calls[0][0];
    for (const key of ["nextProxyStartedAtMs", "nextProxyEndedAtMs", "handlerEnteredAtMs", "handlerReturnedAtMs"])
      expect(fields).not.toHaveProperty(key);
  });

  it("records the thrown handler boundary and preserves the original rejection", async () => {
    let wallClock = 10000;
    vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    const failure = new Error("original failure");
    const result = withHttpMetrics("GET", "/api/server-providers", async () => {
      wallClock += 25;
      throw failure;
    })(new Request("http://localhost/api/server-providers"));
    await expect(result).rejects.toBe(failure);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      status: 500, handlerEnteredAtMs: 10000, handlerReturnedAtMs: 10025,
    }), "request completed");
  });
});


describe("native application-entry operation metrics", () => {
  it("keeps a fast handler measurement while observing the actual measured Node-to-return interval", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(110);
    const original = Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    const response = await withHttpMetrics("GET", "/api/server-providers", async () => original)(
      new Request("http://localhost/api/server-providers?identity=must-not-be-a-label", { headers: {
        [NODE_HTTP_RECEIVED_HEADER]: "7900", [ACTION_PROXY_STARTED_HEADER]: "9900", [ACTION_PROXY_ENDED_HEADER]: "9990",
      } }));
    expect(response).toBe(original); expect(await response.json()).toEqual({ ok: true });
    expect(metricSpies.operationObserve).toHaveBeenCalledExactlyOnceWith(0.01);
    expect(metricSpies.entryLabels).toHaveBeenCalledExactlyOnceWith("GET", "/api/server-providers", "read");
    expect(metricSpies.entryMeasurementLabels).toHaveBeenCalledExactlyOnceWith("GET", "/api/server-providers", "read", "measured");
    expect(metricSpies.entryObserve).toHaveBeenCalledExactlyOnceWith(2.11);
  });
  it.each([undefined, "1, 9950", "10001"])("counts an absent/invalid Node clock (%s) as unknown, without a zero-latency sample", async value => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    const headers = new Headers({ [ACTION_PROXY_STARTED_HEADER]: "9990", [ACTION_PROXY_ENDED_HEADER]: "9995" });
    if (value !== undefined) headers.set(NODE_HTTP_RECEIVED_HEADER, value);
    await withHttpMetrics("GET", "/api/courses", async () => Response.json({ ok: true }))(
      new Request("http://localhost/api/courses", { headers }));
    expect(metricSpies.entryMeasurementLabels).toHaveBeenCalledExactlyOnceWith("GET", "/api/courses", "read", "unknown");
    expect(metricSpies.entryObserve).not.toHaveBeenCalled();
  });
  it("does not create missing-clock series for routes outside the timed allowlist", async () => {
    await withHttpMetrics("GET", "/api/health/live", async () => Response.json({ ok: true }))(
      new Request("http://localhost/api/health/live"));
    expect(metricSpies.entryMeasurementLabels).not.toHaveBeenCalled(); expect(metricSpies.entryObserve).not.toHaveBeenCalled();
  });
  it("keeps a rejected handler's original error while recording its measured application interval", async () => {
    let wall = 10000; vi.spyOn(Date, "now").mockImplementation(() => wall);
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(125);
    const failure = Error("original error");
    await expect(withHttpMetrics("GET", "/api/courses", async () => { wall+=25; throw failure; })(
      new Request("http://localhost/api/courses", { headers: { [NODE_HTTP_RECEIVED_HEADER]: "9900" } }))).rejects.toBe(failure);
    expect(metricSpies.entryObserve).toHaveBeenCalledExactlyOnceWith(0.125);
  });
  it("does not turn a reversed handler wall clock into a measured zero", async () => {
    let wall=10000; vi.spyOn(Date, "now").mockImplementation(() => wall);
    const response = await withHttpMetrics("GET", "/api/courses", async () => { wall=9999; return Response.json({ ok: true }); })(
      new Request("http://localhost/api/courses", { headers: { [NODE_HTTP_RECEIVED_HEADER]: "9900" } }));
    expect(response.status).toBe(200);expect(metricSpies.entryObserve).not.toHaveBeenCalled();
    expect(metricSpies.entryMeasurementLabels).toHaveBeenCalledExactlyOnceWith("GET", "/api/courses", "read", "unknown");
  });
  it("never invalidates a saved response if the new monitoring collector fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    metricSpies.entryObserve.mockImplementationOnce(() => { throw Error("collector failed"); });
    const original = Response.json({ saved: true });
    const response = await withHttpMetrics("POST", "/api/openmaic/progress", async () => original)(
      new Request("http://localhost/api/openmaic/progress", { method:"POST", headers: { [NODE_HTTP_RECEIVED_HEADER]: "9900" } }));
    expect(response).toBe(original); expect(await response.json()).toEqual({ saved: true });
  });
});


describe("hot classroom boundaries", () => {
  it.each([
    ["GET", "/api/courses/course/public-discussion?soundClientId=private", "/api/courses/:courseId/public-discussion", "read"],
    ["PUT", "/api/courses/course/presence", "/api/courses/:courseId/presence", "write"],
    ["DELETE", "/api/courses/course/presence", "/api/courses/:courseId/presence", "write"],
  ])("records actual clock coverage for %s %s with a fixed operation/route", async (method, path, route, operation) => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(110);
    const original = method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ ok: true });
    const result = await withHttpMetrics(method, route, async () => original)(new Request(`http://localhost${path}`, {
      method, headers: { [NODE_HTTP_RECEIVED_HEADER]: "9900", [ACTION_PROXY_STARTED_HEADER]: "9920", [ACTION_PROXY_ENDED_HEADER]: "9950" },
    }));
    expect(result).toBe(original);
    expect(metricSpies.entryMeasurementLabels).toHaveBeenCalledExactlyOnceWith(method, route, operation, "measured");
    expect(metricSpies.entryObserve).toHaveBeenCalledExactlyOnceWith(0.11);
    expect(result.headers.get("Server-Timing")).toMatch(/^node-dispatch;dur=20.00, proxy;dur=30.00, dispatch;dur=50.00, handler;dur=/);
    if (method === "DELETE") expect(await result.text()).toBe("");
    else expect(await result.json()).toEqual({ ok: true });
  });

  it("times a private ranged media Response without consuming or timing the remaining stream", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(110);
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(Uint8Array.of(1, 2, 3)); controller.close();
    });
    const original = new Response(new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), { status: 206, headers: {
      "Cache-Control": "private, no-store", "Content-Type": "audio/wav", "Content-Range": "bytes 0-2/3", "Content-Length": "3",
    } });
    const route = "/api/openmaic/classroom-media/:classroomId/:path";
    const response = await withHttpMetrics("GET", route, async () => original)(new Request("http://localhost/api/openmaic/classroom-media/private/audio/voice.wav", {
      headers: { [NODE_HTTP_RECEIVED_HEADER]: "9900", range: "bytes=0-2" },
    }));
    expect(response).toBe(original); expect(response.bodyUsed).toBe(false); expect(pull).not.toHaveBeenCalled();
    expect(metricSpies.entryMeasurementLabels).toHaveBeenCalledExactlyOnceWith("GET", route, "resource", "measured");
    expect(metricSpies.entryObserve).toHaveBeenCalledExactlyOnceWith(0.11);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-2/3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    expect(metricSpies.entryObserve).toHaveBeenCalledTimes(1);
  });
});
