import { describe, expect, it } from "vitest";
import { deriveCourseEntryPolicy } from "@/lib/course-entry-policy";

describe("course entry policy", () => {
  it("derives a compact entry for a one-hour PBL course with reviewed prerequisites", () => {
    const policy = deriveCourseEntryPolicy({
      hours: 1,
      grade: "高二",
      lessonTargetCount: 5,
      acceptedPrerequisiteCount: 2,
      courseMode: "pbl-six-stage",
    });

    expect(policy.minimumPrerequisites).toBe(2);
    expect(policy.recommendedPrerequisites).toEqual({ min: 2, max: 3 });
    expect(policy.maximumPrerequisites).toBe(3);
    expect(policy.pretestTimeBudgetMin).toBe(5);
    expect(policy.remediationTimeBudgetMin).toBe(9);
  });

  it("allows a larger entry capacity when course duration and target depth support it", () => {
    const shortCourse = deriveCourseEntryPolicy({
      hours: 1,
      grade: "高中",
      lessonTargetCount: 8,
      courseMode: "pbl-six-stage",
    });
    const longCourse = deriveCourseEntryPolicy({
      hours: 4,
      grade: "大学通识",
      lessonTargetCount: 8,
      courseMode: "pbl-six-stage",
    });

    expect(longCourse.maximumPrerequisites).toBeGreaterThan(shortCourse.maximumPrerequisites);
    expect(longCourse.pretestTimeBudgetMin).toBeGreaterThan(shortCourse.pretestTimeBudgetMin);
  });

  it("permits zero pretest only for a genuine early-primary foundation course", () => {
    const policy = deriveCourseEntryPolicy({
      hours: 1,
      grade: "小学低段",
      lessonTargetCount: 2,
      foundationTargetCount: 2,
      acceptedPrerequisiteCount: 0,
    });

    expect(policy.minimumPrerequisites).toBe(0);
  });
});
