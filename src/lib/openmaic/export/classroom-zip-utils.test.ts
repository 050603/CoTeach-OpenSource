import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { actionsToManifest, rewriteAudioRefsToIds } from './classroom-zip-utils';

describe('activity trigger serialization', () => {
  it('preserves activity gate metadata across classroom export and import', () => {
    const gate = {
      id: 'activity-gate',
      type: 'speech',
      text: '',
      title: 'Learner activity',
      activityPauseSec: 75,
      activityPausePurpose: 'interaction',
    } as unknown as Action;

    const manifest = actionsToManifest([gate], new Map());
    expect(manifest[0]).toMatchObject({
      activityPauseSec: 75,
      activityPausePurpose: 'interaction',
    });

    const restored = rewriteAudioRefsToIds(manifest, {});
    expect(restored[0]).toMatchObject({
      activityPauseSec: 75,
      activityPausePurpose: 'interaction',
    });
  });
});
