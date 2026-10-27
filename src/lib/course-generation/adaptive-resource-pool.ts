import { mapWithConcurrency } from "@openmaic/lib/utils/concurrency";

export const ADAPTIVE_RESOURCE_CONCURRENCY = 3;

export type AdaptiveResourcePoolResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export type AdaptiveResourcePoolProgress = {
  completed: number;
  total: number;
  overallProgress: number;
  itemIndex: number;
  itemProgress: number;
};

export async function runAdaptiveResourcePool<TItem, TResult>(
  items: readonly TItem[],
  worker: (
    item: TItem,
    index: number,
    reportProgress: (progress: number) => Promise<void>,
  ) => Promise<TResult>,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: AdaptiveResourcePoolProgress) => Promise<void> | void;
  },
): Promise<Array<AdaptiveResourcePoolResult<TResult>>> {
  const progressByIndex = items.map(() => 0);
  const report = async (itemIndex: number, rawProgress: number) => {
    const itemProgress = Math.max(0, Math.min(1, rawProgress));
    progressByIndex[itemIndex] = Math.max(progressByIndex[itemIndex] ?? 0, itemProgress);
    const completed = progressByIndex.filter((value) => value >= 1).length;
    const overallProgress = items.length > 0
      ? progressByIndex.reduce((sum, value) => sum + value, 0) / items.length
      : 1;
    await options?.onProgress?.({
      completed,
      total: items.length,
      overallProgress,
      itemIndex,
      itemProgress: progressByIndex[itemIndex] ?? itemProgress,
    });
  };

  const results = await mapWithConcurrency(
    items,
    ADAPTIVE_RESOURCE_CONCURRENCY,
    async (item, index): Promise<AdaptiveResourcePoolResult<TResult>> => {
      if (options?.signal?.aborted) {
        return { status: "rejected", reason: options.signal.reason };
      }
      try {
        const value = await worker(item, index, (progress) => report(index, progress));
        await report(index, 1);
        return { status: "fulfilled", value };
      } catch (reason) {
        await report(index, 1);
        return { status: "rejected", reason };
      }
    },
    { shouldContinue: () => !options?.signal?.aborted },
  );

  return results.map((result) => result ?? {
    status: "rejected" as const,
    reason: options?.signal?.reason ?? new Error("Adaptive resource generation cancelled"),
  });
}

