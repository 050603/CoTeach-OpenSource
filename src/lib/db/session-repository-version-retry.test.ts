import { describe, expect, it, vi } from "vitest";
import {
  CourseVersionConflictError,
  retryCourseVersionConflict,
} from "./session-repository";

describe("database course version conflict recovery", () => {
  it("reloads and retries a transient optimistic version conflict", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new CourseVersionConflictError("course-1", 7))
      .mockResolvedValueOnce("saved");

    await expect(retryCourseVersionConflict(operation, 3, 0)).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not hide unrelated persistence failures", async () => {
    const failure = new Error("database unavailable");
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(retryCourseVersionConflict(operation, 3, 0)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured number of conflicts", async () => {
    const operation = vi.fn()
      .mockRejectedValue(new CourseVersionConflictError("course-1", 7));

    await expect(retryCourseVersionConflict(operation, 3, 0)).rejects.toBeInstanceOf(
      CourseVersionConflictError,
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
