import { describe, expect, it } from "vitest";
import { onlineStudentIds } from "@/lib/presence";

describe("onlineStudentIds", () => {
  it("counts students only and removes duplicate members", () => {
    expect(
      onlineStudentIds([
        { id: "teacher-1", role: "teacher", name: "教师" },
        { id: "student-1", role: "student", name: "学生一" },
        { id: "student-1", role: "student", name: "学生一" },
      ]),
    ).toEqual(new Set(["student-1"]));
  });
});
