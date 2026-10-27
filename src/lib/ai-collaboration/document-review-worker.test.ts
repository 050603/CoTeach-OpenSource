import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueuedBackgroundReview } from './document-review-queue';
const mocks = vi.hoisted(() => ({ assert: vi.fn(), renew: vi.fn(), reschedule: vi.fn(), query: vi.fn(), claim: vi.fn(), cancel: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.query, aiTask: { updateMany: mocks.cancel } }, isDatabaseConfigured: () => true }));
vi.mock('@/lib/observability/classroom-ai', () => ({ withClassroomAiUsage: (_: unknown, run: () => unknown) => run(), recordAiAdmission: vi.fn() }));
vi.mock('./document-review-queue', async original => ({ ...await original<typeof import('./document-review-queue')>(),
  assertDocumentReviewScope: mocks.assert, renewDocumentReviewLease: mocks.renew, rescheduleDocumentReview: mocks.reschedule,
  claimQueuedDocumentReview: mocks.claim,
}));
vi.mock('./document-handlers', () => ({ executeQueuedDocumentReview: vi.fn() }));
import { DocumentReviewScopeChanged } from './document-review-queue';
import { BackgroundAiCapacityError } from '@/lib/llm/classroom-capacity';
import { runQueuedDocumentReview, documentReviewWorkerHealth, readDocumentReviewBacklog, startDocumentReviewWorker, stopDocumentReviewWorker } from './document-review-worker';
const job = { id: 'task', token: 'current-token', attemptCount: 1,
  snapshot: { version: 2, task: { courseId: 'course', studentId: 'student', requestId: 'request' } } } as QueuedBackgroundReview;
beforeEach(() => { vi.resetAllMocks(); mocks.renew.mockResolvedValue(true); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it('does not execute a task whose live ownership/stage guard fails', async () => {
  mocks.assert.mockRejectedValue(new DocumentReviewScopeChanged('REVIEW_STAGE_CHANGED'));
  const execute = vi.fn(); await runQueuedDocumentReview(job, new AbortController().signal, execute);
  expect(execute).not.toHaveBeenCalled(); expect(mocks.reschedule).toHaveBeenCalledWith(job, expect.objectContaining({ terminal: true, code: 'REVIEW_STAGE_CHANGED' }));
});
it('treats a foreign-bundle identity failure during prepared commit as terminal', async () => {
  vi.resetModules();
  const foreign = await vi.importActual<typeof import('./document-review-queue')>('./document-review-queue');
  const error = new foreign.DocumentReviewScopeChanged('REVIEW_IDENTITY_CHANGED');
  expect(error).not.toBeInstanceOf(DocumentReviewScopeChanged);
  await runQueuedDocumentReview(job, new AbortController().signal, async () => { throw error; });
  expect(mocks.reschedule).toHaveBeenCalledWith(job, expect.objectContaining({ terminal: true, code: 'REVIEW_IDENTITY_CHANGED' }));
  expect(foreign.isDocumentReviewScopeChanged(Object.assign(new Error('REVIEW_UNTRUSTED'), { code: 'REVIEW_UNTRUSTED' }))).toBe(false);
});
it('returns local capacity saturation to pending without consuming a model attempt', async () => {
  await runQueuedDocumentReview(job, new AbortController().signal, async () => { throw new BackgroundAiCapacityError(10_000); });
  expect(mocks.reschedule).toHaveBeenCalledWith(job, expect.objectContaining({ capacity: true, retryAfterMs: 10_000, terminal: false }));
});
it('keeps foreign-bundle admission errors out of the provider retry budget', async () => {
  vi.resetModules();
  const foreignBackground = await import('@/lib/llm/classroom-capacity');
  const foreignProactive = await import('./proactive-review-capacity');
  const foreignError = new foreignBackground.BackgroundAiCapacityError(12_000);
  expect(foreignError).not.toBeInstanceOf(BackgroundAiCapacityError);
  for (const error of [foreignError, new foreignProactive.ProactiveReviewCapacityError(12_000)]) {
    await runQueuedDocumentReview(job, new AbortController().signal, async () => { throw error; });
    expect(mocks.reschedule).toHaveBeenLastCalledWith(job, expect.objectContaining({ capacity: true, retryAfterMs: 12_000, terminal: false }));
  }
});
it('leaves completed receipts alone without rescheduling or retrying execution', async () => {
  const execute = vi.fn(async () => Response.json({ status: 'completed' }));
  await runQueuedDocumentReview(job, new AbortController().signal, execute);
  expect(execute).toHaveBeenCalledOnce(); expect(mocks.reschedule).not.toHaveBeenCalled();
});
it('reschedules a real provider failure separately from admission saturation', async () => {
  await runQueuedDocumentReview(job, new AbortController().signal, async () => Response.json({ error: 'AI_COLLABORATION_TIMEOUT' }, { status: 504 }));
  expect(mocks.reschedule).toHaveBeenCalledWith(job, expect.objectContaining({ code: 'AI_COLLABORATION_TIMEOUT', terminal: false }));
  expect(mocks.reschedule.mock.calls[0][1].capacity).toBeUndefined();
});
it('renews during work and aborts execution if the worker loses its lease', async () => {
  vi.useFakeTimers(); mocks.renew.mockResolvedValue(false);
  const execute = vi.fn((_job: QueuedBackgroundReview, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const work = runQueuedDocumentReview(job, new AbortController().signal, execute);
  await vi.advanceTimersByTimeAsync(30_000); await work;
  expect(mocks.renew).toHaveBeenCalledWith(job); expect(mocks.reschedule).toHaveBeenCalledWith(job, expect.objectContaining({ code: 'REVIEW_LEASE_LOST' }));
});
it('shutdown preserves the durable request and does not charge the retry budget', async () => {
  const stop = new AbortController(); stop.abort(); const execute = vi.fn();
  await runQueuedDocumentReview(job, stop.signal, execute);
  expect(execute).not.toHaveBeenCalled(); expect(mocks.reschedule).toHaveBeenCalledWith(job, expect.objectContaining({ stopped: true, code: 'REVIEW_WORKER_STOPPED' }));
});
it('does not advertise an unstarted worker as healthy', () => expect(documentReviewWorkerHealth()).toMatchObject({ ok: false }));
it('keeps the shared worker available when only new document reviews are disabled', async () => {
  vi.stubEnv('DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED', 'false');
  mocks.claim.mockResolvedValue(null);
  mocks.query.mockResolvedValue([{ waiting: BigInt(0), outstanding: BigInt(0), oldest: null }]);
  try {
    startDocumentReviewWorker();
    await vi.waitFor(() => expect(documentReviewWorkerHealth()).toEqual({ ok: true }));
    expect(mocks.claim).toHaveBeenCalled();
  } finally { await stopDocumentReviewWorker(); }
});
it('keeps old running work in the settlement age even when no pending job remains', async () => {
  const oldest = new Date(Date.now() - 6 * 60_000);
  mocks.query.mockResolvedValue([{ waiting: BigInt(0), outstanding: BigInt(1), oldest }]);
  expect(await readDocumentReviewBacklog()).toEqual({ queued: 0, oldestQueuedAt: oldest.getTime() });
  const query = (mocks.query.mock.calls[0][0] as TemplateStringsArray).join('?');
  expect(query).toContain("COUNT(*) FILTER (WHERE status = 'PENDING' OR");
  expect(query).toContain('"leaseUntil" <= statement_timestamp()');
  expect(query).toContain("status = 'FAILED' AND \"leaseUntil\" IS NOT NULL");
  expect(query).not.toMatch(/\b(input|output)\b|SELECT\s+\*/i);
  expect(query).toContain("status IN ('PENDING', 'RUNNING')");
  mocks.query.mockResolvedValue([{ waiting: BigInt(0), outstanding: BigInt(0), oldest: null }]);
  expect(await readDocumentReviewBacklog()).toEqual({ queued: 0, oldestQueuedAt: null });
});

it('reports recoverable expired leases as queued and retains the oldest unfinished failure', async () => {
  const oldest = new Date(Date.now() - 10 * 60_000);
  // SQL state categorization is independently covered by the native worker;
  // this checks monitor mapping does not collapse pending/recovery to zero.
  mocks.query.mockResolvedValue([{ waiting: BigInt(3), outstanding: BigInt(4), oldest }]);
  expect(await readDocumentReviewBacklog()).toEqual({ queued: 3, oldestQueuedAt: oldest.getTime() });
});

it('cancels retired document tasks without executing a provider or spending retries', async () => {
  const execute = vi.fn();
  await runQueuedDocumentReview({ ...job, snapshot: { ...job.snapshot, version: 1 } } as QueuedBackgroundReview, new AbortController().signal, execute);
  expect(execute).not.toHaveBeenCalled(); expect(mocks.assert).not.toHaveBeenCalled(); expect(mocks.reschedule).not.toHaveBeenCalled();
  expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ queueKey: 'document-review-v1', OR: [
      { input: { path: ['intent'], equals: 'proactive-document-comments' } },
      { input: { path: ['intent'], equals: 'proactive-document-comment' } },
    ] }),
    data: expect.objectContaining({ status: 'CANCELLED', error: 'DOCUMENT_AUTOMATIC_REVIEW_RETIRED', leaseUntil: null }),
  }));
});
