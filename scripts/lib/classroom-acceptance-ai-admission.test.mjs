import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAiAdmissionMetrics, diffAiAdmissionSnapshots, observeAiAdmissionBatch } from './classroom-acceptance-ai-admission.mjs';

function metrics({ count = 10, sum = 3, buckets = [5, 8, 10], started = 100, priority = 'interactive', outcome = 'admitted' } = {}) {
  const labels = `priority="${priority}",outcome="${outcome}"`;
  return [`process_start_time_seconds ${started}`, ...['0.1', '1', '+Inf'].map((le, i) => `classroom_ai_admission_seconds_bucket{${labels},le="${le}"} ${buckets[i]}`),
    `classroom_ai_admission_seconds_count{${labels}} ${count}`, `classroom_ai_admission_seconds_sum{${labels}} ${sum}`].join('\n');
}
const parsed = options => parseAiAdmissionMetrics(metrics(options));
test('computes actual counter increments and a P95 interval without inventing exact latency', () => {
  const result = diffAiAdmissionSnapshots(parsed(), parsed({ count: 30, sum: 13, buckets: [20, 27, 30] }));
  assert.equal(result.status, 'observed');
  const group = result.groups['interactive/admitted'];
  assert.equal(group.count, 20); assert.equal(group.sumSeconds, 10);
  assert.deepEqual(group.p95Bucket, { lowerBoundSeconds: 0.1, lowerInclusive: false, upperBoundSeconds: 1, upperInclusive: true });
  assert.deepEqual(group.cumulativeBucketDeltas.map(x => x.count), [15, 19, 20]);
});
test('zero increments have no latency quantile, while missing observations remain unknown', () => {
  const zero = diffAiAdmissionSnapshots(parsed(), parsed()).groups['interactive/admitted'];
  assert.equal(zero.count, 0); assert.equal(zero.p95Bucket, null); assert.equal(zero.meanSeconds, null);
  assert.equal(parseAiAdmissionMetrics('process_start_time_seconds 100\n').status, 'unknown');
  const added = diffAiAdmissionSnapshots(parsed(), parsed({ priority: 'background' }));
  assert.equal(added.status, 'unknown'); assert.equal(added.groups['background/admitted'].count, null);
});
test('process changes and reset counters cannot become a zero wait measurement', () => {
  assert.equal(diffAiAdmissionSnapshots(parsed(), parsed({ started: 101 })).reason, 'process-restarted');
  assert.equal(diffAiAdmissionSnapshots(parsed(), parsed({ count: 9, sum: 2, buckets: [5, 8, 9] })).groups['interactive/admitted'].reason, 'counter-reset-or-inconsistent-delta');
  assert.equal(parseAiAdmissionMetrics(metrics().replace('process_start_time_seconds 100', '')).status, 'unknown');
});
test('rejects incomplete, nonmonotonic, changed buckets and inconsistent interval deltas', () => {
  assert.equal(parseAiAdmissionMetrics(metrics().replace('classroom_ai_admission_seconds_sum', 'missing_sum')).status, 'unknown');
  assert.equal(parsed({ buckets: [9, 8, 10] }).status, 'unknown');
  const changed = parseAiAdmissionMetrics(metrics().replace('le="1"', 'le="2"'));
  assert.equal(diffAiAdmissionSnapshots(parsed(), changed).groups['interactive/admitted'].reason, 'bucket-schema-changed');
  assert.equal(diffAiAdmissionSnapshots(parsed(), parsed({ count: 12, sum: 4, buckets: [8, 9, 12] })).groups['interactive/admitted'].reason, 'counter-reset-or-inconsistent-delta');
});
test('keeps rejected admission outcomes and priorities separate', () => {
  const combine = (a, b) => `${a}\n${b.split('\n').slice(1).join('\n')}`;
  const before = parseAiAdmissionMetrics(combine(metrics(), metrics({ priority: 'background', outcome: 'rejected' })));
  const after = parseAiAdmissionMetrics(combine(metrics({ count: 11, sum: 3.05, buckets: [6, 9, 11] }), metrics({ priority: 'background', outcome: 'rejected', count: 12, sum: 3.05, buckets: [7, 10, 12] })));
  const result = diffAiAdmissionSnapshots(before, after);
  assert.equal(result.groups['interactive/admitted'].count, 1); assert.equal(result.groups['background/rejected'].count, 2);
  assert.equal(result.supplierInternalQueue, 'not-observable');
});
test('samples after a real operation failure and preserves the original error when metrics also fail', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'ai-admission-test-'));
  const first = new Error('original browser failure'); let reads = 0; let report;
  try {
    await assert.rejects(observeAiAdmissionBatch({ output, label: 'document-ai', readMetrics: async () => { reads++; if (reads === 2) throw new Error('metrics unavailable'); return metrics(); }, onObservation: value => { report = value; } }, async () => { throw first; }), error => error === first);
    assert.equal(reads, 2); assert.equal(report.status, 'unknown'); assert.equal(report.action.status, 'rejected');
    const folder = path.join(output, 'ai-capacity-admission', (await readdir(path.join(output, 'ai-capacity-admission')))[0]);
    const saved = JSON.parse(await readFile(path.join(folder, 'observation.json'), 'utf8'));
    assert.match(saved.action.firstFailure, /original browser failure/); assert.equal(saved.after.reason, 'metrics-request-failed');
  } finally { await rm(output, { recursive: true, force: true }); }
});
test('a missing before sample does not prevent the operation or its after sample', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'ai-admission-test-')); let reads = 0; let report;
  try {
    const result = await observeAiAdmissionBatch({ output, label: 'private-chat', readMetrics: async () => { if (++reads === 1) throw new Error('offline'); return metrics(); }, onObservation: value => { report = value; } }, async () => 'actual-result');
    assert.equal(result, 'actual-result'); assert.equal(reads, 2); assert.equal(report.status, 'unknown');
  } finally { await rm(output, { recursive: true, force: true }); }
});
test('retains both raw histogram snapshots, filters unrelated metrics, and brackets the actual operation', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'ai-admission-test-')); const events = []; let report;
  try {
    await observeAiAdmissionBatch({ output, label: 'personal-tutor', readMetrics: async () => {
      events.push('sample'); return `${metrics()}\nnodejs_eventloop_lag_max_seconds 0.125\nnodejs_eventloop_lag_p99_seconds 0.08\nunrelated_metric{value="do-not-retain"} 1\n`;
    }, onObservation: value => { report = value; } }, async () => { events.push('operation'); });
    assert.deepEqual(events, ['sample', 'operation', 'sample']); assert.equal(report.status, 'observed');
    for (const boundary of ['before', 'after']) {
      const raw = await readFile(path.join(report.artifactDirectory, `${boundary}.prom`), 'utf8');
      assert.match(raw, /classroom_ai_admission_seconds/); assert.match(raw, /process_start_time_seconds/);
      assert.match(raw, /nodejs_eventloop_lag_max_seconds 0.125/);
      assert.match(raw, /nodejs_eventloop_lag_p99_seconds 0.08/);
      assert.doesNotMatch(raw, /unrelated_metric|do-not-retain/);
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});
