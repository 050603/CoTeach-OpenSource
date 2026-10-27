import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionResponseTracker, isCompletionResponseCleanupCancellation, isCompletionConsoleNavigationCancellation, inspectCompletionBrowserTraffic } from './completion-review-response-tracker.mjs';

function fixture() {
  const completed = []; const failures = [];
  const tracker = createCompletionResponseTracker({ completed: response => completed.push(response),
    failed: (metadata, error) => failures.push({ metadata, error }) });
  return { tracker, completed, failures };
}

test('the same native failed request releases a stuck response.finished waiter', async () => {
  const { tracker, completed, failures } = fixture(); const request = {};
  tracker.response({ request: () => request, finished: () => new Promise(() => {}) }, { path: '/api/lecture-chat' });
  tracker.requestFailed(request);
  await tracker.drain(50);
  assert.equal(tracker.pending.size, 0); assert.deepEqual(completed, []); assert.deepEqual(failures, []);
});

test('an unrelated cancellation does not hide a genuinely pending response', async () => {
  const { tracker } = fixture();
  tracker.response({ request: () => ({}), finished: () => new Promise(() => {}) }, { client: 'student-2', path: '/api/public-discussion' });
  tracker.requestFailed({});
  await assert.rejects(tracker.drain(10), /student-2.*public-discussion/);
  assert.equal(tracker.pending.size, 1);
});

test('cancellation delivered before response does not register a dangling waiter', async () => {
  const { tracker } = fixture(); const request = {};
  tracker.requestFailed(request);
  tracker.response({ request: () => request, finished: () => new Promise(() => {}) }, {});
  await tracker.drain(50); assert.equal(tracker.pending.size, 0);
});

test('a completed response is retained once', async () => {
  const { tracker, completed, failures } = fixture(); const request = {};
  const response = { request: () => request, finished: async () => null };
  tracker.response(response, {}); await tracker.drain(50);
  assert.deepEqual(completed, [response]); assert.deepEqual(failures, []);
});

test('a finished collector error remains an explicit failure', async () => {
  const { tracker, failures } = fixture(); const error = new Error('transport measurement failed');
  tracker.response({ request: () => ({}), finished: async () => { throw error; } }, { path: '/api/courses' });
  await tracker.drain(50);
  assert.deepEqual(failures, [{ metadata: { path: '/api/courses' }, error }]);
});

test('draining also waits for asynchronous response diagnostic collection', async () => {
  let release; let retained = false;
  const tracker = createCompletionResponseTracker({ completed: async () => {
    await new Promise(resolve => { release = resolve; }); retained = true;
  }, failed: error => { throw error; } });
  tracker.response({ request: () => ({}), finished: async () => null }, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracker.pending.size, 1); release(); await tracker.drain(50);
  assert.equal(retained, true); assert.equal(tracker.pending.size, 0);
});

test('only same-client successful response closed by the explicit context cleanup is a collector cancellation', () => {
  const windows = [{ client: 'layout', reason: 'context-close', startedAtMs: 100, finishedAtMs: 150 }];
  const metadata = { client: 'layout', receivedHttpStatus: 200 }; const error = new Error('Target page, context or browser has been closed');
  assert.equal(isCompletionResponseCleanupCancellation(metadata, error, windows, 120), true);
  assert.equal(isCompletionResponseCleanupCancellation({ ...metadata, client: 'other' }, error, windows, 120), false);
  assert.equal(isCompletionResponseCleanupCancellation({ ...metadata, receivedHttpStatus: 503 }, error, windows, 120), false);
  assert.equal(isCompletionResponseCleanupCancellation(metadata, new Error('ECONNRESET'), windows, 120), false);
  assert.equal(isCompletionResponseCleanupCancellation(metadata, error, [{ ...windows[0], reason: 'reload' }], 120), false);
  assert.equal(isCompletionResponseCleanupCancellation(metadata, error, windows, 2000), false);
});

test('presence cancellation requires the corresponding native abort in the explicit reload window; real timeout remains an error', () => {
  const windows = [{ client: 'student-1', reason: 'reload', startedAtMs: 100, finishedAtMs: 150 }];
  const entry = { client: 'student-1', at: 125, console: '[presence] synchronization failed TypeError: Failed to fetch' };
  const row = { client: 'student-1', path: '/api/courses/course/presence', status: 0, networkFailure: 'net::ERR_ABORTED', finishedAtMs: 126 };
  assert.equal(isCompletionConsoleNavigationCancellation(entry, windows, [row]), true);
  assert.equal(isCompletionConsoleNavigationCancellation(entry, [], [row]), false);
  assert.equal(isCompletionConsoleNavigationCancellation(entry, windows, [{ ...row, path: '/api/learning-events' }]), false);
  assert.equal(isCompletionConsoleNavigationCancellation(entry, windows, [{ ...row, networkFailure: 'net::ERR_CONNECTION_RESET' }]), false);
  assert.equal(isCompletionConsoleNavigationCancellation({ ...entry, console: '[session] Course synchronization failed: TypeError: 服务器响应超时' }, windows, [row]), false);
});

const timeoutConsole = overrides => ({ client: 'student-1', phase: 'review', at: 2000,
  console: '[session] Course synchronization failed: TypeError: 服务器响应超时，请检查网络后重试。\n    at bundled-script.js:1:12', ...overrides });
const projectionAbort = overrides => ({ client: 'student-1', phase: 'review', method: 'GET',
  path: '/api/courses/course/projection', status: 0, networkFailure: 'net::ERR_ABORTED',
  startedAtMs: 1250, finishedAtMs: 2000.1, elapsedMs: 750.1, timingSource: 'unavailable', ...overrides });

test('a current projection deadline is an API failure even beside a reload; raw abort and console evidence stay intact', () => {
  const entry = Object.freeze(timeoutConsole()), row = Object.freeze(projectionAbort());
  const windows = [{ client: entry.client, reason: 'reload', startedAtMs: 1000, finishedAtMs: 1800 }];
  const result = inspectCompletionBrowserTraffic([entry], windows, [row]);
  assert.deepEqual(result.navigationConsoleCancellations, []);
  assert.deepEqual(result.unexpectedBrowserErrors, [entry]);
  assert.equal(result.requestTimeouts.length, 1); assert.equal(result.requestTimeouts[0].request, row);
  assert.equal(result.requestTimeouts[0].console, entry);
  assert.ok(result.requestTimeouts[0].differenceMs < 1);
  assert.deepEqual(result.apiFailures, [{ ...row, failureKind: 'request-timeout', timeoutConsoleAtMs: entry.at }]);
  assert.equal(row.status, 0); assert.equal(row.networkFailure, 'net::ERR_ABORTED');
  assert.equal(row.failureKind, undefined);
});

test('timeout correlation requires the exact client, projection read, native abort and nearby completion', () => {
  const entry = timeoutConsole();
  for (const difference of [{ client: 'student-2' }, { path: '/api/courses/course/state' },
    { path: '/api/learning-events' }, { method: 'POST' }, { networkFailure: 'net::ERR_CONNECTION_RESET' },
    { status: 200 }, { finishedAtMs: 2250.01 }, { finishedAtMs: NaN }]) {
    assert.deepEqual(inspectCompletionBrowserTraffic([entry], [], [projectionAbort(difference)]).requestTimeouts, [], JSON.stringify(difference));
  }
  for (const difference of [{ at: NaN }, { console: '[session] Course synchronization failed: TypeError: Failed to fetch' },
    { console: '[presence] synchronization failed TypeError: 服务器响应超时' }]) {
    assert.deepEqual(inspectCompletionBrowserTraffic([timeoutConsole(difference)], [], [projectionAbort()]).requestTimeouts, []);
  }
});

test('a timeout crossing a test phase boundary keeps the request original phase and remains a real failure', () => {
  const entry = timeoutConsole(), row = projectionAbort({ phase: 'preparation' });
  const result = inspectCompletionBrowserTraffic([entry], [], [row]);
  assert.equal(result.requestTimeouts.length, 1); assert.equal(result.apiFailures[0].phase, 'preparation');
  assert.equal(result.unexpectedBrowserErrors[0].phase, 'review');
  assert.equal(inspectCompletionBrowserTraffic([entry], [], [row], 'preparation').apiFailures.length, 1);
  assert.equal(inspectCompletionBrowserTraffic([entry], [], [row], 'review').apiFailures.length, 0);
});

test('nearby events match once to their closest request without spreading one timeout across other aborts', () => {
  const entry = timeoutConsole(), nearest = projectionAbort(), other = projectionAbort({ finishedAtMs: 2050 });
  const duplicate = timeoutConsole({ at: 2001 });
  const result = inspectCompletionBrowserTraffic([entry, duplicate], [], [other, nearest]);
  assert.equal(result.requestTimeouts.length, 2);
  assert.equal(result.requestTimeouts[0].console, entry); assert.equal(result.requestTimeouts[0].request, nearest);
  assert.equal(result.requestTimeouts[1].console, duplicate); assert.equal(result.requestTimeouts[1].request, other);
  assert.equal(inspectCompletionBrowserTraffic([entry], [], [other, nearest]).apiFailures.length, 1);
  assert.equal(inspectCompletionBrowserTraffic([entry, duplicate], [], [nearest]).apiFailures.length, 1);
});

test('navigation cancellations keep their existing rules and a later successful retry cannot clear a timeout failure', () => {
  const navigation = timeoutConsole({ at: 1500, console: '[session] Course synchronization failed: TypeError: Failed to fetch' });
  const cancelled = projectionAbort({ finishedAtMs: 1500.1 });
  const entry = timeoutConsole(), timedOut = projectionAbort();
  const success = projectionAbort({ startedAtMs: 2100, finishedAtMs: 2150, status: 200, networkFailure: undefined });
  const result = inspectCompletionBrowserTraffic([navigation, entry], [{ client: entry.client, reason: 'reload', startedAtMs: 1400, finishedAtMs: 1600 }],
    [cancelled, timedOut, success]);
  assert.deepEqual(result.navigationConsoleCancellations, [navigation]);
  assert.deepEqual(result.unexpectedBrowserErrors, [entry]);
  assert.equal(result.apiFailures.length, 1); assert.equal(result.apiFailures[0].finishedAtMs, timedOut.finishedAtMs);
  const layout = inspectCompletionBrowserTraffic([navigation, entry], [], [cancelled, timedOut, success], 'layout');
  assert.deepEqual(layout.requestTimeouts, []); assert.deepEqual(layout.apiFailures, []); assert.deepEqual(layout.unexpectedBrowserErrors, []);
});
