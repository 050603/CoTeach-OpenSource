import type { Prisma } from '@prisma/client';

/** Metadata-only occupancy shared by admission and worker monitoring.
 * Running tasks reserve the configured execution slots separately from waiting
 * work. A queued FAILED row with a lease is still owned by the executor while
 * recording its failure audit; only FAILED with no lease is truly terminal.
 * Recovery may put admitted reservations back into PENDING. It never discards
 * them to meet a bound: no new admission occurs until waiting is below its cap.
 */
export async function readDocumentReviewQueueCounts(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  queueKey: string,
): Promise<{ waiting: bigint; outstanding: bigint; oldest: Date | null }> {
  const [counts] = await db.$queryRaw<Array<{ waiting: bigint; outstanding: bigint; oldest: Date | null }>>`
    SELECT COUNT(*) FILTER (WHERE status = 'PENDING' OR "leaseUntil" IS NULL
      OR "leaseUntil" <= statement_timestamp()) AS waiting,
      COUNT(*) AS outstanding, MIN("createdAt") AS oldest
    FROM "AiTask" WHERE "queueKey" = ${queueKey}
      AND (status IN ('PENDING', 'RUNNING') OR (status = 'FAILED' AND "leaseUntil" IS NOT NULL))`;
  if (!counts) throw new Error('Document review capacity count unavailable');
  return counts;
}

/** Admission callers hold the queue advisory transaction lock; monitoring may read without it. */
export async function hasDocumentReviewAdmissionCapacity(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  queueKey: string,
  maxWaiting: number,
  concurrency: number,
): Promise<boolean> {
  const counts = await readDocumentReviewQueueCounts(db, queueKey);
  return counts.waiting < BigInt(maxWaiting)
    && counts.outstanding < BigInt(maxWaiting + concurrency);
}
