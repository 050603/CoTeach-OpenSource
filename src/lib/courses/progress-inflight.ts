import { createHash } from 'node:crypto';
import type { StudentAiProgress } from '@/lib/session/types';

type ProgressFlight = { promise: Promise<StudentAiProgress>; expiresAt: number };
type ProgressIdentity = { courseId: string; actorId: string; sessionVersion: number; requestId: string; bodyFingerprint: string };
const MAX_ENTRIES = 512;
// Longer than the existing 10s admission budget. Expiry only removes the
// optimization; it never cancels a commit or replaces the durable receipt.
const MAX_AGE_MS = 30_000;
const KEY = Symbol.for('openpbl.progress-inflight.v1');
const scope = globalThis as typeof globalThis & { [KEY]?: Map<string, ProgressFlight> };
const pending = scope[KEY] ??= new Map<string, ProgressFlight>();

/** Include the entire original JSON body, including ignored/unknown fields.
 * Object order is immaterial; array order and every supplied value are retained.
 * This is separate from the existing database receipt fingerprint contract.
 */
export function progressBodyFingerprint(body: unknown): string {
  const serialized = JSON.stringify(body, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return createHash('sha256').update(serialized).digest('hex');
}

/** Only canonical, live-authorized callers may use this pending-only lane.
 * Authentication/scope checks before and after waiting belong to each HTTP
 * caller. Never share Response objects, auth decisions, or diagnostic spans.
 * No signal is accepted: an HTTP disconnect must not cancel the first write.
 */
export async function coalesceProgressWrite(identity: ProgressIdentity, operation: () => Promise<StudentAiProgress>): Promise<StudentAiProgress> {
  const key = JSON.stringify([identity.courseId, identity.actorId, identity.sessionVersion, identity.requestId, identity.bodyFingerprint]);
  const existing = pending.get(key);
  if (existing && existing.expiresAt > Date.now()) return structuredClone(await existing.promise);
  if (existing) pending.delete(key);
  // Saturation falls back to existing DB idempotency/queue guards, not a new
  // failure mode or eviction/cancellation of another learner's write.
  if (pending.size >= MAX_ENTRIES) return operation();
  const entry: ProgressFlight = { promise: Promise.resolve().then(operation), expiresAt: Date.now() + MAX_AGE_MS };
  pending.set(key, entry);
  const timer = setTimeout(() => { if (pending.get(key) === entry) pending.delete(key); }, MAX_AGE_MS);
  timer.unref?.();
  try { return structuredClone(await entry.promise); }
  finally {
    clearTimeout(timer);
    if (pending.get(key) === entry) pending.delete(key);
  }
}
