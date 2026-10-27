import { describe, expect, it } from 'vitest';
import { hasWavHeader, normalizePlayableWav } from './wav-container';

function pcmWav(payload: Uint8Array, sentinelSizes = false): Uint8Array {
  const wav = new Uint8Array(44 + payload.byteLength);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, sentinelSizes ? 0x7fffffff : wav.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, sentinelSizes ? 0x7fffffff : payload.byteLength, true);
  wav.set(payload, 44);
  return wav;
}

describe('normalizePlayableWav', () => {
  it('repairs streaming sentinel sizes without changing PCM samples', () => {
    const pcm = Uint8Array.from([0xfe, 0xff, 0x03, 0x00]);
    const source = pcmWav(pcm, true);

    const normalized = normalizePlayableWav(source);
    const view = new DataView(normalized.buffer);

    expect(view.getUint32(4, true)).toBe(normalized.byteLength - 8);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(normalized.slice(44)).toEqual(pcm);
    expect(new DataView(source.buffer).getUint32(4, true)).toBe(0x7fffffff);
  });

  it('unwraps a WAV mistakenly stored as another WAV payload', () => {
    const pcm = Uint8Array.from([0xfe, 0xff, 0xfd, 0xff, 0x02, 0x00]);
    const inner = pcmWav(pcm, true);
    const nested = pcmWav(inner);

    const normalized = normalizePlayableWav(nested);

    expect(normalized.byteLength).toBe(inner.byteLength);
    expect(hasWavHeader(normalized)).toBe(true);
    expect(hasWavHeader(normalized.subarray(44))).toBe(false);
    expect(normalized.slice(44)).toEqual(pcm);
    expect(new DataView(normalized.buffer).getUint32(40, true)).toBe(pcm.byteLength);
  });

  it('reuses a normalized Buffer view with its nonzero byte offset', () => {
    const canonical = pcmWav(Uint8Array.from([1, 0, 2, 0]));
    const allocation = Buffer.alloc(canonical.length + 32, 0xaa);
    allocation.set(canonical, 13);
    const source = allocation.subarray(13, 13 + canonical.length);
    const before = Buffer.from(allocation);
    expect(normalizePlayableWav(source)).toBe(source);
    expect(allocation).toEqual(before);
  });

  it('unwraps a valid inner WAV as a read-only view and leaves both headers untouched', () => {
    const inner = pcmWav(Uint8Array.from([1, 0, 2, 0]));
    const nested = pcmWav(inner, true);
    const before = nested.slice();
    const result = normalizePlayableWav(nested);
    expect(result.buffer).toBe(nested.buffer);
    expect(result.byteOffset).toBe(nested.byteOffset + 44);
    expect(result).toEqual(inner);
    expect(nested).toEqual(before);
  });

  it.each([4, 40])('copies only when header field %s needs repairing, preserving an offset source', field => {
    const canonical = pcmWav(Uint8Array.from([3, 0, 4, 0]));
    const allocation = Buffer.alloc(canonical.length + 16, 0xab);
    allocation.set(canonical, 8);
    const source = allocation.subarray(8, 8 + canonical.length);
    new DataView(source.buffer, source.byteOffset, source.byteLength).setUint32(field, 0x7fffffff, true);
    const before = Buffer.from(allocation);
    const result = normalizePlayableWav(source);
    expect(result.buffer).not.toBe(source.buffer);
    expect(result).toEqual(canonical);
    expect(normalizePlayableWav(result)).toBe(result);
    expect(allocation).toEqual(before);
  });

  it('preserves malformed/no-data bytes without manufacturing a repaired header', () => {
    const source = pcmWav(Uint8Array.from([1, 0]));
    source.set(new TextEncoder().encode('JUNK'), 36);
    const snapshot = source.slice();
    expect(normalizePlayableWav(source)).toBe(source);
    expect(source).toEqual(snapshot);
  });

  it('leaves non-WAV audio untouched', () => {
    const mp3Like = Uint8Array.from([0x49, 0x44, 0x33, 0x04]);
    expect(normalizePlayableWav(mp3Like)).toBe(mp3Like);
  });
});
