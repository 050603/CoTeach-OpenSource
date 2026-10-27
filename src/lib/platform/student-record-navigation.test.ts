import { describe, expect, it } from "vitest";
import type { OfferingStudentSummary } from "./student-records";
import { defaultStudentNavigation, filterStudentRecords, readStudentNavigation, resolveStudentSelection, studentNavigationQuery } from "./student-record-navigation";

const students: OfferingStudentSummary[] = Array.from({ length: 25 }, (_, index) => ({
  id: `student-${index + 1}`, enrollmentId: `enrollment-${index + 1}`, username: `account-${index + 1}`,
  displayName: `学生${String(index + 1).padStart(2, "0")}`, status: "active", joinedAt: "2026-09-01T00:00:00.000Z",
  participated: index !== 0, completedOpenActivities: index % 2, openActivityCount: 1,
  classroomParticipationCount: 0, lastLearningAt: index ? "2026-10-26T00:00:00.000Z" : null,
  activityStatuses: { form: index % 2 ? "completed" : "not_started" },
  attentionReasons: index % 2 ? [] : ["incomplete_open_activity"],
}));

describe("student record navigation", () => {
  it("round-trips filters and a closed mobile profile while preserving valid deep links", () => {
    const state = { ...defaultStudentNavigation, query: "学生 23", activityId: "form", status: "completed" as const, attention: "participated" as const, sort: "name" as const, page: 2, student: "enrollment-23", tab: "classrooms" as const };
    expect(readStudentNavigation(new URLSearchParams(studentNavigationQuery(state)))).toEqual(state);
    expect(readStudentNavigation(new URLSearchParams("student=enrollment-23&tab=submissions")).view).toBe("detail");
    expect(readStudentNavigation(new URLSearchParams("page=Infinity&status=unknown&attention=unknown&sort=unknown&tab=unknown"))).toEqual(defaultStudentNavigation);
  });

  it("uses the selected student's actual page, clamps unavailable pages and clears empty results", () => {
    const linked = resolveStudentSelection(students, { ...defaultStudentNavigation, student: "enrollment-23", page: 1 });
    expect(linked.page).toBe(2);
    expect(linked.visible).toHaveLength(5);
    expect(linked.selected?.enrollmentId).toBe("enrollment-23");
    const clamped = resolveStudentSelection(students, { ...defaultStudentNavigation, page: 99, student: "removed-student" });
    expect(clamped.page).toBe(2);
    expect(clamped.selected?.enrollmentId).toBe("enrollment-21");
    expect(resolveStudentSelection([], { ...defaultStudentNavigation, page: 2, student: "enrollment-23" })).toMatchObject({ page: 1, pageCount: 1, selected: null, index: -1, visible: [] });
  });

  it("combines text, activity status and attention without changing the source list or completion denominator", () => {
    const sourceIds = students.map(student => student.enrollmentId);
    const result = filterStudentRecords(students, { ...defaultStudentNavigation, query: "ACCOUNT-2", activityId: "form", status: "not_started", attention: "incomplete_open_activity", sort: "completion" });
    expect(result.map(student => student.enrollmentId)).toEqual(["enrollment-21", "enrollment-23", "enrollment-25"]);
    expect(students.map(student => student.enrollmentId)).toEqual(sourceIds);
    expect(result.every(student => student.openActivityCount === 1 && student.completedOpenActivities === 0)).toBe(true);
    expect(filterStudentRecords(students, { ...defaultStudentNavigation, status: "not_started" }).map(student => student.enrollmentId)).toEqual(["enrollment-1"]);
  });
});
