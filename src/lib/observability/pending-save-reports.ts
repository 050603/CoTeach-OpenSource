import type { PendingSaveTelemetry } from '@/lib/presence-save-telemetry';

const TTL_MS = 60_000;
const MAX_CLIENTS = 4096;
type Report = { seenAt: number; known: boolean; count?: number; oldestCreatedAt?: number | null };
type Reports = { clients: Map<string, Report>; overflowed: boolean };
const KEY = Symbol.for('openpbl.pending-save-reports.v1');
const scope = globalThis as typeof globalThis & { [KEY]?: Reports };
const state = scope[KEY] ??= { clients: new Map(), overflowed: false };

function prune(now: number) {
  for (const [key, report] of state.clients) {
    // A confirmed empty outbox may leave the observed cohort. Pending or
    // unknown reports remain unknown after expiry until that client returns;
    // another browser's zero must never erase an offline browser's work.
    if (now - report.seenAt >= TTL_MS && report.known && report.count === 0) state.clients.delete(key);
  }
}

export function recordPendingSaveReport(actorId: string, courseId: string, value: unknown, now = Date.now()): void {
  const report = value && typeof value === 'object' && !Array.isArray(value) ? value as PendingSaveTelemetry : undefined;
  const clientId = typeof report?.clientId === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(report.clientId) ? report.clientId : 'unidentified';
  const known = report?.known === true && clientId !== 'unidentified' && Number.isSafeInteger(report.count)
    && Number(report.count) >= 0 && Number(report.count) <= 10_000
    && (report.count === 0 ? report.oldestCreatedAt === null
      : typeof report.oldestCreatedAt === 'number' && Number.isFinite(report.oldestCreatedAt) && report.oldestCreatedAt > 0 && report.oldestCreatedAt <= now + 30_000);
  prune(now);
  const key = JSON.stringify([actorId, courseId, clientId]);
  if (!state.clients.has(key) && state.clients.size >= MAX_CLIENTS) {
    state.clients.delete(state.clients.keys().next().value!);
    state.overflowed = true;
  }
  state.clients.set(key, { seenAt: now, known, ...(known ? { count: report!.count, oldestCreatedAt: report!.oldestCreatedAt } : {}) });
}

/** Process-local, self-reported diagnostics. It cannot prove global business
 * durability or represent browsers never seen by this process. No identity is
 * exposed in metrics. Restart, missing samples and expired pending are unknown.
 */
export function pendingSaveReportSnapshot(now = Date.now()) {
  prune(now);
  let count = 0; let oldestCreatedAt: number | null = null; let unknownClients = 0;
  for (const report of state.clients.values()) {
    if (!report.known || now - report.seenAt >= TTL_MS) { unknownClients++; continue; }
    count += report.count!;
    if (report.oldestCreatedAt !== null && report.oldestCreatedAt !== undefined)
      oldestCreatedAt = oldestCreatedAt === null ? report.oldestCreatedAt : Math.min(oldestCreatedAt, report.oldestCreatedAt);
  }
  const known = state.clients.size > 0 && unknownClients === 0 && !state.overflowed;
  return { known, clients: state.clients.size, unknownClients: state.overflowed ? Number.NaN : unknownClients,
    count: known ? count : Number.NaN, oldestCreatedAt: known ? oldestCreatedAt : Number.NaN,
    knownCount: count, oldestKnownCreatedAt: oldestCreatedAt };
}

/** Bound optional heartbeat metadata. Invalid/slow telemetry never rejects the
 * original heartbeat or permits an unbounded JSON body to enter diagnostics.
 */
export async function readPresenceSaveTelemetry(request: Request): Promise<unknown> {
  return (await readPresenceHeartbeat(request))?.pendingSaves;
}

export async function readPresenceHeartbeat(request: Request): Promise<{ pendingSaves?: unknown; showcaseReceipt?: unknown } | undefined> {
  if (!request.body || Number(request.headers.get('content-length')) > 2048) return undefined;
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength; if (length > 2048) return undefined;
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as { pendingSaves?: unknown; showcaseReceipt?: unknown }; }
    catch { return undefined; }
  };
  try { return await Promise.race([read(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 200); })]); }
  catch { return undefined; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}
