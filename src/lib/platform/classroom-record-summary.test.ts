import { describe, expect, it } from "vitest";
import { hasFinalClassroomOutput, teacherEvaluationSummary } from "./classroom-record-summary";

const teacher = (type: string, result: unknown) => ({ evaluatorType: "TEACHER", type, result });
describe("classroom teacher evaluation summary", () => {
  it("keeps draft observations and process-only publication pending", () => {
    expect(teacherEvaluationSummary([
      teacher("PBL_TEACHER", { status: "draft" }),
      teacher("PBL_PUBLICATION", { at: "2026-10-26", teacherEvaluation: null, processReport: { id: "report" } }),
      { evaluatorType: "PEER", type: "PBL_PEER", result: { status: "submitted" } },
    ], true)).toEqual({ teacherStatus: "draft", published: true, publishedTeacher: false, pending: true });
  });
  it("distinguishes a returned draft from a previously published final grade", () => {
    expect(teacherEvaluationSummary([
      teacher("PBL_TEACHER", { status: "draft" }),
      teacher("PBL_PUBLICATION", { at: "2026-10-26", teacherEvaluation: { status: "submitted" } }),
    ], true)).toEqual({ teacherStatus: "draft", published: true, publishedTeacher: true, pending: true });
  });
  it("requires actual submission for new evaluations and preserves legacy teacher grades", () => {
    expect(teacherEvaluationSummary([teacher("PBL_TEACHER", { status: "submitted" })], true)).toEqual({ teacherStatus: "submitted", published: false, publishedTeacher: false, pending: false });
    expect(teacherEvaluationSummary([teacher("FORMATIVE", null)], true).teacherStatus).toBe("submitted");
    expect(teacherEvaluationSummary([teacher("PBL_PUBLICATION", { teacherEvaluation: { status: "submitted" } })], true)).toEqual({ teacherStatus: "none", published: false, publishedTeacher: false, pending: true });
  });
  it("does not request evaluation for a workspace draft or a version without a submission time", () => {
    const hasFinalOutput = hasFinalClassroomOutput({ submissions: [], artifacts: [{ versions: [{ status: "DRAFT", submittedAt: new Date() }, { status: "SUBMITTED", submittedAt: null }] }] });
    expect(hasFinalOutput).toBe(false);
    expect(teacherEvaluationSummary([], hasFinalOutput).pending).toBe(false);
    expect(hasFinalClassroomOutput({ submissions: [{ status: "SUBMITTED", submittedAt: new Date() }], artifacts: [] })).toBe(true);
  });
});
