import { describe, expect, it } from "vitest";
import { claimCompanionTaskTransition } from "./task-transition";

describe("claimCompanionTaskTransition", () => {
  it("claims the same task, lesson and status only once", () => {
    const claimed = new Set<string>();
    const transition = {
      taskId: "task-1",
      lessonId: "lesson-1",
      status: "generating" as const,
    };

    expect(claimCompanionTaskTransition(claimed, transition)).toBe(true);
    expect(claimCompanionTaskTransition(claimed, transition)).toBe(false);
  });

  it("allows the same lesson to advance through later states", () => {
    const claimed = new Set<string>();
    const base = { taskId: "task-1", lessonId: "lesson-1" };

    expect(claimCompanionTaskTransition(claimed, { ...base, status: "generating" })).toBe(true);
    expect(claimCompanionTaskTransition(claimed, { ...base, status: "ready" })).toBe(true);
    expect(claimCompanionTaskTransition(claimed, { ...base, status: "completed" })).toBe(true);
  });
});
