import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import { PlaybackEngine } from '@openmaic/lib/playback/engine';
import type { Scene } from '@openmaic/lib/types/stage';
import { AudioPlayer } from './audio-player';
import { db } from './database';

class FakeAudio extends EventTarget {
  src = '';
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  duration = 10;
  buffered: TimeRanges = { length: 0, start: () => 0, end: () => 0 };
  paused = true;
  ended = false;
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
}

describe('AudioPlayer playback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', FakeAudio);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('preloads only after the current clip is fully buffered and reuses the partial next response', async () => {
    const instances: FakeAudio[] = [];
    class PreloadAudio extends FakeAudio {
      constructor() { super(); instances.push(this); }
    }
    vi.stubGlobal('Audio', PreloadAudio);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const player = new AudioPlayer();
    const playback = player.play('', '/current.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await playback;
    const current = instances[0];
    player.preloadNext('/next.mp3');
    current.buffered = { length: 1, start: () => 0, end: () => 5 };
    current.dispatchEvent(new Event('canplaythrough'));
    expect(instances).toHaveLength(1);

    current.buffered = { length: 1, start: () => 0, end: () => 10 };
    current.dispatchEvent(new Event('progress'));
    current.dispatchEvent(new Event('progress'));
    expect(instances).toHaveLength(2);
    const next = instances[1];
    expect(next.src).toBe('/next.mp3');
    expect(next.play).not.toHaveBeenCalled();
    expect(next.load).toHaveBeenCalledOnce();
    expect(next.buffered.length).toBe(0);

    // Native media emits pause at the end before the engine advances.
    current.ended = true;
    current.dispatchEvent(new Event('pause'));
    await expect(player.play('', '/next.mp3')).resolves.toBe(true);
    expect(instances).toHaveLength(2);
    expect(next.removeAttribute).not.toHaveBeenCalled();
    expect(next.load).toHaveBeenCalledOnce();
    expect(next.play).toHaveBeenCalledOnce();
    player.stop();
  });

  it.each(['pause', 'waiting', 'stalled', 'hidden', 'stop', 'page change'] as const)(
    'releases speculative downloads on %s', async (reason) => {
      const instances: FakeAudio[] = [];
      class PreloadAudio extends FakeAudio {
        override buffered = { length: 1, start: () => 0, end: () => 10 };
        constructor() { super(); instances.push(this); }
      }
      vi.stubGlobal('Audio', PreloadAudio);
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      const player = new AudioPlayer();
      const playback = player.play('', '/current.mp3');
      await vi.advanceTimersByTimeAsync(650);
      await playback;
      player.preloadNext('/next.mp3');
      const next = instances[1];
      expect(next.src).toBe('/next.mp3');

      if (reason === 'pause') player.pause();
      else if (reason === 'stop') player.stop();
      else if (reason === 'page change') await player.play('', '/elsewhere.mp3');
      else if (reason === 'hidden') {
        hidden.mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      } else instances[0].dispatchEvent(new Event(reason));

      expect(next.src).toBe('');
      expect(next.removeAttribute).toHaveBeenCalledWith('src');
      expect(next.load).toHaveBeenCalledTimes(2);
      instances[0].dispatchEvent(new Event('progress'));
      expect(instances).toHaveLength(reason === 'page change' ? 3 : 2);
      player.stop();
    },
  );

  it.each([{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }])(
    'does not preload when the browser reports %o', async (connection) => {
      const instances: FakeAudio[] = [];
      class PreloadAudio extends FakeAudio {
        override buffered = { length: 1, start: () => 0, end: () => 10 };
        constructor() { super(); instances.push(this); }
      }
      vi.stubGlobal('Audio', PreloadAudio);
      vi.stubGlobal('navigator', { connection });
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      const player = new AudioPlayer();
      const playback = player.play('', '/current.mp3');
      await vi.advanceTimersByTimeAsync(650);
      await playback;
      player.preloadNext('/next.mp3');
      expect(instances).toHaveLength(1);
      player.stop();
    },
  );

  it('leaves the current narration playing when speculative loading fails and allows direct retry', async () => {
    const instances: FakeAudio[] = [];
    class PreloadAudio extends FakeAudio {
      override buffered = { length: 1, start: () => 0, end: () => 10 };
      constructor() { super(); instances.push(this); }
    }
    vi.stubGlobal('Audio', PreloadAudio);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const player = new AudioPlayer();
    const onError = vi.fn();
    player.onError(onError);
    const playback = player.play('', '/current.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await playback;
    player.preloadNext('/next.mp3');
    instances[1].dispatchEvent(new Event('error'));
    instances[0].dispatchEvent(new Event('progress'));
    expect(instances).toHaveLength(2);
    expect(player.isPlaying()).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    await expect(player.play('', '/next.mp3')).resolves.toBe(true);
    expect(instances).toHaveLength(3);
    expect(instances[2].src).toBe('/next.mp3');
    player.stop();
  });

  it('recovers a media start that never settles by downloading a bounded fallback', async () => {
    class StuckAudio extends FakeAudio {
      override play = vi.fn(() => this.src.startsWith('blob:')
        ? Promise.resolve().then(() => { this.paused = false; })
        : new Promise<void>(() => {}));
    }
    vi.stubGlobal('Audio', StuckAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:recovered'), revokeObjectURL: vi.fn() });
    const fetchAudio = vi.fn().mockResolvedValue({ ok: true, blob: async () => new NodeBlob(['audio']) });
    vi.stubGlobal('fetch', fetchAudio);
    const player = new AudioPlayer();
    const playback = player.play('', '/stuck.mp3');
    const original = (player as unknown as { audio: FakeAudio }).audio;

    await vi.advanceTimersByTimeAsync(15_650);

    await expect(playback).resolves.toBe(true);
    expect(fetchAudio).toHaveBeenCalledOnce();
    expect(original.removeAttribute).toHaveBeenCalledWith('src');
    expect(original.load).toHaveBeenCalledOnce();
    player.stop();
  });

  it('bounds a stalled fallback response body and leaves the cue available for retry', async () => {
    class FailedAudio extends FakeAudio {
      override play = vi.fn(async () => { throw new Error('decode failed'); });
    }
    vi.stubGlobal('Audio', FailedAudio);
    let downloadSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (_url, { signal }: { signal: AbortSignal }) => {
      downloadSignal = signal;
      return { ok: true, blob: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }) };
    }));
    const player = new AudioPlayer();
    const result = player.play('', '/stalled.mp3').catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(15_000);

    expect((await result as Error).message).toContain('加载超时');
    expect(downloadSignal.aborted).toBe(true);
    expect(player.hasActiveAudio()).toBe(false);
  });

  it('does not redownload media when the browser requires a user gesture', async () => {
    class BlockedAudio extends FakeAudio {
      override play = vi.fn(async () => { throw new DOMException('user gesture required', 'NotAllowedError'); });
    }
    vi.stubGlobal('Audio', BlockedAudio);
    const fetchAudio = vi.fn();
    vi.stubGlobal('fetch', fetchAudio);
    const player = new AudioPlayer();

    await expect(player.play('', '/blocked.mp3')).rejects.toThrow('点击播放按钮');
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(player.hasActiveAudio()).toBe(false);
  });

  it('cancels a pending media start immediately when leaving the page', async () => {
    class StuckAudio extends FakeAudio {
      override play = vi.fn(() => new Promise<void>(() => {}));
    }
    vi.stubGlobal('Audio', StuckAudio);
    const fetchAudio = vi.fn();
    vi.stubGlobal('fetch', fetchAudio);
    const player = new AudioPlayer();
    const playback = player.play('', '/stuck.mp3');
    await vi.advanceTimersByTimeAsync(0);
    player.stop();

    await expect(playback).resolves.toBe(false);
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['error', false], ['waiting', false], ['error', true],
  ] as const)('retries the current speech after a midstream %s (paused: %s) instead of skipping it', async (event, paused) => {
    const player = new AudioPlayer();
    const onError = vi.fn();
    const onSpeechStart = vi.fn();
    const scene = { id: 'lesson', type: 'slide', actions: [
      { id: 'current', type: 'speech', text: '当前讲解', audioUrl: '/current.mp3' },
      { id: 'next', type: 'speech', text: '下一段', audioUrl: '/next.mp3' },
    ] } as Scene;
    const engine = new PlaybackEngine([scene], {
      clearEffects: vi.fn(), restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine, player, { onSpeechStart, onError });
    engine.start();
    await vi.advanceTimersByTimeAsync(650);
    const original = (player as unknown as { audio: FakeAudio }).audio;
    original.currentTime = 3;
    if (paused) engine.pause();
    original.dispatchEvent(new Event(event));
    if (event === 'waiting') await vi.advanceTimersByTimeAsync(15_000);

    expect(engine.getMode()).toBe(paused ? 'paused' : 'idle');
    expect(onError).toHaveBeenCalledOnce();
    expect(player.hasActiveAudio()).toBe(false);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['当前讲解']);
    if (paused) engine.resume();
    else engine.continuePlayback();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['当前讲解', '当前讲解']);
    expect((player as unknown as { audio: FakeAudio }).audio.src).toBe('/current.mp3');
    original.dispatchEvent(new Event('error'));
    expect(onError).toHaveBeenCalledOnce();
    engine.stop();
  });

  it.each(['progress', 'pause', 'ended', 'page change'] as const)('does not treat %s as a stalled playback failure', async (recovery) => {
    const player = new AudioPlayer();
    const onError = vi.fn();
    player.onError(onError);
    const playback = player.play('', '/current.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await playback;
    const original = (player as unknown as { audio: FakeAudio }).audio;
    original.dispatchEvent(new Event('stalled'));
    if (recovery === 'progress') {
      original.currentTime = 1;
      original.dispatchEvent(new Event('timeupdate'));
    } else if (recovery === 'pause') player.pause();
    else if (recovery === 'ended') original.dispatchEvent(new Event('ended'));
    else await player.play('', '/next.mp3');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onError).not.toHaveBeenCalled();
    player.stop();
  });

  it('downloads and retries a URL when the initial quiet preroll fails', async () => {
    const failure = new Error('Audio could not be decoded');
    class RetryAudio extends FakeAudio {
      override play = vi.fn(async () => {
        if (this.src === '/narration.wav') throw failure;
        this.paused = false;
      });
    }
    const fetchAudio = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new NodeBlob(['audio'], { type: 'audio/wav' }),
    });
    vi.stubGlobal('Audio', RetryAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', fetchAudio);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:repaired'), revokeObjectURL: vi.fn() });

    const player = new AudioPlayer();
    const playback = player.play('', '/narration.wav');
    await vi.advanceTimersByTimeAsync(650);

    await expect(playback).resolves.toBe(true);
    expect(fetchAudio).toHaveBeenCalledWith('/narration.wav', { signal: expect.any(AbortSignal) });
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(audio.src).toBe('blob:repaired');
    expect(audio.volume).toBe(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it.each(['URL fallback', 'IndexedDB'])('releases audio when the %s preroll fails', async (source) => {
    const failure = new Error('Audio could not be decoded');
    class FailedAudio extends FakeAudio {
      override play = vi.fn(async () => { throw failure; });
    }
    const blob = new NodeBlob(['audio'], { type: 'audio/wav' });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('Audio', FailedAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:failed'), revokeObjectURL });
    vi.spyOn(db.audioFiles, 'get').mockResolvedValue({
      id: 'speech', blob, format: 'wav',
    } as unknown as Awaited<ReturnType<typeof db.audioFiles.get>>);

    const player = new AudioPlayer();
    await expect(player.play('speech', source === 'URL fallback' ? '/narration.wav' : undefined))
      .rejects.toBe(failure);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed');
    expect(player.hasActiveAudio()).toBe(false);
    expect((player as unknown as { warmupAudio: FakeAudio | null }).warmupAudio).toBeNull();
  });

  it('prerolls quietly, rewinds, and then starts the first page clip audibly', async () => {
    const player = new AudioPlayer();
    player.setVolume(0.8);
    player.requestPlaybackWarmup();

    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(649);

    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.volume).toBe(0.001);

    await vi.advanceTimersByTimeAsync(1);
    await expect(playback).resolves.toBe(true);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBe(0.8);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('does not add a warmup before every narration segment', async () => {
    const player = new AudioPlayer();
    const firstPlayback = player.play('', '/first.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await firstPlayback;

    await expect(player.play('', '/second.mp3')).resolves.toBe(true);
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('starts the warmup timer only after delayed media actually starts playing', async () => {
    class SlowAudio extends FakeAudio {
      override play = vi.fn(async () => {
        if (this.play.mock.calls.length === 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000));
        }
        this.paused = false;
      });
    }
    vi.stubGlobal('Audio', SlowAudio);
    const player = new AudioPlayer();
    const started = vi.fn();
    const playback = player.play('', '/slow.mp3').then((result) => { started(result); return result; });
    const audio = (player as unknown as { audio: FakeAudio }).audio;

    await vi.advanceTimersByTimeAsync(2_649);
    expect(started).not.toHaveBeenCalled();
    expect(player.getCurrentTime()).toBe(0);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.volume).toBe(0.001);

    await vi.advanceTimersByTimeAsync(1);
    await expect(playback).resolves.toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBe(1);
  });

  it('waits for metadata and the real seek before playing a subtitle inside a long clip', async () => {
    class SeekingAudio extends FakeAudio {
      override duration = Number.NaN;
      seeking = false;
      constructor() {
        super();
        let mediaTime = 0;
        Object.defineProperty(this, 'currentTime', {
          get: () => mediaTime,
          set: (target: number) => {
            this.seeking = true;
            window.setTimeout(() => {
              mediaTime = target;
              this.seeking = false;
              this.dispatchEvent(new Event('seeked'));
            }, 80);
          },
        });
      }
      override load = vi.fn(() => window.setTimeout(() => {
        this.duration = 75.2;
        this.dispatchEvent(new Event('loadedmetadata'));
      }, 25));
    }
    vi.stubGlobal('Audio', SeekingAudio);
    const player = new AudioPlayer();
    const playback = player.play('', '/long.wav', 0.55);
    const audio = (player as unknown as { audio: SeekingAudio }).audio;

    await vi.advanceTimersByTimeAsync(25);
    expect(audio.seeking).toBe(true);
    expect(audio.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(79);
    expect(audio.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(playback).resolves.toBe(true);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(player.getCurrentTime()).toBeCloseTo(41_360);
  });

  it('downloads a seekable blob when the URL reports seeked at the wrong position', async () => {
    class NonSeekableUrlAudio extends FakeAudio {
      seeking = false;
      constructor() {
        super();
        let mediaTime = 0;
        Object.defineProperty(this, 'currentTime', {
          get: () => mediaTime,
          set: (target: number) => {
            this.seeking = true;
            window.setTimeout(() => {
              mediaTime = this.src.startsWith('blob:') ? target : 0;
              this.seeking = false;
              this.dispatchEvent(new Event('seeked'));
            }, 10);
          },
        });
      }
    }
    const fetchAudio = vi.fn().mockResolvedValue({
      ok: true, blob: async () => new NodeBlob(['audio'], { type: 'audio/mpeg' }),
    });
    vi.stubGlobal('Audio', NonSeekableUrlAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', fetchAudio);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:seekable'), revokeObjectURL: vi.fn() });
    const player = new AudioPlayer();
    const playback = player.play('', '/long.mp3', 0.55);
    const original = (player as unknown as { audio: FakeAudio }).audio;

    await vi.advanceTimersByTimeAsync(20);

    await expect(playback).resolves.toBe(true);
    expect(original.play).not.toHaveBeenCalled();
    expect(fetchAudio).toHaveBeenCalledWith('/long.mp3', { signal: expect.any(AbortSignal) });
    expect(player.getCurrentTime()).toBe(5_500);
  });

  it('does not restart an older clip after a newer subtitle seek replaces its metadata load', async () => {
    class LoadingAudio extends FakeAudio {
      override duration = Number.NaN;
      override load = vi.fn(() => window.setTimeout(() => {
        this.duration = 10;
        this.dispatchEvent(new Event('loadedmetadata'));
      }, this.src === '/first.mp3' ? 80 : 20));
    }
    vi.stubGlobal('Audio', LoadingAudio);
    const player = new AudioPlayer();
    const firstPlayback = player.play('', '/first.mp3', 0.3);
    const firstAudio = (player as unknown as { audio: FakeAudio }).audio;
    const secondPlayback = player.play('', '/second.mp3', 0.8);

    await vi.advanceTimersByTimeAsync(80);

    await expect(firstPlayback).resolves.toBe(false);
    await expect(secondPlayback).resolves.toBe(true);
    expect(firstAudio.play).not.toHaveBeenCalled();
    expect(player.getCurrentTime()).toBe(8_000);
    expect((player as unknown as { audio: FakeAudio }).audio.src).toBe('/second.mp3');
  });

  it.each([false, true])('honors pause during a subtitle load (resume before load completes: %s)', async (resumeEarly) => {
    class LoadingAudio extends FakeAudio {
      override duration = Number.NaN;
      override load = vi.fn(() => window.setTimeout(() => {
        this.duration = 10;
        this.dispatchEvent(new Event('loadedmetadata'));
      }, 80));
    }
    vi.stubGlobal('Audio', LoadingAudio);
    const player = new AudioPlayer();
    const settled = vi.fn();
    const playback = player.play('', '/long.mp3', 0.8).then((result) => { settled(result); return result; });
    const audio = (player as unknown as { audio: FakeAudio }).audio;

    player.pause();
    if (resumeEarly) player.resume();
    expect(audio.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);

    expect(audio.play).toHaveBeenCalledTimes(resumeEarly ? 1 : 0);
    expect(player.getCurrentTime()).toBe(8_000);
    if (!resumeEarly) {
      expect(settled).not.toHaveBeenCalled();
      player.resume();
    }
    await expect(playback).resolves.toBe(true);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it('still warms and rewinds the first sentence when its download finishes while paused', async () => {
    class RetryAudio extends FakeAudio {
      override play = vi.fn(async () => {
        if (this.src === '/first.mp3') throw new Error('URL decode failed');
        this.paused = false;
      });
    }
    let completeDownload!: () => void;
    vi.stubGlobal('Audio', RetryAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:first'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      completeDownload = () => resolve({
        ok: true, blob: async () => new NodeBlob(['audio'], { type: 'audio/mpeg' }),
      });
    })));
    const player = new AudioPlayer();
    const settled = vi.fn();
    const playback = player.play('', '/first.mp3').then((result) => { settled(result); return result; });
    await vi.advanceTimersByTimeAsync(0);
    player.pause();
    completeDownload();
    await vi.advanceTimersByTimeAsync(1_000);
    const audio = (player as unknown as { audio: FakeAudio }).audio;

    expect(audio.play).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(player.hasActiveAudio()).toBe(true);
    player.resume();
    await vi.advanceTimersByTimeAsync(649);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.volume).toBe(0.001);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(playback).resolves.toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBe(1);
  });

  it.each(['stop', 'page change'])('cancels a start waiting for Resume on %s', async (action) => {
    const player = new AudioPlayer();
    const playback = player.play('', '/first.mp3');
    const original = (player as unknown as { audio: FakeAudio }).audio;
    player.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(original.play).not.toHaveBeenCalled();

    if (action === 'stop') player.stop();
    else {
      const nextPlayback = player.play('', '/second.mp3');
      await vi.advanceTimersByTimeAsync(650);
      await expect(nextPlayback).resolves.toBe(true);
    }
    await expect(playback).resolves.toBe(false);
    expect(original.play).not.toHaveBeenCalled();
    player.stop();
  });

  it('does not start a stale clip when pages change between startup microtasks', async () => {
    const player = new AudioPlayer();
    const firstPlayback = player.play('', '/first.mp3');
    const original = (player as unknown as { audio: FakeAudio }).audio;
    let nextPlayback!: Promise<boolean>;
    queueMicrotask(() => { nextPlayback = player.play('', '/second.mp3'); });
    await vi.advanceTimersByTimeAsync(650);

    await expect(firstPlayback).resolves.toBe(false);
    await expect(nextPlayback).resolves.toBe(true);
    expect(original.paused).toBe(true);
    // If the original preroll started, it must have been stopped on replacement.
    expect(original.play).toHaveBeenCalledTimes(1);
    expect(original.volume).toBe(0.001);
    player.stop();
  });

  it.each(['URL download', 'IndexedDB lookup'])('keeps the target speech when paused and resumed during a pending %s', async (source) => {
    class RetryAudio extends FakeAudio {
      override play = vi.fn(async () => {
        if (this.src === '/long.mp3') throw new Error('URL decode failed');
        this.paused = false;
      });
    }
    const blob = new NodeBlob(['audio'], { type: 'audio/mpeg' });
    let completeLoad!: () => void;
    vi.stubGlobal('Audio', RetryAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:loaded'), revokeObjectURL: vi.fn() });
    if (source === 'URL download') {
      vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
        completeLoad = () => resolve({ ok: true, blob: async () => blob });
      })));
    } else {
      const pendingRecord = new Promise<Awaited<ReturnType<typeof db.audioFiles.get>>>((resolve) => {
        completeLoad = () => resolve({ id: 'pending', blob, format: 'mp3' } as unknown as Awaited<ReturnType<typeof db.audioFiles.get>>);
      });
      vi.spyOn(db.audioFiles, 'get').mockReturnValue(pendingRecord as ReturnType<typeof db.audioFiles.get>);
    }
    const player = new AudioPlayer();
    const onSpeechStart = vi.fn();
    const scene = { id: 'loading-audio', type: 'slide', actions: [
      { id: 'target', type: 'speech', text: '目标讲词', audioId: 'pending', audioDurationSec: 10,
        ...(source === 'URL download' ? { audioUrl: '/long.mp3' } : {}) },
      { id: 'next', type: 'speech', text: '下一段讲词', audioUrl: '/next.mp3' },
    ] } as Scene;
    const engine = new PlaybackEngine([scene], {
      clearEffects: vi.fn(), restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine, player, { onSpeechStart });
    engine.playSpeechAt(0, 0.8);
    await vi.advanceTimersByTimeAsync(0);
    expect(player.isPlaying()).toBe(false);
    expect(player.hasActiveAudio()).toBe(true);

    engine.pause();
    engine.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['目标讲词']);
    completeLoad();
    await vi.advanceTimersByTimeAsync(0);

    expect(player.isPlaying()).toBe(true);
    expect(player.getCurrentTime()).toBe(8_000);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['目标讲词']);
    engine.stop();
    expect(player.hasActiveAudio()).toBe(false);
  });

  it('rewinds and stays paused when the user pauses during warmup', async () => {
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    const settled = vi.fn();
    const playback = player.play('', '/narration.mp3').then((result) => { settled(result); return result; });
    await vi.advanceTimersByTimeAsync(100);
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    player.pause();
    await vi.advanceTimersByTimeAsync(550);

    expect(settled).not.toHaveBeenCalled();
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(0);
    expect(onEnded).not.toHaveBeenCalled();

    player.resume();
    await expect(playback).resolves.toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.volume).toBe(1);
  });

  it('resumes from zero when a pause is lifted before the quiet preroll has finished', async () => {
    const player = new AudioPlayer();
    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(100);
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    player.pause();
    player.resume();
    expect(audio.play).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(550);

    await expect(playback).resolves.toBe(true);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBe(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('ignores a late ended event from audio replaced by a seek or page change', async () => {
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    const firstPlayback = player.play('', '/first.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await firstPlayback;
    const firstAudio = (player as unknown as { audio: FakeAudio }).audio;

    await player.play('', '/second.mp3');
    const secondAudio = (player as unknown as { audio: FakeAudio }).audio;
    firstAudio.dispatchEvent(new Event('ended'));
    expect(onEnded).not.toHaveBeenCalled();

    secondAudio.dispatchEvent(new Event('ended'));
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('does not resume a completed quiz introduction after the tutor modal closes', async () => {
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    const playback = player.play('', '/quiz-introduction.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await playback;
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(player.hasActiveAudio()).toBe(true);

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new Event('ended'));
    expect(onEnded).toHaveBeenCalledOnce();

    player.pause();
    expect(player.hasActiveAudio()).toBe(false);
    player.resume();
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('plays quiz feedback after confirmation without repeating the introduction', async () => {
    const scene = {
      id: 'quiz-1',
      type: 'quiz',
      actions: [
        { id: 'intro', type: 'speech', text: '请完成答题', audioUrl: '/intro.mp3' },
        { id: 'gate', type: 'speech', text: '', activityPauseSec: 60, activityPausePurpose: 'quiz' },
        { id: 'feedback', type: 'speech', text: '继续学习下一部分', audioUrl: '/feedback.mp3' },
      ],
    } as Scene;
    const player = new AudioPlayer();
    const onSpeechStart = vi.fn();
    const onActivityStart = vi.fn();
    const engine = new PlaybackEngine(
      [scene],
      { clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined) } as unknown as ActionEngine,
      player,
      { onSpeechStart, onActivityStart },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(650);
    const intro = (player as unknown as { audio: FakeAudio }).audio;
    intro.ended = true;
    intro.paused = true;
    intro.dispatchEvent(new Event('ended'));
    expect(onActivityStart).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'quiz' }));

    engine.pause(); // Opening the tutor explanation pauses the course.
    expect(engine.completeActivity('quiz-1', 'quiz')).toBe(true);
    engine.resume(); // The learner closed the tutor and confirmed understanding.
    await Promise.resolve();

    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual([
      '请完成答题',
      '继续学习下一部分',
    ]);
    expect(intro.play).toHaveBeenCalledTimes(2);
    expect((player as unknown as { audio: FakeAudio }).audio.src).toBe('/feedback.mp3');
    engine.stop();
  });

  it('plays staged quiz audio in submission, review, and handoff order', async () => {
    const scene = {
      id: 'staged-quiz-audio',
      type: 'quiz',
      actions: [
        { id: 'intro', type: 'speech', text: '请独立作答', audioUrl: '/intro.mp3' },
        { id: 'submit', type: 'speech', text: '', activityPauseSec: 60, activityPausePurpose: 'quiz-submit' },
        { id: 'review', type: 'speech', text: '提交后请看解析', audioUrl: '/review.mp3' },
        { id: 'confirm', type: 'speech', text: '', activityPauseSec: 20, activityPausePurpose: 'quiz' },
        { id: 'handoff', type: 'speech', text: '接下来进入下一节', audioUrl: '/handoff.mp3' },
      ],
    } as Scene;
    const player = new AudioPlayer();
    const onSpeechStart = vi.fn();
    const onActivityStart = vi.fn();
    const engine = new PlaybackEngine(
      [scene],
      { clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined) } as unknown as ActionEngine,
      player,
      { onSpeechStart, onActivityStart },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(650);
    const intro = (player as unknown as { audio: FakeAudio }).audio;
    intro.ended = true;
    intro.paused = true;
    intro.dispatchEvent(new Event('ended'));
    expect(onActivityStart).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'quiz-submit' }));

    expect(engine.completeActivity(scene.id, 'quiz-submit')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const review = (player as unknown as { audio: FakeAudio }).audio;
    expect(review.src).toBe('/review.mp3');
    expect(onSpeechStart.mock.calls.map(([speech]) => speech)).toEqual(['请独立作答', '提交后请看解析']);

    // The learner can confirm quickly, but the current guidance must finish.
    expect(engine.completeActivity(scene.id, 'quiz')).toBe(false);
    expect(review.paused).toBe(false);
    review.ended = true;
    review.paused = true;
    review.dispatchEvent(new Event('ended'));
    expect(onActivityStart).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'quiz' }));
    expect(engine.completeActivity(scene.id, 'quiz')).toBe(true);
    await Promise.resolve();
    expect((player as unknown as { audio: FakeAudio }).audio.src).toBe('/handoff.mp3');
    expect(onSpeechStart.mock.calls.map(([speech]) => speech)).toEqual([
      '请独立作答', '提交后请看解析', '接下来进入下一节',
    ]);
    engine.stop();
  });

  it('waits for the quiet pre-roll to seek back to zero before audible playback', async () => {
    const player = new AudioPlayer();
    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(649);

    const audio = (player as unknown as { audio: FakeAudio & { seeking: boolean } }).audio;
    let mediaTime = 0.65;
    audio.seeking = false;
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => mediaTime,
      set: (value: number) => {
        if (value !== 0) {
          mediaTime = value;
          return;
        }
        audio.seeking = true;
        window.setTimeout(() => {
          mediaTime = 0;
          audio.seeking = false;
          audio.dispatchEvent(new Event('seeked'));
        }, 80);
      },
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(79);
    expect(audio.play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(playback).resolves.toBe(true);
    expect(mediaTime).toBe(0);
    expect(audio.volume).toBe(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it.each(['timeout', 'wrong position', 'media error'])(
    'downloads a fresh clip rather than playing a swallowed opening after a preroll rewind %s',
    async (failure) => {
      class UnreliableRewindAudio extends FakeAudio {
        seeking = false;
        constructor() {
          super();
          let mediaTime = 0;
          this.play = vi.fn(async () => {
            this.paused = false;
            if (this.src === '/narration.mp3') mediaTime = 0.65;
          });
          Object.defineProperty(this, 'currentTime', {
            get: () => mediaTime,
            set: (target: number) => {
              if (this.src !== '/narration.mp3') {
                mediaTime = target;
                return;
              }
              this.seeking = true;
              if (failure === 'timeout') return;
              window.setTimeout(() => {
                this.seeking = false;
                this.dispatchEvent(new Event(failure === 'media error' ? 'error' : 'seeked'));
              }, 20);
            },
          });
        }
      }
      const fetchAudio = vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new NodeBlob(['audio'], { type: 'audio/mpeg' }),
      });
      vi.stubGlobal('Audio', UnreliableRewindAudio);
      vi.stubGlobal('Blob', NodeBlob);
      vi.stubGlobal('fetch', fetchAudio);
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:complete'), revokeObjectURL: vi.fn() });
      const player = new AudioPlayer();
      const playback = player.play('', '/narration.mp3');
      const original = (player as unknown as { audio: FakeAudio }).audio;

      await vi.advanceTimersByTimeAsync(2_400);

      await expect(playback).resolves.toBe(true);
      expect(original.play).toHaveBeenCalledOnce();
      expect(fetchAudio).toHaveBeenCalledWith('/narration.mp3', { signal: expect.any(AbortSignal) });
      expect((player as unknown as { audio: FakeAudio }).audio.src).toBe('blob:complete');
      expect(player.getCurrentTime()).toBe(0);
    },
  );

  it('keeps the preroll quiet when volume or mute settings change during page startup', async () => {
    const player = new AudioPlayer();
    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(100);
    const audio = (player as unknown as { audio: FakeAudio }).audio;

    player.setVolume(0.8);
    expect(audio.volume).toBe(0.001);
    player.setMuted(true);
    expect(audio.volume).toBe(0);
    player.setMuted(false);
    expect(audio.volume).toBe(0.001);

    await vi.advanceTimersByTimeAsync(550);
    await expect(playback).resolves.toBe(true);
    expect(audio.volume).toBe(0.8);
    expect(audio.currentTime).toBe(0);
  });

  it('finishes rewinding before resuming a clip paused during the quiet preroll', async () => {
    const player = new AudioPlayer();
    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(100);
    const audio = (player as unknown as { audio: FakeAudio & { seeking: boolean } }).audio;
    let mediaTime = 0.1;
    audio.seeking = false;
    Object.defineProperty(audio, 'currentTime', {
      get: () => mediaTime,
      set: (target: number) => {
        audio.seeking = true;
        window.setTimeout(() => {
          mediaTime = target;
          audio.seeking = false;
          audio.dispatchEvent(new Event('seeked'));
        }, 800);
      },
    });

    player.pause();
    player.resume();
    await vi.advanceTimersByTimeAsync(550);
    expect(audio.play).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(800);
    await expect(playback).resolves.toBe(true);
    expect(mediaTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed rewind inaudible and reports failure when the downloaded copy also cannot rewind', async () => {
    const instances: FakeAudio[] = [];
    class FailedRewindAudio extends FakeAudio {
      seeking = false;
      constructor() {
        super();
        instances.push(this);
        Object.defineProperty(this, 'currentTime', {
          get: () => 0.65,
          set: () => { this.seeking = true; },
        });
      }
    }
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('Audio', FailedRewindAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new NodeBlob(['audio'], { type: 'audio/mpeg' }),
    }));
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:failed'), revokeObjectURL });
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);
    const playback = expect(player.play('', '/narration.mp3')).rejects.toThrow('rewinding audio');

    await vi.advanceTimersByTimeAsync(3_300);

    await playback;
    expect(instances).toHaveLength(2);
    for (const audio of instances) {
      expect(audio.play).toHaveBeenCalledOnce();
      expect(audio.volume).toBe(0.001);
      expect(audio.paused).toBe(true);
    }
    expect(onEnded).not.toHaveBeenCalled();
    expect(player.hasActiveAudio()).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed');
  });

  it('cancels the old preroll when a different page starts before it finishes', async () => {
    const player = new AudioPlayer();
    const first = player.play('', '/first.mp3');
    await vi.advanceTimersByTimeAsync(100);
    const original = (player as unknown as { audio: FakeAudio }).audio;
    player.requestPlaybackWarmup();
    const second = player.play('', '/second.mp3');
    const current = (player as unknown as { audio: FakeAudio }).audio;

    await vi.advanceTimersByTimeAsync(650);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(original.play).toHaveBeenCalledOnce();
    expect(original.paused).toBe(true);
    expect(current.play).toHaveBeenCalledTimes(2);
    expect(current.currentTime).toBe(0);
    expect(current.volume).toBe(1);
  });
});
