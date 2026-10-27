import { describe, expect, it } from 'vitest';
import { shouldPollClassroomAssets } from './resource-player-policy';

describe('shouldPollClassroomAssets', () => {
  it('polls only while background assets are running', () => {
    expect(shouldPollClassroomAssets(undefined)).toBe(false);
    expect(shouldPollClassroomAssets('running')).toBe(true);
    expect(shouldPollClassroomAssets('completed')).toBe(false);
    expect(shouldPollClassroomAssets('partial-failure')).toBe(false);
  });
});
