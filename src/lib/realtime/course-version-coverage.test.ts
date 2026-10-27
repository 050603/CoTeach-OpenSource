import { expect, it } from "vitest";
import { advanceCourseVersionCoverage, courseVersionRanges, isPersonalVersionEvent } from "./course-version-coverage";

it("does not bridge missing versions, including between pages and outside safe integer precision", () => {
  const ranges = courseVersionRanges([7, 3, 4, 3, 8, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]);
  expect(ranges).toEqual([[3, 4], [7, 8]]);
  expect(advanceCourseVersionCoverage(2, ranges)).toBe(4);
  expect(advanceCourseVersionCoverage(4, [[5, 6]])).toBe(6);
  expect(advanceCourseVersionCoverage(6, [[7, 8]])).toBe(8);
  expect(advanceCourseVersionCoverage(8, [[3, 8]])).toBe(8);
  expect(courseVersionRanges(Array.from({ length: 501 }, (_, i) => i + 1))).toEqual([]);
});

it.each([undefined, null, {}, [["2", 3]], [[2, 1]], [[1.5, 3]], [[2, Infinity]],
  [[2, 3, 4]], [[2, 3], [3, 5]], [[4, 5], [2, 3]], [[2, 502]], [[0, 3]],
  Array.from({ length: 501 }, (_, i) => [i + 2, i + 2])].map(value => [value]))("treats malformed coverage as unknown: %j", value => {
  expect(advanceCourseVersionCoverage(1, value)).toBe(1);
});

it("requires an audited personal producer instead of trusting a generic student notification", () => {
  for (const type of ["UPDATE_STUDENT_PROGRESS", "KNOWLEDGE_QUIZ_SUBMITTED", "KNOWLEDGE_QUIZ_GRADED", "KNOWLEDGE_TUTOR_COMPLETED"]) {
    expect(isPersonalVersionEvent(type, undefined)).toBe(true);
  }
  expect(isPersonalVersionEvent("UPDATE_COURSE", "learning-events")).toBe(true);
  for (const [type, source] of [["UPDATE_COURSE", undefined], ["UPDATE_COURSE", "server-course-update"],
    ["COURSE_ACTION", "learning-events"], ["SHOWCASE_CHANGED", undefined], ["projection-changed", undefined]]) {
    expect(isPersonalVersionEvent(type!, source)).toBe(false);
  }
});
