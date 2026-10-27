import { describe, expect, it } from 'vitest';
import { assertCompleteSceneGeneration } from './generation-completeness';

describe('assertCompleteSceneGeneration', () => {
  it('accepts a one-to-one outline/scene result', () => {
    expect(() => assertCompleteSceneGeneration({
      expectedCount: 3,
      generatedCount: 3,
      failedTitles: [],
      phase: 'content',
    })).not.toThrow();
  });

  it('fails with the missing page titles instead of publishing a partial course', () => {
    expect(() => assertCompleteSceneGeneration({
      expectedCount: 3,
      generatedCount: 2,
      failedTitles: ['Newton second law'],
      phase: 'content',
    })).toThrow('Newton second law');
  });
});
