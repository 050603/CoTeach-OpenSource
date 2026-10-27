import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCoursePresence } from "@/hooks/use-course-presence";
import { toast } from "sonner";
import type { PendingSaveTelemetry } from "@/lib/presence-save-telemetry";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCoursePresence", () => {
  it("coalesces a manual refresh behind the active read and waits for a fresh response", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))));
    const { result } = renderHook(() => useCoursePresence({ courseId: "course-1", role: "teacher" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    let latest: Promise<void> | undefined;
    act(() => { latest = result.current.refresh(); });
    expect(pending).toHaveLength(1);
    await act(async () => {
      pending[0]!(Response.json({ members: [{ id: "old", role: "student", name: "旧状态" }] }));
      await Promise.resolve();
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]!(Response.json({ members: [{ id: "new", role: "student", name: "新状态" }] }));
      await latest;
    });
    expect(result.current.onlineStudentIds.has("new")).toBe(true);
    expect(result.current.onlineStudentIds.has("old")).toBe(false);
  });

  it("sends a student heartbeat and reads the shared presence snapshot", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ online: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          members: [
            { id: "teacher-1", role: "teacher", name: "教师" },
            { id: "student-1", role: "student", name: "测试学生" },
          ],
          source: "database",
          degraded: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() =>
      useCoursePresence({
        courseId: "course-1",
        role: "student",
        heartbeat: true,
      }),
    );

    await waitFor(() => expect(result.current.onlineCount).toBe(1));
    expect(result.current.onlineStudentIds.has("student-1")).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true);
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        init?.method === undefined
        && (init?.headers as Record<string, string>)?.["X-OpenPBL-Role"] === "student"
      ),
    ).toBe(true);

    unmount();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("piggybacks current redacted save summaries only on the existing heartbeat cadence", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ members: [], online: true })); vi.stubGlobal("fetch", fetcher);
    const reader = vi.fn<(courseId: string) => PendingSaveTelemetry>(() => ({ clientId: "browser-profile-123456", known: true, count: 2, oldestCreatedAt: 1000 }));
    const { rerender, unmount } = renderHook(({ read }) => useCoursePresence({ courseId: "course", role: "student", heartbeat: true, readPendingSaves: read }),
      { initialProps: { read: reader } });
    await act(async () => { await Promise.resolve(); });
    const put = () => fetcher.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === "PUT");
    expect(put()).toHaveLength(1);
    expect(JSON.parse(String((put()[0][1] as RequestInit).body))).toEqual({ pendingSaves: reader.mock.results[0].value });
    const latest = vi.fn<(courseId: string) => PendingSaveTelemetry>(() => ({ clientId: "browser-profile-123456", known: true, count: 0, oldestCreatedAt: null }));
    rerender({ read: latest });
    await act(async () => { await Promise.resolve(); });
    expect(put()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(put()).toHaveLength(2);
    expect(JSON.parse(String((put()[1][1] as RequestInit).body))).toEqual({ pendingSaves: latest.mock.results[0].value });
    expect(fetcher.mock.calls.some(call => (call[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
    unmount();
  });

  it("preserves the heartbeat when the diagnostic reader fails", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === "PUT" ? { online: true } : { members: [] }));
    vi.stubGlobal("fetch", fetcher);
    const { unmount } = renderHook(() => useCoursePresence({ courseId: "course", role: "student", heartbeat: true,
      readPendingSaves: () => { throw new Error("storage unreadable"); } }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
    const [, init] = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(init!.body)).pendingSaves).toMatchObject({ known: false });
    unmount();
  });
});


it("isolates course and role changes even if the old transport ignores abort", async () => {
  const requests: Array<{ signal?: AbortSignal | null; resolve: (response: Response) => void }> = [];
  vi.stubGlobal("fetch", vi.fn((_url, init?: RequestInit) => new Promise<Response>(resolve => requests.push({ signal: init?.signal, resolve }))));
  const { result, rerender, unmount } = renderHook(({ courseId, role }: { courseId: string; role: "teacher" | "student" }) => useCoursePresence({ courseId, role }),
    { initialProps: { courseId: "course-1", role: "teacher" as "teacher" | "student" } });
  await waitFor(() => expect(requests).toHaveLength(1));
  rerender({ courseId: "course-2", role: "student" });
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].signal?.aborted).toBe(true);
  await act(async () => { requests[1].resolve(Response.json({ members: [{ id: "new", role: "student", name: "new" }] })); });
  await act(async () => { requests[0].resolve(Response.json({ members: [{ id: "old", role: "student", name: "old" }] })); });
  expect(result.current.onlineStudentIds.has("new")).toBe(true);
  expect(result.current.onlineStudentIds.has("old")).toBe(false);
  unmount();
});

describe("optional presence snapshots", () => {
  it("keeps heartbeat-only mode free of reads and preserves every 20s telemetry payload", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json(init?.method === "PUT" ? { online: true } : { members: [] }));
    vi.stubGlobal("fetch", fetcher);
    const first: PendingSaveTelemetry = { clientId: "profile-fixture-123456", known: true, count: 3, oldestCreatedAt: 1000 };
    const next: PendingSaveTelemetry = { clientId: "profile-fixture-123456", known: true, count: 0, oldestCreatedAt: null };
    const reader = vi.fn<(courseId: string) => PendingSaveTelemetry>(() => first);
    const { result, rerender, unmount } = renderHook(({ read }) => useCoursePresence({
      courseId: "course", role: "student", heartbeat: true, readSnapshot: false, readPendingSaves: read,
    }), { initialProps: { read: reader } });
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ pendingSaves: first });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await result.current.refresh(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const latest = vi.fn<(courseId: string) => PendingSaveTelemetry>(() => next);
    rerender({ read: latest });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(latest).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ pendingSaves: next });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "PUT" && init.keepalive === true)).toBe(true);
    expect(result.current.members).toEqual([]); expect(result.current.source).toBeUndefined();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains default teacher reads on the 5s cadence and reports read recovery", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = vi.spyOn(toast, "error").mockImplementation(() => "presence-error");
    const recovered = vi.spyOn(toast, "success").mockImplementation(() => "presence-success");
    let reads = 0;
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ++reads <= 3 ? new Response(null, { status: 503 })
      : Response.json({ members: [{ id: "visible", role: "student", name: "fixture" }], source: "redis" }));
    vi.stubGlobal("fetch", fetcher);
    const { result, unmount } = renderHook(() => useCoursePresence({ courseId: "course", role: "teacher" }));
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_999); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(result.current.degraded).toBe(true); expect(failed).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetcher).toHaveBeenCalledTimes(4); expect(result.current.degraded).toBe(false); expect(recovered).toHaveBeenCalledOnce();
    expect(result.current.onlineStudentIds.has("visible")).toBe(true);
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "PUT"
      && (init?.headers as Record<string, string>)?.["X-OpenPBL-Role"] === "teacher")).toBe(true);
    unmount();
  });

  it("clears obsolete read failures on opt-out and does not add heartbeats when read policy changes", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = vi.spyOn(toast, "error").mockImplementation(() => "presence-error");
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT" ? Response.json({ online: true }) : new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender, unmount } = renderHook(({ readSnapshot }) => useCoursePresence({
      courseId: "course", role: "student", heartbeat: true, readSnapshot,
    }), { initialProps: { readSnapshot: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(27_000); });
    const puts = () => fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    const reads = () => fetcher.mock.calls.filter(([, init]) => init?.method !== "PUT");
    expect(reads()).toHaveLength(3); expect(puts()).toHaveLength(2);
    expect(result.current.degraded).toBe(true); expect(failed).toHaveBeenCalledTimes(1);
    rerender({ readSnapshot: false });
    expect(result.current.degraded).toBe(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await result.current.refresh(); });
    expect(reads()).toHaveLength(3); expect(puts()).toHaveLength(2);
    rerender({ readSnapshot: true });
    await act(async () => { await Promise.resolve(); });
    expect(reads()).toHaveLength(4); expect(puts()).toHaveLength(2);
    expect(result.current.degraded).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(reads()).toHaveLength(5); expect(result.current.degraded).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(reads()).toHaveLength(6); expect(result.current.degraded).toBe(true); expect(failed).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("keeps heartbeat failures visible across read-policy switches and successful reads", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = vi.spyOn(toast, "error").mockImplementation(() => "presence-error");
    const recovered = vi.spyOn(toast, "success").mockImplementation(() => "presence-success");
    let puts = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "PUT"
      ? ++puts <= 3 ? new Response(null, { status: 503 }) : Response.json({ online: true })
      : Response.json({ members: [], source: "redis" }));
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender, unmount } = renderHook(({ readSnapshot }) => useCoursePresence({
      courseId: "course", role: "student", heartbeat: true, readSnapshot,
    }), { initialProps: { readSnapshot: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(puts).toBe(3); expect(result.current.degraded).toBe(true); expect(failed).toHaveBeenCalledOnce();
    rerender({ readSnapshot: true });
    await act(async () => { await Promise.resolve(); });
    expect(puts).toBe(3); expect(result.current.degraded).toBe(true); expect(recovered).not.toHaveBeenCalled();
    rerender({ readSnapshot: false });
    expect(puts).toBe(3); expect(result.current.degraded).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(puts).toBe(4); expect(result.current.degraded).toBe(false); expect(recovered).toHaveBeenCalledOnce();
    unmount();
  });

  it("disposes the disabled read lane and requires a fresh snapshot when reads resume", async () => {
    const pending: Array<{ signal?: AbortSignal | null; resolve: (response: Response) => void }> = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => init?.method === "PUT"
      ? Promise.resolve(Response.json({ online: true }))
      : new Promise<Response>(resolve => pending.push({ signal: init?.signal, resolve })));
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender, unmount } = renderHook(({ readSnapshot }) => useCoursePresence({
      courseId: "course", role: "student", heartbeat: true, readSnapshot,
    }), { initialProps: { readSnapshot: true } });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => { pending[0].resolve(Response.json({ members: [{ id: "old", role: "student", name: "old" }] })); });
    expect(result.current.onlineStudentIds.has("old")).toBe(true);
    rerender({ readSnapshot: false });
    expect(pending[0].signal?.aborted).toBe(true); expect(result.current.members).toEqual([]);
    rerender({ readSnapshot: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(result.current.members).toEqual([]);
    rerender({ readSnapshot: false });
    await act(async () => { pending[1].resolve(Response.json({ members: [{ id: "late", role: "student", name: "late" }] })); });
    expect(result.current.members).toEqual([]); expect(result.current.degraded).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    unmount();
  });
});
