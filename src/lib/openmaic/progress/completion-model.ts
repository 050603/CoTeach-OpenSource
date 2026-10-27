export const AI_PROGRESS_COMPLETION_MODEL_VERSION = 2 as const;

export function isReliableAiProgress(entry?: object | null): boolean {
  return (
    entry !== null
    && entry !== undefined
    && 'completionModelVersion' in entry
    && entry.completionModelVersion === AI_PROGRESS_COMPLETION_MODEL_VERSION
  );
}
