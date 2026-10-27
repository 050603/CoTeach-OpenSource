export const PROCESS_DIMENSIONS = [
  { id: "knowledge-application", name: "知识理解与应用" },
  { id: "inquiry-validation", name: "问题分析与求证" },
  { id: "iteration-improvement", name: "迭代与改进" },
  { id: "ai-judgment", name: "AI 协作与自主判断" },
] as const;

export type PblProcessEvidence = {
  id: string;
  kind: "quiz" | "learning-dialogue" | "practice-dialogue" | "saved-version" | "artifact" | "presentation" | "reflection";
  stageKey: string;
  occurredAt: string;
  title: string;
  actor: "student" | "ai" | "system";
  content: string;
  /** Only server-verified associations belong here. Temporal proximity is not causation. */
  relatedEvidenceIds: string[];
  limitations: string[];
};

export type RawPblProcessReport = {
  schemaVersion: 1;
  id: string;
  instanceId: string;
  participationId: string;
  studentId: string;
  stageKey: string;
  generatedAt: string;
  snapshotAt: string;
  evidenceThrough: string | null;
  fingerprint: string;
  summary: string;
  dimensions: Array<{
    dimensionId: string;
    name: string;
    score: number | null;
    rationale: string;
    evidenceIds: string[];
    evidenceGaps: string[];
    improvements: string[];
  }>;
  evidence: PblProcessEvidence[];
  evidenceGaps: string[];
  confidence: "low" | "medium" | "high";
  source: "llm" | "insufficient-evidence";
};

export type ProcessEvaluationSnapshot = {
  reports: RawPblProcessReport[];
  jobs: Array<{ id: string; participationId: string; status: string; error?: string; updatedAt: string }>;
  participants: Array<{ participationId: string; studentId: string; name: string }>;
};
