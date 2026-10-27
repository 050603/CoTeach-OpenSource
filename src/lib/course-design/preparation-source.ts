import type { ConfirmedPreparation } from '@/lib/collaborative-preparation/types';
import type { Course } from '@/lib/session/types';
import { fingerprintGenerationValue } from '@/lib/course-generation/page-checkpoints';
import type { ResourcePackageTeachingPoint } from './resource-package-knowledge';

export type PreparationIdentity = { sessionId: string; revision: number; fingerprint: string };

/** Older templates predate the explicit source discriminator. */
export function activeCourseResourcePackage(course: Pick<Course, 'content'>) {
  return course.content?.preparationSource === 'collaborative-preparation' ? undefined : course.content?.resourcePackage;
}

export function activeConfirmedPreparation(course: Pick<Course, 'content'>) {
  return course.content?.preparationSource === 'resource-package' ? undefined : course.content?.confirmedPreparation;
}

export function preparationIdentity(preparation?: ConfirmedPreparation): PreparationIdentity | undefined {
  return preparation ? { sessionId: preparation.sessionId, revision: preparation.revision,
    fingerprint: fingerprintGenerationValue(preparation) } : undefined;
}

export function hasCurrentPreparationSource(course: Pick<Course, 'content'>, expected?: PreparationIdentity): boolean {
  const current = activeConfirmedPreparation(course);
  if (!expected) return course.content?.preparationSource !== 'collaborative-preparation' && !current;
  return Boolean(current?.confirmedAt && preparationIdentity(current)?.fingerprint === expected.fingerprint
    && current.sessionId === expected.sessionId && current.revision === expected.revision);
}

export function assertCurrentPreparationSource(course: Pick<Course, 'content'>, expected?: PreparationIdentity): void {
  if (!hasCurrentPreparationSource(course, expected)) throw Object.assign(
    new Error('协同备课目标已经修改或切换，请使用最新确认方案生成，旧任务不会覆盖当前课程。'),
    { code: 'PREPARATION_SOURCE_CHANGED', isRetryable: false },
  );
}

export function preparationTeachingPoints(preparation?: ConfirmedPreparation): ResourcePackageTeachingPoint[] {
  return preparation?.plan.knowledgePoints.map((point) => ({ id: point.id, name: point.name,
    description: [`教学深度：${point.depth}`, `讲授方式：${point.teachingApproach}`].join('\n'),
    teachingRole: 'detail-concept' as const })) ?? [];
}

export function preparationTeachingContext(preparation?: ConfirmedPreparation): string {
  if (!preparation) return '';
  return `教师已确认的协同备课目标（教学要求，不是外部教材或已验证事实来源）：\n${JSON.stringify(preparation.plan)}`;
}
