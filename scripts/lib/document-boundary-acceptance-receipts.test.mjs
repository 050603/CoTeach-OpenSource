import test from 'node:test';
import assert from 'node:assert/strict';
import { documentAcceptanceReceiptPending, documentAcceptancePollTimeout, documentAcceptanceScenarioCount } from './document-boundary-acceptance-receipts.mjs';

test('a 200 processing receipt remains pending until its payload reaches a terminal state', () => {
  const receipts = [{ status: 202, body: { status: 'processing' } },
    { status: 200, body: { status: 'processing', phase: 'running' } },
    { status: 200, body: { status: 'completed', complete: true } }];
  assert.deepEqual(receipts.map(documentAcceptanceReceiptPending), [true, true, false]);
  assert.equal(documentAcceptanceReceiptPending({ status: 504, body: { status: 'failed' } }), false);
  assert.equal(documentAcceptanceReceiptPending({ status: 200, body: { complete: true } }), false);
});

test('every poll fits both the 8 second single-read limit and the original 120 second window', () => {
  assert.equal(documentAcceptancePollTimeout(1000, 3000), 8000);
  assert.equal(documentAcceptancePollTimeout(1000, 120500), 500);
  assert.equal(documentAcceptancePollTimeout(1000, 121000), 0);
  assert.equal(documentAcceptancePollTimeout(1000, 130000), 0);
});

test('browser and concurrency-only runs have a zero matrix denominator', () => {
  assert.equal(documentAcceptanceScenarioCount('matrix', 18, 3), 54);
  assert.equal(documentAcceptanceScenarioCount('matrix', 3, 3), 9);
  assert.equal(documentAcceptanceScenarioCount('browser', 18, 3), 0);
  assert.equal(documentAcceptanceScenarioCount('concurrency', 18, 3), 0);
});
