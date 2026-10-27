export type PblKnowledgePointReference = {
  id: string;
  name?: string;
};

export type PblDetailKnowledgeInput = {
  id?: string;
  title?: string;
  stageKey?: string;
  knowledgePointIds?: string[];
};

export type PblKnowledgeIssue = {
  code: 'unknown-knowledge-point' | 'missing-knowledge-reference' | 'missing-knowledge-coverage';
  outlineId?: string;
  title?: string;
  knowledgePointIds?: string[];
  message: string;
};

export type PblKnowledgeValidationResult = {
  valid: boolean;
  issues: PblKnowledgeIssue[];
  referencedPointIds: string[];
  unreferencedPointIds: string[];
  coverageRatio: number;
};

/**
 * Validate second-level outline references against the teacher-confirmed
 * knowledge catalog. IDs, rather than generated wording, are the source of
 * truth so a model cannot silently drift to a nearby but different concept.
 */
export function validatePblKnowledgeAlignment(
  details: ReadonlyArray<PblDetailKnowledgeInput>,
  knowledgePoints: ReadonlyArray<PblKnowledgePointReference>,
  options: { requireReferences?: boolean; requireCoverage?: boolean } = {},
): PblKnowledgeValidationResult {
  const knownIds = new Set(knowledgePoints.map((point) => point.id).filter(Boolean));
  const referenced = new Set<string>();
  const issues: PblKnowledgeIssue[] = [];

  for (const detail of details) {
    const ids = Array.from(new Set((detail.knowledgePointIds ?? []).filter(Boolean)));
    const unknownIds = ids.filter((id) => !knownIds.has(id));
    unknownIds.forEach((id) => referenced.add(id));
    ids.filter((id) => knownIds.has(id)).forEach((id) => referenced.add(id));

    if (unknownIds.length > 0) {
      issues.push({
        code: 'unknown-knowledge-point',
        outlineId: detail.id,
        title: detail.title,
        knowledgePointIds: unknownIds,
        message: `细化内容“${detail.title || '未命名内容'}”关联了 ${unknownIds.length} 个已失效的知识点，请重新选择。`,
      });
    }

    if (options.requireReferences && ids.length === 0) {
      issues.push({
        code: 'missing-knowledge-reference',
        outlineId: detail.id,
        title: detail.title,
        message: `细化内容“${detail.title || '未命名内容'}”尚未关联备课阶段确认的知识点。`,
      });
    }
  }

  const referencedKnownIds = knowledgePoints
    .map((point) => point.id)
    .filter((id) => referenced.has(id));
  const unreferencedPointIds = knowledgePoints
    .map((point) => point.id)
    .filter((id) => !referenced.has(id));

  if (options.requireCoverage && unreferencedPointIds.length > 0) {
    issues.push({
      code: 'missing-knowledge-coverage',
      knowledgePointIds: unreferencedPointIds,
      message: `课程大纲尚未覆盖以下已确认知识点：${unreferencedPointIds.map((id) => knowledgePoints.find((point) => point.id === id)?.name || "未命名知识点").join('、')}`,
    });
  }

  return {
    valid: !issues.some(
      (issue) =>
        issue.code === 'unknown-knowledge-point' ||
        issue.code === 'missing-knowledge-coverage',
    ),
    issues,
    referencedPointIds: referencedKnownIds,
    unreferencedPointIds,
    coverageRatio: knowledgePoints.length > 0 ? referencedKnownIds.length / knowledgePoints.length : 1,
  };
}
