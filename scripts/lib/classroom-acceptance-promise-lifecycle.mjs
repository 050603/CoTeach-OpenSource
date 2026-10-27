/** Observe a pre-created waiter immediately without changing its later await.
 * A failed click/closed browser must not leave the separate response promise
 * unobserved while the caller is still awaiting that click.
 */
export function observePendingResponse(promise) {
  void promise.catch(() => undefined);
  return promise;
}

/** Installed only after controlled interruption begins. Closing a browser can
 * reject detached waiters while the driver must still stop writers and preserve
 * its disposable database. These remain failed diagnostics, never test passes.
 * Normal execution (before/after this scope) keeps Node's fatal default.
 */
export function withCleanupRejectionGuard(operation, onRejected) {
  const rejected = reason => {
    try { onRejected(reason); } catch { /* Diagnostic sinks must not interrupt evidence preservation. */ }
  };
  process.on('unhandledRejection', rejected);
  return Promise.resolve().then(operation).finally(() => {
    process.off('unhandledRejection', rejected);
  });
}
