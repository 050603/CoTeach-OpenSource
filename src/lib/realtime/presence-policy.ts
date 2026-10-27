export const PRESENCE_SNAPSHOT_INTERVAL_MS = {
  teacher: 5_000,
  student: 15_000,
} as const;

export function shouldReadPresence(
  visibilityState: DocumentVisibilityState | undefined,
): boolean {
  return visibilityState !== "hidden";
}
