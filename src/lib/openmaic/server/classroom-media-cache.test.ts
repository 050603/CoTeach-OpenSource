// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createClassroomMediaCache } from './classroom-media-cache';

const signal = () => new AbortController().signal;

describe('shared playable classroom media', () => {
  it('uses one disk read for 30 concurrent students and a later replay', async () => {
    const cache = createClassroomMediaCache({ maxBytes: 1024, maxEntries: 4 });
    const bytes = new Uint8Array(100);
    const load = vi.fn(async () => bytes);
    const results = await Promise.all(Array.from({ length: 30 }, () => cache.read('file:v1', load, signal())));
    expect(load).toHaveBeenCalledTimes(1);
    expect(results.every(value => value === bytes)).toBe(true);
    expect(await cache.read('file:v1', load, signal())).toBe(bytes);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.read('file:v2', load, signal());
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.snapshot()).toEqual({ bytes: 200, entries: 2, pending: 0 });
  });

  it('isolates one student cancellation while another is still waiting', async () => {
    const cache = createClassroomMediaCache({ maxBytes: 1024, maxEntries: 4 });
    let resolve!: (bytes: Uint8Array) => void;
    const load = vi.fn((_signal: AbortSignal) => new Promise<Uint8Array>(done => { resolve = done; }));
    const leaving = new AbortController();
    const first = cache.read('audio', load, leaving.signal);
    const second = cache.read('audio', load, signal());
    await Promise.resolve();
    leaving.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(load.mock.calls[0][0].aborted).toBe(false);
    resolve(new Uint8Array([1, 2]));
    await expect(second).resolves.toEqual(new Uint8Array([1, 2]));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('cancels disk work after all consumers leave and permits a fresh request', async () => {
    const cache = createClassroomMediaCache({ maxBytes: 1024, maxEntries: 4 });
    const load = vi.fn((readSignal: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => {
      readSignal.addEventListener('abort', () => reject(readSignal.reason), { once: true });
    }));
    const leaving = new AbortController();
    const pending = cache.read('audio', load, leaving.signal);
    await Promise.resolve();
    leaving.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(load.mock.calls[0][0].aborted).toBe(true);
    expect(cache.snapshot()).toEqual({ bytes: 0, entries: 0, pending: 0 });
    await expect(cache.read('audio', async () => new Uint8Array([3]), signal())).resolves.toEqual(new Uint8Array([3]));
  });

  it('evicts older bytes and counts backing allocations, never retaining oversized WAV views', async () => {
    const cache = createClassroomMediaCache({ maxBytes: 10, maxEntries: 2 });
    const load = vi.fn(async () => new Uint8Array(6));
    await cache.read('first', load, signal());
    await cache.read('second', load, signal());
    expect(cache.snapshot()).toEqual({ bytes: 6, entries: 1, pending: 0 });
    await cache.read('first', load, signal());
    expect(load).toHaveBeenCalledTimes(3);
    const oversized = vi.fn(async () => new Uint8Array(100).subarray(90));
    await cache.read('large', oversized, signal());
    await cache.read('large', oversized, signal());
    expect(oversized).toHaveBeenCalledTimes(2);
    expect(cache.snapshot()).toEqual({ bytes: 6, entries: 1, pending: 0 });
  });

  it('does not retain failed reads or poison retries', async () => {
    const cache = createClassroomMediaCache({ maxBytes: 10, maxEntries: 2 });
    await expect(cache.read('audio', async () => { throw new Error('disk failure'); }, signal())).rejects.toThrow('disk failure');
    expect(cache.snapshot()).toEqual({ bytes: 0, entries: 0, pending: 0 });
    await expect(cache.read('audio', async () => new Uint8Array([5]), signal())).resolves.toEqual(new Uint8Array([5]));
  });
});
