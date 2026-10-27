import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { Stage } from '@openmaic/lib/types/stage';
import type { StageStore } from './stage-api-types';
import { createWhiteboardAPI, whiteboardIdForScene } from './stage-api-whiteboard';

function createStore() {
  let state = {
    stage: { id: 'stage-1', name: '课堂', whiteboard: [] } as unknown as Stage,
    scenes: [],
    currentSceneId: 'scene-1' as string | null,
    mode: 'playback' as const,
  };
  const store: StageStore = {
    getState: () => state,
    setState: (partial) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
  };
  return { store, getState: () => state };
}

describe('scene-scoped whiteboards', () => {
  it('keeps each page board isolated while preserving earlier page content', () => {
    const { store, getState } = createStore();
    const api = createWhiteboardAPI(store);
    const firstId = whiteboardIdForScene('scene-1')!;
    const secondId = whiteboardIdForScene('scene-2')!;
    const first = api.get(firstId);
    expect(first.data?.elements).toEqual([]);

    api.addElement({ id: 'note-1', type: 'text' } as PPTElement, firstId);
    const second = api.get(secondId);

    expect(second.data?.elements).toEqual([]);
    expect(getState().stage.whiteboard).toHaveLength(2);
    expect(api.get(firstId).data?.elements.map((item) => item.id)).toEqual(['note-1']);
  });

  it('returns the same board when a scene is revisited', () => {
    const { store } = createStore();
    const api = createWhiteboardAPI(store);
    const id = whiteboardIdForScene('scene-1')!;

    expect(api.get(id).data?.id).toBe(id);
    expect(api.get(id).data?.id).toBe(id);
    expect(api.list().data).toHaveLength(1);
  });
});
