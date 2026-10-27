import { describe, expect, it } from 'vitest';
import { normalizeProgressUpdate } from './normalize-progress';

describe('normalizeProgressUpdate', () => {
  const validSceneIds = ['s1', 's2', 's3'];

  it('deduplicates, drops unknown ids, and uses the server scene count', () => {
    expect(normalizeProgressUpdate({
      validSceneIds,
      requestedCurrentSceneIndex: 99,
      requestedCompletedScenes: ['s1', 'fake', 's1'],
      previousCompletedScenes: [],
    })).toEqual({
      currentSceneIndex: 2,
      totalScenes: 3,
      completedScenes: ['s1'],
    });
  });

  it('does not allow a later client payload to erase completed scenes', () => {
    expect(normalizeProgressUpdate({
      validSceneIds,
      requestedCurrentSceneIndex: -4,
      requestedCompletedScenes: [],
      previousCompletedScenes: ['s1', 's2'],
    })).toEqual({
      currentSceneIndex: 0,
      totalScenes: 3,
      completedScenes: ['s1', 's2'],
    });
  });
});
