import { describe, expect, it, vi } from 'vitest';
import type { ConfirmedPreparation } from '@/lib/collaborative-preparation/types';
import { emptyResourcePackageDraft } from '@/lib/resource-package/types';
import { createPblTemplateCourse, decodePblTemplate, encodePblTemplate } from '@/lib/platform/pbl-template';
import { withoutPrivatePackageContent } from '@/lib/resource-package/privacy';
import { getCourseStageRequirements } from '@/lib/resource-package/course-requirements';
import { knowledgeLectureBudgetBounds } from '@/lib/classroom/knowledge-lecture-budget';
import { activeCourseResourcePackage, hasCurrentPreparationSource, preparationIdentity, preparationTeachingPoints } from './preparation-source';
import { buildCourseTeachingRequirements } from './teaching-requirements';
import { isSameCourseDesignRequest } from './resume-policy';

const modelCall = vi.hoisted(() => vi.fn());
vi.mock('@/lib/llm/client', () => ({ callLLM: modelCall, parseLLMJson: JSON.parse }));
vi.mock('@/lib/teaching-ai/support-engine', () => ({ generateProjectSkeleton: vi.fn() }));

function confirmed(): ConfirmedPreparation {
  const draft = emptyResourcePackageDraft();
  return { sessionId: 'preparation-1', revision: 3, confirmedAt: '2026-10-23T01:00:00Z', confirmedBy: 'teacher-1',
    referenceIds: [], textbookSelections: [], plan: {
      courseName: '校园节能', subject: '科学', grade: '初中一年级', totalMinutes: 45, learnerContext: '知道常见电器',
      learningObjectives: ['能以证据比较电器能耗'], knowledgePoints: [{ id: 'energy', name: '能耗', depth: '理解功率与使用时间的关系', teachingApproach: '比较校园电器实例' }],
      teachingApproach: '从真实案例推理', teacherRequirements: ['保留单位换算过程'],
      stagePlan: { schemaVersion: 2, source: 'collaborative-preparation', drivingQuestion: '如何减少校园用电？', projectTask: '提出个人节能方案',
        totalMinutes: 45, lessonCount: 1, minutesPerLesson: 45,
        stages: draft.stages.map((stage, index) => ({ ...stage, durationMin: [5, 20, 10, 5, 5][index], requirements: '完成阶段任务', outputs: '有依据的方案' })),
        evaluationCriteria: '推理有证据', reflectionQuestions: ['哪个证据改变了你的判断？'] },
    } };
}

describe('confirmed collaborative preparation generation source', () => {
  it('projects exact confirmed minutes, goals and teaching depth without asking the seed model to infer them', async () => {
    const { applyConfirmedPreparationGenerationInput, inferCourseSeed, buildKnowledgePlanningCapacity } = await import('./job-runner');
    const preparation = confirmed();
    const course = applyConfirmedPreparationGenerationInput(createPblTemplateCourse('course-1'), preparation);
    const seed = await inferCourseSeed(course, { courseId: course.id, teacherBrief: '', confirmedPreparation: preparation }, new AbortController().signal);
    expect(seed).toMatchObject({ grade: '初中一年级', hours: 0.75, learningObjectives: preparation.plan.learningObjectives });
    expect(modelCall).not.toHaveBeenCalled();
    expect(course.content.resourcePackage).toBeUndefined();
    expect(course.content.stagePlan).toEqual(preparation.plan.stagePlan);
    expect(course.content.teacherRequiredKnowledgePoints).toEqual(['能耗']);
    expect(buildKnowledgePlanningCapacity({ courseHours: course.hours, stagePlan: course.content.stagePlan })).toMatchObject({
      durationSource: 'collaborative-preparation', planningDurationMin: 20, durationRangeMin: 20, durationRangeMax: 20,
    });
    expect(preparationTeachingPoints(preparation)[0].description).toContain('理解功率与使用时间的关系');
  }, 15_000);

  it('retains confirmed project requirements and a fixed knowledge budget for the new source', () => {
    const preparation = confirmed();
    const course = createPblTemplateCourse('course-1', { content: { ...createPblTemplateCourse('seed').content, stagePlan: preparation.plan.stagePlan } });
    expect(getCourseStageRequirements(course, 'make')).toMatchObject({ drivingQuestion: '如何减少校园用电？', projectTask: '提出个人节能方案', evaluationCriteria: '推理有证据' });
    expect(knowledgeLectureBudgetBounds(0.75, preparation.plan.stagePlan)).toMatchObject({ minMinutes: 20, maxMinutes: 20, source: 'collaborative-preparation' });
    const requirements = buildCourseTeachingRequirements({ confirmedPreparation: preparation });
    expect(requirements.items.find((item) => item.text.includes('能耗'))).toMatchObject({ source: 'teacher', sourceKnowledgePointIds: ['energy'], responsibility: 'instruction' });
    expect(requirements.items.some((item) => item.text === '保留单位换算过程')).toBe(true);
  });

  it('invalidates old requests when the plan changes, confirmation is cleared, or the active source switches', () => {
    const preparation = confirmed();
    const course = createPblTemplateCourse('course-1');
    course.content.preparationSource = 'collaborative-preparation';
    course.content.confirmedPreparation = preparation;
    const identity = preparationIdentity(preparation);
    expect(hasCurrentPreparationSource(course, identity)).toBe(true);
    expect(hasCurrentPreparationSource(course)).toBe(false);
    course.content.confirmedPreparation = { ...preparation, plan: { ...preparation.plan, totalMinutes: 90 } };
    expect(hasCurrentPreparationSource(course, identity)).toBe(false);
    course.content.confirmedPreparation = undefined;
    expect(hasCurrentPreparationSource(course, identity)).toBe(false);
    course.content.confirmedPreparation = preparation;
    course.content.preparationSource = 'resource-package';
    expect(hasCurrentPreparationSource(course, identity)).toBe(false);
    expect(hasCurrentPreparationSource(course)).toBe(true);
    const request = { courseId: course.id, teacherBrief: '', confirmedPreparation: preparation };
    expect(isSameCourseDesignRequest(request, { ...request, confirmedPreparation: { ...preparation, revision: 4 } })).toBe(false);
  });

  it('persists the private confirmation in templates while excluding it from student snapshots', () => {
    const course = createPblTemplateCourse('course-1');
    course.content.preparationSource = 'collaborative-preparation';
    course.content.confirmedPreparation = confirmed();
    course.content.stagePlan = course.content.confirmedPreparation.plan.stagePlan;
    course.content.resourcePackage = { schemaVersion: 2, id: 'old-package', revision: 1,
      source: { id: 'zip', fileName: '保留旧包.zip', url: '/private/zip' }, documents: {}, draft: emptyResourcePackageDraft() };
    expect(activeCourseResourcePackage(course)).toBeUndefined();
    expect(decodePblTemplate(encodePblTemplate(course))?.content.confirmedPreparation).toEqual(course.content.confirmedPreparation);
    const publicContent = withoutPrivatePackageContent(course.content);
    expect(publicContent.confirmedPreparation).toBeUndefined();
    expect(publicContent.resourcePackage).toBeUndefined();
    expect(publicContent.stagePlan).toEqual(course.content.stagePlan);
    expect(course.content.resourcePackage.id).toBe('old-package');
  });
});
