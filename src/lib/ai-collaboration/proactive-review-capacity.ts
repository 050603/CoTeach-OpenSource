import { isBackgroundAiCapacityError, withBackgroundAiPriority } from "@/lib/llm/classroom-capacity";
export class ProactiveReviewCapacityError extends Error {
  readonly code = 'PROACTIVE_REVIEW_CAPACITY';
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Proactive document review capacity is currently full');
    this.name = 'ProactiveReviewCapacityError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function isProactiveReviewCapacityError(error: unknown): error is ProactiveReviewCapacityError {
  return error instanceof Error && 'code' in error && error.code === 'PROACTIVE_REVIEW_CAPACITY'
    && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
    && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0;
}

type ProactiveReviewCapacity = {
  run<T>(operation: () => Promise<T>, requestKey?: string): Promise<T>;
  snapshot(): { active: number; limit: number };
};

type WaitingReview = { active: boolean; expiresAt: number };

export function createProactiveReviewCapacity(
  rawLimit: number,
  retryAfterMs = 5_000,
  options: { maxPending?: number; leaseMs?: number; now?: () => number } = {},
): ProactiveReviewCapacity {
  const limit = Math.max(1, Math.floor(rawLimit));
  const maxPending = Math.max(1, Math.floor(options.maxPending ?? 80));
  const leaseMs = Math.max(30_000, retryAfterMs * 3, options.leaseMs ?? 0);
  const now = options.now ?? (() => performance.now());
  // These are retry-order tickets, not queued HTTP/model operations. Busy
  // callers return immediately and retain their authenticated request's place.
  const tickets = new Map<string, WaitingReview>();
  let active = 0;
  return {
    async run<T>(operation: () => Promise<T>, requestKey?: string): Promise<T> {
      const at = now();
      for (const [key, ticket] of tickets) {
        if (!ticket.active && ticket.expiresAt <= at) tickets.delete(key);
      }
      let ticket = requestKey === undefined ? undefined : tickets.get(requestKey);
      if (ticket?.active) throw new ProactiveReviewCapacityError(retryAfterMs);
      if (requestKey !== undefined && !ticket) {
        const pending = [...tickets.values()].filter(item => !item.active).length;
        if (pending >= maxPending) throw new ProactiveReviewCapacityError(retryAfterMs);
        ticket = { active: false, expiresAt: at + leaseMs };
        tickets.set(requestKey, ticket);
      }
      if (ticket) ticket.expiresAt = at + leaseMs;
      const waiting = [...tickets.values()].filter(item => !item.active);
      const position = ticket ? waiting.indexOf(ticket) : waiting.length;
      // Reserve available background slots for the oldest live retry tickets.
      // A caller without a ticket may use only capacity those tickets do not need.
      if (active >= limit || position >= limit - active) {
        throw new ProactiveReviewCapacityError(retryAfterMs);
      }
      active += 1;
      if (ticket) ticket.active = true;
      let retainPlace = false;
      try {
        return await withBackgroundAiPriority(operation);
      } catch (error) {
        if (isBackgroundAiCapacityError(error)) {
          retainPlace = true;
          if (ticket) ticket.expiresAt = now() + Math.max(leaseMs, error.retryAfterMs + 5_000);
          throw new ProactiveReviewCapacityError(error.retryAfterMs);
        }
        throw error;
      } finally {
        active -= 1;
        if (ticket) {
          if (retainPlace) ticket.active = false;
          else tickets.delete(requestKey!);
        }
      }
    },
    snapshot: () => ({ active, limit }),
  };
}

export function resolveProactiveReviewConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PROACTIVE_REVIEW_LLM_CONCURRENCY ?? '', 10);
  // At the default global limit 40, eight background calls leave room for
  // the whole 30-student interactive batch plus two reserved slots.
  if (!Number.isFinite(configured) || configured <= 0) return 8;
  return Math.min(20, Math.max(1, configured));
}

declare global {
  var __openPblProactiveReviewCapacity: ProactiveReviewCapacity | undefined;
}

const capacity = globalThis.__openPblProactiveReviewCapacity
  ?? createProactiveReviewCapacity(resolveProactiveReviewConcurrency());
globalThis.__openPblProactiveReviewCapacity = capacity;

export function withProactiveReviewCapacity<T>(operation: () => Promise<T>, requestKey?: string): Promise<T> {
  return capacity.run(operation, requestKey);
}

/** Read-only scheduler hint; the gate remains authoritative for races. */
export const proactiveReviewCapacitySnapshot = capacity.snapshot;
