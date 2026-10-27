import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetShowcaseRealtimeForTests, emitShowcasePresentation } from "@/lib/showcase/realtime-client";
import type { ShowcaseData } from "@/lib/showcase/types";
import { useShowcasePresentation } from "./use-showcase-presentation";
import { projectionClientId } from "@/lib/realtime/projection-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function data(courseId = "A", name = "initial"): ShowcaseData {
  return { courseId, stageKey: "showcase", students: [], ownArtifacts: [], presentations: [], queue: [], minutesPerStudent: 3, presentingStudentName: name };
}
function requests() {
  const pending: { url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const response = deferred<Response>();
    pending.push({ url, init, response });
    return response.promise;
  });
  vi.stubGlobal("fetch", fetch);
  return pending;
}
async function complete(request: ReturnType<typeof requests>[number], body = data()) {
  await act(async () => { request.response.resolve(Response.json(body)); });
}
async function tick(ms = 3_000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  window.history.replaceState({}, "", "/teacher/teach/A/classroom");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  __resetShowcaseRealtimeForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("joins slow initial and later reads on timer ticks without lowering the polling cadence", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  await tick(9_000);
  expect(pending).toHaveLength(1);
  expect(result.current.loading).toBe(true);
  await complete(pending[0]);
  await tick();
  expect(pending).toHaveLength(2);
  await tick(6_000);
  expect(pending).toHaveLength(2);
  await complete(pending[1], data("A", "poll"));
  expect(result.current.data?.presentingStudentName).toBe("poll");
});

it.each([0, 1])("spreads the first ordinary poll while keeping initial and realtime reads immediate (random %s)", async random => {
  vi.mocked(Math.random).mockReturnValue(random);
  const pending = requests();
  const { unmount } = renderHook(() => useShowcasePresentation("A"));
  expect(pending).toHaveLength(1);
  await complete(pending[0]);
  const firstPoll = 3_000 * (0.8 + random * 0.2);
  await tick(firstPoll - 1);
  expect(pending).toHaveLength(1);
  act(() => { emitShowcasePresentation("A", {}); });
  expect(pending).toHaveLength(2);
  await complete(pending[1]);
  await tick(1);
  expect(pending).toHaveLength(3);
  await complete(pending[2]);
  await tick(2_999);
  expect(pending).toHaveLength(3);
  await tick(1);
  expect(pending).toHaveLength(4);
  await complete(pending[3]);
  unmount();
  await tick(9_000);
  expect(pending).toHaveLength(4);
});

it("coalesces multiple realtime invalidations into exactly one fresh trailing read", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  act(() => {
    emitShowcasePresentation("A", { presentingStudentId: "one" });
    emitShowcasePresentation("A", { presentingStudentId: "two" });
    emitShowcasePresentation("A", {});
  });
  await tick(6_000);
  expect(pending).toHaveLength(1);
  await complete(pending[0], data("A", "before invalidation"));
  expect(pending).toHaveLength(2);
  expect(result.current.data).toBeUndefined();
  await complete(pending[1], data("A", "fresh"));
  expect(result.current.data?.presentingStudentName).toBe("fresh");
  expect(pending).toHaveLength(2);
});

it.each(["network", "inactive stage"])("discards an invalidated read's %s error while awaiting fresh state", async kind => {
  const pending = requests();
  const errors: (string | undefined)[] = [];
  const { result } = renderHook(() => {
    const showcase = useShowcasePresentation("A");
    errors.push(showcase.error);
    return showcase;
  });
  act(() => { emitShowcasePresentation("A", {}); });
  await act(async () => {
    if (kind === "inactive stage") {
      pending[0].response.resolve(Response.json({
        code: "SHOWCASE_INACTIVE",
        message: "只有授课中的第四阶段可以进行成果汇报。",
      }, { status: 409 }));
    } else {
      pending[0].response.reject(new Error("offline"));
    }
  });
  expect(pending).toHaveLength(2);
  expect(result.current.loading).toBe(true);
  expect(result.current.error).toBeUndefined();
  await complete(pending[1], data("A", "fresh"));
  expect(result.current.data?.presentingStudentName).toBe("fresh");
  expect(errors.every(error => error === undefined)).toBe(true);
});

it("keeps a notification during the trailing read and lets explicit reload await freshness", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  let reloaded = false;
  act(() => { void result.current.reload().then(() => { reloaded = true; }); });
  await complete(pending[0]);
  expect(pending).toHaveLength(2);
  act(() => { emitShowcasePresentation("A", {}); });
  await complete(pending[1]);
  expect(pending).toHaveLength(3);
  expect(reloaded).toBe(false);
  await complete(pending[2], data("A", "latest"));
  expect(result.current.data?.presentingStudentName).toBe("latest");
  expect(reloaded).toBe(true);
});

it("rejects late A reads and ACKs after A→B→A, including fetches ignoring abort", async () => {
  const pending = requests();
  const { result, rerender } = renderHook(({ id }) => useShowcasePresentation(id), { initialProps: { id: "A" } });
  let oldAction!: Promise<unknown>;
  act(() => { oldAction = result.current.runAction({ action: "assign", groupId: "old" }); });
  const oldReload = result.current.reload;
  rerender({ id: "B" });
  expect(pending[0].init?.signal?.aborted).toBe(true);
  await complete(pending[2], data("B", "B current"));
  rerender({ id: "A" });
  await complete(pending[3], data("A", "new A"));
  await complete(pending[0], data("A", "old A"));
  await act(async () => { pending[1].response.resolve(Response.json(data("A", "old ACK"))); await oldAction; });
  expect(result.current.data?.presentingStudentName).toBe("new A");
  expect(pending).toHaveLength(4);
  // A retained callback on a different scope must not start a read for A.
  rerender({ id: "B" });
  await act(async () => { await oldReload(); });
  expect(pending).toHaveLength(5);
});

it("captures the role for each scope and prevents a teacher response from entering a student view", async () => {
  const pending = requests();
  const { result, rerender } = renderHook(() => useShowcasePresentation("A"));
  window.history.replaceState({}, "", "/student/classroom/A");
  rerender();
  expect(pending[0].init?.signal?.aborted).toBe(true);
  expect(pending[0].init?.headers).toEqual({ "X-OpenPBL-Role": "teacher" });
  expect(pending[1].init?.headers).toEqual({ "X-OpenPBL-Role": "student" });
  await complete(pending[1], data("A", "student"));
  await complete(pending[0], data("A", "teacher private"));
  expect(result.current.data?.presentingStudentName).toBe("student");
});

it.each(["course", "role", "disabled"])("hides previous content and errors on the first render after a %s change", async change => {
  const pending = requests();
  const rendered: { courseId?: string; error?: string; loading: boolean }[] = [];
  const { result, rerender } = renderHook(({ id }) => {
    const showcase = useShowcasePresentation(id);
    rendered.push({ courseId: showcase.data?.courseId, error: showcase.error, loading: showcase.loading });
    return showcase;
  }, { initialProps: { id: "A" as string | undefined } });
  await complete(pending[0]);
  await tick();
  await act(async () => { pending[1].response.reject(new Error("old scope error")); });
  expect(result.current.data?.courseId).toBe("A");
  expect(result.current.error).toBe("old scope error");
  rendered.length = 0;
  if (change === "role") window.history.replaceState({}, "", "/student/classroom/A");
  rerender({ id: change === "course" ? "B" : change === "disabled" ? undefined : "A" });
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.every(state => state.courseId === undefined && state.error === undefined && state.loading === (change !== "disabled"))).toBe(true);
  if (change !== "disabled") {
    const nextCourseId = change === "course" ? "B" : "A";
    await complete(pending[2], data(nextCourseId, "current scope"));
    expect(result.current.data?.presentingStudentName).toBe("current scope");
  }
});

it("shows a current inactive-stage error and recovers on the next normal poll", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  const message = "只有授课中的第四阶段可以进行成果汇报。";
  await act(async () => {
    pending[0].response.resolve(Response.json({ code: "SHOWCASE_INACTIVE", message }, { status: 409 }));
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBe(message);
  await tick();
  expect(pending).toHaveLength(2);
  await complete(pending[1]);
  expect(result.current.error).toBeUndefined();
  expect(result.current.data?.courseId).toBe("A");
});

it.each(["network", "abort", "http"])("recovers from a %s failure on the next normal poll", async kind => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  await act(async () => {
    if (kind === "http") pending[0].response.resolve(Response.json({ message: "unavailable" }, { status: 503 }));
    else pending[0].response.reject(kind === "abort" ? new DOMException("aborted", "AbortError") : new Error("offline"));
  });
  expect(result.current.error).toBeTruthy();
  await tick();
  expect(pending).toHaveLength(2);
  await complete(pending[1]);
  expect(result.current.error).toBeUndefined();
  expect(result.current.data?.courseId).toBe("A");
});

it("aborts pending work and discards queued invalidations on unmount", async () => {
  const pending = requests();
  const { unmount } = renderHook(() => useShowcasePresentation("A"));
  act(() => { emitShowcasePresentation("A", {}); });
  unmount();
  expect(pending[0].init?.signal?.aborted).toBe(true);
  await complete(pending[0]);
  await tick(9_000);
  act(() => { emitShowcasePresentation("A", {}); });
  expect(pending).toHaveLength(1);
});

it("does not overwrite a command ACK with an older pending GET", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  await complete(pending[0]);
  await tick();
  let action!: Promise<unknown>;
  act(() => { action = result.current.runAction({ action: "assign", groupId: "new" }); });
  await act(async () => { pending[2].response.resolve(Response.json(data("A", "ACK"))); await action; });
  expect(result.current.data?.presentingStudentName).toBe("ACK");
  await complete(pending[1], data("A", "stale"));
  expect(result.current.data?.presentingStudentName).toBe("ACK");
  expect(pending).toHaveLength(4);
  await complete(pending[3], data("A", "reconciled"));
  expect(result.current.data?.presentingStudentName).toBe("reconciled");
});

it("reconciles out-of-order command ACKs without briefly applying the older result", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  await complete(pending[0]);
  let first!: Promise<unknown>, second!: Promise<unknown>;
  act(() => {
    first = result.current.runAction({ action: "assign", groupId: "first" });
    second = result.current.runAction({ action: "assign", groupId: "second" });
  });
  await act(async () => { pending[2].response.resolve(Response.json(data("A", "second"))); await second; });
  await act(async () => { pending[1].response.resolve(Response.json(data("A", "first"))); await first; });
  expect(result.current.data?.presentingStudentName).toBe("second");
  expect(pending).toHaveLength(4);
  await complete(pending[3], data("A", "server current"));
  expect(result.current.data?.presentingStudentName).toBe("server current");
});

function lifecycleData(name = "new presenter"): ShowcaseData {
  const snapshot = {
    id: "presentation", courseId: "A", groupId: "group", studentId: "presenter",
    artifactKind: "document" as const, artifactVersionId: "artifact", artifactTitle: "Artifact",
    displayMode: "continuous" as const, status: "active" as const, revision: 2,
    requestedAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:01.000Z",
  };
  return { ...data("A", name), presentingStudentId: "presenter", presentingGroupId: "group",
    presentations: [snapshot], activePresentation: snapshot, minutesPerStudent: 5,
    queue: [{ studentId: "presenter", studentName: name, position: 0, status: "presenting", artifacts: [] }] };
}

it.each([false, true])("protects full lifecycle queue events from an older GET (already loaded: %s)", async loaded => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  if (loaded) { await complete(pending[0]); await tick(); }
  const oldIndex = pending.length - 1;
  const fresh = lifecycleData();
  act(() => {
    emitShowcasePresentation("A", { snapshot: fresh.activePresentation!, queue: fresh.queue,
      minutesPerStudent: fresh.minutesPerStudent, presentingGroupId: fresh.presentingGroupId,
      presentingStudentId: fresh.presentingStudentId, presentingStudentName: fresh.presentingStudentName });
  });
  await complete(pending[oldIndex], data("A", "stale presenter"));
  expect(pending).toHaveLength(oldIndex + 2);
  expect(result.current.data?.presentingStudentName).not.toBe("stale presenter");
  await complete(pending[oldIndex + 1], fresh);
  expect(result.current.data?.queue).toEqual(fresh.queue);
  expect(result.current.data?.presentingStudentName).toBe("new presenter");
  expect(result.current.data?.minutesPerStudent).toBe(5);
  expect(result.current.data?.activePresentation?.revision).toBe(2);
});

it("merges pure active snapshot revisions without an extra GET for every viewport event", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  const initial = lifecycleData();
  await complete(pending[0], initial);
  await tick();
  act(() => {
    for (const revision of [3, 4, 5]) emitShowcasePresentation("A", {
      snapshot: { ...initial.activePresentation!, revision,
        viewState: { revision, scrollRatio: revision / 10, updatedAt: "2026-10-16T00:00:02.000Z" } },
    });
  });
  await complete(pending[1], initial);
  expect(pending).toHaveLength(2);
  expect(result.current.data?.activePresentation?.revision).toBe(5);
  expect(result.current.data?.activePresentation?.viewState?.scrollRatio).toBe(0.5);
});

it("does not lose an explicit reload queued between read completion and its promise finalizer", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  let reloadFinished = false;
  const response = Response.json(data());
  // A caller awaiting a different submission can request reload in the same
  // microtask turn. Inject it after JSON consumption but before GET cleanup.
  vi.spyOn(Response.prototype, "ok", "get").mockImplementationOnce(() => {
    queueMicrotask(() => { void result.current.reload().then(() => { reloadFinished = true; }); });
    return true;
  });
  await act(async () => { pending[0].response.resolve(response); });
  expect(pending).toHaveLength(2);
  expect(reloadFinished).toBe(false);
  await complete(pending[1], data("A", "after submission"));
  expect(result.current.data?.presentingStudentName).toBe("after submission");
  expect(reloadFinished).toBe(true);
});

it.each(["fetch", "body"])("recovers on the next normal poll after a hanging %s reaches the existing 10s read bound", async kind => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  let body!: ReadableStreamDefaultController<Uint8Array>;
  if (kind === "body") {
    await act(async () => {
      pending[0].response.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })));
    });
  }
  await tick(10_000);
  expect(pending).toHaveLength(1);
  expect(result.current.error).toContain("超时");
  expect(pending[0].init?.signal?.aborted).toBe(true);
  await tick(2_000);
  expect(pending).toHaveLength(2);
  await complete(pending[1], data("A", "recovered"));
  expect(result.current.error).toBeUndefined();
  expect(result.current.data?.presentingStudentName).toBe("recovered");
  // Even a transport/body that ignores abort cannot apply after its deadline.
  await act(async () => {
    if (kind === "fetch") pending[0].response.resolve(Response.json(data("A", "late stale")));
    else {
      body.enqueue(new TextEncoder().encode(JSON.stringify(data("A", "late stale"))));
      body.close();
    }
  });
  expect(result.current.data?.presentingStudentName).toBe("recovered");
  expect(pending).toHaveLength(2);
});

it("keeps a student's public presentation independent of their private history", async () => {
  window.history.replaceState({}, "", "/student/classroom/A");
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  const initial = lifecycleData();
  initial.presentations = [];
  initial.projectionVersion = 2;
  initial.activePresentation = { ...initial.activePresentation!, projectionVersion: 2 };
  await complete(pending[0], initial);
  await tick();
  act(() => emitShowcasePresentation("A", { snapshot: { ...initial.activePresentation!, revision: 5,
    viewState: { revision: 5, updatedAt: "2026-10-20T00:00:00Z", scrollRatio: .6 } } }));
  await complete(pending[1], initial);
  expect(result.current.data?.activePresentation?.revision).toBe(5);
  expect(result.current.data?.presentations).toEqual([]);
  act(() => emitShowcasePresentation("A", { projectionVersion: 3,
    snapshot: { ...initial.activePresentation!, status: "ended", revision: 6, projectionVersion: 3 } }));
  expect(result.current.data?.activePresentation).toBeNull();
  act(() => emitShowcasePresentation("A", { snapshot: initial.activePresentation! }));
  expect(result.current.data?.activePresentation).toBeNull();
});

it("coalesces viewport writes and discards a pending scroll after the presentation ends", async () => {
  const pending = requests();
  const { result } = renderHook(() => useShowcasePresentation("A"));
  const initial = lifecycleData();
  initial.activePresentation = { ...initial.activePresentation!, controllerClientId: projectionClientId(), controlEpoch: 4, projectionVersion: 10 };
  initial.presentations = [initial.activePresentation]; initial.projectionVersion = 10;
  await complete(pending[0], initial);
  act(() => {
    result.current.updateViewState({ scrollRatio: .1 });
    result.current.updateViewState({ scrollRatio: .7, blockId: "block-3", blockOffset: .2 });
  });
  await tick(250);
  const writes = pending.filter(item => item.init?.method === "PATCH");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0].init?.body))).toMatchObject({ presentationId: "presentation", clientId: projectionClientId(), controlEpoch: 4,
    viewState: { scrollRatio: .7, blockId: "block-3", blockOffset: .2 } });
  act(() => result.current.updateViewState({ scrollRatio: .9 }));
  act(() => emitShowcasePresentation("A", { projectionVersion: 11, snapshot: { ...initial.activePresentation!, status: "ended", revision: 9, projectionVersion: 11 } }));
  expect(writes[0].init?.signal?.aborted).toBe(true);
  await act(async () => writes[0].response.resolve(Response.json({ ...initial.activePresentation!, revision: 8 })));
  await tick(500);
  expect(pending.filter(item => item.init?.method === "PATCH")).toHaveLength(1);
  expect(result.current.data?.activePresentation).toBeNull();
});
