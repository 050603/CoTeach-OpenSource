// Request-scoped context (traceId / userId / courseId) backed by
// AsyncLocalStorage. Used by the pino logger's `mixin` to inject context
// fields into every log line of the request without explicit threading.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  traceId: string;
  spanId?: string;
  userId?: string;
  courseId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Generate a fresh traceId (UUIDv4, no dashes-stripped to keep it readable). */
export function generateTraceId(): string {
  return randomUUID();
}

/** Generate a fresh spanId (8 hex chars). */
export function generateSpanId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Returns the currently active request context, or undefined if called
 * outside of a `withRequestContext` block.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Run `fn` inside a request context. The context is preserved across
 * `await` boundaries within `fn`.
 */
export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(ctx, fn);
}
