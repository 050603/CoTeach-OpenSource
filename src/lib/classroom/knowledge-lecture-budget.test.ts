import { describe, expect, it } from "vitest";
import { allocateLectureBudget, knowledgeLectureBudgetBounds } from "./knowledge-lecture-budget";

describe("knowledge lecture hard budget", () => {
  it.each([[2, 24, 48], [1.5, 18, 36], [1, 12, 24], [1.25, 15, 30], [101 / 60, 21, 40]])(
    "rounds the bounds inward for %s course hours", (hours, minMinutes, maxMinutes) => {
      expect(knowledgeLectureBudgetBounds(hours)).toMatchObject({ minMinutes, maxMinutes });
    },
  );

  it.each([0, -1, NaN, Infinity])("rejects invalid course hours %s", (hours) => {
    expect(() => knowledgeLectureBudgetBounds(hours)).toThrow();
  });

  it("preserves totals and minimums even with skewed weights", () => {
    for (const weights of [[1, 1, 1], [10000, 1, 1], [1, 2, 7, 19, 40]]) {
      for (let total = weights.length * 45; total < 2000; total += 17) {
        const allocated = allocateLectureBudget(total, weights, 45);
        expect(allocated.reduce((sum, item) => sum + item, 0)).toBe(total);
        expect(allocated.every((item) => Number.isInteger(item) && item >= 45)).toBe(true);
      }
    }
  });
});
