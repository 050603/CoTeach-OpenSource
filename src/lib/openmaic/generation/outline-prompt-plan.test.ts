import { describe, expect, it } from 'vitest';
import { PROMPT_IDS } from '@openmaic/lib/prompts';
import {
  resolveCourseGenerationMode,
  resolveOutlinePromptPlan,
} from './outline-prompt-plan';

describe('resolveOutlinePromptPlan', () => {
  it('uses standard planning by default', () => {
    expect(resolveOutlinePromptPlan({})).toEqual({
      promptId: PROMPT_IDS.REQUIREMENTS_TO_OUTLINES,
      generationMode: 'standard',
      deepInteractionMode: false,
    });
  });

  it('selects the interactive-first prompt only for deep-interaction mode', () => {
    expect(resolveOutlinePromptPlan({ generationMode: 'deep-interaction' })).toEqual({
      promptId: PROMPT_IDS.INTERACTIVE_OUTLINES,
      generationMode: 'deep-interaction',
      deepInteractionMode: true,
    });
  });

  it('keeps structured PBL routing while exposing its selected strategy to the prompt', () => {
    expect(resolveOutlinePromptPlan({
      generationMode: 'deep-interaction',
      pblProfile: { generationTemplate: 'pbl-six-stage' } as never,
    })).toEqual({
      promptId: PROMPT_IDS.PBL_COURSE,
      generationMode: 'deep-interaction',
      deepInteractionMode: true,
    });
  });

  it('accepts the upstream interactiveMode flag for backward compatibility', () => {
    expect(resolveCourseGenerationMode({ interactiveMode: true })).toBe('deep-interaction');
    expect(resolveCourseGenerationMode({ interactiveMode: false })).toBe('standard');
  });

  it('does not let task-engine selection erase the mode variables', () => {
    expect(resolveOutlinePromptPlan({ generationMode: 'deep-interaction' }, true)).toEqual({
      promptId: PROMPT_IDS.TASK_ENGINE_OUTLINES,
      generationMode: 'deep-interaction',
      deepInteractionMode: true,
    });
  });
});
