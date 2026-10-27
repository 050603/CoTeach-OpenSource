import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { evaluateClassroomSoak, observeQuietClassroom, parseResourceSample, parseMainThreadCpuSample, mainThreadCpuInterval, resourceMetricLines } from './classroom-acceptance-soak.mjs';
import { sustainedLesson, syntheticProcessTreeMemory } from './classroom-acceptance-test-fixtures.mjs';
const stages = ['launch', 'ai-learning', 'make', 'showcase', 'reflection'];
const sample = rss => ({ pid: 42,
    values: { process_start_time_seconds: 1000, process_resident_memory_bytes: rss,
      nodejs_heap_size_used_bytes: 100, openpbl_process_external_memory_bytes: 100, openpbl_process_array_buffer_bytes: 50 },
    hostMemory: { total: 1000, available: 800 } });
const originalMinimalLesson = rss => ({ students: 30, actualDurationSeconds: 5400,
  phaseTiming: stages.map(stageKey => ({ stageKey })),
  checks: [{ status: '通过' }], processSamples: stages.map(stageKey => ({ ...sample(rss), stageKey })),
  quietWindow: { startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:02:00Z',
    samples: ['2026-10-16T00:00:00Z', '2026-10-16T00:02:00Z'].map(at => ({ ...sample(rss), at })) } });
let lessonSequence = 0;
const lesson = rss => sustainedLesson({ sequence: ++lessonSequence, rss });
const options = { minutes: 90, students: 30, smoke: false };
const cpuMetrics = ({ user = 2, system = 0.25, supported = 1, available = 1, time = 1700000000, monotonic = 10 } = {}) => [
  `openpbl_process_main_thread_cpu_seconds{mode="user"} ${user}`,
  `openpbl_process_main_thread_cpu_seconds{mode="system"} ${system}`,
  `openpbl_process_main_thread_cpu_supported ${supported}`,
  `openpbl_process_main_thread_cpu_sample_available ${available}`,
  `openpbl_process_main_thread_cpu_sample_time_seconds ${time}`,
  `openpbl_process_main_thread_cpu_sample_monotonic_seconds ${monotonic}`,
].join('\n');

test('original resource capture retains worker generations, CPU and sample clocks including NaN without changing memory evidence', () => {
  const original = ['process_start_time_seconds 1000', 'process_resident_memory_bytes 200', 'nodejs_heap_size_used_bytes 100',
    'openpbl_process_external_memory_bytes 20', 'openpbl_process_array_buffer_bytes 10', cpuMetrics()];
  const worker = ['openpbl_course_read_worker_generation{slot="0"} 3',
    'openpbl_course_read_worker_cpu_microseconds{slot="0",kind="user"} 0',
    'openpbl_course_read_worker_cpu_microseconds{slot="0",kind="system"} 7',
    'openpbl_course_read_worker_sample_time_seconds{slot="0"} 1700000000.123',
    'openpbl_course_read_worker_sample_monotonic_seconds{slot="0"} 12.5',
    'openpbl_course_read_worker_cpu_microseconds{slot="1",kind="user"} Nan',
    'openpbl_course_read_worker_generation{slot="1"} Nan',
    'openpbl_course_read_worker_memory_bytes{slot="1",kind="heapUsed"} Nan',
    'openpbl_course_read_worker_state{state="enabled"} 1', 'openpbl_course_read_queue_oldest_seconds 0'];
  const selected = resourceMetricLines([...original, ...worker, 'unrelated_debug_metric 42', '# HELP worker private'].join('\n'));
  for (const line of worker) assert.ok(selected.includes(line));
  assert.ok(!selected.some(line => line.startsWith('unrelated') || line.startsWith('#')));
  assert.deepEqual(parseResourceSample(selected.join('\n')), parseResourceSample(original.join('\n')));
});

test('optional main-thread CPU retains cumulative values, capability and original clocks without inventing legacy samples', () => {
  assert.deepEqual(parseResourceSample(cpuMetrics()).mainThreadCpu, { status: 'measured', supported: true, sampleAvailable: true,
    userSeconds: 2, systemSeconds: 0.25, sampleTimeSeconds: 1700000000, sampleMonotonicSeconds: 10 });
  assert.deepEqual(parseMainThreadCpuSample(''), { status: 'unknown', supported: null, sampleAvailable: null,
    userSeconds: null, systemSeconds: null, sampleTimeSeconds: null, sampleMonotonicSeconds: null });
  assert.equal(parseMainThreadCpuSample(cpuMetrics({ user: 0, system: 0 })).userSeconds, 0);
  const unsupported = parseMainThreadCpuSample(cpuMetrics({ supported: 0, available: 0 }));
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.sampleAvailable, false);
  assert.equal(unsupported.userSeconds, null); // Stale values cannot override unknown capability.
  for (const text of [cpuMetrics({ available: 0 }), cpuMetrics({ user: 'NaN' }), cpuMetrics({ user: -1 }), cpuMetrics({ system: 'Infinity' }),
    cpuMetrics({ time: 0 }), cpuMetrics({ time: 'NaN' }), cpuMetrics({ monotonic: 'NaN' }), cpuMetrics({ monotonic: -1 }),
    cpuMetrics().replace(/^.*mode="system".*\n/m, ''), `${cpuMetrics()}\nopenpbl_process_main_thread_cpu_seconds{mode="user"} 3`]) {
    assert.equal(parseMainThreadCpuSample(text).status, 'unknown');
    assert.equal(parseMainThreadCpuSample(text).userSeconds, null);
  }
});

test('CPU interval uses native monotonic sample clocks and only the same actual process, with reset/missing/duplicate samples unknown', () => {
  const entry = options => ({ pid: 42, values: parseResourceSample(`process_start_time_seconds 1000\n${cpuMetrics(options)}`) });
  const previous = entry(); const current = entry({ user: 2.6, system: 0.65, time: 1700000004, monotonic: 12 });
  const interval = mainThreadCpuInterval(previous, current);
  assert.equal(interval.status, 'measured');
  assert.equal(interval.elapsedSeconds, 2); // Wall elapsed 4s is not the denominator.
  assert.ok(Math.abs(interval.averageCores - 0.5) < 1e-12);
  for (const damage of [
    sample => { delete sample.pid; }, sample => { sample.pid = 43; },
    sample => { delete sample.values.process_start_time_seconds; }, sample => { sample.values.process_start_time_seconds = 1001; },
    sample => { sample.values.mainThreadCpu = parseMainThreadCpuSample(''); },
    sample => { sample.values.mainThreadCpu.sampleMonotonicSeconds = 10; },
    sample => { sample.values.mainThreadCpu.sampleMonotonicSeconds = 9; },
    sample => { sample.values.mainThreadCpu.sampleTimeSeconds = 1699999999; },
    sample => { sample.values.mainThreadCpu.userSeconds = 1.9; }, sample => { sample.values.mainThreadCpu.systemSeconds = 0.1; },
    sample => { sample.values.mainThreadCpu.userSeconds = NaN; },
  ]) {
    const altered = structuredClone(current); damage(altered);
    const observed = mainThreadCpuInterval(previous, altered);
    assert.equal(observed.status, 'unknown');
    assert.equal(observed.averageCores, null);
  }
  assert.equal(mainThreadCpuInterval(previous, previous).status, 'unknown');
  assert.equal(mainThreadCpuInterval(undefined, current).status, 'unknown');
});
test('soak requires three complete classes in the same actual app process and preserves failures', () => {
  assert.equal(evaluateClassroomSoak([lesson(1e9), lesson(1.1e9), lesson(1.2e9)], options).status, 'passed');
  assert.equal(evaluateClassroomSoak([lesson(1e9)], options).status, 'partial');
  const restarted = [lesson(1e9), lesson(1e9), lesson(1e9)]; restarted[1].quietWindow.samples[0].pid = 43;
  assert.equal(evaluateClassroomSoak(restarted, options).status, 'failed');
  const failed = [lesson(1e9), lesson(1e9), lesson(1e9)]; failed[0].checks[0].status = '失败';
  assert.equal(evaluateClassroomSoak(failed, options).status, 'failed');
});
test('resource growth, missing samples and smoke cannot masquerade as a stable long run', () => {
  assert.equal(evaluateClassroomSoak([lesson(1e9), lesson(2e9), lesson(3e9)], options).status, 'failed');
  const unknown = [lesson(1e9), lesson(1e9), lesson(1e9)]; unknown[2].quietWindow.samples[0].values.openpbl_process_external_memory_bytes = null;
  assert.equal(evaluateClassroomSoak(unknown, options).status, 'partial');
  assert.equal(evaluateClassroomSoak([lesson(1e9), lesson(1e9), lesson(1e9)], { ...options, smoke: true }).status, 'partial');
  assert.equal(parseResourceSample('process_start_time_seconds 123\nprocess_resident_memory_bytes NaN').process_resident_memory_bytes, null);
});

test('rejects incomplete/invalid measurements rather than accepting NaN comparisons or empty objects', () => {
  for (const damage of [
    value => { value.actualDurationSeconds = Number.NaN; },
    value => { delete value.actualDurationSeconds; },
    value => { value.quietWindow.samples[0].values = {}; },
    value => { value.quietWindow.samples[0].values.process_start_time_seconds = Infinity; },
    value => { value.quietWindow.samples[0].hostMemory.total = Number.NaN; },
    value => { value.quietWindow.finishedAt = '2026-10-16T00:00:05Z'; },
    value => { value.quietWindow.samples[1].at = value.quietWindow.samples[0].at; },
    value => { value.quietWindow.samples[0].at = 'invalid'; },
    value => { delete value.phaseTiming; },
    value => { value.checks = []; },
    value => { value.processSamples = []; },
    value => { value.processSamples[2].values.process_start_time_seconds = 1001; },
  ]) {
    const classes = [lesson(1e9), lesson(1e9), lesson(1e9)]; damage(classes[1]);
    assert.notEqual(evaluateClassroomSoak(classes, options).status, 'passed');
  }
});

test('quiet observation covers the full sampling interval after a slow first scrape', async () => {
  let requests = 0; let processMemorySamples = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer isolated-monitor');
    const body = Object.entries(sample(1e9).values).map(([name, value]) => `${name} ${value}`).join('\n');
    const send = () => response.end(body);
    if (++requests === 1) setTimeout(send, 60); else send();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const output = await mkdtemp(path.join(os.tmpdir(), 'openpbl-quiet-window-'));
  try {
    const observed = await observeQuietClassroom({ origin: `http://127.0.0.1:${server.address().port}`, token: 'isolated-monitor',
      pid: process.pid, output, smoke: true, applicationProcessTreeMemory: async () => {
        processMemorySamples++; return syntheticProcessTreeMemory({ pid: process.pid, at: Date.now() });
      } });
    assert.ok(observed.samples.length >= 2);
    assert.ok(Date.parse(observed.samples.at(-1).at) - Date.parse(observed.samples[0].at) >= 1000);
    assert.ok(Date.parse(observed.samples[0].at) - Date.parse(observed.startedAt) >= 50);
    assert.equal(processMemorySamples, requests, 'The existing metrics capture is the only sampling cadence');
    assert.ok(observed.samples.every(row => row.processTreeMemory.expectedApp.pid === process.pid));
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'quiet-resources.json'), 'utf8')), observed);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});

test('blank/malformed resource values stay unknown while explicit zero is observed', () => {
  for (const invalid of ['', ' ', '\t', 'NaN', '+Inf', 'Infinity', '0x10', '1 2']) {
    assert.equal(parseResourceSample(`process_resident_memory_bytes ${invalid}`).process_resident_memory_bytes, null, invalid);
  }
  for (const [raw, expected] of [['0', 0], ['0.0', 0], ['1.2e9', 1.2e9]]) {
    assert.equal(parseResourceSample(`process_resident_memory_bytes ${raw}`).process_resident_memory_bytes, expected);
  }
});
test('the original minimal fixture cannot prove any of the three real classrooms', () => {
  assert.notEqual(evaluateClassroomSoak([originalMinimalLesson(1e9), originalMinimalLesson(1e9), originalMinimalLesson(1e9)], options).status, 'passed');
});
test('every earlier class must retain actual traffic, continuity and durable review proof', () => {
  const valid = () => [1, 2, 3].map(sequence => sustainedLesson({ sequence }));
  for (const damage of [
    value => { delete value.metrics; },
    value => { value.metrics.make = {}; },
    value => { value.metrics.make['GET /api/course/state read'].p95Ms = 1001; },
    value => { value.metrics.make['POST /api/course/actions save'].p95Ms = 2001; },
    value => { value.metrics.make['GET /api/course/state read'].unmeasured = 1; },
    value => { value.continuitySnapshots = []; },
    value => { value.continuitySnapshots[0].authenticatedStudents = 29; },
    value => { value.continuitySnapshots[0].providerConfigurationSha256 = 'b'.repeat(64); },
    value => { delete value.documentReviewSettlement; },
    value => { value.checks = value.checks.filter(row => row.name !== 'soak-classroom-finished'); },
    value => { value.documentReviewSettlement.students.pop(); },
    value => { value.documentReviewSettlement.students[0].status = 'failed'; },
    value => { value.documentReviewSettlement.students[0].finalPendingKeys = ['still-pending']; },
    value => { value.documentReviewSettlement.students[0].proof.missingCheckpoints = ['not-retained']; },
    value => { value.documentReviewSettlement.students[0].elapsedMs = 300001; },
    value => { value.documentReviewSettlement.students[1].userId = value.documentReviewSettlement.students[0].userId; },
  ]) {
    const classes = valid(); damage(classes[0]); assert.notEqual(evaluateClassroomSoak(classes, options).status, 'passed');
  }
  const duplicate = valid(); duplicate[1].instanceId = duplicate[0].instanceId;
  assert.equal(evaluateClassroomSoak(duplicate, options).status, 'failed');
  const overlap = valid(); overlap[1].startedAt = overlap[0].startedAt;
  assert.equal(evaluateClassroomSoak(overlap, options).status, 'failed');
  assert.equal(evaluateClassroomSoak(valid(), options).status, 'passed');
});


test('process scrape clocks belong to their named phase and cannot borrow stale/future/cross-class evidence', () => {
  const valid = () => [1, 2, 3].map(sequence => sustainedLesson({ sequence }));
  assert.equal(evaluateClassroomSoak(valid(), options).status, 'passed');
  const iso = value => new Date(value).toISOString();
  for (const damage of [
    value => { delete value.processSamples[0].at; },
    value => { value.processSamples[0].at = 'invalid'; },
    value => { delete value.processSamples[0].metricsCapture; },
    value => { value.processSamples[0].at = '2000-01-01T00:00:00Z'; },
    value => { value.processSamples[0].metricsCapture.requestedAt = iso(Date.parse(value.phaseTiming[0].startedAt) - 1); },
    value => { value.processSamples[0].metricsCapture.headersAt = iso(Date.parse(value.processSamples[0].metricsCapture.requestedAt) - 1); },
    value => { value.processSamples[0].metricsCapture.receivedAt = 'invalid'; },
    value => { value.processSamples[0].metricsCapture.receivedAt = iso(Date.parse(value.processSamples[0].metricsCapture.headersAt) - 1); },
    value => { value.processSamples[0].metricsCapture.requestedAt = iso(Date.parse(value.phaseTiming[0].finishedAt) + 1); },
    value => { value.processSamples[0].metricsCapture.receivedAt = iso(Date.parse(value.phaseTiming[0].finishedAt) + 5001); },
    value => { value.processSamples[0] = { ...value.processSamples[1], stageKey: 'launch' }; },
    value => { value.processSamples[4].metricsCapture.receivedAt = iso(Date.parse(value.quietWindow.startedAt) + 1); },
  ]) {
    const classes = valid(); damage(classes[1]);
    assert.notEqual(evaluateClassroomSoak(classes, options).status, 'passed');
  }
  const late = valid(); const row = late[1].processSamples[0]; const end = Date.parse(late[1].phaseTiming[0].finishedAt);
  row.at = iso(end - 200); row.metricsCapture = { requestedAt: iso(end - 100), headersAt: iso(end + 50), receivedAt: iso(end + 100) };
  row.processTreeMemory = syntheticProcessTreeMemory({ at: end + 101 });
  assert.equal(evaluateClassroomSoak(late, options).status, 'passed', 'bounded response completion can cross a phase boundary');
});

test('child-process memory requires stable complete identities and original sampling clocks; old/partial evidence stays unknown', () => {
  const valid = () => [1, 2, 3].map(sequence => sustainedLesson({ sequence }));
  for (const damage of [
    row => { delete row.processTreeMemory; },
    row => { row.processTreeMemory = null; },
    row => { row.processTreeMemory.inventory.status = 'unknown'; },
    row => { row.processTreeMemory.inventory.descendantsCount = null; },
    row => { row.processTreeMemory.root.identityStatus = 'unknown'; },
    row => { row.processTreeMemory.root.memory.pssBytes = null; },
    row => { row.processTreeMemory.expectedApp.pid++; },
    row => { row.processTreeMemory.root.startTicks = '999'; },
    row => { row.processTreeMemory.descendantTotals.pssBytes = 1; },
    row => { row.processTreeMemory.startedAt = Date.parse(row.metricsCapture.receivedAt) - 1; },
    row => { row.processTreeMemory.finishedAt += 10000000; },
    row => { row.processTreeMemory.finishedMonotonicMs = 252; },
    row => { row.processTreeMemory.issues = [{ scope: 'inventory', code: 'max-depth' }]; },
  ]) {
    const classes = valid(); damage(classes[1].processSamples[0]);
    const result = evaluateClassroomSoak(classes, options);
    assert.equal(result.status, 'partial');
    assert.equal(result.processTreeMemory.status, 'unknown');
    assert.ok(result.missing.includes('Class 2 has unknown application child-process memory'));
  }
  const classes = valid(); delete classes[0].quietWindow.samples[0].processTreeMemory;
  assert.equal(evaluateClassroomSoak(classes, options).status, 'partial');
  const known = evaluateClassroomSoak(valid(), options);
  assert.equal(known.processTreeMemory.status, 'measured');
  assert.equal(known.processTreeMemory.samples, 21);
  assert.equal(known.processTreeMemory.completeSamples, 21);
  assert.deepEqual(known.processTreeMemory.processIdentities, ['42:42000']);
  const restarted = valid(); const tree = restarted[1].processSamples[0].processTreeMemory;
  tree.root.startTicks = '42001'; tree.expectedApp.startTicks = '42001';
  assert.equal(evaluateClassroomSoak(restarted, options).status, 'failed');
});

test('quiet resource captures must follow the class and stay within the complete quiet window', () => {
  const valid = () => [1, 2, 3].map(sequence => sustainedLesson({ sequence }));
  const iso = value => new Date(value).toISOString();
  for (const damage of [
    value => { const start = Date.parse(value.startedAt) - 120100; value.quietWindow.startedAt = iso(start); value.quietWindow.finishedAt = value.startedAt;
      value.quietWindow.samples.forEach((row, index) => { const at = start + 100 + index * 120000; row.at = iso(at);
        row.metricsCapture = { requestedAt: iso(at - 100), headersAt: iso(at - 50), receivedAt: iso(at) }; }); },
    value => { delete value.quietWindow.samples[0].metricsCapture; },
    value => { value.quietWindow.samples[0].metricsCapture.requestedAt = iso(Date.parse(value.quietWindow.startedAt) - 1); },
    value => { value.quietWindow.samples[0].metricsCapture.headersAt = iso(Date.parse(value.quietWindow.samples[0].metricsCapture.requestedAt) - 1); },
    value => { value.quietWindow.samples[0].metricsCapture.receivedAt = iso(Date.parse(value.quietWindow.samples[0].at) + 1); },
    value => { value.quietWindow.samples[0].metricsCapture.receivedAt = 'invalid'; },
    value => { value.quietWindow.samples[1].at = iso(Date.parse(value.quietWindow.finishedAt) + 1); },
  ]) {
    const classes = valid(); damage(classes[1]);
    assert.notEqual(evaluateClassroomSoak(classes, options).status, 'passed');
  }
});
