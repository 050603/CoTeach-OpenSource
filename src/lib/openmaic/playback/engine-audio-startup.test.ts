import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import { useSettingsStore } from '@openmaic/lib/store/settings';
import type { Scene } from '@openmaic/lib/types/stage';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';
import { PlaybackEngine } from './engine';

function createPendingNarration(scenes?: Scene[]) {
  let resolvePlayback!: (started: boolean) => void;
  let rejectPlayback!: (error: Error) => void;
  const pendingPlayback = new Promise<boolean>((resolve, reject) => {
    resolvePlayback = resolve;
    rejectPlayback = reject;
  });
  let active = true;
  let playing = false;
  let currentTimeMs = 0;
  let onEnded: (() => void) | undefined;
  const play = vi.fn().mockImplementationOnce(() => pendingPlayback).mockImplementation(() => {
    active = true;
    playing = true;
    return Promise.resolve(true);
  });
  const preloadNext = vi.fn();
  const player = {
    play,
    preloadNext,
    onEnded: vi.fn((callback: () => void) => { onEnded = callback; }),
    pause: vi.fn(() => { playing = false; }),
    resume: vi.fn(),
    stop: vi.fn(() => { active = false; playing = false; }),
    hasActiveAudio: vi.fn(() => active),
    isPlaying: vi.fn(() => playing),
    getCurrentTime: vi.fn(() => currentTimeMs),
    getDuration: vi.fn(() => 10_000),
  } as unknown as AudioPlayer;
  const actionEngine = {
    clearEffects: vi.fn(),
    restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
  } as unknown as ActionEngine;
  const scene = {
    id: 'lesson',
    type: 'slide',
    ttsPolicy: 'target-duration',
    actions: [
      { id: 'first', type: 'speech', text: '首页第一句', audioUrl: '/first.wav' },
      { id: 'second', type: 'speech', text: '下一句', audioUrl: '/second.wav' },
    ],
  } as Scene;
  const onSpeechStart = vi.fn();
  const onSpeechProgress = vi.fn();
  const onComplete = vi.fn();
  const engine = new PlaybackEngine(scenes ?? [scene], actionEngine, player, {
    onSpeechStart,
    onSpeechProgress,
    onComplete,
    onError: vi.fn(),
  });
  return {
    engine, play, preloadNext, onSpeechStart, onSpeechProgress, onComplete,
    fail(error: Error | null) {
      active = false;
      if (error) rejectPlayback(error);
      else resolvePlayback(false);
    },
    startAudio() {
      active = true;
      playing = true;
      resolvePlayback(true);
    },
    advanceAudio(timeMs: number) { currentTimeMs = timeMs; },
    endAudio() {
      active = false;
      playing = false;
      onEnded?.();
    },
  };
}

describe('PlaybackEngine audio startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const settings = useSettingsStore.getState();
    vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
      ...settings,
      ttsProvidersConfig: {
        ...settings.ttsProvidersConfig,
        'browser-native-tts': { apiKey: '', baseUrl: '', enabled: false },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['failed download', new Error('Narration download failed'), 0],
    ['missing narration', null, 0],
    ['failed subtitle seek', new Error('Narration seek failed'), 0.4],
  ] as const)('retries the unheard speech after %s settles while paused', async (_label, error, startRatio) => {
    const { engine, play, fail, onSpeechStart, onComplete } = createPendingNarration();
    if (startRatio > 0) engine.playSpeechAt(0, startRatio);
    else engine.start();
    await vi.advanceTimersByTimeAsync(0);
    engine.pause();
    fail(error);
    await vi.advanceTimersByTimeAsync(0);

    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['首页第一句']);
    // The Play control resumes a paused engine or continues a failed idle cue.
    if (engine.getMode() === 'paused') engine.resume();
    else engine.continuePlayback();
    await vi.advanceTimersByTimeAsync(0);

    expect(play.mock.calls).toEqual([
      ['', '/first.wav', startRatio],
      ['', '/first.wav', startRatio],
    ]);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['首页第一句', '首页第一句']);
    expect(onComplete).not.toHaveBeenCalled();
    engine.stop();
  });

  it('waits for delayed playback before advancing subtitles or the next speech', async () => {
    const {
      engine, play, startAudio, advanceAudio, endAudio,
      onSpeechStart, onSpeechProgress, onComplete,
    } = createPendingNarration();
    engine.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(play).toHaveBeenCalledOnce();
    expect(onSpeechProgress.mock.calls).toEqual([[0]]);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['首页第一句']);
    expect(onComplete).not.toHaveBeenCalled();

    startAudio();
    await vi.advanceTimersByTimeAsync(0);
    advanceAudio(2_000);
    await vi.advanceTimersByTimeAsync(80);
    expect(onSpeechProgress).toHaveBeenLastCalledWith(0.2);
    expect(play).toHaveBeenCalledOnce();

    endAudio();
    await vi.advanceTimersByTimeAsync(0);
    expect(play).toHaveBeenLastCalledWith('', '/second.wav', 0);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['首页第一句', '下一句']);
    engine.stop();
  });

  it.each([
    ['same page', [{ id: 'next', type: 'speech', text: '下一句', audioUrl: '/next.mp3' }], [], '/next.mp3'],
    ['adjacent lecture page', [], [{ id: 'next-page', type: 'slide', actions: [{ id: 'next', type: 'speech', text: '下一页', audioUrl: '/next.mp3' }] }], '/next.mp3'],
    ['discussion', [{ id: 'discuss', type: 'discussion' }, { id: 'next', type: 'speech', text: '下一句', audioUrl: '/next.mp3' }], [], undefined],
    ['quiz gate', [], [{ id: 'quiz', type: 'quiz', actions: [{ id: 'next', type: 'speech', text: '测验', audioUrl: '/quiz.mp3' }] }], undefined],
    ['unprepared narration', [{ id: 'unprepared', type: 'speech', text: '尚未生成' }, { id: 'next', type: 'speech', text: '下一句', audioUrl: '/next.mp3' }], [], undefined],
    ['more distant page', [], [{ id: 'empty', type: 'slide', actions: [] }, { id: 'distant', type: 'slide', actions: [{ id: 'next', type: 'speech', text: '后续页', audioUrl: '/distant.mp3' }] }], undefined],
  ])('limits speculative audio to the next contiguous lecture segment: %s', async (_label, laterActions, laterScenes, expectedUrl) => {
    const { engine, startAudio, preloadNext } = createPendingNarration([
      { id: 'current', type: 'slide', actions: [
        { id: 'first', type: 'speech', text: '当前讲解', audioUrl: '/current.mp3' },
        ...laterActions,
      ] },
      ...laterScenes,
    ] as Scene[]);
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(preloadNext).not.toHaveBeenCalled();
    startAudio();
    await vi.advanceTimersByTimeAsync(0);
    expect(preloadNext).toHaveBeenCalledExactlyOnceWith(expectedUrl);
    engine.stop();
  });
});
