import { expect, it, vi } from 'vitest';
import { hasDocumentReviewAdmissionCapacity } from './document-review-admission';

it.each([
  // No execution slots may be treated as extra new waiting capacity.
  { waiting: 79, outstanding: 79, concurrency: 8, admitted: true },
  { waiting: 80, outstanding: 80, concurrency: 8, admitted: false },
  // Eight active reservations leave the full eighty-slot waiting budget.
  { waiting: 79, outstanding: 87, concurrency: 8, admitted: true },
  { waiting: 80, outstanding: 88, concurrency: 8, admitted: false },
  // Retained reservations and configuration decreases cannot over-admit.
  { waiting: 79, outstanding: 88, concurrency: 8, admitted: false },
  { waiting: 79, outstanding: 87, concurrency: 2, admitted: false },
  { waiting: 79, outstanding: 81, concurrency: 2, admitted: true },
  { waiting: 79, outstanding: 99, concurrency: 20, admitted: true },
  { waiting: 88, outstanding: 88, concurrency: 8, admitted: false },
])('preserves independent waiting/execution bounds: %j', async row => {
  const $queryRaw = vi.fn().mockResolvedValue([{ waiting: BigInt(row.waiting), outstanding: BigInt(row.outstanding) }]);
  expect(await hasDocumentReviewAdmissionCapacity({ $queryRaw }, 'document-review-v1', 80, row.concurrency)).toBe(row.admitted);
  expect($queryRaw).toHaveBeenCalledOnce();
});

it('counts only metadata and includes retained failure leases without loading immutable inputs', async () => {
  const $queryRaw = vi.fn().mockResolvedValue([{ waiting: BigInt(0), outstanding: BigInt(0) }]);
  await hasDocumentReviewAdmissionCapacity({ $queryRaw }, 'document-review-v1', 80, 8);
  const [parts, ...values] = $queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const sql = parts.join('?');
  expect(values).toEqual(['document-review-v1']);
  expect(sql).toContain("status = 'FAILED' AND \"leaseUntil\" IS NOT NULL");
  expect(sql).toContain('"leaseUntil" <= statement_timestamp()');
  expect(sql).not.toMatch(/\b(input|output)\b|SELECT\s+\*/i);
});

it('does not silently admit if the aggregate result is unavailable', async () => {
  await expect(hasDocumentReviewAdmissionCapacity({ $queryRaw: vi.fn().mockResolvedValue([]) }, 'document-review-v1', 80, 8)).rejects.toThrow('capacity count unavailable');
});
