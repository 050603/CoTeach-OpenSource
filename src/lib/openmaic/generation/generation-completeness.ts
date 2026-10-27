export function assertCompleteSceneGeneration(input: {
  expectedCount: number;
  generatedCount: number;
  failedTitles: string[];
  phase: 'content' | 'assembly';
}): void {
  if (input.generatedCount === input.expectedCount && input.failedTitles.length === 0) return;
  const failed = input.failedTitles.length > 0 ? input.failedTitles.join('、') : '未知页面';
  throw new Error(
    `Course scene ${input.phase} incomplete: expected ${input.expectedCount}, generated ${input.generatedCount}; failed: ${failed}`,
  );
}
