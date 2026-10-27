import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedTtsResult, ttsResultCacheKey } from './tts-result-cache';
import type { TTSModelConfig } from '../audio/types';
const config: TTSModelConfig = { providerId: 'qwen-tts', modelId: 'model', voice: 'voice', speed: 1, apiKey: 'secret' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'coteach-tts-')); vi.stubEnv('TTS_CACHE_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('shared speech results', () => {
  it('coalesces thirty listeners and reads the persisted audio on the next request', async () => {
    const generate = vi.fn(async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'wav' }));
    const results = await Promise.all(Array.from({ length: 30 }, () => cachedTtsResult(config, '同一道题', generate)));
    expect(results.every(item => item.audio.length === 3)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await cachedTtsResult(config, '同一道题', generate)).audio).toEqual(Buffer.from([1, 2, 3]));
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });
  it('never caches provider failures or empty audio', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('provider')).mockResolvedValueOnce({ audio: new Uint8Array(), format: 'wav' })
      .mockResolvedValue({ audio: new Uint8Array([3]), format: 'wav' });
    await expect(cachedTtsResult(config, '内容', generate)).rejects.toThrow('provider');
    await expect(cachedTtsResult(config, '内容', generate)).rejects.toThrow('空音频');
    expect((await cachedTtsResult(config, '内容', generate)).audio.length).toBe(1);
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it('invalidates by exact text and all speech settings without depending on option key order', () => {
    const base = ttsResultCacheKey(config, 'text');
    for (const change of [{ voice: 'other' }, { modelId: 'other' }, { speed: 1.1 }, { language: 'en' }, { apiKey: 'other' }]) {
      expect(ttsResultCacheKey({ ...config, ...change }, 'text')).not.toBe(base);
    }
    expect(ttsResultCacheKey(config, 'new text')).not.toBe(base);
    expect(ttsResultCacheKey({ ...config, providerOptions: { a: 1, b: 2 } }, 'text'))
      .toBe(ttsResultCacheKey({ ...config, providerOptions: { b: 2, a: 1 } }, 'text'));
  });

  it('cancels one listener without interrupting another listener of the same speech', async () => {
    const first = new AbortController(), second = new AbortController();
    let complete!: (value: {audio:Uint8Array;format:string}) => void;
    const generate = vi.fn((signal: AbortSignal) => new Promise<{audio:Uint8Array;format:string}>(resolve => {
      expect(signal.aborted).toBe(false); complete = resolve;
    }));
    const a = cachedTtsResult(config, 'shared cancellation', generate, {signal:first.signal});
    const b = cachedTtsResult(config, 'shared cancellation', generate, {signal:second.signal});
    const rejected = expect(a).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    first.abort(); await rejected;
    expect(generate.mock.calls[0][0].aborted).toBe(false);
    complete({audio:new Uint8Array([4]),format:'wav'});
    expect((await b).audio.length).toBe(1);
  });

  it('aborts abandoned synthesis and permits a fresh same-text request', async () => {
    const controller = new AbortController();
    const first = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve,reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    }));
    const work = cachedTtsResult(config, 'abandoned', first, {signal:controller.signal});
    const rejected = expect(work).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    controller.abort(); await rejected;
    expect(first.mock.calls[0][0].aborted).toBe(true);
    const replacement = vi.fn(async () => ({audio:new Uint8Array([5]),format:'wav'}));
    expect((await cachedTtsResult(config, 'abandoned', replacement)).audio.length).toBe(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
