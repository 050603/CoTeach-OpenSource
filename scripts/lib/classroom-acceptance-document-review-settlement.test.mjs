import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_REVIEW_SETTLEMENT_CHECK, documentReviewSettlementBudget, documentReviewSettlementProof,
  removeAcknowledgedDocumentDrafts,
} from './classroom-acceptance-document-review-settlement.mjs';
import { CLASSROOM_REQUIRED_EVIDENCE } from './classroom-acceptance-contract.mjs';

function reviewFixture() {
  return { studentId: 'student-1', participationId: 'participation-1',
    checkpoints: [{ fingerprint: 'text:current', reviewVersion: 4 }],
    tasks: [{ createdById: 'student-1', status: 'COMPLETED', input: {
      participationId: 'participation-1', requestId: 'request-1', stageKey: 'make', workspaceKind: 'document',
      intent: 'proactive-document-comments', documentVersion: 'document-1', message: JSON.stringify([{ candidateId: 'block:p1', targetText: 'Actual submitted paragraph.' }]),
    }, output: { response: { status: 'completed', requestId: 'request-1', documentVersion: 'document-1',
      reviewDecision: { action: 'proactive-document-comments', reviewVersion: 4, documentVersion: 'document-1', requestedCandidates: [{ candidateId: 'block:p1', targetText: 'Actual submitted paragraph.' }] },
      reviewedParagraphFingerprints: ['text:current'],
    } } }],
  };
}

test('all students have a mandatory gate; queue size never increases the five-minute observation deadline', () => {
  assert.equal(CLASSROOM_REQUIRED_EVIDENCE[DOCUMENT_REVIEW_SETTLEMENT_CHECK], 'browser-real-backend');
  const budget = documentReviewSettlementBudget({ queuedBatches: 30, concurrency: 2 });
  assert.equal(budget.queuedBatches, 30); assert.equal(budget.queueWaves, 15);
  assert.equal(budget.deadlineMs, 300000); assert.equal(budget.taskExecutionMs, 110000);
  assert.equal(budget.browserRequestMs, 120000); assert.equal(budget.maximumExistingBackoffMs, 310000);
  assert.equal(budget.queueExecutionAtTaskLimitMs, 1650000);
  assert.equal(documentReviewSettlementBudget({ queuedBatches: 0, concurrency: 2 }).deadlineMs, 300000);
});

test('only fingerprints declared in actual completed receipts require matching persisted checkpoints', () => {
  assert.equal(documentReviewSettlementProof(reviewFixture()).settled, true);
  for (const mutate of [
    value => { value.checkpoints = []; },
    value => { value.checkpoints[0].reviewVersion--; },
    value => { value.tasks[0].output.response.reviewedParagraphFingerprints = ['old-text']; },
    value => { value.tasks[0].output.response.reviewDecision.reviewVersion--; },
  ]) {
    const value = reviewFixture(); mutate(value);
    const result = documentReviewSettlementProof(value);
    assert.equal(result.settled, false); assert.ok(result.missingCheckpoints.length);
  }
});

test('running, failed and cancelled requests cannot disappear behind other completed reviews', () => {
  for (const status of ['RUNNING', 'FAILED', 'CANCELLED']) {
    const value = reviewFixture(); const pending = structuredClone(value.tasks[0]); pending.status = status; pending.input.requestId = 'another-request'; value.tasks.push(pending);
    assert.equal(documentReviewSettlementProof(value).settled, false, status);
  }
  const value = reviewFixture(); value.tasks[0].status = 'COMPLETED'; value.tasks[0].output.response.status = 'processing';
  assert.throws(() => documentReviewSettlementProof(value));
});

test('another student, participation, workspace or document receipt never covers the current version', () => {
  for (const mutate of [
    value => { value.tasks[0].createdById = 'other-student'; },
    value => { value.tasks[0].input.participationId = 'other-participation'; },
    value => { value.tasks[0].input.stageKey = 'showcase'; },
    value => { value.tasks[0].input.workspaceKind = 'code'; },
    value => { value.tasks[0].output.response.reviewDecision.requestedCandidates[0].targetText = 'Different paragraph.'; },
    value => { value.tasks[0].output.response.requestId = 'other-request'; },
    value => { value.tasks[0].output.response.documentVersion = 'other-document'; },
    value => { value.tasks[0].output.response.reviewDecision.documentVersion = 'other-document'; },
  ]) {
    const value = reviewFixture(); mutate(value); assert.throws(() => documentReviewSettlementProof(value));
  }
});

test('no actual request creates no obligation to review or call a model for unqueued text', () => {
  const value = reviewFixture(); value.tasks = []; value.checkpoints = [];
  assert.equal(documentReviewSettlementProof(value).settled, true);
});

async function withStorage(values, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = { ...values };
  Object.defineProperties(storage, {
    getItem: { value: key => storage[key] ?? null },
    removeItem: { value: key => { delete storage[key]; } },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return await callback(storage); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
}
function draftFixture() {
  const scope = 'course-1:student-1:make:document';
  const key = `openpbl:document-draft:v1:${encodeURIComponent(scope)}:editor-tab`;
  const saved = { id: 'submission-1', studentId: 'student-1', courseId: 'course-1', content: '<p>Saved.</p>', version: 3 };
  return { key, draft: { key, scope, submissionId: saved.id, content: saved.content, expectedVersion: 2, updatedAt: 100 },
    arguments: { studentId: saved.studentId, courseId: saved.courseId, submission: { payload: { view: saved } } },
    page: { evaluate: async (fn, input) => fn(input) } };
}

test('server reload removes only an acknowledged exact document draft and preserves every other queue', async () => {
  const value = draftFixture();
  const untouched = {
    [`openpbl:document-review:v1:${encodeURIComponent(value.draft.scope)}:pending-ai`]: 'immutable AI request',
    'openpbl:document-draft:v1:another-course:editor-tab': 'another draft',
    'openpbl:document-draft:v1:another-student:editor-tab': 'peer draft',
    'openpbl:pending-actions': 'unacknowledged action queue', locale: 'zh-CN',
  };
  await withStorage({ ...untouched, [value.key]: JSON.stringify(value.draft) }, async storage => {
    assert.deepEqual(await removeAcknowledgedDocumentDrafts(value.page, value.arguments), [value.key]);
    assert.deepEqual({ ...storage }, untouched);
  });
});

test('a newer or different draft remains intact and prevents all draft deletion', async () => {
  for (const mutate of [
    draft => { draft.content = '<p>Unsent local edit.</p>'; },
    draft => { draft.expectedVersion = 4; },
    draft => { draft.submissionId = 'other-document'; },
  ]) {
    const value = draftFixture(); mutate(value.draft);
    const pending = JSON.stringify(value.draft);
    await withStorage({ [value.key]: pending }, async storage => {
      await assert.rejects(removeAcknowledgedDocumentDrafts(value.page, value.arguments), /Unacknowledged/);
      assert.equal(storage[value.key], pending);
    });
  }
});


test('a real HTTP request with a missing durable task cannot pass even if its outbox disappeared', () => {
  const value = reviewFixture(); value.observedRequestIds = ['request-1', 'lost-request'];
  const result = documentReviewSettlementProof(value);
  assert.equal(result.settled, false); assert.deepEqual(result.missingTasks, ['lost-request']);
});
