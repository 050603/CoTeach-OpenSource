import { describe, expect, it } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { isScenePlaybackExhausted } from './scene-completion';

function scene(actions: unknown[], id = 'scene-1'): Scene {
  return { id, actions } as unknown as Scene;
}

describe('isScenePlaybackExhausted', () => {
  it('does not treat an initial idle engine as completion', () => {
    expect(isScenePlaybackExhausted(scene([{ type: 'speech' }]), {
      engineMode: 'idle',
      snapshot: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: 'scene-1' },
    })).toBe(false);
  });

  it('requires an idle engine whose cursor consumed every real action', () => {
    expect(isScenePlaybackExhausted(scene([{ type: 'speech' }, { type: 'laser' }]), {
      engineMode: 'playing',
      snapshot: { sceneIndex: 0, actionIndex: 2, consumedDiscussions: [], sceneId: 'scene-1' },
    })).toBe(false);
    expect(isScenePlaybackExhausted(scene([{ type: 'speech' }, { type: 'laser' }]), {
      engineMode: 'idle',
      snapshot: { sceneIndex: 0, actionIndex: 2, consumedDiscussions: [], sceneId: 'scene-1' },
    })).toBe(true);
  });

  it('requires the synthetic dwell beat for a scene without actions', () => {
    expect(isScenePlaybackExhausted(scene([]), {
      engineMode: 'idle',
      snapshot: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: 'scene-1' },
    })).toBe(false);
    expect(isScenePlaybackExhausted(scene([]), {
      engineMode: 'idle',
      snapshot: { sceneIndex: 0, actionIndex: 1, consumedDiscussions: [], sceneId: 'scene-1' },
    })).toBe(true);
  });

  it('rejects a snapshot from another scene', () => {
    expect(isScenePlaybackExhausted(scene([{ type: 'speech' }]), {
      engineMode: 'idle',
      snapshot: { sceneIndex: 0, actionIndex: 1, consumedDiscussions: [], sceneId: 'other' },
    })).toBe(false);
  });
});
