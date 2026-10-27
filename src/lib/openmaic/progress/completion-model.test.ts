import { describe, expect, it } from 'vitest';
import { AI_PROGRESS_COMPLETION_MODEL_VERSION, isReliableAiProgress } from './completion-model';

describe('AI progress completion model version', () => {
  it('rejects legacy progress produced by enter-equals-complete tracking', () => {
    expect(isReliableAiProgress({ masteryLevel: 'completed' })).toBe(false);
    expect(isReliableAiProgress({ completionModelVersion: 1, masteryLevel: 'completed' })).toBe(false);
    expect(isReliableAiProgress({
      completionModelVersion: AI_PROGRESS_COMPLETION_MODEL_VERSION,
      masteryLevel: 'completed',
    })).toBe(true);
  });
});
