import { AsyncLocalStorage } from "node:async_hooks";

export type ProgressPhase =
  | "course-read-worker"
  | "course-read-queue" | "course-read-execution"
  | "course-queue"
  | "personal-admission" | "personal-course-admission" | "personal-course-row-admission" | "course-admission"
  | "course-admission-backoff" | "transaction-retry-backoff"
  | "progress-auth" | "progress-scope" | "progress-context"
  | "progress-classroom" | "progress-normalize" | "progress-receipt-read" | "progress-transaction"
  | "progress-callback" | "progress-rowlock" | "progress-read"
  | "progress-merge" | "progress-write" | "progress-publish"
  | "courses-auth" | "courses-scope" | "courses-read"
  | "document-support-context" | "document-model-initial" | "document-model-context-retry"
  | "document-model-repair" | "document-audit-success" | "document-audit-invalid" | "document-memory-read"
  | "document-discussion-initial" | "document-discussion-repair" | "document-discussion-review"
  | "document-delegation-history" | "document-delegation-assessment" | "document-delegation-placement-repair"
  | "document-delegation-delivery" | "document-delegation-review"
  | "document-history-auth" | "document-history-context" | "document-history-threads"
  | "document-history-requests" | "document-history-comments" | "document-history-serialization"
  | "code-auth" | "code-context"
  | "code-history-threads" | "code-history-memory"
  | "memory-scope" | "memory-read" | "learning-auth" | "learning-ingest"
  | "learning-admission" | "learning-rowlock" | "learning-context"
  | "learning-transaction" | "learning-write" | "learning-readback";

export type ProgressTimingSpan = {
  phase: ProgressPhase; sequence: number; startMs: number; endMs: number;
  outcome: "ok" | "error";
  origin?: "worker";
};
type TimingContext = { started: number; sequence: number; spans: ProgressTimingSpan[] };
const STORAGE_KEY = Symbol.for("openpbl.progress-request-timing.v1");
const scope = globalThis as typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<TimingContext>;
};
// Next can compile the route, service and wrapper into different module copies.
// One request-local store is shared across those copies, never between requests.
const storage = scope[STORAGE_KEY] ??= new AsyncLocalStorage<TimingContext>();

export function collectProgressTimings<T>(started: number, spans: ProgressTimingSpan[], operation: () => T): T {
  return storage.run({ started, sequence: 0, spans }, operation);
}

/** Capture the caller's context before crossing a thread/EventEmitter boundary.
 * Worker offsets are relative to its execution, never claimed as parent offsets. */
export function captureWorkerProgressTimings(): (spans: readonly ProgressTimingSpan[]) => void {
  const context = storage.getStore();
  return spans => {
    if (!context) return;
    for (const span of spans.slice(0, 64)) {
      if (Number.isFinite(span.startMs) && Number.isFinite(span.endMs)
        && span.startMs >= 0 && span.endMs >= span.startMs) {
        context.spans.push({ ...span, sequence: context.sequence++, origin: "worker" });
      }
    }
  };
}

function begin(phase: ProgressPhase) {
  const context = storage.getStore();
  if (!context) return undefined;
  const sequence = context.sequence++;
  const startMs = performance.now() - context.started;
  return (outcome: ProgressTimingSpan["outcome"]) => {
    const endMs = performance.now() - context.started;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs >= startMs) {
      context.spans.push({ phase, sequence, startMs, endMs, outcome });
    }
  };
}

/** For admission that completes in another callback; one recorded boundary per operation. */
export function beginProgressTiming(phase: ProgressPhase): (outcome: ProgressTimingSpan["outcome"]) => void {
  const finish = begin(phase); let finished = false;
  return outcome => { if (!finished) { finished = true; finish?.(outcome); } };
}

export async function timeProgress<T>(phase: ProgressPhase, operation: () => Promise<T>): Promise<T> {
  const finish = begin(phase);
  if (!finish) return operation();
  let outcome: ProgressTimingSpan["outcome"] = "error";
  try { const value = await operation(); outcome = "ok"; return value; }
  finally { finish(outcome); }
}

export function timeProgressSync<T>(phase: ProgressPhase, operation: () => T): T {
  const finish = begin(phase);
  if (!finish) return operation();
  let outcome: ProgressTimingSpan["outcome"] = "error";
  try { const value = operation(); outcome = "ok"; return value; }
  finally { finish(outcome); }
}

/** Keep each occurrence (including failed attempts); names are a fixed union.
 * Nested durations overlap and must not be added into a request percentile.
 * Offsets identify callback boundaries without claiming their complement is DB queue time.
 * Admission spans include the full query await, not just PostgreSQL lock time.
 * Bound the diagnostic header even when a busy request exhausts its retry budget.
 * Omitted spans remain unknown; the marker has no invented duration.
 */
export function progressServerTimings(spans: readonly ProgressTimingSpan[]): string[] {
  const sorted = [...spans].sort((a, b) => a.sequence - b.sequence);
  const result: string[] = [];
  // Leave space for the fixed native/Proxy boundary fields and other headers.
  const limit = 6_144;
  let length = 0;
  for (const span of sorted) {
    const prefix = span.origin === "worker" ? "worker-" : "";
    const value = `${prefix}${span.phase};dur=${(span.endMs - span.startMs).toFixed(3)};desc="${prefix}start=${span.startMs.toFixed(3)};${prefix}end=${span.endMs.toFixed(3)};outcome=${span.outcome}"`;
    // Reserve the small omission marker before adding the next whole span.
    if (length + value.length + 2 + 80 > limit) break;
    result.push(value);
    length += value.length + 2;
  }
  if (result.length < sorted.length) result.push(`progress-timing-omitted;desc="count=${sorted.length - result.length}"`);
  return result;
}
