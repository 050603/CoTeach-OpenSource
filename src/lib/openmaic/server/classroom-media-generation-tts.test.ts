import { describe, expect, it } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { isStudentNarratedScene } from './classroom-media-generation';

function routedScene(overrides: Partial<Scene>): Scene {
  return {
    id: 'scene-1',
    title: '测试场景',
    description: '',
    type: 'slide',
    order: 0,
    actions: [],
    ...overrides,
  } as unknown as Scene;
}

describe('isStudentNarratedScene', () => {
  it('includes on-demand knowledge micro-lessons in proposal and make', () => {
    expect(isStudentNarratedScene(routedScene({
      audience: 'student',
      generationPurpose: 'knowledge-teaching',
      stageKey: 'proposal',
      ttsPolicy: 'target-duration',
    }))).toBe(true);
    expect(isStudentNarratedScene(routedScene({
      audience: 'student',
      generationPurpose: 'knowledge-teaching',
      stageKey: 'make',
      ttsPolicy: 'target-duration',
    }))).toBe(true);
  });

  it('keeps teacher resources and explicitly silent scenes out of TTS', () => {
    expect(isStudentNarratedScene(routedScene({
      audience: 'teacher',
      generationPurpose: 'teacher-resource',
      stageKey: 'proposal',
    }))).toBe(false);
    expect(isStudentNarratedScene(routedScene({
      audience: 'student',
      generationPurpose: 'knowledge-teaching',
      stageKey: 'make',
      ttsPolicy: 'none',
    }))).toBe(false);
  });
});
