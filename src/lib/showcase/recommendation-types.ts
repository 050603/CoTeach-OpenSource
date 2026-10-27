/** Teacher-only recommendation contract. Scores never become course grades. */
export type ShowcaseRecommendationReason = {
  kind: "quality" | "earliest" | "latest" | "ai-interactions";
  text: string;
  location?: string;
  quote?: string;
};

export type ShowcaseRecommendationCandidate = {
  studentId: string;
  studentName: string;
  artifactVersionId: string;
  artifactKind: "document" | "pdf";
  analysisStatus: "pending" | "running" | "complete" | "failed" | "unreadable";
  qualityScore?: number;
  reasons: ShowcaseRecommendationReason[];
  firstSubmittedAt?: string;
  aiRequestCount: number;
  analyzedArtifactVersionId?: string;
  analyzedAt?: string;
  analysisFreshness?: "exact" | "reused" | "minor-change" | "outdated" | "none";
  coverage?: ShowcaseAnalysisCoverage;
};

export type ShowcaseRecommendations = {
  courseId: string;
  targetCount: number;
  targetSource: "teacher" | "plan" | "default";
  recommendedStudentIds: string[];
  candidates: ShowcaseRecommendationCandidate[];
  pendingCount: number;
  updatedAt: string;
  revision: string;
};

export type ShowcaseQualityDimension = { id: string; name: string; description: string; weight: number };
export type ShowcaseEvidenceBlock = { location: string; text: string; heading?: boolean };
export type ShowcaseAnalysisCoverage = { mode: "full" | "sampled"; sourceCharacters: number; analyzedCharacters: number };
export type ShowcaseQualityAnalysis = {
  qualityScore: number;
  dimensionScores: Record<string, number>;
  reasons: ShowcaseRecommendationReason[];
  coverage?: ShowcaseAnalysisCoverage;
};
