import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { applyDeepInteractionPolicy, suggestTeachingWidget } from './deep-interaction-policy';

function outline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-1',
    type: 'slide',
    title: 'How variables affect a model',
    description: 'Explain the relationship before students test it.',
    keyPoints: ['independent variable', 'dependent variable', 'causal pattern'],
    estimatedDuration: 120,
    targetDurationSec: 120,
    order: 1,
    stageKey: 'ai-learning',
    audience: 'student',
    generationPurpose: 'knowledge-teaching',
    parentActivityId: 'ai-module',
    knowledgePointIds: ['kp-1'],
    resourceTypes: ['ppt'],
    ...overrides,
  };
}

describe('deep interaction outline policy compatibility', () => {
  it('never manufactures interaction pages after model or teacher planning', () => {
    const planned = [
      outline({ id: 's1' }),
      outline({ id: 's2' }),
      outline({ id: 'quiz', type: 'quiz' }),
    ];

    expect(applyDeepInteractionPolicy(planned, 'generated')).toEqual(planned);
    expect(applyDeepInteractionPolicy(planned, 'confirmed')).toEqual(planned);
  });

  it('preserves a deliberately planned interaction without adding a duplicate', () => {
    const planned = [
      outline({ id: 'explanation' }),
      outline({
        id: 'practice',
        type: 'interactive',
        widgetType: 'simulation',
        widgetOutline: { concept: 'variable model' },
        resourceTypes: ['interactive-demo'],
      }),
    ];

    expect(applyDeepInteractionPolicy(planned)).toEqual(planned);
  });

  it('selects widgets from teaching affordance for explicit interactive planning', () => {
    const forTitle = (title: string) => outline({ title, description: title, keyPoints: [title] });

    expect(suggestTeachingWidget(forTitle('Python loop debugging practice')).widgetType).toBe('code');
    expect(suggestTeachingWidget(forTitle('Solar system spatial structure')).widgetType)
      .toBe('visualization3d');
    expect(suggestTeachingWidget(forTitle('Force and acceleration variable experiment')).widgetType)
      .toBe('simulation');
    expect(suggestTeachingWidget(forTitle('Classification rule challenge game')).widgetType)
      .toBe('game');
    expect(suggestTeachingWidget(forTitle('Causal relationships among concepts')).widgetType)
      .toBe('diagram');
  });
});
