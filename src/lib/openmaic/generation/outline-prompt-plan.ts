import { PROMPT_IDS } from '@openmaic/lib/prompts';
import type { PromptId } from '@openmaic/lib/prompts/types';
import type {
  CourseGenerationMode,
  UserRequirements,
} from '@openmaic/lib/types/generation';

export type OutlinePromptPlan = {
  promptId: PromptId;
  generationMode: CourseGenerationMode;
  deepInteractionMode: boolean;
};

export function resolveCourseGenerationMode(
  requirements: Pick<UserRequirements, 'generationMode' | 'interactiveMode'>,
): CourseGenerationMode {
  if (requirements.generationMode === 'deep-interaction') return 'deep-interaction';
  if (requirements.generationMode === 'standard') return 'standard';
  return requirements.interactiveMode === true ? 'deep-interaction' : 'standard';
}

/** Keep prompt selection and conditional mode variables identical in streaming and batch generation. */
export function resolveOutlinePromptPlan(
  requirements: Pick<
    UserRequirements,
    'pblProfile' | 'generationMode' | 'interactiveMode'
  >,
  taskEngineMode = false,
): OutlinePromptPlan {
  const generationMode = resolveCourseGenerationMode(requirements);
  const deepInteractionMode = generationMode === 'deep-interaction';
  const promptId = requirements.pblProfile?.generationTemplate === 'pbl-six-stage'
    ? PROMPT_IDS.PBL_COURSE
    : taskEngineMode
      ? PROMPT_IDS.TASK_ENGINE_OUTLINES
      : deepInteractionMode
        ? PROMPT_IDS.INTERACTIVE_OUTLINES
        : PROMPT_IDS.REQUIREMENTS_TO_OUTLINES;

  return { promptId, generationMode, deepInteractionMode };
}
