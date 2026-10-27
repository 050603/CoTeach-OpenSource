import { describe, expect, it } from "vitest";
import {
  currentGenerationProgress,
  estimateCourseGenerationRemainingSeconds,
  estimateCourseGenerationSeconds,
  mapAdaptiveGenerationProgress,
  mapPrimaryGenerationProgress,
} from "./course-generation-progress";

describe("course generation progress", () => {
  it("reserves the final range for post-processing and adaptive resources", () => {
    expect(mapPrimaryGenerationProgress(0)).toBe(0);
    expect(mapPrimaryGenerationProgress(50)).toBe(41);
    expect(mapPrimaryGenerationProgress(100)).toBe(82);
  });

  it("combines parallel adaptive branch progress", () => {
    expect(mapAdaptiveGenerationProgress([0, 0])).toBe(86);
    expect(mapAdaptiveGenerationProgress([100, 50])).toBe(95);
    expect(mapAdaptiveGenerationProgress([100, 100])).toBe(98);
  });

  it("does not report completion until the workflow finishes", () => {
    expect(currentGenerationProgress([])).toBe(0);
    expect(currentGenerationProgress([82, 98, 99])).toBe(99);
    expect(currentGenerationProgress([82, 98], true)).toBe(100);
  });

  it("calibrates a normal lesson near the observed ten-minute range", () => {
    expect(estimateCourseGenerationSeconds({
      sceneCount: 12,
      adaptiveBranchCount: 0,
      enableWebSearch: false,
      enableImageGeneration: true,
      enableVideoGeneration: false,
      enableTTS: true,
    })).toBe(9 * 60);
  });

  it("adds time for web research and adaptive branches", () => {
    const standard = estimateCourseGenerationSeconds({
      sceneCount: 12,
      adaptiveBranchCount: 0,
      enableWebSearch: false,
      enableImageGeneration: true,
      enableVideoGeneration: false,
      enableTTS: true,
    });
    const expanded = estimateCourseGenerationSeconds({
      sceneCount: 12,
      adaptiveBranchCount: 2,
      enableWebSearch: true,
      enableImageGeneration: true,
      enableVideoGeneration: true,
      enableTTS: true,
    });

    expect(expanded - standard).toBe(3.75 * 60);
  });

  it("never lets early fast progress shrink the workload baseline", () => {
    expect(estimateCourseGenerationRemainingSeconds({
      elapsedSeconds: 3 * 60,
      estimatedTotalSeconds: 9 * 60,
      progress: 50,
    })).toBe(6 * 60);
  });

  it("extends the estimate when observed generation is slower than baseline", () => {
    expect(estimateCourseGenerationRemainingSeconds({
      elapsedSeconds: 10 * 60,
      estimatedTotalSeconds: 9 * 60,
      progress: 25,
    })).toBe(30 * 60);
  });
});
