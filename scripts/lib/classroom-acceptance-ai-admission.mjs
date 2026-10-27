import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const metric = 'classroom_ai_admission_seconds';
const boundaryNumber = value => value === '+Inf' ? Infinity : Number(value);
const unknown = reason => ({ status: 'unknown', reason, count: null, sumSeconds: null, p95Bucket: null });
const selectedLines = text => text.split('\n').filter(line => line.startsWith(`${metric}_`)
  || line.startsWith(`# HELP ${metric} `) || line.startsWith(`# TYPE ${metric} `)
  || line.startsWith('process_start_time_seconds ')
  // This scrape also resets prom-client's event-loop histogram. Retain its
  // fixed, unlabeled samples so a concurrent classroom snapshot cannot hide
  // the diagnostic interval merely because this observer requested metrics.
  || /^nodejs_eventloop_lag(?:_(?:min|max|mean|stddev|p50|p90|p99))?_seconds /.test(line)).join('\n') + '\n';

/** Preserve observed counters; an absent label is unknown, never an invented zero. */
export function parseAiAdmissionMetrics(text) {
  const series = new Map(); let processStartedAtSeconds;
  try {
    for (const line of text.split('\n')) {
      if (line.startsWith('process_start_time_seconds ')) {
        if (processStartedAtSeconds !== undefined) throw new Error('duplicate-process-identity');
        processStartedAtSeconds = Number(line.split(/\s+/)[1]);
      }
      if (!line.startsWith(`${metric}_`)) continue;
      const match = line.match(/^classroom_ai_admission_seconds_(bucket|count|sum)\{([^}]+)\} ([^ ]+)$/);
      if (!match) throw new Error('malformed-histogram');
      const labels = Object.fromEntries([...match[2].matchAll(/(\w+)="([^"\\]*)"/g)].map(item => [item[1], item[2]]));
      if (!['interactive', 'background'].includes(labels.priority) || !['admitted', 'rejected'].includes(labels.outcome)
        || Object.keys(labels).some(key => !['priority', 'outcome', 'le'].includes(key))) throw new Error('unexpected-labels');
      const key = `${labels.priority}/${labels.outcome}`;
      if (!series.has(key)) series.set(key, { priority: labels.priority, outcome: labels.outcome, buckets: {} });
      const group = series.get(key); const value = Number(match[3]);
      if (!Number.isFinite(value) || value < 0 || (match[1] !== 'sum' && !Number.isInteger(value))) throw new Error('invalid-counter');
      if (match[1] === 'bucket') {
        if (labels.le === undefined || !(boundaryNumber(labels.le) >= 0) || labels.le in group.buckets) throw new Error('invalid-bucket');
        group.buckets[labels.le] = value;
      } else {
        if (labels.le !== undefined || group[match[1]] !== undefined) throw new Error('duplicate-counter');
        group[match[1]] = value;
      }
    }
    if (!Number.isFinite(processStartedAtSeconds) || processStartedAtSeconds <= 0) throw new Error('missing-process-identity');
    if (!series.size) throw new Error('missing-admission-series');
    for (const group of series.values()) {
      const ordered = Object.entries(group.buckets).sort(([a], [b]) => boundaryNumber(a) - boundaryNumber(b));
      if (group.count === undefined || group.sum === undefined || group.buckets['+Inf'] !== group.count || ordered.length < 2) throw new Error('incomplete-histogram');
      let previous = 0;
      for (const [, value] of ordered) { if (value < previous || value > group.count) throw new Error('nonmonotonic-histogram'); previous = value; }
    }
    return { status: 'observed', processStartedAtSeconds, series: Object.fromEntries(series) };
  } catch (error) { return unknown(error.message); }
}

/** Bucket intervals describe process-local admission waits during this window, not provider queues. */
export function diffAiAdmissionSnapshots(before, after) {
  if (before.status !== 'observed' || after.status !== 'observed') return { ...unknown('missing-or-invalid-snapshot'), beforeStatus: before.status, afterStatus: after.status, groups: {} };
  if (before.processStartedAtSeconds !== after.processStartedAtSeconds) return { ...unknown('process-restarted'), groups: {} };
  const groups = {};
  for (const key of new Set([...Object.keys(before.series), ...Object.keys(after.series)])) {
    const left = before.series[key]; const right = after.series[key];
    if (!left || !right) { groups[key] = unknown('series-missing-at-one-boundary'); continue; }
    const bounds = Object.keys(left.buckets).sort((a, b) => boundaryNumber(a) - boundaryNumber(b));
    if (JSON.stringify(bounds) !== JSON.stringify(Object.keys(right.buckets).sort((a, b) => boundaryNumber(a) - boundaryNumber(b)))) { groups[key] = unknown('bucket-schema-changed'); continue; }
    const count = right.count - left.count; const sumSeconds = right.sum - left.sum;
    const buckets = bounds.map(upperBoundSeconds => ({ upperBoundSeconds, count: right.buckets[upperBoundSeconds] - left.buckets[upperBoundSeconds] }));
    if (count < 0 || sumSeconds < 0 || buckets.some((bucket, i) => bucket.count < 0 || bucket.count > count || (i > 0 && bucket.count < buckets[i - 1].count))
      || buckets.at(-1).count !== count || (count === 0 && sumSeconds !== 0)) { groups[key] = unknown('counter-reset-or-inconsistent-delta'); continue; }
    let p95Bucket = null;
    if (count > 0) {
      const index = buckets.findIndex(bucket => bucket.count >= Math.ceil(count * .95));
      p95Bucket = { lowerBoundSeconds: index === 0 ? 0 : Number(buckets[index - 1].upperBoundSeconds), lowerInclusive: index === 0,
        upperBoundSeconds: buckets[index].upperBoundSeconds === '+Inf' ? '+Inf' : Number(buckets[index].upperBoundSeconds), upperInclusive: true };
    }
    groups[key] = { status: 'observed', priority: left.priority, outcome: left.outcome, count, sumSeconds,
      meanSeconds: count ? sumSeconds / count : null, p95Bucket, cumulativeBucketDeltas: buckets,
      ...(count === 0 ? { note: 'No new observed admissions; this is not proof of zero queue latency.' } : {}) };
  }
  return { status: Object.values(groups).some(group => group.status === 'unknown') ? 'unknown' : 'observed', groups,
    scope: 'All process-local admission observations between snapshots, grouped by priority/outcome. Concurrent background or other work may be included; no per-student attribution.',
    supplierInternalQueue: 'not-observable', quantileMethod: 'Nearest-rank P95 bucket interval; no interpolation.' };
}

/** Sample both boundaries even if the browser action fails; diagnostics never replace its first error. */
export async function observeAiAdmissionBatch({ label, output, readMetrics, onObservation = () => {} }, action) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid AI observation label');
  const folder = path.join(output, 'ai-capacity-admission', `${label}-${randomUUID()}`);
  const diagnosticErrors = [];
  const safeWrite = async (file, value) => {
    try { await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, file), value, { mode: 0o600 }); }
    catch (error) { diagnosticErrors.push({ operation: `write-${file}`, code: error.code ?? error.name }); }
  };
  const capture = async boundary => {
    const startedAt = new Date().toISOString(); let snapshot;
    try {
      const raw = selectedLines(await readMetrics());
      await safeWrite(`${boundary}.prom`, raw);
      snapshot = { ...parseAiAdmissionMetrics(raw), startedAt, sampledAt: new Date().toISOString() };
    } catch (error) { snapshot = { ...unknown('metrics-request-failed'), startedAt, sampledAt: new Date().toISOString(), errorName: error.name }; }
    await safeWrite(`${boundary}.json`, JSON.stringify(snapshot, null, 2));
    return snapshot;
  };
  const before = await capture('before');
  let result; let firstFailure; let rejected = false;
  try { result = await action(); }
  catch (error) { firstFailure = error; rejected = true; }
  finally {
    const after = await capture('after');
    const observation = { label, artifactDirectory: folder, before, after, ...diffAiAdmissionSnapshots(before, after),
      action: { status: rejected ? 'rejected' : 'fulfilled', ...(rejected ? { firstFailure: String(firstFailure?.stack ?? firstFailure) } : {}) }, diagnosticErrors };
    if (diagnosticErrors.length) observation.status = 'unknown';
    await safeWrite('observation.json', JSON.stringify(observation, null, 2));
    if (diagnosticErrors.length) observation.status = 'unknown';
    try { await onObservation(observation); }
    catch (error) { diagnosticErrors.push({ operation: 'report-observation', code: error.code ?? error.name }); }
  }
  if (rejected) throw firstFailure;
  return result;
}
