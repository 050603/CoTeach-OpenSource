/** Public, role-projected PBL evaluation contract. No private process records belong here. */
export type PblRubricDimension = { id: string; name: string; description: string; weight: number };
export type PblEvaluationConfig = {
  version: number;
  rubric: PblRubricDimension[];
  peerMode: "off" | "balanced" | "presenters-only" | "manual";
  reviewsPerStudent: number;
  anonymous: boolean;
};
export type PblEvaluationSource = "self" | "peer" | "teacher";
export type PblEvaluationAnswers = {
  dimensionScores: Record<string, number | null>;
  comment: string;
  evidence: string;
  strengths: string;
  improvements: string;
  learning: string;
  plan: string;
  finalScore: number | null;
  overrideReason: string;
};
export type PblEvaluationRecord = {
  id: string;
  participationId: string;
  source: PblEvaluationSource;
  assignmentId: string | null;
  evaluatorName?: string;
  version: number;
  status: "draft" | "submitted" | "returned";
  rubric: PblRubricDimension[];
  answers: PblEvaluationAnswers;
  suggestedScore: number | null;
  score: number | null;
  submittedAt: string | null;
  returnedReason: string | null;
  updatedAt: string;
  history: Array<{ version: number; status: string; answers: PblEvaluationAnswers; at: string }>;
};
export type PblArtifact = { versionId: string; title: string; sequence: number; sourceHtml: string | null; mimeType: string | null; submittedAt: string | null; fileUrl: string | null };
export type PblPeerAssignment = {
  id: string;
  reviewerParticipationId: string;
  targetParticipationId: string;
  targetName: string;
  reviewerName?: string;
  artifact: PblArtifact;
  evaluation: PblEvaluationRecord | null;
};
export type PblProcessReport = {
  evidenceThrough?: string | null;
  evidenceGaps?: string[];
  confidence?: "low" | "medium" | "high";
  source?: "llm" | "insufficient-evidence";
  id: string;
  generatedAt: string;
  summary: string;
  dimensions: Array<{ id: string; name: string; judgment: string; score: number | null; evidence: Array<{ id: string; label: string; detail: string }>; gaps: string[]; suggestion: string }>;
};
export type PblParticipantDossier = {
  participationId: string;
  studentId: string;
  name: string;
  artifacts: PblArtifact[];
  selfEvaluation: PblEvaluationRecord | null;
  peerEvaluations: PblEvaluationRecord[];
  teacherEvaluation: PblEvaluationRecord | null;
  processReport: PblProcessReport | null;
  published: { at: string; teacherEvaluation: PblEvaluationRecord | null; processReport: PblProcessReport | null } | null;
};
export type PblEvaluationSnapshot = {
  contractVersion: 2;
  role: "teacher" | "student";
  instanceId: string;
  stage: string;
  canWrite: boolean;
  canConfigureRubric: boolean;
  canPublish: boolean;
  config: PblEvaluationConfig;
  participants: PblParticipantDossier[];
  assignments: PblPeerAssignment[];
  completion: { total: number; selfSubmitted: number; peerAssigned: number; peerSubmitted: number; teacherSubmitted: number; published: number };
};
export type PblEvaluationCommand = (
  | { action: "config"; version: number; config: Omit<PblEvaluationConfig, "version"> }
  | { action: "assign"; pairs?: Array<{ reviewerParticipationId: string; targetParticipationId: string }> }
  | { action: "save" | "submit"; source: PblEvaluationSource; participationId: string; assignmentId?: string; version: number; answers: PblEvaluationAnswers }
  | { action: "return"; evaluationId: string; version: number; reason: string }
  | { action: "publish"; participationIds: string[]; includeTeacher: boolean; includeProcess: boolean }
) & { idempotencyKey: string };
export const DEFAULT_PBL_RUBRIC: PblRubricDimension[] = [
  { id: "knowledge", name: "知识应用", description: "准确理解并运用所学知识。", weight: 25 },
  { id: "problem-solving", name: "问题解决与成果质量", description: "分析问题、形成方案并验证作品。", weight: 25 },
  { id: "evidence", name: "证据论证", description: "使用可靠证据解释选择和结论。", weight: 25 },
  { id: "reflection", name: "表达与反思", description: "清楚表达思路，反思过程并提出改进。", weight: 25 },
];
export function emptyPblAnswers(rubric: PblRubricDimension[]): PblEvaluationAnswers {
  return { dimensionScores: Object.fromEntries(rubric.map(d => [d.id, null])), comment: "", evidence: "", strengths: "", improvements: "", learning: "", plan: "", finalScore: null, overrideReason: "" };
}
export function pblWeightedScore(rubric: PblRubricDimension[], scores: Record<string, number | null>): number | null {
  if (!rubric.length || rubric.some(d => scores[d.id] == null || !Number.isFinite(scores[d.id]))) return null;
  const weight = rubric.reduce((sum, d) => sum + d.weight, 0);
  return weight > 0 ? Math.round(rubric.reduce((sum, d) => sum + (scores[d.id] as number) * d.weight, 0) / weight * 100) / 100 : null;
}
