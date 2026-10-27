export async function runIndependentClassroomAssetTasks(input: {
  media: () => Promise<void>;
  tts: () => Promise<void>;
  persistMergedState: () => Promise<void>;
}): Promise<void> {
  const results = await Promise.allSettled([input.media(), input.tts()]);
  await input.persistMergedState();
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Classroom asset generation incomplete");
  }
}
