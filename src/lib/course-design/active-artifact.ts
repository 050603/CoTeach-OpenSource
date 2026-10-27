export function resolveLatestCompletedArtifactId(
  artifacts: ReadonlyArray<{ id: string }>,
): string | undefined {
  return artifacts.at(-1)?.id;
}
