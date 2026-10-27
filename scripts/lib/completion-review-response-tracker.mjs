export function isCompletionResponseCleanupCancellation(metadata, error, windows, atMs) {
  return metadata.receivedHttpStatus >= 200 && metadata.receivedHttpStatus < 400
    && /Target (?:page, context or browser has been closed|closed)/.test(error.message)
    && windows.some(window => window.client === metadata.client && window.reason === 'context-close'
      && atMs >= window.startedAtMs && atMs <= (window.finishedAtMs ?? atMs) + 1500);
}

export function isCompletionConsoleNavigationCancellation(entry, windows, traffic) {
  if (typeof entry.console !== 'string') return false;
  let matchesPath;
  if (/Learning event synchronization failed: TypeError: Failed to fetch/.test(entry.console)) matchesPath = path => path === '/api/learning-events';
  else if (/Course synchronization failed: TypeError: Failed to fetch/.test(entry.console)) matchesPath = path => /^\/api\/courses(?:\/[^/]+\/(?:state|events|projection))?$/.test(path);
  else if (/\[presence\] synchronization failed TypeError: Failed to fetch/.test(entry.console)) matchesPath = path => /^\/api\/courses\/[^/]+\/presence$/.test(path);
  else return false;
  return windows.some(window => window.client === entry.client && entry.at >= window.startedAtMs && entry.at <= (window.finishedAtMs ?? Infinity) + 1500)
    && traffic.some(row => row.client === entry.client && matchesPath(row.path)
      && row.status === 0 && row.networkFailure === 'net::ERR_ABORTED' && Math.abs(row.finishedAtMs - entry.at) < 2000);
}

/** A native abort alone cannot distinguish navigation from boundedFetch's
 * deadline. Match the explicit session timeout to one same-client
 * projection abort. Collector callbacks may arrive in either order; keep a
 * narrow window and choose the closest pair without reusing either record.
 * Raw browser and request evidence is never changed.
 */
export function inspectCompletionBrowserTraffic(browserErrors, windows, traffic, onlyPhase) {
  const timeoutPattern = /^\[session\] Course synchronization failed:\s+TypeError: 服务器响应超时(?:，请检查网络后重试。)?(?:\n|$)/;
  const candidates = [];
  for (const console of browserErrors) {
    if (!timeoutPattern.test(console.console ?? '') || !Number.isFinite(console.at)) continue;
    for (const request of traffic) {
      if (request.client !== console.client || request.method !== 'GET' || !/^\/api\/courses\/[^/]+\/projection$/.test(request.path)
        || request.status !== 0 || request.networkFailure !== 'net::ERR_ABORTED'
        || !Number.isFinite(request.finishedAtMs)) continue;
      const differenceMs = Math.abs(request.finishedAtMs - console.at);
      if (differenceMs <= 250) candidates.push({ console, request, differenceMs });
    }
  }
  candidates.sort((left, right) => left.differenceMs - right.differenceMs);
  const matchedConsoles = new Set(), matchedRequests = new Set(), timeouts = [];
  for (const match of candidates) {
    if (matchedConsoles.has(match.console) || matchedRequests.has(match.request)) continue;
    matchedConsoles.add(match.console); matchedRequests.add(match.request); timeouts.push(match);
  }
  const inPhase = row => !onlyPhase || row.phase === onlyPhase;
  const navigationConsoleCancellations = browserErrors.filter(entry => isCompletionConsoleNavigationCancellation(entry, windows, traffic));
  const timeoutByRequest = new Map(timeouts.map(match => [match.request, match]));
  return {
    navigationConsoleCancellations,
    requestTimeouts: timeouts.filter(match => inPhase(match.request)),
    unexpectedBrowserErrors: browserErrors.filter(entry => inPhase(entry) && !navigationConsoleCancellations.includes(entry)),
    apiFailures: traffic.filter(row => inPhase(row) && (row.status >= 400 || (row.status === 0
      && (row.networkFailure !== 'net::ERR_ABORTED' || matchedRequests.has(row)))))
      .map(row => timeoutByRequest.has(row) ? { ...row, failureKind: 'request-timeout',
        timeoutConsoleAtMs: timeoutByRequest.get(row).console.at } : row),
  };
}

/** Playwright may leave response.finished() unresolved after native navigation
 * cancellation. Settle only the same Request; unrelated or genuinely pending
 * responses retain their diagnostic deadline. */
export function createCompletionResponseTracker({ completed, failed }) {
  const pending = new Map();
  const aborted = new WeakSet();
  const abortWaiters = new WeakMap();
  return {
    pending,
    requestFailed(request) {
      aborted.add(request);
      abortWaiters.get(request)?.({ aborted: true });
    },
    response(response, metadata) {
      const request = response.request();
      if (aborted.has(request)) return;
      const cancellation = new Promise(resolve => abortWaiters.set(request, resolve));
      const completion = Promise.resolve().then(() => response.finished()).then(error => ({ error }));
      const job = Promise.race([completion, cancellation]).then(result => {
        if (result.aborted || aborted.has(request)) return;
        if (result.error) failed(metadata, result.error);
        else return completed(response);
      }).catch(error => failed(metadata, error)).finally(() => {
        pending.delete(job); abortWaiters.delete(request);
      });
      pending.set(job, metadata);
    },
    async drain(timeoutMs) {
      let deadline;
      try {
        await Promise.race([Promise.allSettled([...pending.keys()]), new Promise((resolve, reject) => {
          void resolve;
          deadline = setTimeout(() => reject(new Error(`API responses did not finish: ${JSON.stringify([...pending.values()])}`)), timeoutMs);
        })]);
      } finally { clearTimeout(deadline); }
    },
  };
}
