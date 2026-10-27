// Process lifecycle management for graceful shutdown (Stage 7).
//
// When the orchestrator (k8s / docker / systemd) sends SIGTERM, we want to:
//   1. Stop accepting new requests (health checks flip to 503 so the LB
//      drains traffic from this pod).
//   2. Let in-flight requests finish — within a bounded budget.
//   3. Run any registered cleanup hooks (persist long-task state, close
//      WebSocket clients, release DB connections, ...).
//   4. Exit cleanly with code 0.
//
// This module is the single source of truth for "is the process shutting
// down?". Route handlers and long-running tasks poll `isShuttingDown()` and
// bail out early when it flips to true.
//
// Only the Node.js runtime ever enters this code path — `instrumentation.ts`
// guards the SIGTERM/SIGINT handlers with `process.env.NEXT_RUNTIME === "nodejs"`
// so the Edge runtime never touches `process`.

import { logger } from "@/lib/observability/logger";

/** Total budget for the entire shutdown sequence. Must fit inside the
 *  orchestrator's grace period (k8s terminationGracePeriodSeconds, docker
 *  stop_grace_period, ...). We leave a 5s margin for the very last
 *  `process.exit()` and any OS-level teardown, hence 25s here maps cleanly
 *  to a 30s grace period. */
export const SHUTDOWN_TIMEOUT_MS = 25_000;

/** Default per-hook timeout. Individual hooks can override via the `timeout`
 *  option, but no single hook is allowed to consume the whole budget. */
const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

type ShutdownHook = {
  name: string;
  fn: () => Promise<void>;
  timeoutMs: number;
};

const shutdownHooks: ShutdownHook[] = [];
let shutdownStarted = false;
let shutdownComplete = false;
let shutdownResolve: (() => void) | null = null;
const shutdownPromise = new Promise<void>((resolve) => {
  shutdownResolve = resolve;
});

/** True once shutdown has been triggered (SIGTERM/SIGINT received or
 *  `beginShutdown()` called explicitly). Route handlers should poll this and
 *  return 503 / close streams when it flips. */
export function isShuttingDown(): boolean {
  return shutdownStarted;
}

/** True once all shutdown hooks have finished (or timed out) and the process
 *  is about to exit. Useful in tests / for diagnostics. */
export function isShutdownComplete(): boolean {
  return shutdownComplete;
}

/**
 * Register a cleanup hook to run during shutdown. Hooks run sequentially in
 * registration order. Each hook gets its own timeout (default 5s); if it
 * exceeds the timeout, we log a warning and move on — no single hook is
 * allowed to wedge the whole sequence.
 *
 * Registration is ignored (with a warning) once shutdown has already started,
 * so late importers don't try to add hooks mid-shutdown.
 */
export function registerShutdownHook(
  name: string,
  fn: () => Promise<void>,
  options?: { timeout?: number },
): void {
  if (shutdownStarted) {
    logger.warn(
      { hook: name },
      "shutdown already in progress; hook registration ignored",
    );
    return;
  }
  shutdownHooks.push({
    name,
    fn,
    timeoutMs: options?.timeout ?? DEFAULT_HOOK_TIMEOUT_MS,
  });
}

/**
 * Trigger the shutdown sequence. Idempotent — calling it again while a
 * shutdown is already in flight just awaits the existing promise.
 *
 * Returns when all hooks have completed or timed out. The caller
 * (`instrumentation.ts`) is then responsible for any final cleanup
 * (close WebSocket, disconnect Prisma) and `process.exit(0)`.
 */
export async function beginShutdown(reason?: string): Promise<void> {
  if (shutdownStarted) {
    return shutdownPromise;
  }
  shutdownStarted = true;
  logger.info({ reason, hooks: shutdownHooks.length }, "graceful shutdown started");

  for (const hook of shutdownHooks) {
    await runHookWithTimeout(hook);
  }

  shutdownComplete = true;
  logger.info("graceful shutdown hooks complete");
  if (shutdownResolve) {
    shutdownResolve();
    shutdownResolve = null;
  }
}

/**
 * Wait until the shutdown sequence finishes (all hooks done or timed out).
 * Resolves immediately if shutdown has already completed.
 */
export function waitForShutdown(): Promise<void> {
  return shutdownPromise;
}

async function runHookWithTimeout(hook: ShutdownHook): Promise<void> {
  const start = Date.now();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  await new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn(
        { hook: hook.name, timeoutMs: hook.timeoutMs },
        "shutdown hook timed out; continuing",
      );
      resolve();
    }, hook.timeoutMs);

    Promise.resolve()
      .then(() => hook.fn())
      .then(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        logger.info(
          { hook: hook.name, ms: Date.now() - start },
          "shutdown hook completed",
        );
        resolve();
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        logger.warn(
          {
            hook: hook.name,
            ms: Date.now() - start,
            err: err instanceof Error ? err.message : String(err),
          },
          "shutdown hook failed; continuing",
        );
        resolve();
      });
  });
}
