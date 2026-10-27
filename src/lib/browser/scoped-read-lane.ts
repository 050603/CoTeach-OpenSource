/** One mounted scope owns this lane; nothing is retained after disposal.
 * Ordinary ticks join an in-flight read. Notifications request one trailing
 * fresh read, since a response already in flight cannot acknowledge them.
 */
export function createScopedReadLane(read: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let flight: Promise<void> | undefined;
  let fresh = false;
  return {
    request(needsFresh = false): Promise<void> {
      if (controller.signal.aborted) return Promise.resolve();
      if (flight) {
        fresh ||= needsFresh;
        return flight;
      }
      flight = Promise.resolve().then(async () => {
        try {
          if (controller.signal.aborted) return;
          let lastError: unknown;
          let failed = false;
          do {
            fresh = false;
            try { await read(controller.signal); failed = false; }
            catch (error) { lastError = error; failed = true; }
            // Failure itself never schedules retries. Only an actual subsequent
            // notification can request one more read; ordinary polling remains.
          } while (fresh && !controller.signal.aborted);
          if (failed && !controller.signal.aborted) throw lastError;
        } finally {
          // Release in the same continuation that ends the loop. An outer
          // Promise.finally leaves a microtask gap in which a fresh hint could
          // join a finished loop and be incorrectly acknowledged without a read.
          flight = undefined;
        }
      });
      return flight;
    },
    dispose() { fresh = false; controller.abort(); },
  };
}

/** Abort only this caller's wait; a caller must not cancel another subscriber
 * or the scope's ordinary poll. Scope disposal owns transport cancellation.
 */
export function waitForScopedRead(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Keep the original steady cadence; spread only the first poll phase. Initial
 * loads, realtime notifications and visibility recovery are never delayed.
 */
export function startPhasedPolling(tick: () => void, intervalMs: number): () => void {
  let interval: number | undefined;
  const first = window.setTimeout(() => {
    tick();
    interval = window.setInterval(tick, intervalMs);
  }, intervalMs * (0.8 + Math.random() * 0.2));
  return () => { window.clearTimeout(first); window.clearInterval(interval); };
}
