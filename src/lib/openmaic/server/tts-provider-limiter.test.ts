import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithGlobalTtsProviderSlot } from "./tts-provider-limiter";
afterEach(() => vi.useRealTimers());

describe("global TTS provider limiter", () => {
  it("caps concurrency across independent classroom callers", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const providerId = `provider-${Date.now()}`;
    const tasks = Array.from({ length: 6 }, (_, index) =>
      runWithGlobalTtsProviderSlot(providerId, 2, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return index;
      }),
    );

    for (let batch = 0; batch < 3; batch += 1) {
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases.splice(0).forEach((release) => release());
    }
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxActive).toBe(2);
  });

  it('spaces starts while retaining bounded concurrent synthesis', async () => {
    vi.useFakeTimers();
    const starts: number[] = [], releases: Array<() => void> = [];
    const work = Array.from({length:3}, () => runWithGlobalTtsProviderSlot('paced-provider', 2, async () => {
      starts.push(performance.now()); await new Promise<void>(resolve => releases.push(resolve));
    }, undefined, {minStartIntervalMs:350}));
    await vi.advanceTimersByTimeAsync(0); expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(349); expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(starts).toHaveLength(2);
    releases.shift()!(); await vi.advanceTimersByTimeAsync(350); expect(starts).toHaveLength(3);
    releases.splice(0).forEach(release => release()); await Promise.all(work);
    expect(starts[1]-starts[0]).toBeGreaterThanOrEqual(350);
  });

  it('removes cancelled waiters and releases a slot after a synchronous throw', async () => {
    const controller = new AbortController(); let release!: () => void;
    const busy = runWithGlobalTtsProviderSlot('cancelled-provider', 1, () => new Promise<void>(resolve => {release=resolve;}));
    const cancelled = runWithGlobalTtsProviderSlot('cancelled-provider', 1, async () => {throw new Error('must not start');},controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({name:'AbortError'});
    controller.abort(); await rejected; await Promise.resolve(); release(); await busy;
    await expect(runWithGlobalTtsProviderSlot('cancelled-provider',1,()=>{throw new Error('sync failure');})).rejects.toThrow('sync failure');
    await expect(runWithGlobalTtsProviderSlot('cancelled-provider',1,async()=>42)).resolves.toBe(42);
  });

  it('bounds waiting requests and never starts a cancelled queued synthesis', async () => {
    const controller = new AbortController(); let release!: () => void;
    const active = runWithGlobalTtsProviderSlot('bounded-provider',1,()=>new Promise<void>(resolve=>{release=resolve;}));
    const operation = vi.fn(async()=>undefined);
    const waiting = Array.from({length:256},()=>runWithGlobalTtsProviderSlot('bounded-provider',1,operation,controller.signal));
    const settled = Promise.allSettled(waiting);
    await expect(runWithGlobalTtsProviderSlot('bounded-provider',1,operation)).rejects.toMatchObject({statusCode:503});
    controller.abort(); await settled; release(); await active;
    expect(operation).not.toHaveBeenCalled();
  });
});
