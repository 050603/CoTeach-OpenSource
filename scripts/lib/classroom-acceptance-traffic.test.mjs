import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClassroomRequest, summarizeClassroomTraffic, summarizeClassroomAiTraffic, measureClassroomRequestTiming, isClassroomObservedRequestPath } from './classroom-acceptance-traffic.mjs';

const row = overrides => ({ client: 'student-1', phase: 'make', path: '/api/courses/example/actions', method: 'POST',
  operation: 'UPDATE_COURSE', category: 'write', status: 200, elapsedMs: 100, startedAtMs: 1000, finishedAtMs: 1100, ...overrides });
const summary = rows => Object.values(summarizeClassroomTraffic(rows, 'make'))[0];

test('immutable Monaco assets retain the same completed read gates and transport failure evidence', () => {
  const base = `/_next/static/openpbl-runtime/monaco/0.56.0/${'a'.repeat(64)}/vs`;
  for (const suffix of ['loader.js', 'base/worker/workerMain.js', 'editor/editor.main.css', 'base/browser/ui/codicons/codicon/codicon.ttf']) {
    const path = `${base}/${suffix}`;
    assert.equal(isClassroomObservedRequestPath(path), true);
    for (const method of ['GET', 'HEAD']) {
      const classified = classifyClassroomRequest({ path, method });
      assert.equal(classified.category, 'read');
      const result = summary([row({ ...classified, path, method, elapsedMs: 1300 }),
        row({ ...classified, path, method, status: 0, networkFailure: 'net::ERR_CONNECTION_RESET', elapsedMs: 1400 }),
        row({ ...classified, path, method, status: 0, networkFailure: 'net::ERR_ABORTED' })]);
      assert.equal(result.p95Ms, 1400); assert.equal(result.samples, 2);
      assert.equal(result.failures, 1); assert.equal(result.cancellations, 1);
    }
  }
  for (const path of ['/api/courses/private/state', '/api/openmaic/interactive-runtime/monaco/0.56.0/loader.js']) {
    assert.equal(isClassroomObservedRequestPath(path), true);
  }
  for (const path of ['/private/course/file.js', '/_next/static/chunks/app.js', `${base}/`, `${base}/../private`,
    `${base}/./loader.js`, `${base}/nested//loader.js`, `${base}/loader.js?private=true`,
    base.replace('a'.repeat(64), 'a'.repeat(63)) + '/loader.js',
    base.replace('/0.56.0/', '/unversioned/') + '/loader.js']) {
    assert.equal(isClassroomObservedRequestPath(path), false, path);
  }
});

test('native network duration retains slow driver observations without making them network latency', () => {
  const measured = measureClassroomRequestTiming({ startTime: 100000, responseStart: 50, responseEnd: 53 }, 1000, 1814);
  assert.equal(measured.elapsedMs, 53); assert.equal(measured.observerElapsedMs, 814);
  assert.equal(measured.nativeFinishedAtEpochMs, 100053);
  const result = summary([row(measured)]);
  assert.equal(result.p95Ms, 53); assert.equal(result.observerP95Ms, 814); assert.equal(result.unmeasured, 0);
});

test('a genuinely slow network request cannot use a faster observer value', () => {
  const result = summary([row(measureClassroomRequestTiming({ startTime: 100000, responseStart: 1200, responseEnd: 1300 }, 1000, 1100))]);
  assert.equal(result.p95Ms, 1300); assert.equal(result.observerP95Ms, 100);
});

test('missing and incomplete network clocks remain unmeasured, including within a retry chain', () => {
  for (const timing of [null, {}, { startTime: 100000, responseStart: 50, responseEnd: -1 },
    { startTime: -1, responseStart: 50, responseEnd: 53 }, { startTime: 100000, responseStart: -1, responseEnd: 53 },
    { startTime: 100000, responseStart: 50, responseEnd: 40 }]) {
    const missing = row(measureClassroomRequestTiming(timing, 1000, 1100));
    const result = summary([missing]);
    assert.equal(result.samples, 0); assert.equal(result.p95Ms, null); assert.equal(result.unmeasured, 1);
    const retried = summary([{ ...missing, requestId: 'same', status: 409, errorCode: 'VERSION_CONFLICT' },
      row({ requestId: 'same', finishedAtMs: 1500, ...measureClassroomRequestTiming(
        { startTime: 100400, responseStart: 50, responseEnd: 100 }, 1400, 1500) })]);
    assert.equal(retried.samples, 0); assert.equal(retried.unmeasured, 1);
  }
});

test('native retry clocks still include all backoff instead of summing only HTTP durations', () => {
  const result = summary([row({ requestId: 'same', status: 409, errorCode: 'VERSION_CONFLICT',
    ...measureClassroomRequestTiming({ startTime: 100000, responseStart: 50, responseEnd: 100 }, 1000, 1100) }),
  row({ requestId: 'same', startedAtMs: 1400, finishedAtMs: 1500,
    ...measureClassroomRequestTiming({ startTime: 100400, responseStart: 50, responseEnd: 100 }, 1400, 1500) })]);
  assert.equal(result.p95Ms, 500); assert.equal(result.observerP95Ms, 500); assert.equal(result.recoveredConflicts, 1);
});
test('a recovered version conflict includes backoff and every attempt in its elapsed time', () => {
  const result = summary([row({ status: 409, errorCode: 'VERSION_CONFLICT', requestId: 'same' }),
    row({ requestId: 'same', startedAtMs: 1180, finishedAtMs: 1380, elapsedMs: 200 })]);
  assert.equal(result.p95Ms, 380); assert.equal(result.failures, 0);
  assert.equal(result.firstAttemptFailures, 1); assert.equal(result.recoveredConflicts, 1);
});
test('another student or another request cannot mask an unrecovered conflict', () => {
  for (const other of [{ client: 'student-2' }, { requestId: 'different' }]) {
    const result = summary([row({ status: 409, errorCode: 'VERSION_CONFLICT', requestId: 'same' }),
      row({ requestId: 'same', ...other })]);
    assert.equal(result.failures, 1);
  }
});
test('a recovered optimistic conflict cannot hide a server error in its retry chain', () => {
  const result = summary([row({ requestId: 'same', status: 409, errorCode: 'VERSION_CONFLICT' }),
    row({ requestId: 'same', status: 500, startedAtMs: 1180, finishedAtMs: 1280 }),
    row({ requestId: 'same', startedAtMs: 1360, finishedAtMs: 1460 })]);
  assert.equal(result.p95Ms, 460); assert.equal(result.failures, 1); assert.equal(result.recoveredConflicts, 1);
});
test('cancellation is retained separately and does not fabricate a completed latency sample', () => {
  const result = summary([row({ status: 0, networkFailure: 'net::ERR_ABORTED' })]);
  assert.equal(result.samples, 0); assert.equal(result.p95Ms, null); assert.equal(result.cancellations, 1);
  assert.equal(summary([row({ status: 0, networkFailure: 'net::ERR_CONNECTION_REFUSED' })]).failures, 1);
});
test('a separately proven deadline abort remains failed and unmeasured instead of becoming navigation cancellation or a completed sample', () => {
  const deadline = Object.freeze(row({ method: 'GET', operation: 'GET', category: 'read', path: '/api/courses/example/projection',
    status: 0, networkFailure: 'net::ERR_ABORTED', timingSource: 'unavailable', elapsedMs: 530 }));
  const cancelled = { ...deadline, startedAtMs: 2000, finishedAtMs: 2050 };
  const success = { ...deadline, startedAtMs: 3000, finishedAtMs: 3100, status: 200, networkFailure: undefined,
    elapsedMs: 100, timingSource: 'browser-resource-timing' };
  const options = { timeoutRequests: new Set([deadline]) };
  const result = Object.values(summarizeClassroomTraffic([deadline, cancelled, success], 'make', options))[0];
  assert.equal(result.failures, 1); assert.equal(result.timeouts, 1); assert.equal(result.unmeasured, 1);
  assert.equal(result.cancellations, 1); assert.equal(result.samples, 1); assert.equal(result.p95Ms, 100);
  const onlyTimeout = Object.values(summarizeClassroomTraffic([deadline], 'make', options))[0];
  assert.equal(onlyTimeout.p95Ms, null); assert.equal(onlyTimeout.samples, 0); assert.equal(onlyTimeout.failures, 1);
  assert.equal(summary([deadline]).cancellations, 1, 'Existing callers retain their default cancellation policy');
  assert.equal(deadline.networkFailure, 'net::ERR_ABORTED'); assert.equal(deadline.elapsedMs, 530);
});
test('an inactive showcase response is expected only during an observed stage transition', () => {
  const inactive = row({ path: '/api/courses/example/showcase/presentation', method: 'GET', operation: 'GET', category: 'read', status: 409, errorCode: 'SHOWCASE_INACTIVE' });
  assert.equal(summary([inactive]).failures, 1);
  assert.equal(summary([{ ...inactive, stageTransition: true }]).expectedBoundaryResponses, 1);
});


test('non-model history, cached explanations, learning events and progress retain ordinary latency gates', () => {
  for (const path of ['/api/courses/course/lecture-chat', '/api/ai-collaboration/document', '/api/ai-collaboration/code']) {
    assert.equal(classifyClassroomRequest({ path, method: 'GET' }).category, 'read');
    assert.equal(classifyClassroomRequest({ path, method: 'POST', body: { requestId: 'real-ai' } }).category, 'ai-or-quiz');
  }
  assert.equal(classifyClassroomRequest({ path: '/api/knowledge-lecture', method: 'POST', body: { action: 'tutor-explain' } }).category, 'read');
  for (const path of ['/api/learning-events', '/api/openmaic/progress', '/api/ai-collaboration/events', '/api/courses/course/presence']) {
    assert.equal(classifyClassroomRequest({ path, method: 'POST' }).category, 'write');
  }
  assert.deepEqual(classifyClassroomRequest({ path: '/api/courses/course/actions', method: 'POST', body: { requestId: 'save-id', action: { type: 'UPSERT_SUBMISSION' } } }),
    { requestId: 'save-id', operation: 'UPSERT_SUBMISSION', category: 'write' });
  assert.equal(classifyClassroomRequest({ path: '/api/ai-collaboration/code/run', method: 'POST' }).category, 'code-execution');
});

test('normal AI HTTP failures cannot disappear behind successful text or cancelled navigation', () => {
  const ai = overrides => row({ path: '/api/openmaic/generate/tts', category: 'ai-or-quiz', ...overrides });
  const result = Object.values(summarizeClassroomAiTraffic([
    ai({ status: 429, requestId: 'one', errorCode: 'TTS_RATE_LIMITED' }),
    ai({ status: 0, requestId: 'two', networkFailure: 'net::ERR_ABORTED' }),
    ai({ requestId: 'three' }),
    ai({ requestId: 'one', client: 'other-student' }),
  ], 'make'))[0];
  assert.equal(result.unrecoveredFailures, 1); assert.equal(result.cancellations, 1);
  assert.equal(result.successes, 2); assert.equal(result.failedAttempts[0].errorCode, 'TTS_RATE_LIMITED');
  const recovered = Object.values(summarizeClassroomAiTraffic([ai({ status: 429, requestId: 'same' }),
    ai({ requestId: 'same', finishedAtMs: 2000 })], 'make'))[0];
  assert.equal(recovered.unrecoveredFailures, 0); assert.equal(recovered.firstAttemptFailures, 1);
  assert.equal(recovered.recoveredFailures, 1);
  const onlyQueued = Object.values(summarizeClassroomAiTraffic([ai({ status: 503, requestId: 'pending' }),
    ai({ status: 202, requestId: 'pending', finishedAtMs: 2000 })], 'make'))[0];
  assert.equal(onlyQueued.acceptedPending, 1); assert.equal(onlyQueued.recoveredFailures, 0);
  assert.equal(onlyQueued.successes, 0); assert.equal(onlyQueued.httpSuccessfulResponses, 0);
  assert.equal(onlyQueued.businessCompletedRequests, null);
  assert.equal(onlyQueued.unrecoveredFailures, 1, 'An in-progress receipt is not final recovery');
  const disconnected = Object.values(summarizeClassroomAiTraffic([ai({ status: 0, networkFailure: 'net::ERR_CONNECTION_REFUSED' })], 'make'))[0];
  assert.equal(disconnected.completedResponses, 0); assert.equal(disconnected.unrecoveredFailures, 1);
  assert.equal(classifyClassroomRequest({ path: '/api/openmaic/generate/tts', method: 'POST', body: { audioId: 'voice' } }).requestId, 'voice');
});


test('repeated AI HTTP failures retain every attempt while one same-ID recovery counts once', () => {
  const ai = overrides => row({ path: '/api/ai-collaboration/document', operation: 'proactive-document-comments',
    category: 'ai-or-quiz', requestId: 'same', ...overrides });
  const result = Object.values(summarizeClassroomAiTraffic([
    ai({ status: 503, errorCode: 'AI_PROACTIVE_REVIEW_BUSY' }),
    ai({ status: 503, errorCode: 'AI_PROACTIVE_REVIEW_BUSY', startedAtMs: 6000, finishedAtMs: 6100 }),
    ai({ startedAtMs: 12000, finishedAtMs: 13000, elapsedMs: 1000 }),
  ], 'make'))[0];
  assert.equal(result.firstAttemptFailures, 2); assert.equal(result.failedHttpAttempts, 2);
  assert.equal(result.failedLogicalRequests, 1); assert.equal(result.recoveredLogicalRequests, 1);
  assert.equal(result.unrecoveredLogicalRequests, 0); assert.equal(result.unrecoveredFailures, 0);
  assert.equal(result.recoveredFailures, 2);
  assert.deepEqual(result.failedAttempts.map(attempt => [attempt.requestId, attempt.status, attempt.errorCode]),
    [['same', 503, 'AI_PROACTIVE_REVIEW_BUSY'], ['same', 503, 'AI_PROACTIVE_REVIEW_BUSY']]);
});

test('AI logical failure counts separate students and request IDs without changing the strict gate', () => {
  const ai = overrides => row({ path: '/api/ai-collaboration/document', operation: 'proactive-document-comments',
    category: 'ai-or-quiz', requestId: 'shared', status: 503, ...overrides });
  const result = Object.values(summarizeClassroomAiTraffic([
    ai({}), ai({ startedAtMs: 1200, finishedAtMs: 1300 }),
    ai({ client: 'student-2' }), ai({ requestId: 'different' }),
    ai({ status: 200, startedAtMs: 2000, finishedAtMs: 2100 }),
  ], 'make'))[0];
  assert.equal(result.failedHttpAttempts, 4); assert.equal(result.failedLogicalRequests, 3);
  assert.equal(result.recoveredLogicalRequests, 1); assert.equal(result.unrecoveredLogicalRequests, 2);
  assert.equal(result.firstAttemptFailures, 4); assert.equal(result.recoveredFailures, 2);
  assert.equal(result.unrecoveredFailures, 2); assert.equal(result.failedAttempts.length, 4);
});

test('AI failures without usable IDs remain individually visible and cannot infer a shared retry', () => {
  const ai = overrides => row({ path: '/api/ai-collaboration/document', operation: 'proactive-document-comments',
    category: 'ai-or-quiz', ...overrides });
  const result = Object.values(summarizeClassroomAiTraffic([
    ai({ status: 503 }), ai({ status: 503 }), ai({ requestId: '', status: 503 }),
    ai({ requestId: ' ', status: 503 }),
    ai({}), ai({ requestId: '' }), ai({ requestId: ' ' }), ai({ requestId: 'assigned-later' }),
    ai({ status: 0, networkFailure: 'net::ERR_ABORTED' }),
  ], 'make'))[0];
  assert.equal(result.failedHttpAttempts, 4); assert.equal(result.failedLogicalRequests, 4);
  assert.equal(result.recoveredLogicalRequests, 0); assert.equal(result.unrecoveredLogicalRequests, 4);
  assert.equal(result.unrecoveredFailures, 4); assert.equal(result.recoveredFailures, 0);
  assert.equal(result.cancellations, 1); assert.equal(result.failedAttempts.length, 4);
  assert.deepEqual(result.failedAttempts.map(attempt => attempt.requestId), [undefined, undefined, '', ' ']);
});

test('a later same-ID failure cannot inherit recovery from an earlier successful response', () => {
  const ai = overrides => row({ path: '/api/ai-collaboration/document', operation: 'proactive-document-comments',
    category: 'ai-or-quiz', requestId: 'same', ...overrides });
  const result = Object.values(summarizeClassroomAiTraffic([
    ai({ status: 503 }), ai({ startedAtMs: 2000, finishedAtMs: 2100 }),
    ai({ status: 503, startedAtMs: 3000, finishedAtMs: 3100 }),
  ], 'make'))[0];
  assert.equal(result.failedHttpAttempts, 2); assert.equal(result.failedLogicalRequests, 1);
  assert.equal(result.recoveredLogicalRequests, 0); assert.equal(result.unrecoveredLogicalRequests, 1);
  assert.equal(result.recoveredFailures, 1); assert.equal(result.unrecoveredFailures, 1);
});


test('same-ID success without a usable client cannot manufacture scope or recovery', () => {
  for (const client of [undefined, '', ' ']) {
    const ai = overrides => row({ client, path: '/api/ai-collaboration/document', operation: 'proactive-document-comments',
      category: 'ai-or-quiz', requestId: 'same', ...overrides });
    const result = Object.values(summarizeClassroomAiTraffic([
      ai({ status: 503 }), ai({ startedAtMs: 2000, finishedAtMs: 2100 }),
    ], 'make'))[0];
    assert.equal(result.firstAttemptFailures, 1); assert.equal(result.failedHttpAttempts, 1);
    assert.equal(result.failedLogicalRequests, 1); assert.equal(result.recoveredLogicalRequests, 0);
    assert.equal(result.unrecoveredLogicalRequests, 1); assert.equal(result.recoveredFailures, 0);
    assert.equal(result.unrecoveredFailures, 1, 'The legacy strict gate must also fail closed when client evidence is absent');
    assert.equal(result.failedAttempts[0].client, client); assert.equal(result.failedAttempts[0].requestId, 'same');
  }
});

const reviewScope = 'course-1:user-1:make:document';
const reviewTraffic = overrides => row({ client: 'student-1', path: '/api/ai-collaboration/document',
  operation: 'proactive-document-comments', category: 'ai-or-quiz', requestId: 'review-1',
  documentReviewScope: reviewScope, status: 202, ...overrides });
const settledReview = () => ({ status: 'passed', students: [{ index: 1, userId: 'user-1', status: 'passed',
  requestScope: reviewScope,
  recovery: { status: 'completed', scope: 'Existing durable review queue before reload/new-paragraph stimulus; natural browser retries only' },
  proof: { settled: true }, finalPendingKeys: [],
  tasks: [{ requestId: 'review-1', status: 'COMPLETED' }], browserAttempts: [{ requestId: 'review-1', phase: 'make' }] }] });
const aiSummary = (traffic, documentReviewSettlement) => Object.values(summarizeClassroomAiTraffic(traffic, 'make', { documentReviewSettlement }))[0];

test('90 accepted review attempts are HTTP completions and never 90 final successes', () => {
  const result = aiSummary(Array.from({ length: 90 }, (_, index) => reviewTraffic({ requestId: `review-${index}` })));
  assert.equal(result.attempts, 90); assert.equal(result.completedResponses, 90); assert.equal(result.httpResponsesCompleted, 90);
  assert.equal(result.acceptedPending, 90); assert.equal(result.httpAcceptedPending, 90);
  assert.equal(result.successes, 0); assert.equal(result.httpSuccessfulResponses, 0);
  assert.equal(result.businessCompletedRequests, null); assert.equal(result.businessCompletionEvidence, null);
  assert.equal(result.businessUnverifiedRequests, 90);
  assert.match(result.semantics.completedResponses, /not business completion/);
});

test('actual settlement counts one scope/request once and preserves every failed HTTP attempt', () => {
  const result = aiSummary([reviewTraffic({ status: 503 }), reviewTraffic({}), reviewTraffic({}),
    reviewTraffic({ requestId: 'unverified-review' })], settledReview());
  assert.equal(result.businessCompletedRequests, 1); assert.equal(result.businessUnverifiedRequests, 1);
  assert.equal(result.businessCompletionEvidence, 'document-all-student-review-settlement');
  assert.equal(result.successes, 0); assert.equal(result.acceptedPending, 3);
  assert.equal(result.failedHttpAttempts, 1); assert.equal(result.failedLogicalRequests, 1);
  assert.equal(result.unrecoveredFailures, 1); assert.equal(result.recoveredFailures, 0);
  assert.equal(result.failedAttempts[0].status, 503, 'Durable completion cannot erase a failed transport attempt');
});

test('missing, wrong-scope or incomplete settlement cannot invent business completion from 202 or 200', () => {
  for (const change of [student => { student.index = 2; }, student => { student.requestScope = 'another:user-1:make:document'; },
    student => { delete student.requestScope; },
    student => { student.status = 'failed'; }, student => { student.recovery.status = 'failed'; },
    student => { student.proof.settled = false; }, student => { student.finalPendingKeys = ['pending']; },
    student => { delete student.finalPendingKeys; }, student => { student.tasks[0].status = 'FAILED'; },
    student => { student.tasks[0].requestId = 'another'; }, student => { student.browserAttempts[0].phase = 'share'; }]) {
    const evidence = settledReview(); change(evidence.students[0]);
    const result = aiSummary([reviewTraffic({})], evidence);
    assert.equal(result.businessCompletedRequests, null); assert.equal(result.businessUnverifiedRequests, 1);
  }
  assert.equal(aiSummary([reviewTraffic({ documentReviewScope: undefined })], settledReview()).businessCompletedRequests, null);
  const httpOnly = aiSummary([reviewTraffic({ status: 200 })]);
  assert.equal(httpOnly.successes, 1); assert.equal(httpOnly.businessCompletedRequests, null);
});

test('classifier retains exact document review scope for settlement without classifying generic HTTP as business proof', () => {
  const request = { path: '/api/ai-collaboration/document', method: 'POST', body: { action: 'proactive-document-comments',
    requestId: 'review-1', courseId: 'course-1', studentId: 'user-1', stageKey: 'make', workspaceKind: 'document' } };
  assert.equal(classifyClassroomRequest(request).documentReviewScope, reviewScope);
  assert.equal(classifyClassroomRequest({ ...request, body: { ...request.body, courseId: undefined } }).documentReviewScope, undefined);
  assert.equal(classifyClassroomRequest({ ...request, body: { ...request.body, action: 'reply-document-comment' } }).documentReviewScope, undefined);
});
for (const path of ['/api/ai-collaboration/code', '/api/ai-collaboration/document']) {
  test(path + ' task-status classification follows production query-key presence without exposing IDs', () => {
    const cases = [
      ['', 'GET'], ['?courseId=synthetic', 'GET'], ['?requestid=lowercase', 'GET'],
      ['?requestId', 'task-status'], ['?requestId=', 'task-status'],
      ['?requestId=synthetic-private-task', 'task-status'],
      ['?requestId=&requestId=second', 'task-status'],
      ['?requestId=first&requestId=', 'task-status'],
      ['?requestId=%20', 'task-status'], ['?%72equestId=encoded-key', 'task-status'],
    ];
    for (const [search, operation] of cases) {
      const url = new URL(path + search, 'http://isolated.invalid');
      const classified = classifyClassroomRequest({ path: url.pathname, query: url.searchParams, method: 'GET' });
      assert.deepEqual(classified, { requestId: undefined, operation, category: 'read' });
      assert.equal(JSON.stringify(classified).includes('synthetic-private-task'), false);
      assert.equal(JSON.stringify(classified).includes('encoded-key'), false);
    }
  });

  test(path + ' 120 fast status reads cannot dilute six slow history reads below the unchanged one-second gate', () => {
    const request = (index, duration, query) => {
      const classified = classifyClassroomRequest({ path, method: 'GET', query });
      const startedAtMs = 10_000 + index * 2_000;
      return row({ ...classified, path, method: 'GET', startedAtMs, finishedAtMs: startedAtMs + duration,
        ...measureClassroomRequestTiming({ startTime: 1_000_000 + index * 2_000,
          requestStart: 1, responseStart: duration - 1, responseEnd: duration }, startedAtMs, startedAtMs + duration) });
    };
    const statuses = Array.from({ length: 120 }, (_, index) =>
      request(index, 20, new URLSearchParams({ requestId: 'synthetic-private-task-' + index })));
    const histories = Array.from({ length: 6 }, (_, index) => request(120 + index, 1600, new URLSearchParams()));
    const entries = [...statuses, ...histories];
    const grouped = summarizeClassroomTraffic(entries, 'make');
    assert.equal(Object.keys(grouped).length, 2);
    const history = grouped['GET ' + path + ' GET'];
    const status = grouped['GET ' + path + ' task-status'];
    assert.equal(history.category, 'read'); assert.equal(status.category, 'read');
    assert.equal(history.samples, 6); assert.equal(history.attempts, 6); assert.equal(history.p95Ms, 1600);
    assert.ok(history.p95Ms > 1000, 'History must still fail the original read latency threshold');
    assert.equal(status.samples, 120); assert.equal(status.attempts, 120); assert.equal(status.p95Ms, 20);
    assert.equal(history.failures, 0); assert.equal(status.failures, 0);
    assert.equal(history.unmeasured, 0); assert.equal(status.unmeasured, 0);
    assert.ok(entries.every(entry => entry.requestId === undefined), 'GET query identifiers never become logical-request IDs');
    assert.deepEqual(summarizeClassroomAiTraffic(entries, 'make'), {}, 'Status reads cannot become model or logical AI completions');
    const formerlyCollapsed = summarizeClassroomTraffic(entries.map(entry => ({ ...entry, operation: 'GET' })), 'make');
    assert.equal(formerlyCollapsed['GET ' + path + ' GET'].p95Ms, 20,
      'The regression workload actually reproduces dilution when operations are collapsed');
  });
}

test('task-status query classification leaves other methods, paths and original save/AI request identities unchanged', () => {
  const query = new URLSearchParams({ requestId: 'synthetic-private-task' });
  for (const path of ['/api/ai-collaboration/code', '/api/ai-collaboration/document']) {
    assert.deepEqual(classifyClassroomRequest({ path, method: 'HEAD', query }),
      { requestId: undefined, operation: 'HEAD', category: 'read' });
    assert.deepEqual(classifyClassroomRequest({ path, method: 'POST', query,
      body: { requestId: 'original-client-id', action: 'proactive-review' } }),
    { requestId: 'original-client-id', operation: 'proactive-review', category: 'ai-or-quiz' });
  }
  assert.deepEqual(classifyClassroomRequest({ path: '/api/courses/private/state', method: 'GET', query }),
    { requestId: undefined, operation: 'GET', category: 'read' });
  assert.deepEqual(classifyClassroomRequest({ path: '/api/courses/private/actions', method: 'POST', query,
    body: { requestId: 'original-save-id', action: { type: 'UPSERT_SUBMISSION' } } }),
  { requestId: 'original-save-id', operation: 'UPSERT_SUBMISSION', category: 'write' });
});
