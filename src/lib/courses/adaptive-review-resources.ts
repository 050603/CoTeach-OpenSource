import type { StudentAdaptiveLearningState } from '@/lib/session/types';

/** Only resources actually retained in this learner's saved path are reviewable. */
export function adaptiveReviewResources(state: StudentAdaptiveLearningState | undefined): Array<{
  insertionId: string;
  classroomId: string;
}> {
  return [
    ...(state?.branchRuns ?? []).map(run => ({ ...run, insertionId: run.id })),
    ...(state?.microLessons ?? []).map(lesson => ({ ...lesson, insertionId: `micro-lesson:${lesson.id}` })),
  ].flatMap(resource => (resource.status === 'ready' || resource.status === 'completed')
    && resource.classroomId && resource.insertionId
    ? [{ insertionId: resource.insertionId, classroomId: resource.classroomId }]
    : []);
}
