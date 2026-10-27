import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({generate:vi.fn()}));
vi.mock('../audio/tts-providers', () => ({generateTTS:mocks.generate}));
vi.mock('./provider-config', () => ({getTtsConcurrencyLimit:()=>2}));
import { generateInteractiveTts } from './interactive-tts';
import type { TTSModelConfig } from '../audio/types';
let directory: string;
const config: TTSModelConfig = {providerId:'openai-tts',modelId:'unchanged',voice:'unchanged',apiKey:'synthetic'};
beforeEach(async () => {vi.resetAllMocks();directory=await mkdtemp(path.join(tmpdir(),'interactive-tts-'));vi.stubEnv('TTS_CACHE_DIR',directory);});
afterEach(async () => {vi.useRealTimers();vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});

describe('interactive synthesis admission', () => {
  it('caps 30 distinct texts at the existing provider concurrency and preserves all text/settings', async () => {
    let active=0,maximum=0;
    mocks.generate.mockImplementation(async () => {active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return {audio:new Uint8Array([1]),format:'wav'};});
    const texts=Array.from({length:30},(_,index)=>`完整文本${index}`);
    await Promise.all(texts.map(text=>generateInteractiveTts(config,text)));
    expect(maximum).toBe(2);expect(mocks.generate).toHaveBeenCalledTimes(30);
    expect(new Set(mocks.generate.mock.calls.map(call=>call[1]))).toEqual(new Set(texts));
    expect(mocks.generate.mock.calls.every(call=>call[0].modelId==='unchanged' && call[0].voice==='unchanged')).toBe(true);
  });

  it('does not retry authentication or exhausted-quota failures', async () => {
    mocks.generate.mockRejectedValue(Object.assign(new Error('quota'),{statusCode:403,isRetryable:false}));
    await expect(generateInteractiveTts(config,'quota')).rejects.toThrow('quota');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('waits for the actual Retry-After then retries the same synthesis', async () => {
    mocks.generate.mockRejectedValueOnce(Object.assign(new Error('throttled'),{statusCode:429,retryAfterMs:1250}))
      .mockResolvedValue({audio:new Uint8Array([1]),format:'wav'});
    const start=performance.now();
    expect((await generateInteractiveTts(config,'retry unchanged')).audio.length).toBe(1);
    expect(performance.now()-start).toBeGreaterThanOrEqual(1250);
    expect(mocks.generate.mock.calls.map(call=>call[1])).toEqual(['retry unchanged','retry unchanged']);
  });

  it('stops active upstream work when its only browser cancels', async () => {
    mocks.generate.mockImplementation((input:TTSModelConfig)=>new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true})));
    const controller=new AbortController();const work=generateInteractiveTts(config,'cancelled',controller.signal);
    const rejected=expect(work).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(()=>expect(mocks.generate).toHaveBeenCalledTimes(1));controller.abort();await rejected;
    expect(mocks.generate.mock.calls[0][0].signal.aborted).toBe(true);
  });
});
