export function normalizeProgressUpdate(input: {
  validSceneIds: string[];
  requestedCurrentSceneIndex: number;
  requestedCompletedScenes: string[];
  previousCompletedScenes: string[];
}): {
  currentSceneIndex: number;
  totalScenes: number;
  completedScenes: string[];
} {
  const validIds = new Set(input.validSceneIds);
  const requested = new Set(input.requestedCompletedScenes.filter((id) => validIds.has(id)));
  for (const id of input.previousCompletedScenes) {
    if (validIds.has(id)) requested.add(id);
  }
  const totalScenes = input.validSceneIds.length;
  const rawIndex = Number.isFinite(input.requestedCurrentSceneIndex)
    ? Math.trunc(input.requestedCurrentSceneIndex)
    : 0;
  const currentSceneIndex = totalScenes > 0
    ? Math.max(0, Math.min(rawIndex, totalScenes - 1))
    : 0;

  return {
    currentSceneIndex,
    totalScenes,
    completedScenes: input.validSceneIds.filter((id) => requested.has(id)),
  };
}
