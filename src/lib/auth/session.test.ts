// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import {
  clearAuthCookies,
  readAuthFromRequest,
  signStudentToken,
  signTeacherToken,
} from "./session";

const originalSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalSecret;
  }
});

describe("readAuthFromRequest", () => {
  it("selects the student session when teacher and student cookies coexist", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const teacher = await signTeacherToken({
      teacherId: "teacher-1",
      username: "teacher",
      displayName: "Teacher",
      sessionVersion: 1,
    });
    const student = await signStudentToken({
      courseId: "course-1",
      studentId: "student-1",
      studentName: "Student",
      sessionVersion: 1,
    });
    const request = new Request("http://localhost/api/chat/companion", {
      headers: {
        cookie: `${teacher.cookieName}=${teacher.token}; ${student.cookieName}=${student.token}`,
      },
    });

    const claims = await readAuthFromRequest(request, "student");

    expect(claims?.role).toBe("student");
    expect(claims?.sub).toBe("student-1");
  });

  it("does not fall back to a teacher cookie for a student-scoped request", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const teacher = await signTeacherToken({
      teacherId: "teacher-1",
      username: "teacher",
      displayName: "Teacher",
      sessionVersion: 1,
    });
    const request = new Request("http://localhost/api/session", {
      headers: {
        cookie: `${teacher.cookieName}=${teacher.token}`,
      },
    });

    await expect(readAuthFromRequest(request, "student")).resolves.toBeNull();
  });

  it("clears only the requested role cookie", () => {
    expect(clearAuthCookies("student").map((cookie) => cookie.name)).toEqual([
      "openpbl_student",
    ]);
    expect(clearAuthCookies("teacher").map((cookie) => cookie.name)).toEqual([
      "openpbl_teacher",
    ]);
    expect(clearAuthCookies().map((cookie) => cookie.name)).toEqual([
      "openpbl_teacher",
      "openpbl_student",
    ]);
  });
});
