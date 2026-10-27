import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { applyCourseUpdate } from "./course-update";

describe("applyCourseUpdate", () => {
  it("always advances the course version timestamp", () => {
    const course = {
      id: "course-1",
      updatedAt: "2026-07-23T00:00:00.000Z",
      aiLearningProgress: {},
    } as Course;

    const updated = applyCourseUpdate(
      course,
      (current) => ({
        ...current,
        aiLearningProgress: { student: {} as never },
      }),
      "2026-07-23T00:00:10.000Z",
    );

    expect(updated.updatedAt).toBe("2026-07-23T00:00:10.000Z");
    expect(updated.aiLearningProgress).toHaveProperty("student");
  });
});
