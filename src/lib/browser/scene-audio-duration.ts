import type { Scene } from '@openmaic/lib/types/stage';

function audioDurationSec(url: string, signal: AbortSignal): Promise<number | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const finish = (duration?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      resolve(duration);
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 8_000);
    signal.addEventListener('abort', abort, { once: true });
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined);
    audio.onerror = abort;
    audio.src = url;
  });
}

/** Measure only missing durations, serially; incomplete audio is not a full-page measurement. */
export async function measuredSceneTtsDurationSec(scene: Scene, signal: AbortSignal): Promise<number | undefined> {
  const durations = new Map<string, number>();
  let total = 0;
  for (const action of scene.actions ?? []) {
    if (signal.aborted) return undefined;
    if (action.type !== 'speech' || !action.text.trim()) continue;
    let duration = action.audioDurationSec;
    if (!(typeof duration === 'number' && Number.isFinite(duration) && duration > 0)) {
      if (!action.audioUrl) return undefined;
      duration = durations.get(action.audioUrl) ?? await audioDurationSec(action.audioUrl, signal);
      if (!duration || signal.aborted) return undefined;
      durations.set(action.audioUrl, duration);
    }
    total += duration;
  }
  return total > 0 ? total : undefined;
}
