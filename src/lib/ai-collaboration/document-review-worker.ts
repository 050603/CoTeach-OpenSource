import { isDatabaseConfigured, prisma } from '@/lib/db/client';
import { readDocumentReviewQueueCounts } from './document-review-admission';
import { withClassroomAiUsage } from '@/lib/observability/classroom-ai';
import { isBackgroundAiCapacityError, classroomAiCapacitySnapshot } from '@/lib/llm/classroom-capacity';
import { isProactiveReviewCapacityError, proactiveReviewCapacitySnapshot, resolveProactiveReviewConcurrency, withProactiveReviewCapacity } from './proactive-review-capacity';
import {
  cancelRetiredDocumentReviews, assertDocumentReviewScope, claimQueuedDocumentReview, documentReviewRecoveredLeases, DOCUMENT_REVIEW_QUEUE, isDocumentReviewScopeChanged,
  renewDocumentReviewLease, rescheduleDocumentReview, type QueuedBackgroundReview,
} from './document-review-queue';

type Executor = (job: QueuedBackgroundReview, signal: AbortSignal) => Promise<Response>;
export type DocumentReviewWorkerSnapshot = { initialized: boolean; running: boolean; lastTickAt: number | null; active: number; queued: number; lastErrorAt: number | null; oldestQueuedAt: number | null; leaseRecoveryTotal: number };

/** The injectable executor keeps lease/retry tests independent of model/network
 * services. Production uses exactly the shared document review implementation. */
export async function runQueuedDocumentReview(job: QueuedBackgroundReview, stopSignal: AbortSignal, execute: Executor): Promise<void> {
  if (job.snapshot.version === 1) {
    await cancelRetiredDocumentReviews();
    return;
  }
  const lease = new AbortController();
  const signal = AbortSignal.any([stopSignal, lease.signal]);
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewal) return;
    renewal = renewDocumentReviewLease(job).then(valid => { if (!valid) lease.abort(new Error('REVIEW_LEASE_LOST')); })
      .catch(error => lease.abort(error)).finally(() => { renewal = undefined; });
  }, 30_000);
  timer.unref?.();
  try {
    signal.throwIfAborted();
    await assertDocumentReviewScope(prisma, job.snapshot);
    signal.throwIfAborted();
    const task = job.snapshot.task;
    const response = await withClassroomAiUsage({ feature: job.snapshot.version === 2 ? 'code-collaboration' : 'document-collaboration', courseId: task.courseId,
      studentId: task.studentId, requestId: task.requestId }, () => withProactiveReviewCapacity(
        () => execute(job, signal), `queued-document:${job.id}`));
    signal.throwIfAborted();
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      await rescheduleDocumentReview(job, { code: body.error || 'AI_REVIEW_FAILED',
        terminal: response.status >= 400 && response.status < 500 && response.status !== 429,
        retryAfterMs: Number(response.headers.get('Retry-After') || 0) * 1_000 });
    }
  } catch (error) {
    const capacity = isProactiveReviewCapacityError(error) || isBackgroundAiCapacityError(error);
    await rescheduleDocumentReview(job, { code: stopSignal.aborted ? 'REVIEW_WORKER_STOPPED'
      : isDocumentReviewScopeChanged(error) ? error.message
      : capacity ? 'AI_PROACTIVE_REVIEW_BUSY' : lease.signal.aborted ? 'REVIEW_LEASE_LOST' : 'AI_REVIEW_FAILED',
      capacity, stopped: stopSignal.aborted, terminal: isDocumentReviewScopeChanged(error),
      ...(capacity ? { retryAfterMs: error.retryAfterMs } : {}),
    });
  } finally { clearInterval(timer); await renewal; }
}

type Runtime = {
  timer?: ReturnType<typeof setTimeout>; controller?: AbortController;
  tick?: Promise<void>; tasks: Set<Promise<void>>; snapshot: DocumentReviewWorkerSnapshot;
};
declare global { var __openPblDocumentReviewWorker: Runtime | undefined; }
const runtime = globalThis.__openPblDocumentReviewWorker ??= { tasks: new Set(),
  snapshot: { initialized: false, running: false, lastTickAt: null, active: 0, queued: 0, lastErrorAt: null, oldestQueuedAt: null, leaseRecoveryTotal: 0 } };
export function documentReviewWorkerSnapshot(): DocumentReviewWorkerSnapshot { return { ...runtime.snapshot }; }

export async function readDocumentReviewBacklog(db: Pick<typeof prisma, '$queryRaw'> = prisma) {
  const row = await readDocumentReviewQueueCounts(db, DOCUMENT_REVIEW_QUEUE);
  return { queued: Number(row.waiting), oldestQueuedAt: row.oldest?.getTime() ?? null };
}

export function documentReviewWorkerHealth(): { ok: boolean; error?: string } {
  if (!isDatabaseConfigured()) return { ok: false, error: 'DATABASE_NOT_CONFIGURED' };
  const state = documentReviewWorkerSnapshot();
  if (!state.running || !state.initialized) return { ok: false, error: 'DOCUMENT_REVIEW_WORKER_NOT_READY' };
  if (!state.lastTickAt || Date.now() - state.lastTickAt > 15_000
    || (state.lastErrorAt !== null && state.lastErrorAt > state.lastTickAt)) return { ok: false, error: 'DOCUMENT_REVIEW_WORKER_UNAVAILABLE' };
  return { ok: true };
}

export function startDocumentReviewWorker(): void {
  if (runtime.controller && !runtime.controller.signal.aborted) return;
  if (!isDatabaseConfigured() || process.env.NEXT_PHASE === 'phase-production-build') return;
  const controller = runtime.controller = new AbortController();
  runtime.snapshot.running = true;
  let retired = false;
  const tick = async () => {
    try {
      if (!retired) { await cancelRetiredDocumentReviews(); retired = true; }
      const { executeQueuedDocumentReview } = await import('./document-handlers');
      const execute: Executor = async (job, signal) => job.snapshot.version === 2
        ? (await import('./code-handlers')).executeQueuedCodeReview({ ...job, snapshot: job.snapshot }, signal)
        : executeQueuedDocumentReview({ ...job, snapshot: job.snapshot }, signal);
      while (!controller.signal.aborted && runtime.tasks.size < resolveProactiveReviewConcurrency()) {
        // Do not repeatedly claim/write every waiting task during foreground
        // saturation. Actual gates still arbitrate races after this cheap hint.
        const global = classroomAiCapacitySnapshot();
        const background = proactiveReviewCapacitySnapshot();
        if (global.pending || global.active >= Math.max(1, global.limit - 2) || background.active >= background.limit) break;
        const job = await claimQueuedDocumentReview();
        if (!job) break;
        const work = runQueuedDocumentReview(job, controller.signal, execute)
          .catch(() => {
            runtime.snapshot.lastErrorAt = Date.now();
            console.error('[document-review] worker unavailable; durable lease retained');
          }).finally(() => { runtime.tasks.delete(work); runtime.snapshot.active = runtime.tasks.size; });
        runtime.tasks.add(work); runtime.snapshot.active = runtime.tasks.size;
      }
      const backlog = await readDocumentReviewBacklog();
      runtime.snapshot.queued = backlog.queued;
      runtime.snapshot.oldestQueuedAt = backlog.oldestQueuedAt;
      runtime.snapshot.leaseRecoveryTotal = documentReviewRecoveredLeases();
      runtime.snapshot.initialized = true; runtime.snapshot.lastTickAt = Date.now();
    } catch {
      runtime.snapshot.lastErrorAt = Date.now();
      console.error('[document-review] queue unavailable; durable requests retained');
    } finally {
      runtime.tick = undefined;
      if (!controller.signal.aborted) {
        runtime.timer = setTimeout(() => { runtime.tick = tick(); }, 1_000);
        runtime.timer.unref?.();
      }
    }
  };
  runtime.tick = tick();
}

export async function stopDocumentReviewWorker(): Promise<void> {
  runtime.controller?.abort(); runtime.snapshot.running = false;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
  // Bounded network calls observe abort. A nonresponsive database can outlive
  // shutdown; its persisted lease, never an in-memory replay, enables recovery.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled([runtime.tick, ...runtime.tasks]),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 5_000); })]);
  } finally { if (timeout) clearTimeout(timeout); }
}
