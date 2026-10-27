import { describe, expect, it } from "vitest";
import { hasValidProxyAuthClaims } from "./proxy-claims";

describe("hasValidProxyAuthClaims", () => {
  it("rejects a legacy teacher token without a session version", () => {
    expect(
      hasValidProxyAuthClaims({
        sub: "teacher-1",
        role: "teacher",
        username: "teacher",
        displayName: "教师",
      }),
    ).toBe(false);
  });

  it("accepts a current teacher token", () => {
    expect(
      hasValidProxyAuthClaims({
        sub: "teacher-1",
        role: "teacher",
        username: "teacher",
        displayName: "教师",
        sv: 1,
      }),
    ).toBe(true);
  });

  it("requires a student subject to match the student id", () => {
    expect(
      hasValidProxyAuthClaims({
        sub: "student-1",
        role: "student",
        courseId: "course-1",
        studentId: "student-2",
        studentName: "学生",
        sv: 1,
      }),
    ).toBe(false);
  });
});
