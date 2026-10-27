import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { waitForNaturalDocumentReviewRecovery } from './classroom-acceptance-document-ai.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const sha = value => createHash('sha256').update(value).digest('hex');
const view = row => object(row.payload).view ?? row.payload;
const boundedRead = async operation => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Read-only settlement diagnostics exceeded 15 seconds')), 15000);
  })]); } finally { clearTimeout(timer); }
};
export const DOCUMENT_REVIEW_SETTLEMENT_CHECK = 'document-all-student-review-settlement';

/** Separate queue admission from the unchanged per-task execution/HTTP budgets. */
export function documentReviewSettlementBudget({ queuedBatches, concurrency }) {
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 20);
  assert.ok(Number.isInteger(queuedBatches) && queuedBatches >= 0);
  const queueWaves = Math.ceil(queuedBatches / concurrency);
  return { concurrency, queuedBatches, queueWaves,
    taskExecutionMs: 110000, browserRequestMs: 120000, firstSettleMs: 30000,
    maximumExistingBackoffMs: 310000,
    queueExecutionAtTaskLimitMs: queueWaves * 110000, queueBackoffAtLimitMs: queueWaves * 310000,
    deadlineMs: 300000 };
}

/** A cancelled/failed task is preserved as evidence, never a successful review. */
export function documentReviewSettlementProof({ tasks, checkpoints, studentId, participationId, observedRequestIds = [] }) {
  const requestIds = new Set();
  const declared = new Set(); const statuses = { completed: 0, failed: 0, running: 0, cancelled: 0 };
  for (const task of tasks) {
    const input = object(task.input); const receipt = object(object(task.output).response);
    assert.equal(task.createdById, studentId); assert.equal(input.participationId, participationId);
    assert.equal(input.stageKey, 'make'); assert.equal(input.workspaceKind, 'document');
    assert.equal(input.intent, 'proactive-document-comments');
    assert.ok(typeof input.requestId === 'string' && input.requestId && !requestIds.has(input.requestId));
    requestIds.add(input.requestId);
    if (task.status !== 'COMPLETED') {
      const key = { FAILED: 'failed', PENDING: 'running', RUNNING: 'running', CANCELLED: 'cancelled' }[task.status];
      assert.ok(key, `Unknown review task state ${task.status}`); statuses[key]++; continue;
    }
    statuses.completed++;
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.requestId, input.requestId);
    assert.equal(receipt.documentVersion, input.documentVersion);
    const decision = object(receipt.reviewDecision);
    assert.equal(decision.documentVersion, input.documentVersion); assert.equal(decision.action, input.intent);
    assert.ok(Number.isInteger(decision.reviewVersion));
    assert.deepEqual(decision.requestedCandidates, JSON.parse(input.message), 'Receipt candidates differ from the actual request');
    assert.ok(Array.isArray(receipt.reviewedParagraphFingerprints));
    for (const fingerprint of receipt.reviewedParagraphFingerprints) {
      assert.equal(typeof fingerprint, 'string'); declared.add(`${decision.reviewVersion}:${fingerprint}`);
    }
  }
  const checkpointed = new Set(checkpoints.map(item => `${item.reviewVersion}:${item.fingerprint}`));
  const missing = [...declared].filter(fingerprint => !checkpointed.has(fingerprint));
  const missingTasks = [...new Set(observedRequestIds)].filter(requestId => !requestIds.has(requestId));
  return { ...statuses, observedRequests: new Set(observedRequestIds).size, missingTasks, declaredReviewedParagraphs: declared.size, retainedCheckpoints: declared.size - missing.length,
    missingCheckpoints: missing, settled: !statuses.failed && !statuses.running && !statuses.cancelled && !missing.length && !missingTasks.length };
}

export { removeAcknowledgedDocumentDrafts } from './classroom-acceptance-save-confirmation.mjs';

/** Observe real scheduled requests; unqueued paragraphs are not an additional product guarantee. */
export async function runDocumentReviewSettlement({ students, instance, db, env, traffic, output, onEvidence }) {
  const observationStarted = performance.now();
  const deadline = observationStarted + 300000;
  const configured = Number.parseInt(env.PROACTIVE_REVIEW_LLM_CONCURRENCY ?? '', 10);
  const concurrency = Number.isFinite(configured) && configured > 0 ? Math.min(20, configured) : 8;
  const evidence = { startedAt: new Date().toISOString(), students: [],
    source: 'All live browsers: actual outboxes and tasks, durable receipts and their declared review checkpoints',
    observation: { intervalMs: 5000, auditReads: 'Once per student at settlement end; hashes only in evidence',
      taskTiming: 'Task timestamp differences include retries and clock skew; local admission metrics measure queue waits separately.',
      performanceScope: 'Direct read-only DB/local-storage probes excluded from browser HTTP metrics' }, status: 'running' };
  const save = async () => {
    onEvidence?.(evidence);
    await writeFile(path.join(output, 'document-review-settlement.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  };
  const browserAttempts = student => traffic.filter(entry => entry.client === `student-${student.index}`
    && entry.phase === 'make' && entry.path === '/api/ai-collaboration/document' && entry.operation === 'proactive-document-comments');
  const readTasks = student => db.aiTask.findMany({ where: {
    taskType: 'DOCUMENT_COLLABORATION', createdById: student.user.id,
    conversation: { participationId: student.participation.id },
    AND: ['stageKey', 'workspaceKind', 'intent'].map((key, index) => ({ input: {
      path: [key], equals: ['make', 'document', 'proactive-document-comments'][index],
    } })),
  }, orderBy: { createdAt: 'asc' } });
  try {
    const initialization = await Promise.allSettled(students.map(async student => {
      const saved = await boundedRead(db.classroomSubmission.findUniqueOrThrow({ where: { id: student.saved.id } }));
      const source = view(saved);
      const tasks = await boundedRead(readTasks(student));
      const pending = tasks.filter(task => task.status !== 'COMPLETED');
      const row = { index: student.index, userId: student.user.id, participationId: student.participation.id,
        requestScope: `${instance.id}:${student.user.id}:make:document`,
        finalSubmissionId: saved.id, finalSubmissionVersion: source.version, finalContentSha256: sha(source.content),
        initialPendingTasks: pending.length, initialObservedTasks: tasks.length,
        status: 'running', recovery: {} };
      evidence.students.push(row);
      return { student, row, source };
    }));
    const scopes = initialization.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      const student = students[index];
      evidence.students.push({ index: student.index, userId: student.user.id, participationId: student.participation.id,
        status: 'failed', error: `Final-review precondition: ${result.reason}` });
      return [];
    });
    // Queue metadata explains recovery time; it never extends the five-minute deadline.
    evidence.budget = documentReviewSettlementBudget({ concurrency,
      queuedBatches: scopes.reduce((sum, scope) => sum + scope.row.initialPendingTasks, 0) });
    evidence.students.sort((a, b) => a.index - b.index);
    await save();
    const readProof = async ({ student, row }) => {
      const tasks = await readTasks(student);
      const messages = await db.aiMessage.findMany({ where: { conversationId: { in: tasks.map(task => task.conversationId).filter(Boolean) },
        content: { startsWith: 'OPENPBL_DOCUMENT_COMMENT_REVIEW:' } }, select: { content: true } });
      const checkpoints = messages.map(message => JSON.parse(message.content.slice('OPENPBL_DOCUMENT_COMMENT_REVIEW:'.length)));
      row.proof = documentReviewSettlementProof({ tasks, checkpoints, studentId: student.user.id, participationId: student.participation.id,
        observedRequestIds: browserAttempts(student).map(entry => entry.requestId) });
      return { tasks, settled: row.proof.settled };
    };
    const outcomes = await Promise.allSettled(scopes.map(async scope => {
      const { student, row, source } = scope;
      try {
        const result = await waitForNaturalDocumentReviewRecovery({ page: student.page, db, student, instanceId: instance.id,
          entries: () => traffic.filter(entry => entry.client === `student-${student.index}`).map(entry => ({ ...entry,
            body: { requestId: entry.requestId }, response: { error: entry.errorCode } })),
          evidence: row.recovery, timeoutMs: Math.max(1, deadline - performance.now()), minimumObservationMs: 30000,
          pollMs: 5000, allowCancelled: false, auditEveryPoll: false,
          finalProof: async () => {
            const saved = view(await db.classroomSubmission.findUniqueOrThrow({ where: { id: student.saved.id } }));
            assert.equal(saved.content, source.content, 'Final document changed during natural queue settlement');
            return (await readProof(scope)).settled;
          } });
        row.elapsedMs = result.elapsedMs;
        // Every student shares the class deadline, including initialization.
        // Keep final read-only audit duration separate from this completion.
        row.settledElapsedMs = performance.now() - observationStarted;
        assert.ok(row.settledElapsedMs <= evidence.budget.deadlineMs, 'Whole-class review deadline exceeded');
        row.status = 'passed';
      } catch (error) { row.status = 'failed'; row.error = String(error.stack ?? error); }
    }));
    evidence.settlementElapsedMs = performance.now() - observationStarted;
    // Reconcile every student at the common end, including students whose queue
    // cleared early; a later scheduled request must not escape the class gate.
    await Promise.allSettled(scopes.map(async scope => {
      const { student, row } = scope;
      const diagnosticsStarted = performance.now();
      try {
        const { tasks, settled } = await boundedRead(readProof(scope));
        const localPending = await boundedRead(student.page.evaluate(scope => {
          const prefix = `openpbl:document-review:v1:${encodeURIComponent(scope)}:`;
          return Object.keys(localStorage).filter(key => key.startsWith(prefix));
        }, `${instance.id}:${student.user.id}:make:document`));
        row.finalPendingKeys = localPending;
        row.tasks = tasks.map(task => ({ id: task.id, requestId: object(task.input).requestId, status: task.status, error: task.error,
          createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt,
          taskTimestampDeltaMs: task.startedAt ? task.startedAt - task.createdAt : null,
          executionMs: task.startedAt && task.completedAt ? task.completedAt - task.startedAt : null }));
        row.browserAttempts = browserAttempts(student)
          .map(({ requestId, status, phase, elapsedMs, startedAtMs, finishedAtMs, errorCode, networkFailure }) =>
            ({ requestId, status, phase, elapsedMs, startedAtMs, finishedAtMs, errorCode, networkFailure }));
        const events = await boundedRead(db.aiInteractionEvent.findMany({ where: { participationId: student.participation.id, userId: student.user.id,
          requestId: { in: row.tasks.map(task => task.requestId) } }, orderBy: { createdAt: 'asc' },
          select: { id: true, requestId: true, createdAt: true, eventType: true, content: true, payload: true } }));
        row.originalAttempts = events.filter(event => event.eventType === 'error' || object(object(event.payload).detail).kind === 'model-output')
          .map(event => {
            const detail = object(object(event.payload).detail);
            if (detail.kind === 'model-output') {
              assert.equal(detail.rawSha256, sha(event.content ?? ''), 'Retained review output hash differs');
              assert.equal(detail.rawLength, event.content?.length, 'Retained review output length differs');
            }
            return { id: event.id, requestId: event.requestId,
              at: event.createdAt, eventType: event.eventType, error: event.eventType === 'error' ? event.content : undefined,
              elapsedMs: detail.elapsedMs, failureKind: detail.failureKind, validation: detail.validation,
              rawSha256: detail.rawSha256, retainedRawSha256: detail.kind === 'model-output' ? sha(event.content ?? '') : undefined }; });
        assert.ok(settled && localPending.length === 0, 'A real review request remains unfinished at whole-class settlement');
      } catch (error) { row.status = 'failed'; row.diagnosticError = String(error.stack ?? error); }
      row.observationMs = row.recovery.elapsedMs; row.diagnosticsMs = performance.now() - diagnosticsStarted;
      row.elapsedMs ??= row.recovery.elapsedMs;
    }));
    assert.ok(evidence.students.length === students.length && evidence.students.every(row => row.status === 'passed')
      && outcomes.every(item => item.status === 'fulfilled') && evidence.settlementElapsedMs <= evidence.budget.deadlineMs,
      evidence.students.filter(row => row.status !== 'passed').map(row => `Student ${row.index}: ${row.error ?? row.diagnosticError}`).join('\n'));
    evidence.status = 'passed';
    return evidence;
  } catch (error) { evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error; }
  finally { evidence.finishedAt = new Date().toISOString(); evidence.totalElapsedMs = performance.now() - observationStarted; await save(); }
}
