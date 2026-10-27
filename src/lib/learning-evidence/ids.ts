import type { LearningEvidenceKind } from "./types";

function recordId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 160);
}

export function learningEvidenceRecordId(input: {
  courseId: string;
  studentId: string;
  kind: LearningEvidenceKind;
  suffix?: string;
}): string {
  return recordId(
    ["evidence", input.courseId, input.studentId, input.kind, input.suffix]
      .filter(Boolean)
      .join("-"),
  );
}
