import { matchTutorUiRecovery, tutorQuestionFingerprint } from './classroom-acceptance-tutor-recovery.mjs';
import { isMonacoStaticResourcePath } from './runtime-resource-path.mjs';

/** Moving a runtime from its API to immutable static delivery must not remove
 * its real browser failures or latency from the classroom's existing gates. */
export function isClassroomObservedRequestPath(pathname) {
  return pathname.startsWith('/api/') || isMonacoStaticResourcePath(pathname);
}

/** Classify by the operation actually executed, including non-model history/progress routes. */
export function classifyClassroomRequest({ path, method, body, query }) {
  const operation = typeof body?.action === 'string' ? body.action : body?.action?.type;
  const requestId = body?.requestId ?? (path.endsWith('/generate/tts') ? body?.audioId : undefined);
  let category;
  if (method === 'GET' || method === 'HEAD') category = 'read';
  else if (path === '/api/knowledge-lecture' && operation === 'tutor-explain') category = 'read';
  else if (path.endsWith('/ai-collaboration/code/run')) category = 'code-execution';
  else {
    const bookkeeping = ['cancel-request', 'reset-conversation', 'read-document-comment', 'set-document-comment-status'];
    const model = path.endsWith('/lecture-chat')
      || (/\/ai-collaboration\/(document|code)$/.test(path) && !bookkeeping.includes(operation))
      || path.endsWith('/generate/tts')
      || (path === '/api/knowledge-lecture' && !['record-attempt', 'tutor-explain'].includes(operation));
    category = model ? 'ai-or-quiz' : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'write' : 'other';
  }
  // Match the production GET metrics boundary: presence of this key, even
  // empty or repeated, identifies a task-status request. Never label by its value.
  const taskStatus = method === 'GET' && /^\/api\/ai-collaboration\/(code|document)$/.test(path)
    && query instanceof URLSearchParams && query.has('requestId');
  return { requestId, operation: taskStatus ? 'task-status' : operation ?? method, category,
    ...(path === '/api/ai-collaboration/document' && operation === 'proactive-document-comments'
      && [body?.courseId, body?.studentId, body?.stageKey].every(value => typeof value === 'string' && value.trim())
      ? { documentReviewScope: `${body.courseId}:${body.studentId}:${body.stageKey}:${body.workspaceKind ?? 'document'}` } : {}),
    ...(path === '/api/knowledge-lecture' && operation === 'tutor-message'
      ? { tutorQuestionFingerprint: tutorQuestionFingerprint(body) } : {}) };
}

/** Network clocks come from the browser, not when the load-driver's callbacks
 * happen to run. Keep the driver clock separately for diagnostic comparison.
 */
export function measureClassroomRequestTiming(timing, startedAtMs, finishedAtMs) {
  const observerElapsedMs = finishedAtMs - startedAtMs;
  const measured = Number.isFinite(timing?.startTime) && timing.startTime > 0
    && Number.isFinite(timing?.responseStart) && timing.responseStart >= 0
    && Number.isFinite(timing?.responseEnd) && timing.responseEnd >= timing.responseStart;
  return { observerElapsedMs, elapsedMs: measured ? timing.responseEnd : observerElapsedMs,
    timingSource: measured ? 'browser-resource-timing' : 'unavailable',
    ...(measured ? { nativeStartedAtEpochMs: timing.startTime,
      nativeFinishedAtEpochMs: timing.startTime + timing.responseEnd } : {}) };
}

/** Preserve every attempt; latency gates use completed operations, including
 * retry time. Explicitly correlated deadlines are failures, without inventing
 * a completed native latency sample for the aborted transport.
 */
export function summarizeClassroomTraffic(traffic, phase, { timeoutRequests = new Set() } = {}) {
  const selected = traffic.filter(row => row.phase === phase && !row.injected && ['read', 'write'].includes(row.category));
  const groups = new Map();
  for (const row of selected) {
    const key = `${row.method} ${row.path} ${row.operation}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const result = {};
  const isCancellation = row => row.status === 0 && row.networkFailure === 'net::ERR_ABORTED' && !timeoutRequests.has(row);
  for (const [operation, rows] of groups) {
    const times = []; const observerTimes = [];
    let failures = 0; let cancellations = 0; let recoveredConflicts = 0; let expectedBoundaryResponses = 0; let unmeasured = 0;
    const consumed = new Set();
    for (const row of rows) {
      if (consumed.has(row)) continue;
      if (isCancellation(row)) { cancellations++; continue; }
      if (row.method === 'GET' && row.path.endsWith('/showcase/presentation') && row.status === 409
        && row.errorCode === 'SHOWCASE_INACTIVE' && row.stageTransition === true) { expectedBoundaryResponses++; continue; }
      if (row.requestId && [409, 428].includes(row.status) && ['VERSION_CONFLICT', 'EXPECTED_VERSION_REQUIRED'].includes(row.errorCode)) {
        const attempts = rows.filter(candidate => candidate.client === row.client && candidate.requestId === row.requestId);
        const completed = attempts.find(candidate => candidate.status >= 200 && candidate.status < 400
          && candidate.finishedAtMs >= row.finishedAtMs);
        if (completed) {
          for (const candidate of attempts) consumed.add(candidate);
          const isConflict = candidate => [409, 428].includes(candidate.status)
            && ['VERSION_CONFLICT', 'EXPECTED_VERSION_REQUIRED'].includes(candidate.errorCode);
          recoveredConflicts += attempts.filter(isConflict).length;
          failures += attempts.filter(candidate => (candidate.status === 0 || candidate.status >= 400) && !isConflict(candidate)
            && !isCancellation(candidate)).length;
          observerTimes.push(completed.finishedAtMs - Math.min(...attempts.map(candidate => candidate.startedAtMs)));
          if (attempts.some(candidate => candidate.timingSource === 'unavailable')) unmeasured++;
          else if (attempts.every(candidate => candidate.timingSource === 'browser-resource-timing')) {
            times.push(completed.nativeFinishedAtEpochMs - Math.min(...attempts.map(candidate => candidate.nativeStartedAtEpochMs)));
          } else times.push(completed.finishedAtMs - Math.min(...attempts.map(candidate => candidate.startedAtMs)));
          continue;
        }
      }
      if (row.status === 0 || row.status >= 400) failures++;
      observerTimes.push(row.observerElapsedMs ?? row.elapsedMs);
      if (row.timingSource === 'unavailable') unmeasured++;
      else times.push(row.elapsedMs);
    }
    times.sort((a, b) => a - b);
    observerTimes.sort((a, b) => a - b);
    result[operation] = { category: rows[0].category, attempts: rows.length, samples: times.length,
      p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
      observerP95Ms: observerTimes.length ? observerTimes[Math.ceil(observerTimes.length * 0.95) - 1] : null,
      failures, cancellations, recoveredConflicts, expectedBoundaryResponses, unmeasured,
      timeouts: rows.filter(row => timeoutRequests.has(row)).length,
      firstAttemptFailures: rows.filter(row => row.status === 0 || row.status >= 400).length };
  }
  return result;
}

/** HTTP transport failures are reported separately from model task/stream and
 * native playback assertions. A cancelled navigation is never a completed AI
 * response; an actual failed attempt needs a later successful same-scope retry.
 * firstAttemptFailures is a compatibility name for failed HTTP attempts, not
 * distinct requests. Logical counts use exact client/requestId per operation
 * and phase; an unidentified failure remains a separate request-count entry.
 * completedResponses remains an HTTP-response count, including errors/202.
 * successes is an HTTP-success compatibility alias, now excluding pending 202;
 * neither field proves task/model/UI completion. Durable business completion
 * is separately reconciled with exact scope/ID settlement evidence, or null.
 * A logical request is recovered only when every failed attempt is covered by
 * the existing same-ID or independently verified tutor UI recovery evidence.
 */
export function summarizeClassroomAiTraffic(traffic, phase, { tutorUiRecoveries = [], documentReviewSettlement } = {}) {
  const rows = traffic.filter(row => row.phase === phase && !row.injected && row.category === 'ai-or-quiz');
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.method} ${row.path} ${row.operation}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return Object.fromEntries([...grouped].map(([operation, entries]) => {
    const cancellations = entries.filter(row => row.status === 0 && row.networkFailure === 'net::ERR_ABORTED');
    const failures = entries.filter(row => (row.status === 0 || row.status >= 400) && !cancellations.includes(row));
    const identifiedRequest = row => typeof row.client === 'string' && row.client.trim().length > 0
      && typeof row.requestId === 'string' && row.requestId.trim().length > 0;
    const recovered = failures.filter(row => identifiedRequest(row) && entries.some(candidate => candidate.client === row.client
      && candidate.requestId === row.requestId && candidate.status >= 200 && candidate.status < 400 && candidate.status !== 202
      && candidate.finishedAtMs >= row.finishedAtMs));
    const logicalRecoveries = failures.filter(row => !recovered.includes(row))
      .map(row => ({ failure: row, chain: matchTutorUiRecovery(row, entries, tutorUiRecoveries) }))
      .filter(item => item.chain);
    const recoveredAttempts = new Set([...recovered, ...logicalRecoveries.map(item => item.failure)]);
    const failedRequests = new Set(); const unrecoveredRequests = new Set();
    for (const failure of failures) {
      // Missing identity cannot establish that two HTTP failures are one intent.
      const key = identifiedRequest(failure) ? JSON.stringify([failure.client, failure.requestId]) : Symbol();
      failedRequests.add(key);
      if (!recoveredAttempts.has(failure)) unrecoveredRequests.add(key);
    }
    const httpResponsesCompleted = entries.filter(row => row.status > 0).length;
    const httpSuccessfulResponses = entries.filter(row => row.status >= 200 && row.status < 400 && row.status !== 202).length;
    const httpAcceptedPending = entries.filter(row => row.status === 202).length;
    const logical = new Map();
    for (const entry of entries) {
      const key = identifiedRequest(entry) ? JSON.stringify([entry.client, entry.requestId, entry.documentReviewScope]) : Symbol();
      if (!logical.has(key)) logical.set(key, entry);
    }
    // Settlement verifies durable receipts/checkpoints, audit integrity and an
    // empty actual browser outbox. It does not replace the separate browser
    // receipt, model deadline or comment-UI feature gates.
    const businessCompleted = [...logical.values()].filter(entry => phase === 'make'
      && entry.path === '/api/ai-collaboration/document' && entry.operation === 'proactive-document-comments'
      && identifiedRequest(entry) && typeof entry.documentReviewScope === 'string'
      && documentReviewSettlement?.students?.some(student => student.status === 'passed'
        && entry.client === `student-${student.index}` && student.recovery?.status === 'completed'
        && entry.documentReviewScope === student.requestScope
        && student.proof?.settled === true && Array.isArray(student.finalPendingKeys) && student.finalPendingKeys.length === 0
        && student.tasks?.some(task => task.requestId === entry.requestId && task.status === 'COMPLETED')
        && student.browserAttempts?.some(attempt => attempt.requestId === entry.requestId && attempt.phase === phase)));
    return [operation, { attempts: entries.length, completedResponses: httpResponsesCompleted,
      successes: httpSuccessfulResponses, acceptedPending: httpAcceptedPending,
      httpResponsesCompleted, httpSuccessfulResponses, httpAcceptedPending,
      semantics: { completedResponses: 'HTTP responses including errors and 202; not business completion',
        successes: 'HTTP 2xx/3xx excluding pending 202; not business completion',
        acceptedPending: 'HTTP 202 attempts; not unique tasks or final success',
        businessCompletedRequests: 'Unique scope/request IDs verified by durable settlement; null when no matching evidence' },
      businessCompletedRequests: businessCompleted.length || null,
      businessCompletionEvidence: businessCompleted.length ? 'document-all-student-review-settlement' : null,
      businessUnverifiedRequests: logical.size - businessCompleted.length,
      firstAttemptFailures: failures.length, recoveredFailures: recovered.length,
      failedHttpAttempts: failures.length, failedLogicalRequests: failedRequests.size,
      recoveredLogicalRequests: failedRequests.size - unrecoveredRequests.size,
      unrecoveredLogicalRequests: unrecoveredRequests.size,
      logicalRecoveredFailures: logicalRecoveries.length,
      logicalRecoveries: logicalRecoveries.map(({ chain }) => ({ client: chain.client,
        failedRequestId: chain.attempts[0].body.requestId, completedRequestId: chain.attempts[1].body.requestId,
        questionFingerprint: chain.questionFingerprint, completeMs: chain.completeMs })),
      unrecoveredFailures: failures.length - recovered.length - logicalRecoveries.length, cancellations: cancellations.length,
      failedAttempts: failures.map(row => ({ client: row.client, requestId: row.requestId,
        status: row.status, errorCode: row.errorCode, errorMessage: row.errorMessage,
        networkFailure: row.networkFailure, elapsedMs: row.elapsedMs })) }];
  }));
}
