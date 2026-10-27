import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encodeEventCursor } from '../../src/lib/realtime/event-cursor.ts';
import { confirmSubmissionSave, observeSubmissionSaveReceipts, removeAcknowledgedDocumentDrafts, submissionSaveScopeSettled } from './classroom-acceptance-save-confirmation.mjs';

const saved = { id: 'draft', courseId: 'course', studentId: 'student', stageKey: 'make', type: 'document', content: '<p>Saved</p>', version: 2 };
const request = { requestId: 'request', action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: 1, submission: { ...saved, version: 1 } } } };
const ack = { requestId: request.requestId, courseVersion: 3, submissionVersion: 2,
  eventCursor: encodeEventCursor({ createdAt: new Date('2026-10-16T00:00:00.000Z'), id: '11111111-1111-4111-8111-111111111111' }) };
const receipt = { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date('2026-10-16T00:00:00.000Z'), actorId: 'student', idempotencyKey: 'course-action:student:request', payload: { ack } };
const scope = 'course:student:make:document';
const draftKey = `openpbl:document-draft:v1:${encodeURIComponent(scope)}:editor`;
const draft = { key: draftKey, scope, submissionId: saved.id, content: saved.content, expectedVersion: 1, updatedAt: 1 };
const outboxKey = 'openpbl:submission-save:v1:student:request';
const pending = { requestId: 'request', actorId: 'student', action: request.action, createdAt: 1, state: 'pending' };
async function storage(values, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); const local = { ...values };
  Object.defineProperties(local, { getItem: { value: key => local[key] ?? null }, removeItem: { value: key => { delete local[key]; } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  try { return await run(local); } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; }
}
const page = { evaluate: async (fn, arg) => fn(arg), waitForFunction: async (fn, arg) => { assert.ok(fn(arg), 'pending save remains'); } };
const fixture = changes => ({ page, db: { domainEvent: { findUnique: async () => receipt } }, courseId: 'course', studentId: 'student', participationId: 'participation',
  submission: { participationId: 'participation', payload: { view: saved } }, observations: [{ request, ack, status: 200 }], timeoutMs: 0, ...changes });

test('an existing real observation plus matching durable receipt permits exact cleanup without another POST', async () => {
  const other = { 'openpbl:document-draft:v1:other:editor': 'keep', 'openpbl:document-review:v1:pending': 'keep-ai',
    'openpbl:submission-save:v1:peer:pending': 'keep-peer', locale: 'zh-CN', 'openpbl:save-telemetry-client:v1': 'keep-browser-id' };
  await storage({ ...other, [draftKey]: JSON.stringify(draft) }, async local => {
    const proof = await confirmSubmissionSave(fixture());
    assert.equal(proof.ack, ack); assert.equal(proof.receiptId, receipt.id);
    await removeAcknowledgedDocumentDrafts(page, { courseId: 'course', studentId: 'student', submission: fixture().submission });
    assert.deepEqual({ ...local }, other);
  });
});

test('a same-scope pending/conflicting save prevents draft deletion and remains intact', async () => {
  for (const state of ['pending', 'conflict']) await storage({ [draftKey]: JSON.stringify(draft), [outboxKey]: JSON.stringify({ ...pending, state }) }, async local => {
    const before = { ...local };
    await assert.rejects(confirmSubmissionSave(fixture()), /pending save/);
    assert.deepEqual({ ...local }, before);
  });
});

test('other scopes and resolved conflict archives are retained without blocking this confirmed save', async () => {
  for (const record of [{ ...pending, state: 'resolved' }, { ...pending, action: { ...request.action, payload: { ...request.action.payload, courseId: 'other-course' } } },
    { ...pending, action: { ...request.action, payload: { ...request.action.payload, submission: { ...saved, type: 'code' } } } }]) {
    await storage({ [outboxKey]: JSON.stringify(record) }, async local => {
      const before = { ...local }; await confirmSubmissionSave(fixture()); assert.deepEqual({ ...local }, before);
    });
  }
});

test('a database match without its exact original browser ACK cannot pass', async () => {
  for (const observations of [[], [{ request, status: 202, ack }], [{ request, status: 200, ack: { ...ack, requestId: 'different' } }],
    [{ request, status: 200, ack: { ...ack, submissionVersion: 3 } }], [{ request: { ...request, action: { ...request.action, payload: { ...request.action.payload, submission: { ...saved, content: '<p>Different</p>' } } } }, status: 200, ack }]]) {
    await storage({ [draftKey]: JSON.stringify(draft) }, async local => {
      const before = { ...local }; await assert.rejects(confirmSubmissionSave(fixture({ observations })), /actual browser ACK/); assert.deepEqual({ ...local }, before);
    });
  }
});

test('cursor, durable receipt and editor baseline must agree before clearing anything', async () => {
  for (const value of [
    fixture({ observations: [{ request, status: 200, ack: { ...ack, eventCursor: 'placeholder' } }] }),
    fixture({ db: { domainEvent: { findUnique: async () => ({ ...receipt, payload: { ack: { ...ack, courseVersion: 99 } } }) } } }),
    fixture({ db: { domainEvent: { findUnique: async () => ({ ...receipt, id: '22222222-2222-4222-8222-222222222222' }) } } }),
    fixture({ db: { domainEvent: { findUnique: async () => ({ ...receipt, createdAt: new Date('2026-10-16T00:00:00.001Z') }) } } }),
    fixture({ observations: [{ request: { ...request, action: { ...request.action, payload: { ...request.action.payload, expectedSubmissionVersion: 0 } } }, status: 200, ack }] }),
  ]) await storage({ [draftKey]: JSON.stringify(draft) }, async local => {
    const before = { ...local }; await assert.rejects(confirmSubmissionSave(value)); assert.deepEqual({ ...local }, before);
  });
});

test('equal content/version cannot conceal changed submission business fields', async () => {
  for (const patch of [{ title: 'Different title' }, { groupId: 'another-group' }, { status: 'draft' },
    { files: [{ name: 'unexpected.pdf', type: 'application/pdf', url: '/api/uploads/unexpected' }] }]) {
    await storage({ [draftKey]: JSON.stringify(draft) }, async local => {
      const before = { ...local };
      await assert.rejects(confirmSubmissionSave(fixture({ submission: { participationId: 'participation', payload: { view: { ...saved, ...patch } } } })), /business fields/);
      assert.deepEqual({ ...local }, before);
    });
  }
});

test('an unreadable own outbox remains unknown and cannot enable cleanup', async () => {
  await storage({ [outboxKey]: '{' }, async local => {
    const before = { ...local }; assert.throws(() => submissionSaveScopeSettled({ courseId: 'course', studentId: 'student', stageKey: 'make', type: 'document' })); assert.deepEqual({ ...local }, before);
  });
});

test('the short observer captures earlier auto/manual responses and unregisters without emitting HTTP', async () => {
  const emitter = new EventEmitter();
  const observed = observeSubmissionSaveReceipts(emitter, { origin: 'http://127.0.0.1:3198', courseId: 'course', studentId: 'student' });
  const actual = { method: () => 'POST', postDataJSON: () => request };
  emitter.emit('response', { url: () => 'http://elsewhere/api/courses/course/actions', request: () => actual, status: () => 200, json: async () => ack });
  emitter.emit('response', { url: () => 'http://127.0.0.1:3198/api/courses/course/actions', request: () => actual, status: () => 200, json: async () => ack });
  await observed.close(); assert.equal(emitter.listenerCount('response'), 0);
  assert.deepEqual(observed.entries, [{ request, status: 200, ack }]);
});


test('a new pending save appearing after confirmation still prevents draft deletion in its own browser turn', async () => {
  await storage({ [draftKey]: JSON.stringify(draft) }, async local => {
    await confirmSubmissionSave(fixture());
    local[outboxKey] = JSON.stringify(pending);
    const before = { ...local };
    await assert.rejects(removeAcknowledgedDocumentDrafts(page, { courseId: 'course', studentId: 'student', submission: fixture().submission }), /Unacknowledged submission save/);
    assert.deepEqual({ ...local }, before);
  });
});

test('an older exact ACK cannot clear current typing marked for preceding-save reconciliation', async () => {
  for (const requiresConfirmation of [true, 'unreadable']) {
    const marked = { ...draft, requiresConfirmation };
    await storage({ [draftKey]: JSON.stringify(marked) }, async local => {
      await confirmSubmissionSave(fixture());
      const before = { ...local };
      await assert.rejects(removeAcknowledgedDocumentDrafts(page, { courseId: 'course', studentId: 'student',
        submission: fixture().submission }), /Unacknowledged document draft/);
      assert.deepEqual({ ...local }, before);
    });
  }
});

test('artifact briefs and code require their own observed save ACK even when an upload or another draft succeeded', async () => {
  for (const type of ['artifact-brief', 'code']) {
    const own = { ...saved, type, content: type === 'code' ? '{"files":[{"path":"main.c","content":"int main(void) { return 7; }"}]}' : '<p>成果协作稿</p>' };
    const ownRequest = { ...request, action: { ...request.action, payload: { ...request.action.payload, submission: own } } };
    const submission = { participationId: 'participation', payload: { view: own } };
    const upload = { status: 201, request: { requestId: request.requestId }, ack: { requestId: request.requestId, versionId: 'upload-version' } };
    await storage({}, async () => {
      await assert.rejects(confirmSubmissionSave(fixture({ submission, observations: [upload, { request, ack, status: 200 }] })), /actual browser ACK/);
      const proof = await confirmSubmissionSave(fixture({ submission, observations: [{ request: ownRequest, ack, status: 200 }] }));
      assert.equal(proof.request.action.payload.submission.type, type);
      assert.equal(proof.ack.requestId, ownRequest.requestId);
      assert.equal(proof.receiptId, receipt.id);
    });
  }
});
