import { describe, expect, it } from "vitest";
import { shouldDeliverMutationToStudent } from "./event-visibility";

describe("student realtime event visibility", () => {
  it("broadcasts shared teacher changes such as announcements and driving questions", () => {
    expect(shouldDeliverMutationToStudent(
      { actionType: "UPSERT_ANNOUNCEMENT", actorId: "teacher-1" },
      "student-2",
    )).toBe(true);
    expect(shouldDeliverMutationToStudent(
      { actionType: "UPDATE_COURSE", actorId: "teacher-1" },
      "student-2",
    )).toBe(true);
  });

  it("does not fan one student's frequent progress updates out to every peer", () => {
    expect(shouldDeliverMutationToStudent(
      { actionType: "UPDATE_STUDENT_PROGRESS", targetStudentId: "student-1" },
      "student-1",
    )).toBe(true);
    expect(shouldDeliverMutationToStudent(
      { actionType: "UPDATE_STUDENT_PROGRESS", targetStudentId: "student-1" },
      "student-2",
    )).toBe(false);

    const recipients = Array.from({ length: 30 }, (_, index) => `student-${index + 1}`)
      .filter((studentId) => shouldDeliverMutationToStudent(
        { actionType: "UPDATE_STUDENT_PROGRESS", targetStudentId: "student-1" },
        studentId,
      ));
    expect(recipients).toEqual(["student-1"]);
  });

  it("scopes direct adaptive and companion course updates to the affected student", () => {
    expect(shouldDeliverMutationToStudent(
      { actionType: "UPDATE_COURSE", scope: "student", targetStudentId: "student-1" },
      "student-1",
    )).toBe(true);
    expect(shouldDeliverMutationToStudent(
      { actionType: "UPDATE_COURSE", scope: "student", targetStudentId: "student-1" },
      "student-2",
    )).toBe(false);
  });
});
