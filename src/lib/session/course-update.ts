import type { Course } from "@/lib/session/types";

export function applyCourseUpdate(
  course: Course,
  updater: (course: Course) => Course,
  updatedAt = new Date().toISOString(),
): Course {
  return {
    ...updater(course),
    updatedAt,
  };
}
