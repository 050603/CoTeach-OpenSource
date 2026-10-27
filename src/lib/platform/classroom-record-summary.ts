type EvaluationRecord = { evaluatorType: string; type?: string; result?: unknown };
type FinalOutput = {
  submissions: Array<{ status: string; submittedAt: Date | null }>;
  artifacts: Array<{ versions: Array<{ status: string; submittedAt: Date | null }> }>;
};

const FINAL_STATUSES = new Set(["SUBMITTED", "COMPLETED", "PUBLISHED", "READY"]);

export function isFinalClassroomSubmission(record: { status: string; submittedAt: Date | null }) {
  return FINAL_STATUSES.has(record.status.toUpperCase()) && Boolean(record.submittedAt);
}

export function hasFinalClassroomOutput(participation: FinalOutput) {
  return participation.submissions.some(isFinalClassroomSubmission)
    || participation.artifacts.some((artifact) => artifact.versions.some(isFinalClassroomSubmission));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isSubmittedTeacherEvaluation(evaluation: EvaluationRecord): boolean {
  if (evaluation.evaluatorType.toUpperCase() !== "TEACHER") return false;
  if (!evaluation.type?.startsWith("PBL_")) return true;
  // Observation drafts and publication receipts do not replace a submitted grade.
  return evaluation.type === "PBL_TEACHER" && object(evaluation.result).status === "submitted";
}

export type TeacherEvaluationSummary = {
  teacherStatus: "none" | "draft" | "submitted";
  published: boolean;
  publishedTeacher: boolean;
  pending: boolean;
};

export function teacherEvaluationSummary(evaluations: EvaluationRecord[], hasFinalOutput: boolean): TeacherEvaluationSummary {
  const submitted = evaluations.some(isSubmittedTeacherEvaluation);
  const draft = evaluations.some((evaluation) => evaluation.evaluatorType.toUpperCase() === "TEACHER"
    && evaluation.type === "PBL_TEACHER" && object(evaluation.result).status === "draft");
  const publications = evaluations.filter((evaluation) => evaluation.evaluatorType.toUpperCase() === "TEACHER"
    && evaluation.type === "PBL_PUBLICATION" && typeof object(evaluation.result).at === "string");
  return {
    teacherStatus: submitted ? "submitted" : draft ? "draft" : "none",
    published: publications.length > 0,
    publishedTeacher: publications.some((evaluation) => object(object(evaluation.result).teacherEvaluation).status === "submitted"),
    pending: hasFinalOutput && !submitted,
  };
}
