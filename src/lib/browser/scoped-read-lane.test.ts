import { afterEach, expect, it, vi } from 'vitest';
import { createScopedReadLane, startPhasedPolling, waitForScopedRead } from './scoped-read-lane';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('joins ordinary ticks and collapses notifications into one fresh read after the current response', async () => {
  const pending: Array<() => void> = [];
  const read = vi.fn(() => new Promise<void>(resolve => pending.push(resolve)));
  const lane = createScopedReadLane(read);
  const initial = lane.request(); await flush();
  for (let i = 0; i < 10; i++) expect(lane.request()).toBe(initial);
  lane.request(true); const fresh = lane.request(true);
  expect(read).toHaveBeenCalledTimes(1);
  pending[0](); await flush(); expect(read).toHaveBeenCalledTimes(2);
  let finished = false; void fresh.then(() => { finished = true; }); await flush(); expect(finished).toBe(false);
  pending[1](); await fresh; expect(finished).toBe(true); expect(read).toHaveBeenCalledTimes(2);
  lane.dispose();
});
it('a failed fresh read stops until the next actual trigger and never retries itself', async () => {
  const pending: Array<(value?: unknown) => void> = [];
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => pending.push(resolve)))
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const lane = createScopedReadLane(read); const initial = lane.request(); await flush();
  const observed = initial.catch(error => error); lane.request(true);
  pending[0](); expect((await observed).message).toBe('offline'); await flush();
  expect(read).toHaveBeenCalledTimes(2);
  await lane.request(); expect(read).toHaveBeenCalledTimes(3); lane.dispose();
});
it('does not acknowledge a fresh notification arriving between read completion and promise settlement', async () => {
  const pending: Array<() => void> = [];
  const read = vi.fn(() => new Promise<void>(resolve => pending.push(resolve)));
  const lane = createScopedReadLane(read);
  const first = lane.request(); await flush();
  let fresh!: Promise<void>;
  pending[0]();
  queueMicrotask(() => { fresh = lane.request(true); });
  await first; await flush();
  expect(read).toHaveBeenCalledTimes(2);
  let acknowledged = false; void fresh.then(() => { acknowledged = true; });
  await flush(); expect(acknowledged).toBe(false);
  pending[1](); await fresh; lane.dispose();
});
it('scope disposal aborts its transport and drops trailing work without affecting another scope', async () => {
  let complete!: () => void; let oldSignal!: AbortSignal;
  const oldRead = vi.fn((signal: AbortSignal) => { oldSignal = signal; return new Promise<void>(resolve => { complete = resolve; }); });
  const old = createScopedReadLane(oldRead); const otherRead = vi.fn(async () => {}); const other = createScopedReadLane(otherRead);
  const pending = old.request(); await flush(); old.request(true); old.dispose();
  expect(oldSignal.aborted).toBe(true); await other.request(); complete(); await pending;
  expect(oldRead).toHaveBeenCalledTimes(1); expect(otherRead).toHaveBeenCalledTimes(1); other.dispose();
});
it('aborting one manual waiter preserves the shared read and another waiter', async () => {
  let complete!: () => void;
  const lane = createScopedReadLane(async () => new Promise<void>(resolve => { complete = resolve; }));
  const work = lane.request(); const abort = new AbortController();
  const cancelled = waitForScopedRead(work, abort.signal).catch(error => error);
  const joined = waitForScopedRead(work); await flush(); abort.abort();
  expect((await cancelled).name).toBe('AbortError'); complete(); await joined; lane.dispose();
});
it('spreads only the first poll while retaining steady cadence and independent immediate notifications', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5); const tick = vi.fn();
  const stop = startPhasedPolling(tick, 2500);
  await vi.advanceTimersByTimeAsync(2249); expect(tick).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); expect(tick).toHaveBeenCalledTimes(3);
  stop(); await vi.advanceTimersByTimeAsync(10000); expect(tick).toHaveBeenCalledTimes(3);
});
