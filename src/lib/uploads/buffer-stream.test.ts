// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { streamBufferBytes } from './buffer-stream';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

describe('immutable buffer response streams', () => {
  it('delivers exact full and offset range bytes without detaching a shared Buffer', async () => {
    const allocation = Buffer.alloc(220_000);
    for (let index = 0; index < allocation.length; index++) allocation[index] = index % 251;
    const source = allocation.subarray(13, 210_013);
    const snapshot = Buffer.from(source);
    const full = new Response(streamBufferBytes(source));
    const range = new Response(streamBufferBytes(source, { start: 123, end: 65_537 }));
    const [all, part] = await Promise.all([full.arrayBuffer(), range.arrayBuffer()]);
    expect(Buffer.from(all)).toEqual(snapshot);
    expect(Buffer.from(part)).toEqual(snapshot.subarray(123, 65_538));
    expect(source).toEqual(snapshot);
    expect(source.buffer.byteLength).toBe(allocation.buffer.byteLength);
  });

  it('queues at most 64 KiB before consumption and stops reading on cancel', async () => {
    const source = Buffer.alloc(1024 * 1024, 7);
    const chunks = vi.spyOn(source, 'subarray');
    const signal = new AbortController().signal;
    const remove = vi.spyOn(signal, 'removeEventListener');
    const body = streamBufferBytes(source, { signal });
    await nextTurn();
    expect(chunks).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveBeenLastCalledWith(0, 64 * 1024);
    const reader = body.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(64 * 1024);
    expect(first.value?.buffer).toBe(source.buffer);
    await nextTurn();
    expect(chunks).toHaveBeenCalledTimes(2);
    const survivor = streamBufferBytes(source, { start: 10, end: 12 });
    await reader.cancel();
    expect(Buffer.from(await new Response(survivor).arrayBuffer())).toEqual(Buffer.from([7, 7, 7]));
    await nextTurn();
    expect(chunks).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(source.byteLength).toBe(1024 * 1024);
  });

  it('abort discards unread queued bytes and does not affect another range of the same source', async () => {
    const source = Buffer.alloc(1024 * 1024, 42);
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const interrupted = streamBufferBytes(source, { signal: abort.signal });
    const survivor = streamBufferBytes(source, { start: 65_536, end: 131_073 });
    await nextTurn();
    abort.abort();
    await expect(interrupted.getReader().read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(Buffer.from(await new Response(survivor).arrayBuffer())).toEqual(source.subarray(65_536, 131_074));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(source.byteLength).toBe(1024 * 1024);
  });

  it('handles already aborted, empty and normally completed responses without retained abort listeners', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(new Response(streamBufferBytes(Buffer.alloc(5), { signal: abort.signal })).arrayBuffer())
      .rejects.toMatchObject({ name: 'AbortError' });
    for (const bytes of [Buffer.alloc(0), Buffer.from('complete')]) {
      const signal = new AbortController().signal;
      const remove = vi.spyOn(signal, 'removeEventListener');
      expect(Buffer.from(await new Response(streamBufferBytes(bytes, { signal })).arrayBuffer())).toEqual(bytes);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    }
  });

  it('rejects unsafe ranges instead of exposing bytes outside the requested view', () => {
    for (const range of [{ start: -1 }, { end: 10 }, { start: 5, end: 3 }, { start: NaN }, { end: Infinity }]) {
      expect(() => streamBufferBytes(Buffer.alloc(10), range)).toThrow(RangeError);
    }
  });
});
