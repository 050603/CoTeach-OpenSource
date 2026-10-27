// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { normalizePlayableWav } from '@openmaic/lib/audio/wav-container';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn(), stream: vi.fn(), authorize: vi.fn() }));
vi.mock('fs', () => {
  const fsModule = { promises: { readFile: mocks.readFile, stat: mocks.stat } };
  return { ...fsModule, default: fsModule };
});
vi.mock('@openmaic/lib/server/classroom-storage', () => ({
  CLASSROOMS_DIR: '/classroom-media-test',
  isValidClassroomId: (value: string) => /^[a-zA-Z0-9_-]+$/.test(value),
}));
vi.mock('@/lib/platform/classroom-media-access', () => ({ authorizeClassroomMediaRead: mocks.authorize }));
vi.mock('@/lib/uploads/file-stream', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/uploads/file-stream')>(), streamFileBytes: mocks.stream,
}));

import { GET, HEAD } from './route';

const context = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.mp3'] }) };
function request(range?: string, signal?: AbortSignal) {
  return new Request('http://localhost/api/openmaic/classroom-media/classroom/audio/voice.mp3', {
    headers: range === undefined ? {} : { Range: range },
    signal,
  }) as NextRequest;
}
function conditionalRequest(headers: Record<string, string>, method = 'GET') {
  return new Request('http://localhost/api/openmaic/classroom-media/classroom/audio/voice.mp3', { headers, method }) as NextRequest;
}

function wav(payload: Uint8Array, sentinelSizes = false): Uint8Array {
  const bytes = new Uint8Array(44 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    bytes.set(new TextEncoder().encode(value), offset);
  }
  view.setUint32(4, sentinelSizes ? 0x7fffffff : bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, sentinelSizes ? 0x7fffffff : payload.byteLength, true);
  bytes.set(payload, 44);
  return bytes;
}

let fileRevision = 0;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(null);
  mocks.readFile.mockResolvedValue(Buffer.from('0123456789'));
  mocks.stat.mockResolvedValue({ size: BigInt(10), dev: BigInt(1), ino: BigInt(2), mtimeNs: BigInt(++fileRevision), ctimeNs: BigInt(fileRevision) });
  mocks.stream.mockImplementation(async (_path: string, options: { start?: number; end?: number }) => {
    const bytes = Buffer.from('0123456789').subarray(options.start ?? 0, options.end === undefined ? undefined : options.end + 1);
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  });
});

describe('classroom media byte ranges', () => {
  it('revalidates retained browser bytes after authorization without reopening the body', async () => {
    const response = await GET(request(), context);
    const etag = response.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"/);
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    const cached = await GET(conditionalRequest({ 'If-None-Match': etag }), context);
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect(cached.headers.get('etag')).toBe(etag);
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    mocks.authorize.mockResolvedValueOnce(new Response('Denied', { status: 403 }));
    expect((await GET(conditionalRequest({ 'If-None-Match': etag }), context)).status).toBe(403);
    mocks.stat.mockResolvedValue({ size: BigInt(10), dev: BigInt(1), ino: BigInt(2), mtimeNs: BigInt(++fileRevision), ctimeNs: BigInt(fileRevision) });
    const updated = await GET(conditionalRequest({ 'If-None-Match': etag }), context);
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).not.toBe(etag);
  });

  it('returns the full current body when If-Range cannot strongly validate it', async () => {
    const first = await GET(request(), context);
    for (const validator of [first.headers.get('etag')!, '"older"', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      const response = await GET(conditionalRequest({ Range: 'bytes=2-5', 'If-Range': validator }), context);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-range')).toBeNull();
      expect(await response.text()).toBe('0123456789');
    }
  });

  it('serves HEAD metadata without opening a stream', async () => {
    const response = await HEAD(conditionalRequest({ Range: 'bytes=2-5' }, 'HEAD'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
    expect(await response.text()).toBe('');
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('reuses normalized WAV reads and invalidates them when the source file changes', async () => {
    const source = Buffer.from(wav(Uint8Array.from([1, 0, 2, 0])));
    mocks.readFile.mockResolvedValue(source);
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const initial = await Promise.all(Array.from({ length: 30 }, () => GET(request('bytes=44-47'), wavContext)));
    expect(initial.every(response => response.status === 206)).toBe(true);
    await Promise.all(initial.map(response => response.arrayBuffer()));
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    const etag = initial[0].headers.get('etag')!;
    expect((await GET(conditionalRequest({ 'If-None-Match': etag }), wavContext)).status).toBe(304);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    mocks.stat.mockResolvedValue({ size: BigInt(source.length), dev: BigInt(1), ino: BigInt(2), mtimeNs: BigInt(++fileRevision), ctimeNs: BigInt(fileRevision) });
    mocks.readFile.mockResolvedValue(Buffer.from(wav(Uint8Array.from([3, 0, 4, 0]))));
    const updated = await GET(request('bytes=44-47'), wavContext);
    expect(new Uint8Array(await updated.arrayBuffer())).toEqual(Uint8Array.from([3, 0, 4, 0]));
    expect(updated.headers.get('etag')).not.toBe(etag);
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
  });

  it('resumes WAV byte ranges only when the exact playable representation still matches', async () => {
    const source = Buffer.from(wav(Uint8Array.from([1, 0, 2, 0])));
    mocks.readFile.mockResolvedValue(source);
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const full = await GET(request(), wavContext);
    const etag = full.headers.get('etag')!;
    expect(etag).toMatch(/^"/);
    const resumed = await GET(conditionalRequest({ Range: 'bytes=44-47', 'If-Range': etag }), wavContext);
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get('etag')).toBe(etag);
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(Uint8Array.from([1, 0, 2, 0]));
    const stale = await GET(conditionalRequest({ Range: 'bytes=44-47', 'If-Range': '"old-audio"' }), wavContext);
    expect(stale.status).toBe(200);
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(new Uint8Array(source));
  });

  it('retries a WAV changed during reading and never caches its bytes under the previous identity', async () => {
    const oldStat = await mocks.stat();
    const newStat = { ...oldStat, mtimeNs: BigInt(++fileRevision), ctimeNs: BigInt(fileRevision) };
    mocks.stat.mockResolvedValue(newStat).mockResolvedValueOnce(oldStat);
    mocks.readFile.mockResolvedValueOnce(Buffer.from(wav(Uint8Array.from([1, 0]))))
      .mockResolvedValue(Buffer.from(wav(Uint8Array.from([2, 0]))));
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const response = await GET(request('bytes=44-45'), wavContext);
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([2, 0]));
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
    const replay = await GET(request('bytes=44-45'), wavContext);
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(Uint8Array.from([2, 0]));
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
  });

  it('keeps full responses private and announces seekable byte-range support', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect(response.headers.get('content-range')).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.stream).toHaveBeenCalledWith('/classroom-media-test/classroom/audio/voice.mp3', { signal: expect.any(AbortSignal) });
  });

  it.each([
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-4', '6789', 'bytes 6-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
    ['bytes=-20', '0123456789', 'bytes 0-9/10'],
    ['BYTES=0-1', '01', 'bytes 0-1/10'],
  ])('serves a requested single range %s', async (range, body, contentRange) => {
    const response = await GET(request(range), context);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('content-length')).toBe(String(body.length));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it.each(['bytes=-', 'bytes=10-', 'bytes=8-7', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=NaN-4', 'bytes=9007199254740992-', ''])('rejects invalid or unsatisfiable range %s', async (range) => {
    const response = await GET(request(range), context);
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect(await response.text()).toBe('');
  });

  it('ranges the normalized WAV representation rather than raw nested file bytes', async () => {
    const samples = Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const source = wav(wav(samples, true));
    const normalized = normalizePlayableWav(source);
    mocks.readFile.mockResolvedValue(Buffer.from(source));
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const full = await GET(request(), wavContext);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(normalized);
    expect(full.headers.get('content-length')).toBe('52');
    expect(full.headers.get('content-type')).toBe('audio/wav');
    for (const [range, start, end] of [['bytes=0-43', 0, 43], ['bytes=44-', 44, 51], ['bytes=-8', 44, 51]] as const) {
      const response = await GET(request(range), wavContext);
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/52`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(normalized.slice(start, end + 1));
    }
    // This interval exists in the stored wrapper, but not in the playable WAV.
    const unsatisfiable = await GET(request('bytes=60-70'), wavContext);
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */52');
    expect(new DataView(source.buffer).getUint32(4, true)).toBe(source.byteLength - 8);
  });

  it('streams canonical WAV bytes in bounded shared views without a whole-body Response copy', async () => {
    const source = Buffer.from(wav(Buffer.alloc(200_000, 17)));
    const before = Buffer.from(source);
    mocks.readFile.mockResolvedValue(source);
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const response = await GET(request(), wavContext);
    expect(response.headers.get('content-length')).toBe(String(source.length));
    expect(response.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    const reader = response.body!.getReader();
    let count = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      expect(chunk.value.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(chunk.value.buffer).toBe(source.buffer);
      expect(chunk.value.byteOffset).toBe(source.byteOffset + count);
      expect(Buffer.from(chunk.value)).toEqual(before.subarray(count, count + chunk.value.byteLength));
      count += chunk.value.byteLength;
    }
    expect(count).toBe(source.length);
    expect(source).toEqual(before);
    expect(mocks.readFile).toHaveBeenCalledWith('/classroom-media-test/classroom/audio/voice.wav', { signal: expect.any(AbortSignal) });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('aborts an unread WAV stream without damaging an independent range and rechecks authorization', async () => {
    const source = Buffer.from(wav(Buffer.alloc(200_000, 19)));
    mocks.readFile.mockResolvedValue(source);
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const abort = new AbortController();
    const interrupted = await GET(request(undefined, abort.signal), wavContext);
    const survivor = await GET(request('bytes=44-99'), wavContext);
    abort.abort();
    await expect(interrupted.body!.getReader().read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(new Uint8Array(await survivor.arrayBuffer())).toEqual(new Uint8Array(source.subarray(44, 100)));
    expect(survivor.headers.get('content-range')).toBe(`bytes 44-99/${source.length}`);
    expect(survivor.headers.get('content-length')).toBe('56');
    mocks.authorize.mockResolvedValueOnce(new Response('Denied', { status: 403 }));
    const denied = await GET(request('bytes=44-99'), wavContext);
    expect(denied.status).toBe(403);
    expect(mocks.authorize).toHaveBeenCalledTimes(3);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(source.length).toBe(200_044);
  });

  it.each([401, 403])('authorizes range requests before reading bytes or exposing their size (%s)', async (status) => {
    const denied = new Response('Denied', { status });
    mocks.authorize.mockResolvedValue(denied);
    const response = await GET(request('bytes=0-1'), context);
    expect(response).toBe(denied);
    expect(response.headers.get('content-range')).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('rejects paths outside the classroom directory before reading', async () => {
    const response = await GET(request('bytes=0-1'), {
      params: Promise.resolve({ classroomId: 'classroom', path: ['..', 'outside.mp3'] }),
    });
    expect(response.status).toBe(400);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('keeps empty files valid for a full read and rejects their byte ranges', async () => {
    mocks.readFile.mockResolvedValue(Buffer.alloc(0));
    mocks.stat.mockResolvedValue({ size: 0 });
    expect((await GET(request(), context)).status).toBe(200);
    for (const range of ['bytes=0-', 'bytes=-1']) {
      const response = await GET(request(range), context);
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */0');
    }
  });

  it('retains missing-file errors even when a range is requested', async () => {
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    mocks.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect((await GET(request('bytes=0-1'), context)).status).toBe(404);
  });

  it('distinguishes a cancelled WAV read from server failures before response headers', async () => {
    const abort = new AbortController(); abort.abort();
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const cancelled = await GET(request(undefined, abort.signal), wavContext);
    expect(cancelled.status).toBe(499);
    expect(cancelled.headers.get('cache-control')).toBe('private, no-store');
    expect(await cancelled.text()).toBe('');
    expect(mocks.readFile).not.toHaveBeenCalled();
    mocks.readFile.mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }));
    expect((await GET(request(), wavContext)).status).toBe(500);
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    mocks.readFile.mockRejectedValueOnce(aborted);
    expect((await GET(request(), wavContext)).status).toBe(500);
    mocks.stat.mockRejectedValueOnce(aborted);
    expect((await GET(request(undefined, abort.signal), context)).status).toBe(500);
  });
});
