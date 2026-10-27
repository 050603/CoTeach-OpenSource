// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));
import { collectProgressTimings, progressServerTimings, timeProgress, timeProgressSync, type ProgressTimingSpan } from "./progress-request-timing";
import { withHttpMetrics } from "./http";

describe("request-local progress timing", () => {
  it("keeps instrumented responses and unconsumed request bodies intact", async () => {
    const request = new Request("http://localhost/api/openmaic/progress", { method: "POST", body: "original request body" });
    const original = new Response("original response body", { status: 409,
      headers: { "Server-Timing": "existing;dur=1", "Cache-Control": "private, no-store" } });
    const response = await withHttpMetrics("POST", "/api/openmaic/progress", async received => {
      expect(received).toBe(request);
      return timeProgress("progress-auth", async () => original);
    })(request);
    expect(response).toBe(original); expect(response.status).toBe(409);
    expect(request.bodyUsed).toBe(false); expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Server-Timing")).toMatch(/^existing;dur=1, progress-auth;dur=/);
    expect(await response.text()).toBe("original response body");
    expect(await request.text()).toBe("original request body");
  });

  it("isolates interleaved requests, preserves repeated phases and nested boundaries", async () => {
    const first: ProgressTimingSpan[] = []; const second: ProgressTimingSpan[] = [];
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const a = collectProgressTimings(performance.now(), first, async () => {
      await timeProgress("progress-transaction", () => timeProgress("progress-callback", async () => {
        await barrier;
        await timeProgress("progress-read", async () => 1);
        await timeProgress("progress-read", async () => 2);
      }));
      return "first-original-result";
    });
    const b = collectProgressTimings(performance.now(), second, async () => {
      const result = await timeProgress("progress-auth", async () => "second-original-result");
      release(); return result;
    });
    expect(await Promise.all([a, b])).toEqual(["first-original-result", "second-original-result"]);
    expect(second.map(span => span.phase)).toEqual(["progress-auth"]);
    expect(first.filter(span => span.phase === "progress-read")).toHaveLength(2);
    expect(first.some(span => span.phase === "progress-auth")).toBe(false);
    const transaction = first.find(span => span.phase === "progress-transaction")!;
    for (const span of first) {
      expect(span.startMs).toBeGreaterThanOrEqual(transaction.startMs);
      expect(span.endMs).toBeLessThanOrEqual(transaction.endMs);
    }
    expect(progressServerTimings(first).filter(value => value.startsWith("progress-read;"))).toHaveLength(2);
  });

  it("retains the original error and failed span, and leaves uncollected calls unchanged", async () => {
    const spans: ProgressTimingSpan[] = []; const failure = new Error("private failure must not enter timing");
    await expect(collectProgressTimings(performance.now(), spans, () =>
      timeProgress("progress-write", async () => { throw failure; }))).rejects.toBe(failure);
    expect(spans).toHaveLength(1); expect(spans[0].outcome).toBe("error");
    expect(progressServerTimings(spans).join()).not.toContain(failure.message);
    const value = {};
    expect(timeProgressSync("progress-merge", () => value)).toBe(value);
    expect(await timeProgress("progress-read", async () => value)).toBe(value);
    expect(spans).toHaveLength(1);
  });

  it("preserves document abort identity and a bounded, private 504 header including repeated repair spans", async () => {
    const controller = new AbortController();
    const failure = new DOMException("secret provider/token detail", "TimeoutError");
    const original = Response.json({ error: "AI_COLLABORATION_TIMEOUT" }, { status: 504 });
    const response = await withHttpMetrics("POST", "/api/ai-collaboration/document", async () => {
      try {
        await timeProgress("document-model-initial", async () => {
          controller.abort(failure);
          controller.signal.throwIfAborted();
        });
      } catch (error) { expect(error).toBe(failure); }
      // Exercise the existing header bound independently of actual repair budgets.
      for (let index = 0; index < 100; index += 1) await timeProgress("document-model-repair", async () => undefined);
      return original;
    })(new Request("http://localhost/api/ai-collaboration/document", { method: "POST" }));
    expect(response).toBe(original);
    expect(response.status).toBe(504);
    const header = response.headers.get("Server-Timing")!;
    expect(header).toMatch(/document-model-initial;dur=[\d.]+;desc="start=[\d.]+;end=[\d.]+;outcome=error"/);
    expect(header).toContain("document-model-repair;");
    expect(header).toContain("progress-timing-omitted;");
    expect(header).not.toContain(failure.message);
    // The wrapper also appends its fixed handler/native boundary fields.
    expect(header.length).toBeLessThan(6_500);
    expect(await response.json()).toEqual({ error: "AI_COLLABORATION_TIMEOUT" });
  });

  it("bounds response diagnostics under continuous contention and explicitly reports omitted spans", async () => {
    const spans: ProgressTimingSpan[] = Array.from({ length: 1_000 }, (_, sequence) => ({
      phase: sequence % 2 ? "course-admission-backoff" : "course-admission",
      sequence, startMs: sequence * 10, endMs: sequence * 10 + 5,
      outcome: sequence % 2 ? "ok" : "error",
    }));
    const original = JSON.stringify(spans);
    const headers = progressServerTimings(spans);
    expect(headers.join(", ").length).toBeLessThanOrEqual(6_144);
    expect(headers.length).toBeGreaterThan(2);
    expect(headers.at(-1)).toBe(`progress-timing-omitted;desc="count=${spans.length - headers.length + 1}"`);
    expect(headers.at(-1)).not.toContain("dur=");
    expect(headers[0]).toBe('course-admission;dur=5.000;desc="start=0.000;end=5.000;outcome=error"');
    expect(headers[1]).toBe('course-admission-backoff;dur=5.000;desc="start=10.000;end=15.000;outcome=ok"');
    expect(JSON.stringify(spans)).toBe(original);
    expect(progressServerTimings([])).toEqual([]);
  });
});
