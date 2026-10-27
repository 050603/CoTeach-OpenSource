import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudentClassroomDetail } from "./use-student-classroom-detail";
import type { StudentClassroomActivity } from "./student-classroom-detail.types";

const initial: StudentClassroomActivity = { id: "activity", title: "课堂", isOpen: true, offering: { id: "o", name: "课程", status: "open" }, chapter: { title: "章节" }, instance: { id: "run-1", status: "scheduled" } };
const teaching = { ...initial, instance: { id: "run-2", status: "teaching", canWrite: true } };
let fetcher: ReturnType<typeof vi.fn>;
let hidden = false;
let online = true;
function response(activity: StudentClassroomActivity = teaching) { return new Response(JSON.stringify({ activity })); }
async function tick(ms = 15_000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  online = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  fetcher = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("classroom detail refresh lifecycle", () => {
  it("refreshes every 15 seconds using the visit-free request and accepts a new run", async () => {
    const { result } = renderHook(() => useStudentClassroomDetail(initial));
    await tick(14_999);
    expect(fetcher).not.toHaveBeenCalled();
    await tick(1);
    expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity?refresh=1", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(result.current.activity.instance?.id).toBe("run-2");
    expect(result.current.refreshing).toBe(false);
  });

  it("prevents overlapping requests, cancels when hidden, and rejects a late response from the old request", async () => {
    let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useStudentClassroomDetail(initial));
    await tick();
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await tick(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.activity.instance?.id).toBe("run-2");
    await act(async () => { finish(response(initial)); });
    expect(result.current.activity.instance?.id).toBe("run-2");
  });

  it("pauses offline and refreshes immediately on reconnect and window focus", async () => {
    const { result } = renderHook(() => useStudentClassroomDetail(initial));
    online = false;
    act(() => window.dispatchEvent(new Event("offline")));
    await tick(60_000);
    expect(fetcher).not.toHaveBeenCalled();
    online = true;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(result.current.activity.instance?.status).toBe("teaching");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves the page after a transient failure and supports manual retry", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "暂时无法同步" }), { status: 503 }));
    const { result } = renderHook(() => useStudentClassroomDetail(initial));
    await tick();
    expect(result.current.activity).toEqual(initial);
    expect(result.current.refreshError).toBe("暂时无法同步");
    expect(result.current.accessLost).toBe(false);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.refreshError).toBeNull();
    expect(result.current.activity.instance?.status).toBe("teaching");
  });

  it.each([401, 403, 404])("stops requests after access is lost with %s", async (status) => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "请重新确认权限" }), { status }));
    const { result } = renderHook(() => useStudentClassroomDetail(initial));
    await tick();
    expect(result.current.accessLost).toBe(true);
    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("suspends and invalidates refreshes while entering, then resumes on failure", async () => {
    let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useStudentClassroomDetail(initial));
    await tick();
    act(() => result.current.suspendRefresh());
    await act(async () => { finish(response()); });
    await tick();
    expect(result.current.activity).toEqual(initial);
    expect(fetcher).toHaveBeenCalledTimes(1);
    act(() => result.current.resumeRefresh());
    await tick();
    expect(result.current.activity.instance?.id).toBe("run-2");
  });

  it("aborts pending requests and clears all scheduled work on unmount", async () => {
    fetcher.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const { unmount } = renderHook(() => useStudentClassroomDetail(initial));
    await tick();
    unmount();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await tick(60_000);
    window.dispatchEvent(new Event("focus"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
