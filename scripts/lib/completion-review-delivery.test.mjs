import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCompletionEventDelivery, inspectCompletionLearningQueue } from './completion-review-delivery.mjs';

const event = (occurredAt, receivedAt, source = 'legacy-classroom') => ({ occurredAt: new Date(occurredAt), receivedAt: new Date(receivedAt), source });
test('delivery uses the actual occurrence window and server receive time, including late arrival', () => {
  const summary = summarizeCompletionEventDelivery([event(1000, 1100), event(2000, 6000), event(999, 1100), event(2001, 2100), event(1500, 2000, 'other')],
    { fromEpochMs: 1000, toEpochMs: 2000 });
  assert.equal(summary.events, 2); assert.equal(summary.p50Ms, 100); assert.equal(summary.p95Ms, 4000); assert.equal(summary.maxMs, 4000);
  assert.equal(summary.cumulativeBuckets.find(bucket => bucket.upperMs === 5000).count, 2);
});
test('delivery keeps negative clock differences visible rather than clamping them', () => {
  const summary = summarizeCompletionEventDelivery([event(1000, 995)], { fromEpochMs: 0, toEpochMs: 2000 });
  assert.equal(summary.negativeSamples, 1); assert.equal(summary.p95Ms, -5);
});
test('an empty occurrence window never claims a measured delivery percentile', () => {
  const summary = summarizeCompletionEventDelivery([], { fromEpochMs: 1, toEpochMs: 2 });
  assert.equal(summary.events, 0); assert.equal(summary.p95Ms, null); assert.equal(summary.maxMs, null);
});

const queueFixture = entries => {
  const values = new Map(entries.map(([scope, id, value]) => [`openpbl.learning-outbox.v1:${encodeURIComponent(scope)}:${id}`,
    JSON.stringify({ id, createdAt: 1000, value })]));
  return { length: values.size, key: index => [...values.keys()][index], getItem: key => values.get(key) };
};
const pendingEvent = (id, occurredAt = 1500) => ({ id, courseId: 'course', studentId: 'student', occurredAt: new Date(occurredAt).toISOString() });
const window = { courseId: 'course', studentId: 'student', fromEpochMs: 1000, toEpochMs: 2000 };
test('queue inspection includes current, legacy and immutable checkpoint entries without double counting facts', () => {
  const scope = 'learning-events:["course","student"]'; const a = pendingEvent('a');
  const entries = [[scope, 'a', a], ['events:course:student:classroom', 'b', pendingEvent('b', 2500)],
    ['resource-events:course:student', 'c', pendingEvent('c')],
    ['learning-event-batch:["course","student"]', 'flight', [{ scope, entry: { id: 'a', value: a } }]],
    ['learning-events:["other","student"]', 'unrelated', { invalid: true }]];
  assert.deepEqual(inspectCompletionLearningQueue(window, queueFixture(entries)), {
    eventEntries: 3, batchEntries: 1, pendingEventIds: ['a', 'b', 'c'], pendingWindowEventIds: ['a', 'c'],
  });
});
test('a checkpoint by itself is still pending and invalid ownership cannot report an empty queue', () => {
  const batch = 'learning-event-batch:["course","student"]';
  const fixture = value => queueFixture([[batch, 'flight', [{ scope: 'learning-events:["course","student"]', entry: { value } }]]]);
  assert.equal(inspectCompletionLearningQueue(window, fixture(pendingEvent('a'))).batchEntries, 1);
  assert.throws(() => inspectCompletionLearningQueue(window, fixture({ ...pendingEvent('a'), studentId: 'another' })), /ownership/);
  assert.throws(() => inspectCompletionLearningQueue(window, queueFixture([[batch, 'flight', []]])), /checkpoint/);
});
test('fully acknowledged storage has no pending facts or checkpoints', () => {
  assert.deepEqual(inspectCompletionLearningQueue(window, queueFixture([])), {
    eventEntries: 0, batchEntries: 0, pendingEventIds: [], pendingWindowEventIds: [],
  });
});
