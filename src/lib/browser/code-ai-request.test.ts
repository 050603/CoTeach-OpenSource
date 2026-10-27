import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_BROWSER_TIMEOUT_MS, COLLABORATION_EXECUTION_TIMEOUT_MS } from "@/lib/ai-collaboration/request-budget";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./bounded-fetch", () => ({ boundedFetch: mocks.fetch }));
import { acknowledgeCodeAiRequest, readPendingCodeAiRequest, requestBackgroundCodeAi, requestCodeAi, readPendingBackgroundCodeAi, codeBackgroundScope } from "./code-ai-request";
const body = { courseId: "course", studentId: "student", stageKey: "make", language: "python", intent: "discuss", message: "explain", artifact: { files: ["old"] } };
describe("durable code AI requests", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("reuses the paid request and its original artifact after a lost response", async () => {
    mocks.fetch.mockImplementationOnce(async (url: string) => Response.json({ error: "REQUEST_STATE_UNAVAILABLE", status: "failed", retryable: true,
      requestId: new URL(url, "https://test").searchParams.get("requestId") }, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    await expect(requestCodeAi("scope", "sidebar", body)).rejects.toThrow("offline");
    const pending = readPendingCodeAiRequest("scope", "sidebar")!;
    const posted = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(posted.requestId).toBe(pending.requestId);
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: "completed", result: { message: "done" } }));
    const result = await requestCodeAi("scope", "sidebar", { ...body, artifact: { files: ["new"] } });
    expect(result.pending.body.artifact).toEqual(body.artifact);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    acknowledgeCodeAiRequest("scope", "sidebar", pending.requestId);
    expect(readPendingCodeAiRequest("scope", "sidebar")).toBeNull();
  });
  it("does not overwrite an unresolved request with a different question", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(requestCodeAi("scope", "comment", body)).rejects.toThrow();
    await expect(requestCodeAi("scope", "comment", { ...body, message: "different" })).rejects.toThrow("先恢复");
    expect(readPendingCodeAiRequest("scope", "comment")?.body.message).toBe("explain");
    expect(readPendingCodeAiRequest("another-student", "comment")).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not launch generation after an infrastructure failure or denied receipt read", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "DATABASE_UNAVAILABLE" }, { status: 503 }));
    expect((await requestCodeAi("scope", "sidebar", body)).response.status).toBe(503);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "FORBIDDEN" }, { status: 403 }));
    expect((await requestCodeAi("scope", "sidebar", body)).response.status).toBe(403);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("joins a background review until its durable receipt completes", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let requestId = '';
    mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      requestId ||= JSON.parse(String(options.body)).requestId;
      const complete = mocks.fetch.mock.calls.length === 3;
      return Response.json({ requestId, status: complete ? 'completed' : 'processing', commentThreads: [] }, { status: complete ? 200 : 202 });
    });
    const result = requestBackgroundCodeAi(body, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(12_500);
    expect(await (await result).json()).toMatchObject({ status: "completed", commentThreads: [] });
    expect(mocks.fetch.mock.calls[0][1].method).toBe("POST");
    expect(new URL(mocks.fetch.mock.calls[1][0], 'https://test').searchParams.get('requestId')).toBe(requestId);
    expect(new URL(mocks.fetch.mock.calls[2][0], 'https://test').searchParams.get('requestId')).toBe(requestId);
    expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))).toEqual([]);
  });
  it("keeps waiting for a normal reasoning review past the old 50 second cutoff", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const controller = new AbortController();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let requestId = '';
    mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
      requestId ||= JSON.parse(String(options.body)).requestId;
      return Date.now() - startedAt < 105_000
        ? Response.json({ requestId, status: 'processing' }, { status: 202 })
        : Response.json({ requestId, status: 'completed', commentThreads: [] });
    });
    const result = requestBackgroundCodeAi(body, controller.signal);
    await vi.advanceTimersByTimeAsync(115_000);
    expect(await (await result).json()).toMatchObject({ status: "completed" });
    expect(mocks.fetch.mock.calls[0][2]).toBe(COLLABORATION_BROWSER_TIMEOUT_MS);
    expect(COLLABORATION_BROWSER_TIMEOUT_MS).toBeGreaterThan(COLLABORATION_EXECUTION_TIMEOUT_MS);
    expect(mocks.fetch.mock.calls.every(call => call[1].signal === controller.signal)).toBe(true);
  });
  it("still cancels a pending background receipt when the artifact becomes stale", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => Response.json({ requestId: JSON.parse(String(options.body)).requestId, status: 'processing' }, { status: 202 }));
    const controller = new AbortController();
    const result = requestBackgroundCodeAi(body, controller.signal);
    const rejected = expect(result).rejects.toThrow("artifact changed");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("artifact changed"));
    await rejected;
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))).toHaveLength(1);
  });
  it('recovers a lost admission response by the original alias without another POST', async () => {
    let posted: Record<string, unknown>;
    mocks.fetch.mockImplementationOnce(async (_url: string, options: RequestInit) => { posted = JSON.parse(String(options.body)); throw new TypeError('lost 202'); })
      .mockImplementationOnce(async () => Response.json({ requestId: posted.requestId, status: 'completed' }));
    expect((await requestBackgroundCodeAi(body, new AbortController().signal)).status).toBe(200);
    expect(mocks.fetch.mock.calls.map(call => call[1].method ?? 'GET')).toEqual(['POST', 'GET']);
    expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))).toEqual([]);
  });
  it('replays only the immutable original body after a lost unaccepted POST and reload', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('offline'));
    await expect(requestBackgroundCodeAi(body, new AbortController().signal)).rejects.toThrow('offline');
    const retained = readPendingBackgroundCodeAi(codeBackgroundScope(body))[0];
    mocks.fetch.mockReset().mockResolvedValueOnce(Response.json({ error: 'REQUEST_NOT_FOUND' }, { status: 404 }))
      .mockImplementationOnce(async () => Response.json({ requestId: retained.requestId, status: 'completed' }));
    await requestBackgroundCodeAi(JSON.parse(retained.body), new AbortController().signal);
    expect(mocks.fetch.mock.calls[1][1].body).toBe(retained.body);
    expect(readPendingBackgroundCodeAi(codeBackgroundScope({ ...body, studentId: 'another' }))).toEqual([]);
  });
  it('retains exact input on mismatched receipt or terminal failure, and never POSTS after denied read', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ requestId: 'different', status: 'completed' }));
    await expect(requestBackgroundCodeAi(body, new AbortController().signal)).rejects.toThrow('匹配');
    const retained = readPendingBackgroundCodeAi(codeBackgroundScope(body))[0];
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: 'FORBIDDEN' }, { status: 403 }));
    expect((await requestBackgroundCodeAi(body, new AbortController().signal)).status).toBe(403);
    expect(mocks.fetch.mock.calls[1][1].method).toBeUndefined();
    mocks.fetch.mockResolvedValueOnce(Response.json({ requestId: retained.requestId, status: 'failed' }));
    await expect(requestBackgroundCodeAi(body, new AbortController().signal)).rejects.toThrow('保留');
    expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))[0]).toEqual(retained);
  });
  it('does not start background execution when immutable input cannot be stored', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    await expect(requestBackgroundCodeAi(body, new AbortController().signal)).rejects.toThrow('quota');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
