// @vitest-environment node
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseReadWorkerPool, courseReadThreadEnvironment } from "./course-read-worker-pool";
import type { CourseReadWorkerConfig } from "./course-read-worker-config";
import type { CourseReadWorkerRequest } from "./course-read-worker-protocol";
import { collectProgressTimings, type ProgressTimingSpan } from "@/lib/observability/progress-request-timing";

const config: CourseReadWorkerConfig = { enabled: true, count: 2, budget: 57, perWorkerConnections: 16,
  primaryDatabaseUrl: "postgresql://writer:secret@localhost/test?connection_limit=25",
  workerDatabaseUrl: "postgresql://reader:read-secret@localhost/test?connection_limit=16" };
class FakeThread extends EventEmitter {
  sent: CourseReadWorkerRequest[] = [];
  terminate = vi.fn(async () => 0);
  ref = vi.fn(); unref = vi.fn();
  postMessage(message: CourseReadWorkerRequest) { this.sent.push(message); }
  ready() { this.emit("message", { type: "ready", protocol: 1 }); }
  jobs() { return this.sent.filter(value => value.type === "execute"); }
  finish(id: number, text = "ok", spans: ProgressTimingSpan[] = []) {
    this.emit("message", { type: "result", id, status: 200, statusText: "OK", headers: [["content-type", "text/plain"]],
      cookies: ["session=a; HttpOnly", "student=b; HttpOnly"], body: new TextEncoder().encode(text).buffer,
      phaseSpans: spans, executionMs: 100 });
  }
}
function setup(overrides: Partial<CourseReadWorkerConfig> = {}) {
  const threads: FakeThread[] = [], verify = vi.fn(async () => {});
  const pool = new CourseReadWorkerPool({ ...config, ...overrides }, { verify, env: { JWT_SECRET: "x".repeat(32) },
    create: () => { const thread = new FakeThread(); threads.push(thread); return thread as unknown as Worker; } });
  return { pool, threads, verify };
}
async function ready(context: ReturnType<typeof setup>) {
  const start = context.pool.initialize();
  await vi.waitFor(() => expect(context.threads).toHaveLength(config.count));
  for (const thread of context.threads) thread.ready();
  await start;
}
const request = (signal?: AbortSignal) => new Request("http://localhost/api/courses?courseId=class", { signal,
  headers: { cookie: "openpbl=one", "x-openpbl-role": "student" } });
afterEach(() => vi.useRealTimers());

describe("bounded read thread execution", () => {
  it("rejects malformed HTTP inputs before initialization, queueing or assigning a job ID", async () => {
    const context = setup();
    const invalid = await context.pool.execute("state", new Request("http://localhost/api/courses/one/state"), "other");
    expect(invalid.status).toBe(400); expect(context.verify).not.toHaveBeenCalled(); expect(context.threads).toHaveLength(0);
    expect(context.pool.health()).toMatchObject({ active: 0, queued: 0, restarts: 0 });
    await ready(context);
    const valid = context.pool.execute("courses", request());
    await vi.waitFor(() => expect(context.threads[0].jobs()).toHaveLength(1));
    expect(context.threads[0].jobs()[0].id).toBe(1);
    context.threads[0].finish(1); expect((await valid).status).toBe(200); await context.pool.stop();
  });
  it("keeps concurrent valid reads alive when user course, URI or headers exceed IPC limits", async () => {
    const context = setup(); await ready(context);
    const valid = context.pool.execute("courses", request());
    await vi.waitFor(() => expect(context.pool.health().active).toBe(1));
    const longId = 'a'.repeat(257);
    const cases: ["courses" | "state", Request, string | undefined, number][] = [
      ["state", new Request(`http://localhost/api/courses/${longId}/state`), longId, 400],
      ["state", new Request("http://localhost/api/courses/one/state"), "other", 400],
      ["courses", new Request(`http://localhost/api/courses?x=${'a'.repeat(16_384)}`), undefined, 414],
      ["courses", new Request("http://localhost/api/courses", { headers: Array.from({ length: 129 }, (_, i) => [`x-${i}`, 'private']) }), undefined, 431],
      ["courses", new Request("http://localhost/api/courses", { headers: [['a', 'é'.repeat(32_766)], ['b', 'a'.repeat(65_531)]] }), undefined, 431],
    ];
    for (const [operation, input, courseId, status] of cases) {
      const response = await context.pool.execute(operation, input, courseId);
      expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("private");
    }
    expect(context.threads.flatMap(thread => thread.jobs())).toHaveLength(1);
    expect(context.threads.every(thread => thread.terminate.mock.calls.length === 0)).toBe(true);
    expect(context.pool.health()).toMatchObject({ ok: true, active: 1, queued: 0, restarts: 0, failures: 0 });
    context.threads[0].finish(1, "original"); expect(await (await valid).text()).toBe("original");
    const next = context.pool.execute("courses", request());
    await vi.waitFor(() => expect(context.threads[0].jobs()).toHaveLength(2));
    context.threads[0].finish(2, "next"); expect(await (await next).text()).toBe("next"); await context.pool.stop();
  });
  it("keeps the disabled deployment path free of artifacts and threads", async () => {
    const context = setup({ enabled: false, count: 0 });
    await context.pool.initialize(); expect(context.verify).not.toHaveBeenCalled(); expect(context.threads).toHaveLength(0);
    expect(context.pool.health()).toMatchObject({ ok: true, enabled: false }); await context.pool.stop();
  });
  it("passes only the reader identity and explicitly required authentication settings", () => {
    const env = courseReadThreadEnvironment(config, { JWT_SECRET: "secret", PUBLIC_BASE_URL: "https://school.test",
      PROVIDER_CONFIG_DATABASE_URL: "writer-secret", MODEL_API_KEY: "model-secret", REDIS_URL: "redis-secret", DATABASE_URL: "writer" });
    expect(env.DATABASE_URL).toBe(config.workerDatabaseUrl);
    expect(env).toMatchObject({ OPENPBL_COURSE_READ_WORKERS: "0", OPENPBL_INTERNAL_COURSE_READ_THREAD: "1", JWT_SECRET: "secret" });
    expect(JSON.stringify(env)).not.toMatch(/writer-secret|model-secret|redis-secret/);
  });
  it("shares initialization and balances 30 reads while bounding each thread at sixteen", async () => {
    const context = setup();
    expect(context.pool.initialize()).toBe(context.pool.initialize()); await ready(context);
    const results = Array.from({ length: 36 }, () => context.pool.execute("courses", request()));
    await vi.waitFor(() => expect(context.pool.health()).toMatchObject({ active: 32, queued: 4 }));
    expect(context.threads.map(thread => thread.jobs().length)).toEqual([16, 16]);
    for (const thread of context.threads) for (const job of thread.jobs()) thread.finish(job.id);
    for (const thread of context.threads) for (const job of thread.jobs().slice(16)) thread.finish(job.id);
    const responses = await Promise.all(results);
    expect(responses).toHaveLength(36); expect(responses[0].headers.getSetCookie()).toHaveLength(2);
    expect(context.pool.health()).toMatchObject({ active: 0, queued: 0 }); await context.pool.stop();
  });
  it("retains an aborted active read until its actual result, and removes only its queued successor", async () => {
    const context = setup(); await ready(context);
    const active = new AbortController(), queued = new AbortController();
    const first = context.pool.execute("courses", request(active.signal)).catch(error => error);
    const others = Array.from({ length: 31 }, () => context.pool.execute("courses", request()));
    const last = context.pool.execute("courses", request(queued.signal)).catch(error => error);
    await vi.waitFor(() => expect(context.pool.health()).toMatchObject({ active: 32, queued: 1 }));
    active.abort(); queued.abort();
    expect((await first).name).toBe("AbortError"); expect((await last).name).toBe("AbortError");
    expect(context.pool.health()).toMatchObject({ active: 32, queued: 0 });
    for (const thread of context.threads) for (const job of thread.jobs()) thread.finish(job.id);
    await Promise.all(others); expect(context.pool.health().active).toBe(0); await context.pool.stop();
  });
  it("records remote phases in their original caller even when responses arrive in reverse order", async () => {
    const context = setup(); await ready(context);
    const a: ProgressTimingSpan[] = [], b: ProgressTimingSpan[] = [];
    const first = collectProgressTimings(performance.now(), a, () => context.pool.execute("courses", request()));
    const second = collectProgressTimings(performance.now(), b, () => context.pool.execute("courses", request()));
    await vi.waitFor(() => expect(context.pool.health().active).toBe(2));
    context.threads[1].finish(context.threads[1].jobs()[0].id, "second", [{ phase: "courses-auth", sequence: 0, startMs: 2, endMs: 4, outcome: "ok" }]);
    context.threads[0].finish(context.threads[0].jobs()[0].id, "first", [{ phase: "courses-read", sequence: 0, startMs: 1, endMs: 7, outcome: "ok" }]);
    expect(await (await first).text()).toBe("first"); expect(await (await second).text()).toBe("second");
    expect(a.filter(span => span.phase === "courses-read")).toMatchObject([{ origin: "worker", startMs: 1, endMs: 7 }]);
    expect(b.filter(span => span.phase === "courses-auth")).toMatchObject([{ origin: "worker", startMs: 2, endMs: 4 }]);
    expect(a.filter(span => span.phase === "course-read-queue")).toHaveLength(1);
    expect(b.filter(span => span.phase === "course-read-execution")).toMatchObject([{ origin: "worker", endMs: 100 }]); await context.pool.stop();
  });
  it("waits for confirmed termination before replacement and ignores the old generation's late response", async () => {
    const context = setup(); await ready(context);
    const old = context.threads[0]; let terminated!: () => void;
    old.terminate.mockImplementationOnce(() => new Promise(resolve => { terminated = () => resolve(0); }));
    const read = context.pool.execute("courses", request()).catch(error => error);
    await vi.waitFor(() => expect(old.jobs()).toHaveLength(1)); old.emit("error", new Error("thread failed"));
    await Promise.resolve(); expect(context.threads).toHaveLength(2); expect(context.pool.health().ok).toBe(false);
    terminated(); expect((await read).code).toBe("COURSE_READ_UNAVAILABLE");
    await vi.waitFor(() => expect(context.threads).toHaveLength(3)); context.threads[2].ready();
    old.finish(old.jobs()[0].id, "stale");
    const next = context.pool.execute("courses", request());
    await vi.waitFor(() => expect(context.threads[2].jobs()).toHaveLength(1));
    context.threads[2].finish(context.threads[2].jobs()[0].id, "fresh");
    expect(await (await next).text()).toBe("fresh"); expect(context.pool.health().restarts).toBe(1); await context.pool.stop();
  });
  it("keeps missing diagnostic samples unknown and accepts a late sample without killing the thread", async () => {
    const context = setup(); await ready(context); vi.useFakeTimers();
    const sampling = context.pool.sample(); expect(context.pool.sample()).toBe(sampling);
    await vi.advanceTimersByTimeAsync(1001); expect(await sampling).toEqual([null, null]);
    const id = context.threads[0].sent.find(value => value.type === "stats")!.id;
    context.threads[0].emit("message", { type: "stats", id });
    expect(context.pool.health().ok).toBe(true); await context.pool.stop();
  });
  it("does not claim readiness when artifact verification fails", async () => {
    const pool = new CourseReadWorkerPool(config, { verify: async () => { throw Error("hash changed"); } });
    await expect(pool.initialize()).rejects.toThrow("hash changed"); expect(pool.health().ok).toBe(false); await pool.stop();
  });
  it("never spawns a late worker after shutdown during artifact verification", async () => {
    let verified!: () => void; const create = vi.fn();
    const pool = new CourseReadWorkerPool(config, { create, verify: () => new Promise<void>(resolve => { verified = resolve; }) });
    const start = pool.initialize().catch(error => error);
    await pool.stop(); verified();
    expect((await start).code).toBe("COURSE_READ_UNAVAILABLE"); expect(create).not.toHaveBeenCalled();
  });
  it("bounds HTTP execution time even while thread termination is still pending", async () => {
    const context = setup(); await ready(context); vi.useFakeTimers();
    let terminated!: () => void;
    context.threads[0].terminate.mockImplementationOnce(() => new Promise(resolve => { terminated = () => resolve(0); }));
    const read = context.pool.execute("courses", request()).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(20_001);
    expect((await read).code).toBe("COURSE_READ_UNAVAILABLE");
    expect(context.pool.health().active).toBe(1); expect(context.threads).toHaveLength(2);
    terminated(); await vi.advanceTimersByTimeAsync(0); context.threads[2].ready(); await context.pool.stop();
  });
  it("bounds waiting requests and expires them without starting database work", async () => {
    const context = setup(); await ready(context); vi.useFakeTimers();
    const reads = Array.from({ length: 288 }, () => context.pool.execute("courses", request()).catch(error => error));
    await vi.advanceTimersByTimeAsync(0);
    expect(context.pool.health()).toMatchObject({ active: 32, queued: 256 });
    await expect(context.pool.execute("courses", request())).rejects.toMatchObject({ code: "COURSE_READ_BUSY" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(context.pool.health()).toMatchObject({ active: 32, queued: 0 });
    expect(context.threads.reduce((sum, thread) => sum + thread.jobs().length, 0)).toBe(32);
    for (const thread of context.threads) for (const job of thread.jobs()) thread.finish(job.id);
    const outcomes = await Promise.all(reads);
    expect(outcomes.filter(value => value instanceof Response)).toHaveLength(32);
    expect(outcomes.filter(value => value.code === "COURSE_READ_BUSY")).toHaveLength(256); await context.pool.stop();
  });
  it("rejects affected readers and never creates replacement capacity when termination cannot be confirmed", async () => {
    const context = setup(); await ready(context);
    context.threads[0].terminate.mockRejectedValueOnce(Error("termination unknown"));
    const read = context.pool.execute("courses", request()).catch(error => error);
    await vi.waitFor(() => expect(context.threads[0].jobs()).toHaveLength(1));
    context.threads[0].emit("error", Error("worker error"));
    expect((await read).code).toBe("COURSE_READ_UNAVAILABLE");
    expect(context.threads).toHaveLength(2); expect(context.pool.health()).toMatchObject({ ok: false, active: 1 });
    await expect(context.pool.execute("courses", request())).rejects.toMatchObject({ code: "COURSE_READ_UNAVAILABLE" });
    await expect(context.pool.stop()).rejects.toMatchObject({ code: "COURSE_READ_UNAVAILABLE" });
  });
});
