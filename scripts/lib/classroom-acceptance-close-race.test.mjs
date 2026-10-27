import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRaceReceipt, isRaceTransition, withClassroomRaceBarrier } from './classroom-acceptance-close-race.mjs';

const successful = () => {
  const body = { requestId: 'real-request', action: { payload: { submission: { content: '<p>new draft</p>' } } } };
  const receipt = { requestId: body.requestId, submissionVersion: 2, courseVersion: 9, eventCursor: 'cursor' };
  return { body, receipt, status: 200, stored: { content: '<p>new draft</p>', version: 2 },
    event: { payload: { ack: { ...receipt }, action: body.action } } };
};

test('real UI stage gate UPDATE_COURSE is matched while unrelated timing updates cannot satisfy the race', () => {
  const actualUi = { action: { type: 'UPDATE_COURSE', payload: { id: 'isolated', patch: {
    currentStageIndex: 3, stageTransitions: [{ fromStageKey: 'make', toStageKey: 'showcase' }],
    uiState: { classroomTiming: { status: 'running', activeStageKey: 'showcase' } },
  } } } };
  assert.equal(isRaceTransition(actualUi, 'stage', 'isolated'), true);
  assert.equal(isRaceTransition(actualUi, 'stage', 'another-classroom'), false);
  assert.equal(isRaceTransition({ action: { type: 'UPDATE_COURSE', payload: { id: 'isolated', patch: {
    uiState: { classroomTiming: { status: 'running', activeStageKey: 'make' } },
  } } } }, 'stage', 'isolated'), false);
  assert.equal(isRaceTransition({ action: { type: 'SET_STAGE', payload: { id: 'isolated', index: 3 } } }, 'stage', 'isolated'), true);
  assert.equal(isRaceTransition({ action: { type: 'SET_STAGE', payload: { id: 'isolated', index: 2 } } }, 'stage', 'isolated'), false);
  assert.equal(isRaceTransition({ action: { type: 'END_TEACHING', payload: { id: 'isolated' } } }, 'finish', 'isolated'), true);
  assert.equal(isRaceTransition(actualUi, 'finish', 'isolated'), false);
});

test('a successful racing save needs identical content, version and durable receipt', () => {
  assert.doesNotThrow(() => assertRaceReceipt(successful()));
  for (const mutate of [
    row => { row.stored.content = 'older draft'; },
    row => { row.stored.version = 1; },
    row => { delete row.event; },
    row => { row.event.payload.ack.eventCursor = 'another-request'; },
  ]) {
    const row = successful(); mutate(row); assert.throws(() => assertRaceReceipt(row));
  }
});

test('a rejection must be a real close/version conflict and preserve the exact local draft', () => {
  const row = successful(); row.status = 409; row.receipt = { code: 'CLASSROOM_READ_ONLY' }; delete row.event;
  row.localDrafts = [{ content: '<p>new draft</p>' }];
  assert.doesNotThrow(() => assertRaceReceipt(row));
  assert.throws(() => assertRaceReceipt({ ...row, status: 500 }));
  assert.throws(() => assertRaceReceipt({ ...row, receipt: { code: 'FORBIDDEN' } }));
  assert.throws(() => assertRaceReceipt({ ...row, localDrafts: [{ content: 'old draft' }] }));
  assert.throws(() => assertRaceReceipt({ ...row, event: { payload: {} } }));
});

test('the scoped row barrier releases and completes its bounded transaction when browser work fails', async () => {
  let completed = false;
  let locks = 0;
  const db = { $transaction: async (operation, settings) => {
    assert.equal(settings.timeout, 30_000); assert.equal(settings.maxWait, 5000);
    try {
      return await operation({ $executeRaw: async () => 0,
        $queryRaw: async (query, id) => { assert.match(query.join(''), /ClassroomInstance.*FOR UPDATE/); assert.equal(id, 'isolated-run'); locks++; return [{ id }]; } });
    } finally { completed = true; }
  } };
  await assert.rejects(withClassroomRaceBarrier(db, 'isolated-run', async timing => {
    assert.equal(locks, 1); assert.ok(timing.acquiredAt); assert.equal(completed, false);
    throw new Error('browser failed');
  }), /browser failed/);
  assert.equal(completed, true);
});

test('the barrier cannot run browser actions if the scoped classroom no longer exists', async () => {
  let called = false;
  const db = { $transaction: async operation => operation({ $executeRaw: async () => 0, $queryRaw: async () => [] }) };
  await assert.rejects(withClassroomRaceBarrier(db, 'missing-run', async () => { called = true; }), /disappeared/);
  assert.equal(called, false);
});
