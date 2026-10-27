import { describe, expect, it } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { auditAndRepairGeneratedCourse } from './course-quality';
import { deriveTeachingConstraints } from '../pedagogy/teaching-constraints';

const outline: SceneOutline = {
  id: 'quiz-1', type: 'quiz', title: '理解检查', description: '检查核心概念', keyPoints: ['分类'],
  order: 0, stageKey: 'ai-learning', audience: 'student', knowledgePointIds: ['kp-1'],
};

describe('course quality audit', () => {
  it('repairs malformed quiz content before persistence', () => {
    const scene = {
      id: 'quiz-1', stageId: 'stage', order: 0, type: 'quiz', title: '理解检查', actions: [],
      content: { type: 'quiz', questions: [{ id: 'x', type: 'single', question: '说明分类依据' }] },
    } as unknown as Scene;
    const result = auditAndRepairGeneratedCourse([outline], [scene]);
    expect(result.scenes[0]?.content.type).toBe('quiz');
    if (result.scenes[0]?.content.type === 'quiz') {
      expect(result.scenes[0].content.questions[0]?.type).toBe('short_answer');
    }
    expect(result.report.corrections.length).toBeGreaterThan(0);
  });

  it('reports knowledge references outside the confirmed boundary', () => {
    const result = auditAndRepairGeneratedCourse([outline], [], deriveTeachingConstraints({
      grade: '高一', subject: '信息技术', topic: 'NLP', hours: 1,
      learningObjectives: ['理解分类'],
      knowledgePoints: [{ id: 'kp-2', name: '情感分析' }],
    }));
    expect(result.report.warnings.join('')).toContain('kp-1');
  });
});
