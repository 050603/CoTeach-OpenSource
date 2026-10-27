import { clientUUID } from '@/lib/uuid';
import type { PendingSaveTelemetry } from '@/lib/presence-save-telemetry';
import { readSubmissionSaves } from './submission-save-outbox';

const CLIENT_KEY = 'openpbl:save-telemetry-client:v1';
const validId = (value: string | null): value is string => Boolean(value && /^[A-Za-z0-9_-]{16,80}$/.test(value));

/** Shared by tabs in one browser storage profile; deliberately unrelated to
 * users, sessions and individual save request IDs. Failure remains unknown.
 */
export function unknownSubmissionSaveTelemetry(): PendingSaveTelemetry {
  try {
    let clientId = localStorage.getItem(CLIENT_KEY);
    if (!validId(clientId)) {
      localStorage.setItem(CLIENT_KEY, clientUUID());
      clientId = localStorage.getItem(CLIENT_KEY);
    }
    return validId(clientId) ? { clientId, known: false } : { known: false };
  } catch { return { known: false }; }
}

export function submissionSaveTelemetry(actorId: string, courseId: string): PendingSaveTelemetry {
  const identity = unknownSubmissionSaveTelemetry();
  if (!identity.clientId) return identity;
  try {
    const pending = readSubmissionSaves(actorId, courseId).filter(record => record.state !== 'resolved');
    if (pending.some(record => record.createdAt <= 0 || record.createdAt > Date.now() + 30_000)) return identity;
    return { ...identity, known: true, count: pending.length, oldestCreatedAt: pending[0]?.createdAt ?? null };
  } catch { return identity; }
}
