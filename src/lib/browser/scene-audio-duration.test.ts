import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { measuredSceneTtsDurationSec } from './scene-audio-duration';

class MetadataAudio {
  static instances: MetadataAudio[] = [];
  src = '';
  preload = '';
  duration = 0;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  load = vi.fn();
  removeAttribute = vi.fn();
  constructor() { MetadataAudio.instances.push(this); }
  ready(duration: number) { this.duration = duration; this.onloadedmetadata?.(); }
}
const scene = (...actions: Array<{ audioUrl?: string; audioDurationSec?: number }>) => ({
  actions: actions.map((action, index) => ({ id: String(index), type: 'speech', text: '讲解', ...action })),
}) as Scene;

beforeEach(() => { MetadataAudio.instances = []; vi.stubGlobal('Audio', MetadataAudio); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('scene audio duration measurement', () => {
  it('uses saved durations without requesting audio', async () => {
    await expect(measuredSceneTtsDurationSec(scene({ audioDurationSec: 2 }, { audioDurationSec: 3 }), new AbortController().signal)).resolves.toBe(5);
    expect(MetadataAudio.instances).toHaveLength(0);
  });

  it('requests missing tracks one at a time and reuses repeated URLs', async () => {
    const pending = measuredSceneTtsDurationSec(scene({ audioUrl: '/a' }, { audioUrl: '/b' }, { audioUrl: '/a' }), new AbortController().signal);
    expect(MetadataAudio.instances).toHaveLength(1);
    MetadataAudio.instances[0].ready(2);
    await vi.waitFor(() => expect(MetadataAudio.instances).toHaveLength(2));
    MetadataAudio.instances[1].ready(3);
    await expect(pending).resolves.toBe(7);
    expect(MetadataAudio.instances).toHaveLength(2);
  });

  it('releases an in-flight track and stops further requests on navigation', async () => {
    const controller = new AbortController();
    const pending = measuredSceneTtsDurationSec(scene({ audioUrl: '/a' }, { audioUrl: '/b' }), controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(MetadataAudio.instances).toHaveLength(1);
    expect(MetadataAudio.instances[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(MetadataAudio.instances[0].load).toHaveBeenCalledOnce();
  });

  it('does not report a partial duration after a stalled metadata request', async () => {
    vi.useFakeTimers();
    const pending = measuredSceneTtsDurationSec(scene({ audioDurationSec: 3 }, { audioUrl: '/stalled' }), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toBeUndefined();
  });
});
