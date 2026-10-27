import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEventCursor } from '../../src/lib/realtime/event-cursor.ts';
import { browserLearningEventReceipt, createBrowserActionReceipts } from './classroom-acceptance-action-receipts.mjs';
import { nativeLearningFixture } from '../../e2e/fixtures/native-learning.ts';

const timestamp = '2026-10-16T12:00:00.000Z';
const request = { requestId: 'original', expectedVersion: 1, action: { type: 'UPSERT_SUBMISSION', payload: {
  courseId: 'course', expectedSubmissionVersion: 1, submission: { id: 'draft', studentId: 'student', content: '<p>Original</p>' },
} } };
test('a browser fixture ACK has a real valid cursor and replays its exact original value', () => {
  const store = createBrowserActionReceipts('course', timestamp);
  assert.equal(store.lookup(request), undefined);
  const ack = store.remember(request, { courseVersion: 2, submissionVersion: 2, updatedAt: timestamp });
  assert.equal(ack.requestId, request.requestId);
  const cursor = decodeEventCursor(ack.eventCursor);
  assert.equal(cursor.createdAt.toISOString(), timestamp);
  assert.match(cursor.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(store.lookup({ ...structuredClone(request), expectedVersion: 99 }), { status: 200, body: ack });
  assert.equal(store.remember(structuredClone(request), { courseVersion: 99, submissionVersion: 99 }), ack);
  assert.deepEqual(store.lookup(request).body, ack);
});
test('an unchanged request id cannot conceal changed content or changed draft baseline', () => {
  const store = createBrowserActionReceipts('course', timestamp);
  store.remember(request, { courseVersion: 2, submissionVersion: 2 });
  for (const mutate of [
    changed => { changed.action.payload.submission.content = '<p>Different</p>'; },
    changed => { changed.action.payload.expectedSubmissionVersion = 2; },
    changed => { changed.action.type = 'END_TEACHING'; },
  ]) {
    const changed = structuredClone(request); mutate(changed);
    assert.equal(store.lookup(changed).status, 409);
    assert.equal(store.lookup(changed).body.code, 'IDEMPOTENCY_CONFLICT');
    assert.throws(() => store.remember(changed, { courseVersion: 3, submissionVersion: 3 }), /conflicting/);
  }
  assert.equal(store.lookup(request).status, 200);
});
test('only a new logical request can create a different valid receipt', () => {
  const store = createBrowserActionReceipts('course', timestamp);
  const first = store.remember(request, { courseVersion: 2, submissionVersion: 2 });
  const next = { ...structuredClone(request), requestId: 'next' }; next.action.payload.expectedSubmissionVersion = 2;
  const second = store.remember(next, { courseVersion: 3, submissionVersion: 3 });
  assert.notEqual(first.eventCursor, second.eventCursor);
  assert.equal(decodeEventCursor(second.eventCursor).createdAt.toISOString(), timestamp);
  assert.equal(store.lookup(request).body, first);
});

const learningClock = Date.parse(timestamp);
const learningEvent = (id = 'observed-event') => ({ id, idempotencyKey: `event-key-${id}`,
  courseId: 'course', studentId: 'student', stageKey: 'ai-learning', sceneId: 'scene',
  type: 'scene-complete', occurredAt: timestamp, durationMs: 1200, visible: true,
  content: { sceneTitle: '科学观察', knowledgePointIds: ['observation'] }, metadata: { complete: true } });
const learningBatch = () => ({ courseId: 'course', studentId: 'student',
  events: [learningEvent('first'), learningEvent('second')] });

test('learning-event fixture acknowledges exactly all supplied valid IDs without mutating the batch', () => {
  const batch = learningBatch(); const unchanged = structuredClone(batch);
  for (const input of [batch, JSON.stringify(batch)]) {
    assert.deepEqual(browserLearningEventReceipt(input, learningClock), {
      status: 200, body: { acceptedIds: ['first', 'second'] },
    });
  }
  assert.deepEqual(batch, unchanged);
  const replayed = { ...batch, events: [batch.events[0], structuredClone(batch.events[0]), batch.events[1]] };
  assert.deepEqual(browserLearningEventReceipt(replayed, learningClock).body.acceptedIds, ['first', 'second']);
  assert.throws(() => browserLearningEventReceipt(batch), /explicit clock/);
});

test('learning-event fixture fails malformed batches atomically instead of inventing an acknowledgement', () => {
  assert.deepEqual(browserLearningEventReceipt('{malformed', learningClock), { status: 400, body: { error: 'INVALID_JSON' } });
  for (const input of [undefined, null, [], {}, { ...learningBatch(), events: [] },
    { ...learningBatch(), events: Array.from({ length: 101 }, (_, i) => learningEvent(String(i))) },
    ...[
      event => { event.id = ''; }, event => { delete event.idempotencyKey; },
      event => { event.studentId = 'another-student'; }, event => { event.courseId = 'another-course'; },
      event => { event.type = 'fabricated-success'; }, event => { event.occurredAt = 'not-a-time'; },
      event => { event.occurredAt = new Date(learningClock + 300_001).toISOString(); },
      event => { event.durationMs = -1; }, event => { event.metadata = { nested: { unexpected: true } }; },
      event => { event.progressMarker = 'x'.repeat(32_001); },
    ].map(mutate => { const batch = learningBatch(); mutate(batch.events[1]); return batch; }),
  ]) {
    const receipt = browserLearningEventReceipt(input, learningClock);
    assert.deepEqual(receipt, { status: 400, body: { error: 'INVALID_EVENTS' } });
    assert.equal('acceptedIds' in receipt.body, false, 'A partly valid batch must not partially acknowledge');
  }
});

test('a learning-event fixture rejects conflicting reuse within a batch but accepts canonical identical events', () => {
  const original = learningEvent();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(browserLearningEventReceipt({ courseId: 'course', studentId: 'student', events: [original, reordered] }, learningClock).status, 200);
  for (const changed of [{ ...original, id: 'different-id' }, { ...original, durationMs: 9000 }]) {
    assert.deepEqual(browserLearningEventReceipt({ courseId: 'course', studentId: 'student', events: [original, changed] }, learningClock),
      { status: 409, body: { error: 'LEARNING_EVENT_CONFLICT' } });
  }
});

test('native browser fixture uses the POST receipt and preserves other event and analytics contracts', () => {
  const fixture = nativeLearningFixture(); fixture.setMode('quiz');
  const state = fixture.response('/api/courses', 'GET', {}).body;
  const event = { ...learningEvent(), courseId: fixture.id, studentId: state.studentId, occurredAt: '2020-01-01T00:00:00.000Z' };
  const body = { courseId: fixture.id, studentId: state.studentId, events: [event] };
  assert.deepEqual(fixture.response('/api/learning-events', 'POST', body), {
    status: 200, body: { acceptedIds: [event.id] },
  });
  assert.deepEqual(fixture.response('/api/learning-events', 'POST', { ...body, events: [] }), {
    status: 400, body: { error: 'INVALID_EVENTS' },
  });
  for (const endpoint of ['/api/learning-events', `/api/courses/${fixture.id}/learning-events`,
    `/api/courses/${fixture.id}/learning-analytics`]) {
    assert.deepEqual(fixture.response(endpoint, 'GET', {}), { status: 200, body: { success: true } });
  }
  assert.deepEqual(fixture.response('/api/ai-collaboration/events', 'POST', {}), {
    status: 200, body: { events: [], success: true },
  });
});
