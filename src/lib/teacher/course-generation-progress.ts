export const PRIMARY_GENERATION_PROGRESS_MAX = 82;
export const ADAPTIVE_GENERATION_PROGRESS_START = 86;
export const ADAPTIVE_GENERATION_PROGRESS_END = 98;

export type CourseGenerationWorkload = {
  sceneCount: number;
  adaptiveBranchCount: number;
  enableWebSearch: boolean;
  enableImageGeneration: boolean;
  enableVideoGeneration: boolean;
  enableTTS: boolean;
};

const MINIMUM_COURSE_GENERATION_SECONDS = 5 * 60;
const MAXIMUM_ESTIMATE_SECONDS = 60 * 60;

export function estimateCourseGenerationSeconds(
  workload: CourseGenerationWorkload,
): number {
  const sceneCount = Math.max(6, Math.round(workload.sceneCount));
  const estimate =
    2 * 60 +
    sceneCount * 35 +
    workload.adaptiveBranchCount * 90 +
    (workload.enableWebSearch ? 45 : 0);
  return Math.min(
    MAXIMUM_ESTIMATE_SECONDS,
    Math.max(MINIMUM_COURSE_GENERATION_SECONDS, estimate),
  );
}

export function estimateCourseGenerationRemainingSeconds({
  elapsedSeconds,
  estimatedTotalSeconds,
  progress,
}: {
  elapsedSeconds: number;
  estimatedTotalSeconds: number;
  progress: number;
}): number {
  const safeElapsed = Math.max(0, elapsedSeconds);
  const safeProgress = Math.max(0, Math.min(99, progress));
  const observedTotalSeconds =
    safeProgress >= 5 && safeElapsed >= 30
      ? safeElapsed / (safeProgress / 100)
      : 0;
  const calibratedTotalSeconds = Math.min(
    MAXIMUM_ESTIMATE_SECONDS,
    Math.max(estimatedTotalSeconds, observedTotalSeconds),
  );
  return Math.max(60, Math.round(calibratedTotalSeconds - safeElapsed));
}

export function mapPrimaryGenerationProgress(progress: number): number {
  return Math.min(
    PRIMARY_GENERATION_PROGRESS_MAX,
    Math.max(0, Math.round(progress * (PRIMARY_GENERATION_PROGRESS_MAX / 100))),
  );
}

export function mapAdaptiveGenerationProgress(values: Iterable<number>): number {
  const progress = Array.from(values);
  if (progress.length === 0) return ADAPTIVE_GENERATION_PROGRESS_START;
  const average = progress.reduce((sum, value) => sum + value, 0) / progress.length;
  const span =
    ADAPTIVE_GENERATION_PROGRESS_END - ADAPTIVE_GENERATION_PROGRESS_START;
  return Math.min(
    ADAPTIVE_GENERATION_PROGRESS_END,
    ADAPTIVE_GENERATION_PROGRESS_START +
      Math.round((Math.max(0, average) / 100) * span),
  );
}

export function currentGenerationProgress(
  values: Iterable<number>,
  complete = false,
): number {
  if (complete) return 100;
  const progress = Array.from(values);
  if (progress.length === 0) return 0;
  return Math.min(99, Math.max(0, ...progress));
}
