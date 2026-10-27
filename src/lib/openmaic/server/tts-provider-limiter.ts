type WaitingTask = {
  start: () => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type ProviderPool = {
  active: number;
  limit: number;
  queue: WaitingTask[];
  minStartIntervalMs: number;
  nextStartAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const POOLS_KEY = Symbol.for('openpbl.tts-provider-pools.v2');
const scope = globalThis as typeof globalThis & { [POOLS_KEY]?: Map<string, ProviderPool> };
const pools = scope[POOLS_KEY] ??= new Map<string, ProviderPool>();
const MAX_WAITERS = 256;
const MAX_POOLS = 128;

export class TtsCapacityError extends Error {
  readonly statusCode = 503;
  readonly retryAfterMs = 1000;
  constructor() { super('语音合成队列已满，请稍后重试'); this.name = 'TtsCapacityError'; }
}

function pump(pool: ProviderPool): void {
  while (pool.active < pool.limit && pool.queue.length > 0) {
    const remaining = pool.nextStartAt - performance.now();
    if (remaining > 0) {
      pool.timer ??= setTimeout(() => { pool.timer = undefined; pump(pool); }, remaining);
      return;
    }
    const waiting = pool.queue.shift()!;
    if (waiting.onAbort) waiting.signal?.removeEventListener("abort", waiting.onAbort);
    if (waiting.signal?.aborted) {
      waiting.reject(waiting.signal.reason ?? new DOMException("Aborted", "AbortError"));
      continue;
    }
    pool.active += 1;
    pool.nextStartAt = performance.now() + pool.minStartIntervalMs;
    waiting.start();
  }
}

/**
 * Enforce one provider's configured concurrency across every classroom and
 * adaptive branch in this server process. Per-classroom pools alone can burst
 * far beyond a shared API-key quota when several resources generate together.
 */
export function runWithGlobalTtsProviderSlot<T>(
  providerId: string,
  limit: number,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  options: { minStartIntervalMs?: number } = {},
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (!pools.has(providerId) && pools.size >= MAX_POOLS) {
    for (const [key, candidate] of pools) {
      if (!candidate.active && !candidate.queue.length && candidate.nextStartAt <= performance.now()) {
        clearTimeout(candidate.timer); pools.delete(key);
      }
    }
    if (pools.size >= MAX_POOLS) return Promise.reject(new TtsCapacityError());
  }
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const pool = pools.get(providerId) ?? { active: 0, limit: safeLimit, queue: [], minStartIntervalMs: 0, nextStartAt: 0 };
  pool.limit = Math.min(pool.limit, safeLimit);
  const interval = options.minStartIntervalMs ?? 0;
  if (Number.isFinite(interval)) pool.minStartIntervalMs = Math.max(pool.minStartIntervalMs, Math.max(0, interval));
  pools.set(providerId, pool);
  if (pool.queue.length >= MAX_WAITERS) return Promise.reject(new TtsCapacityError());

  return new Promise<T>((resolve, reject) => {
    const waiting: WaitingTask = {
      signal,
      reject,
      start: () => {
        Promise.resolve().then(operation).then(resolve, reject).finally(() => {
          pool.active -= 1;
          pump(pool);
        });
      },
    };
    waiting.onAbort = () => {
      const index = pool.queue.indexOf(waiting);
      if (index >= 0) pool.queue.splice(index, 1);
      signal?.removeEventListener('abort', waiting.onAbort!);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      pump(pool);
    };
    signal?.addEventListener("abort", waiting.onAbort, { once: true });
    pool.queue.push(waiting);
    pump(pool);
  });
}
