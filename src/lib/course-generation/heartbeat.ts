export const GENERATION_HEARTBEAT_STALE_AFTER_MS = 30 * 60 * 1_000;

type GenerationHeartbeatSnapshot = {
  status: string;
  lastHeartbeatAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
};

/**
 * A durable task is only considered disconnected while it claims to be
 * running. Queued, paused and review states can legitimately have no active
 * heartbeat. Older rows may not have a heartbeat, so fall back to their last
 * update/start time instead of showing an endless live-running state.
 */
export function isGenerationHeartbeatStale(
  job: GenerationHeartbeatSnapshot | null | undefined,
  now = Date.now(),
  staleAfterMs = GENERATION_HEARTBEAT_STALE_AFTER_MS,
): boolean {
  if (!job || job.status !== "running") return false;
  const timestamp = Date.parse(job.lastHeartbeatAt ?? job.updatedAt ?? job.startedAt ?? "");
  return Number.isFinite(timestamp) && now - timestamp >= staleAfterMs;
}
