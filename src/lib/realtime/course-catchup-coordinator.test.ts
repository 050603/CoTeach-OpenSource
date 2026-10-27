import { describe, expect, it, vi } from "vitest";
import { createCourseCatchUpCoordinator } from "./course-catchup-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("same-epoch course bootstrap and durable catch-up", () => {
  it("shares a pending seed with subscription and reads events from its acknowledged cursor", async () => {
    const first = deferred<boolean>(); let cursor: string | undefined;
    const seed = vi.fn(async () => { const accepted = await first.promise; if (accepted) cursor = "25"; return accepted; });
    const catchUp = vi.fn(async () => { expect(cursor).toBe("25"); });
    const onRefreshed = vi.fn();
    const sync = createCourseCatchUpCoordinator({ isCurrent: () => true, hasCursor: () => cursor !== undefined, seed, catchUp, onRefreshed, onError: vi.fn() });
    const initial = sync.request(); await flush();
    const subscription = sync.request(true); const poll = sync.request();
    expect(subscription).toBe(initial); expect(poll).toBe(initial);
    expect(seed).toHaveBeenCalledOnce(); expect(catchUp).not.toHaveBeenCalled();
    first.resolve(true); await Promise.all([initial, subscription, poll]);
    expect(seed).toHaveBeenCalledOnce(); expect(catchUp).toHaveBeenCalledOnce(); expect(onRefreshed).toHaveBeenCalledOnce();
  });

  it("runs one trailing read for subscriptions after the event query already started", async () => {
    const reads = [deferred<void>(), deferred<void>()]; const cursors: string[] = []; let cursor = "1";
    const catchUp = vi.fn(async () => { const index = cursors.length; cursors.push(cursor); await reads[index].promise; cursor = String(index + 2); });
    const sync = createCourseCatchUpCoordinator({ isCurrent: () => true, hasCursor: () => true, seed: vi.fn(), catchUp, onRefreshed: vi.fn(), onError: vi.fn() });
    const initial = sync.request(); await flush(); expect(cursors).toEqual(["1"]);
    const subscription = sync.request(true); sync.request(true); sync.request();
    reads[0].resolve(); await flush(); expect(cursors).toEqual(["1", "2"]);
    reads[1].resolve(); await Promise.all([initial, subscription]); expect(catchUp).toHaveBeenCalledTimes(2);
    // No settled-result cache: the next normal poll performs a real read.
    catchUp.mockImplementationOnce(async () => { cursors.push(cursor); });
    await sync.request(); expect(cursors).toEqual(["1", "2", "3"]);
  });

  it("does not turn every initial poll into an unnecessary event request", async () => {
    let seeded = false;
    const seed = vi.fn(async () => { seeded = true; return true; }); const catchUp = vi.fn(async () => undefined);
    const sync = createCourseCatchUpCoordinator({ isCurrent: () => true, hasCursor: () => seeded, seed, catchUp, onRefreshed: vi.fn(), onError: vi.fn() });
    await sync.request(); expect(seed).toHaveBeenCalledOnce(); expect(catchUp).not.toHaveBeenCalled();
    await sync.request(); expect(catchUp).toHaveBeenCalledOnce();
  });

  it("does not advance events if an optimistic write makes the snapshot unusable", async () => {
    const seed = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true); const catchUp = vi.fn(async () => undefined);
    const onRefreshed = vi.fn();
    const sync = createCourseCatchUpCoordinator({ isCurrent: () => true, hasCursor: () => false, seed, catchUp, onRefreshed, onError: vi.fn() });
    await sync.request(true); expect(catchUp).not.toHaveBeenCalled(); expect(onRefreshed).not.toHaveBeenCalled();
    await sync.request(true); expect(catchUp).toHaveBeenCalledOnce();
  });

  it("disposes an old epoch without running its queued catch-up or affecting a new scope", async () => {
    const seed = deferred<boolean>(); const oldCatchUp = vi.fn(async () => undefined); const oldRefreshed = vi.fn();
    const old = createCourseCatchUpCoordinator({ isCurrent: () => true, hasCursor: () => false, seed: () => seed.promise, catchUp: oldCatchUp, onRefreshed: oldRefreshed, onError: vi.fn() });
    const pending = old.request(true); await flush(); old.dispose();
    const freshCatchUp = vi.fn(async () => undefined); const freshRefreshed = vi.fn();
    const fresh = createCourseCatchUpCoordinator({ isCurrent: () => true, hasCursor: () => true, seed: vi.fn(), catchUp: freshCatchUp, onRefreshed: freshRefreshed, onError: vi.fn() });
    await fresh.request(true); seed.resolve(true); await pending;
    expect(oldCatchUp).not.toHaveBeenCalled(); expect(oldRefreshed).not.toHaveBeenCalled();
    expect(freshCatchUp).toHaveBeenCalledOnce(); expect(freshRefreshed).toHaveBeenCalledOnce();
  });

  it("reports one actual failure for joined readers and releases the flight for retry", async () => {
    const read = deferred<void>(); const catchUp = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(undefined); const onError = vi.fn();
    const sync = createCourseCatchUpCoordinator({ isCurrent: () => true, hasCursor: () => true, seed: vi.fn(), catchUp, onRefreshed: vi.fn(), onError });
    const first = sync.request(); const second = sync.request(); await flush(); read.reject(new Error("COURSE_EVENTS_FAILED_503"));
    await Promise.all([first, second]); expect(onError).toHaveBeenCalledOnce();
    await sync.request(); expect(catchUp).toHaveBeenCalledTimes(2);
  });
});
