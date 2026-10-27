// Pino-backed structured logger with request-scoped context.
//
// Exports:
//   logger              - default root logger (no module binding)
//   createChildLogger() - child logger bound to a module name + optional ctx
//   setRequestContext() - merge values into the active request context
//   clearRequestContext()- reset (used at request end)
//
// Request context is propagated via AsyncLocalStorage (see request-id.ts).
// The pino `mixin` hook injects traceId / spanId / userId / courseId into
// every log line without callers having to pass them explicitly.

import pino, { type Logger } from "pino";
import { buildLoggerOptions } from "./pino-config";
import { getRequestContext, type RequestContext } from "./request-id";

/**
 * Mixin: called by pino on every log call. Pulls the current request context
 * (if any) and exposes traceId / spanId / userId / courseId as fields.
 */
function requestMixin(): object {
  const ctx = getRequestContext();
  if (!ctx) return {};
  return {
    traceId: ctx.traceId,
    ...(ctx.spanId ? { spanId: ctx.spanId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(ctx.courseId ? { courseId: ctx.courseId } : {}),
  };
}

const rootOptions = buildLoggerOptions();

const rootLogger: Logger = pino({
  ...rootOptions,
  mixin: requestMixin,
});

export { rootLogger };

/** Default logger. Re-exported as `logger` for ergonomic imports. */
export const logger: Logger = rootLogger;

/**
 * Create a child logger bound to a module name (e.g. "llm", "tts", "db").
 * Additional bindings (e.g. { courseId }) are merged into every line.
 */
export function createChildLogger(
  module: string,
  bindings?: Record<string, unknown>,
): Logger {
  return rootLogger.child({ module, ...(bindings ?? {}) });
}

/**
 * Merge values into the active request context. Use this from middleware /
 * route handlers that already run inside a `withRequestContext` block to
 * progressively enrich the context (e.g. add `userId` after auth).
 *
 * NOTE: This is a no-op when called outside an active request context —
 * AsyncLocalStorage cannot retroactively wrap the current call stack. To
 * establish a context for a request, wrap the handler in
 * `withRequestContext({ traceId }, () => handler())`.
 */
export function setRequestContext(
  ctx: Partial<RequestContext>,
): void {
  const current = getRequestContext();
  if (!current) return;
  // Mutate in place so all loggers see the updated values. AsyncLocalStorage
  // content is shared by reference within the same run() scope.
  Object.assign(current, ctx);
}

/**
 * Reset the current request context's mutable fields. Safe to call when no
 * context is active.
 */
export function clearRequestContext(): void {
  const current = getRequestContext();
  if (!current) return;
  current.userId = undefined;
  current.courseId = undefined;
  current.spanId = undefined;
}

export type { Logger } from "pino";
