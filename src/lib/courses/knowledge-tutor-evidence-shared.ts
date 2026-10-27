import type { CourseContent } from '@/lib/session/types';
import type { QuizQuestion } from '@openmaic/lib/types/stage';
import type { CourseEvidenceItem } from '@/lib/textbook/course-evidence-types';

export type TutorEvidence = {
  version?: number; fingerprint?: string;
  items: Array<Pick<CourseEvidenceItem, 'id' | 'content' | 'source' | 'completeSourceBlocks'>>;
  authoredQuotes: Array<{ unitId: string; quotes: string[] }>;
};
export function knowledgeTutorEvidence(content: Partial<CourseContent>, knowledgePointIds: readonly string[], unitIds: readonly string[] = []): TutorEvidence {
  const points = (content.knowledgePoints ?? []).filter(point => knowledgePointIds.includes(point.id));
  const evidenceIds = new Set<string>();
  for (const point of points) {
    if (point.evidenceItemIds !== undefined) {
      for (const id of point.evidenceItemIds) evidenceIds.add(id);
    } else {
      const sourceIds = new Set([point.id, point.sourceId, ...(point.sourceKnowledgePointIds ?? [])].filter(Boolean));
      for (const mapping of content.courseEvidence?.mappings ?? []) {
        if (sourceIds.has(mapping.sourceKnowledgePointId)) for (const id of mapping.evidenceItemIds) evidenceIds.add(id);
      }
    }
  }
  const units = (content.teachingBlueprint?.sections ?? []).flatMap(section => section.units)
    .filter(unit => unitIds.includes(unit.id) || unit.knowledgePointIds?.some(id => knowledgePointIds.includes(id)));
  return {
    version: content.courseEvidence?.version, fingerprint: content.courseEvidence?.fingerprint,
    items: (content.courseEvidence?.items ?? []).filter(item => evidenceIds.has(item.id))
      .map(({ id, content: body, source, completeSourceBlocks }) => ({ id, content: body, source, completeSourceBlocks })),
    authoredQuotes: units.filter(unit => unit.evidenceQuotes?.length).map(unit => ({ unitId: unit.id, quotes: unit.evidenceQuotes })),
  };
}

/** Keep this exact wire order compatible with immutable submission fingerprints. */
export function authoredQuestionFingerprintInput(question: QuizQuestion, evidence: TutorEvidence): string {
  return JSON.stringify({ question, evidence });
}
