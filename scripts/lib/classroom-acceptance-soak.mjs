import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluateSustainedClassroom } from './classroom-acceptance-evidence.mjs';

const RESOURCE_METRICS = ['process_start_time_seconds', 'process_resident_memory_bytes', 'nodejs_heap_size_used_bytes',
  'openpbl_process_external_memory_bytes', 'openpbl_process_array_buffer_bytes'];

/** Preserve the original scrape, including unknown values and worker clocks.
 * This does not issue a request or change the existing collection cadence.
 */
export function resourceMetricLines(text) {
  return text.split('\n').filter(line => /^(process_(cpu|resident|heap|start)|nodejs_(heap|eventloop|external)|classroom_(ai|ws|persistence)|openpbl_(process|document_review|pending_save|runtime_asset|published_design_cache|course_admission|course_read_worker|course_read_queue|learning_event_batch|mutation_phase_seconds))/.test(line));
}

export function parseResourceSample(text) {
  const values = {};
  for (const name of RESOURCE_METRICS) {
    const line = text.split('\n').find(value => value.startsWith(`${name} `));
    const token = line?.slice(name.length + 1).trim();
    const value = token && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) ? Number(token) : null;
    values[name] = value !== null && Number.isFinite(value) ? value : null;
  }
  values.mainThreadCpu = parseMainThreadCpuSample(text);
  return values;
}

/** Optional diagnosis only: old applications/unsupported runtimes have no CPU
 * observation. The raw resource journal already retains openpbl_process_*.
 */
export function parseMainThreadCpuSample(text) {
  const lines = text.split('\n');
  const number = name => {
    const matches = lines.filter(line => line.startsWith(`${name} `));
    const token = matches.length === 1 ? matches[0].slice(name.length + 1).trim() : '';
    const value = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) ? Number(token) : null;
    return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const prefix = 'openpbl_process_main_thread_cpu';
  const supported = number(`${prefix}_supported`);
  const available = number(`${prefix}_sample_available`);
  const user = number(`${prefix}_seconds{mode="user"}`);
  const system = number(`${prefix}_seconds{mode="system"}`);
  const time = number(`${prefix}_sample_time_seconds`);
  const monotonic = number(`${prefix}_sample_monotonic_seconds`);
  const measured = supported === 1 && available === 1 && user !== null && system !== null && time > 0 && monotonic !== null;
  return { status: measured ? 'measured' : 'unknown',
    supported: supported === 1 ? true : supported === 0 ? false : null,
    sampleAvailable: available === 1 ? true : available === 0 ? false : null,
    userSeconds: measured ? user : null, systemSeconds: measured ? system : null,
    sampleTimeSeconds: measured ? time : null, sampleMonotonicSeconds: measured ? monotonic : null };
}

/** Native cumulative readings are usable only within the same actual process.
 * This is a sampled interval average, never CPU ownership of a request.
 */
export function mainThreadCpuInterval(previous, current) {
  const unknown = reason => ({ status: 'unknown', reason, userSeconds: null, systemSeconds: null, elapsedSeconds: null, averageCores: null });
  const before = previous?.values?.mainThreadCpu; const after = current?.values?.mainThreadCpu;
  if (before?.status !== 'measured' || after?.status !== 'measured') return unknown('missing-or-invalid-sample');
  if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || previous.pid !== current.pid
    || !(previous.values.process_start_time_seconds > 0) || !Number.isFinite(previous.values.process_start_time_seconds)
    || previous.values.process_start_time_seconds !== current.values.process_start_time_seconds) return unknown('unknown-or-changed-process');
  const numbers = ['userSeconds', 'systemSeconds', 'sampleTimeSeconds', 'sampleMonotonicSeconds'];
  if (numbers.some(key => !Number.isFinite(before[key]) || before[key] < 0 || !Number.isFinite(after[key]) || after[key] < 0)
    || before.sampleTimeSeconds <= 0 || after.sampleTimeSeconds < before.sampleTimeSeconds
    || after.sampleMonotonicSeconds <= before.sampleMonotonicSeconds) return unknown('invalid-or-nonadvancing-clock');
  if (after.userSeconds < before.userSeconds || after.systemSeconds < before.systemSeconds) return unknown('counter-regressed');
  const userSeconds = after.userSeconds - before.userSeconds; const systemSeconds = after.systemSeconds - before.systemSeconds;
  const elapsedSeconds = after.sampleMonotonicSeconds - before.sampleMonotonicSeconds;
  return { status: 'measured', userSeconds, systemSeconds, elapsedSeconds, averageCores: (userSeconds + systemSeconds) / elapsedSeconds };
}

/** No interaction or model load is injected in this window; ordinary browser
 * subscriptions remain live. It is not counted in the five-stage duration.
 */
export async function observeQuietClassroom({ origin, token, pid, output, smoke, applicationProcessTreeMemory }) {
  const startedAt = Date.now(); const durationMs = smoke ? 1000 : 120000;
  const samples = []; let firstSampleAt;
  do {
    const requestedAt = new Date().toISOString();
    const response = await fetch(`${origin}/api/metrics`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    const headersAt = new Date().toISOString();
    assert.equal(response.status, 200, 'Resource metrics unavailable in quiet window');
    const values = parseResourceSample(await response.text());
    const receivedAt = new Date().toISOString();
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const memory = key => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
    let nativeMemory = null;
    try { nativeMemory = (await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')).split('\n')
      .filter(line => /^(Rss|Pss|Private_Dirty|Private_Clean|Anonymous|Swap):/.test(line)).join('\n'); }
    catch { /* Permissions may prevent PSS; process metrics remain authoritative. */ }
    const processTreeMemory = await applicationProcessTreeMemory?.() ?? null;
    const sampledAt = Date.now(); firstSampleAt ??= sampledAt;
    const sample = { at: new Date(sampledAt).toISOString(), metricsCapture: { requestedAt, headersAt, receivedAt }, pid, values, hostMemory: { total: memory('MemTotal'), available: memory('MemAvailable') },
      driverMemory: process.memoryUsage(), nativeMemory, processTreeMemory };
    sample.mainThreadCpuInterval = mainThreadCpuInterval(samples.at(-1), sample);
    samples.push(sample);
    if (sampledAt - firstSampleAt >= durationMs) break;
    await delay(smoke ? 1000 : Math.min(15000, Math.max(1, durationMs - (Date.now() - firstSampleAt))));
  } while (true);
  const evidence = { startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), samples,
    scope: 'Quiet five-stage boundary; live browser subscriptions, no new driver interactions or model requests; accepted background work may finish; excluded from classroom duration' };
  await writeFile(path.join(output, 'quiet-resources.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}

// An absent/partial child inventory is unknown, including in old reports. This
// checks recorded evidence only; it never samples a process during evaluation.
function completeProcessTreeMemory(sample, maximumFinishedAt) {
  const tree = sample.processTreeMemory; const received = Date.parse(sample.metricsCapture?.receivedAt);
  const bytes = value => Number.isSafeInteger(value) && value >= 0;
  if (tree?.schemaVersion !== 1 || tree.expectedApp?.pid !== sample.pid
    || !/^[1-9]\d{0,23}$/.test(tree.expectedApp?.startTicks ?? '') || tree.root?.pid !== sample.pid
    || tree.root.startTicks !== tree.expectedApp.startTicks || tree.root.parentPid !== null || tree.root.depth !== 0
    || tree.inventory?.status !== 'complete' || tree.descendantTotals?.status !== 'measured'
    || !Array.isArray(tree.descendants) || !Array.isArray(tree.issues) || tree.issues.length !== 0) return null;
  if (![received, maximumFinishedAt, tree.startedAt, tree.finishedAt, tree.startedMonotonicMs, tree.finishedMonotonicMs].every(Number.isFinite)
    || tree.startedAt < received || tree.finishedAt < tree.startedAt || tree.finishedAt > maximumFinishedAt
    || tree.finishedMonotonicMs < tree.startedMonotonicMs || tree.finishedMonotonicMs - tree.startedMonotonicMs > 250) return null;
  const members = [tree.root, ...tree.descendants]; const byPid = new Map(members.map(row => [row.pid, row]));
  if (byPid.size !== members.length || members.length > 64 || tree.inventory.descendantsCount !== tree.descendants.length
    || tree.inventory.knownStableDescendantsCount !== tree.descendants.length || !Number.isSafeInteger(tree.inventory.threadsInspected)
    || tree.inventory.threadsInspected < members.length || tree.inventory.threadsInspected > 512) return null;
  for (const member of members) {
    const memory = member.memory;
    if (!Number.isSafeInteger(member.pid) || member.pid <= 0 || member.identityStatus !== 'verified'
      || !/^[1-9]\d{0,23}$/.test(member.startTicks ?? '') || memory?.status !== 'measured'
      || !bytes(memory.rssBytes) || !bytes(memory.pssBytes)
      || !Number.isFinite(memory.sampledAt) || memory.sampledAt < tree.startedAt || memory.sampledAt > tree.finishedAt
      || !Number.isFinite(memory.sampleMonotonicMs) || memory.sampleMonotonicMs < tree.startedMonotonicMs
      || memory.sampleMonotonicMs > tree.finishedMonotonicMs) return null;
    if (member !== tree.root) {
      const parent = byPid.get(member.parentPid);
      if (!parent || member.ppid !== parent.pid || member.depth !== parent.depth + 1 || member.depth > 4) return null;
    }
  }
  for (const key of ['rssBytes', 'pssBytes']) {
    const sum = tree.descendants.reduce((total, row) => total + row.memory[key], 0);
    if (tree.descendantTotals[key] !== sum || tree.descendantTotals[`knownStable${key === 'rssBytes' ? 'Rss' : 'Pss'}SumBytes`] !== sum) return null;
  }
  return `${sample.pid}:${tree.root.startTicks}`;
}

export function evaluateClassroomSoak(classes, { minutes, students, smoke, count = 3 }) {
  const failures = []; const missing = [];
  if (classes.length !== count) missing.push(`Expected ${count} classes, observed ${classes.length}`);
  const identities = new Set(); const treeIdentities = new Set(); const instances = new Set(); const rss = []; let previousQuietEnd;
  let treeSamples = 0; let completeTreeSamples = 0;
  for (const [index, lesson] of classes.entries()) {
    const label = `Class ${index + 1}`;
    const sustained = evaluateSustainedClassroom(lesson, { minutes, students, smoke });
    failures.push(...sustained.failures.map(message => `${label}: ${message}`));
    missing.push(...sustained.missing.map(message => `${label}: ${message}`));
    if (index < count - 1) {
      const finished = lesson.checks?.filter(row => row.name === 'soak-classroom-finished') ?? [];
      if (finished.length !== 1 || !['通过', 'passed'].includes(finished[0]?.status)
        || finished[0]?.evidence !== 'browser-real-backend') missing.push(`${label} has no confirmed teacher classroom completion`);
    }
    if (!lesson.instanceId) missing.push(`${label} instance identity is missing`);
    else if (instances.has(lesson.instanceId)) failures.push('Sustained classroom instances are duplicated');
    instances.add(lesson.instanceId);
    const classStart = Date.parse(lesson.startedAt);
    if (Number.isFinite(previousQuietEnd) && Number.isFinite(classStart) && classStart < previousQuietEnd) failures.push('Sustained classroom windows overlap');
    previousQuietEnd = Date.parse(lesson.quietWindow?.finishedAt);
    if (!Number.isFinite(lesson.actualDurationSeconds) || lesson.actualDurationSeconds < minutes * 60) missing.push(`${label} continuous duration is incomplete`);
    const samples = lesson.quietWindow?.samples ?? [];
    if (samples.length < 2) missing.push(`${label} has no quiet resource evidence`);
    const quietStart = Date.parse(lesson.quietWindow?.startedAt);
    const quietEnd = Date.parse(lesson.quietWindow?.finishedAt);
    const firstAt = Date.parse(samples[0]?.at); const lastAt = Date.parse(samples.at(-1)?.at);
    const quietDuration = smoke ? 1000 : 120000;
    const classEnd = Date.parse(lesson.finishedAt);
    if (!Number.isFinite(classEnd) || !Number.isFinite(quietStart) || quietStart < classEnd) missing.push(`${label} quiet resources were not observed after the classroom`);
    if (!Number.isFinite(quietStart) || !Number.isFinite(quietEnd) || !Number.isFinite(firstAt) || !Number.isFinite(lastAt)
      || quietEnd - quietStart < quietDuration || lastAt - firstAt < quietDuration || firstAt < quietStart || lastAt > quietEnd
      || samples.some((sample, i) => !Number.isFinite(Date.parse(sample.at)) || (i > 0 && Date.parse(sample.at) < Date.parse(samples[i - 1].at)))) missing.push(`${label} has an incomplete quiet window`);
    const processSamples = lesson.processSamples ?? [];
    const expected = ['launch', 'ai-learning', 'make', 'showcase', 'reflection'];
    if (!expected.every(stage => processSamples.some(sample => sample.stageKey === stage))) missing.push(`${label} lacks process evidence during all five stages`);
    for (const sample of processSamples) {
      const phase = lesson.phaseTiming?.find(value => value.stageKey === sample.stageKey);
      const at = Date.parse(sample.at); const phaseStart = Date.parse(phase?.startedAt); const phaseEnd = Date.parse(phase?.finishedAt);
      const capture = sample.metricsCapture ?? {};
      const requested = Date.parse(capture.requestedAt); const headers = Date.parse(capture.headersAt); const received = Date.parse(capture.receivedAt);
      // `at` begins authentication/continuity checks; metrics are fetched later.
      // A response may cross a phase boundary by the existing 5s fetch timeout,
      // but cannot borrow another class or the following quiet observation.
      if (![at, phaseStart, phaseEnd, requested, headers, received, quietStart].every(Number.isFinite)
        || at < phaseStart || at > phaseEnd || requested < at || requested > phaseEnd
        || headers < requested || received < headers || received - requested > 5000
        || received > phaseEnd + 5000 || received > quietStart) missing.push(`${label} has unbound or invalid process sample clocks`);
      treeSamples++;
      const treeIdentity = completeProcessTreeMemory(sample, Math.min(phaseEnd + 5000, quietStart));
      if (!treeIdentity) missing.push(`${label} has unknown application child-process memory`);
      else { completeTreeSamples++; treeIdentities.add(treeIdentity); }
    }
    for (const sample of [...processSamples, ...samples]) {
      const values = sample.values ?? {};
      if (!Number.isSafeInteger(sample.pid) || sample.pid <= 0 || RESOURCE_METRICS.some(name => !Number.isFinite(values[name]) || values[name] < 0)
        || !(values.process_start_time_seconds > 0)) missing.push(`${label} has unknown process metrics`);
      else identities.add(`${sample.pid}:${values.process_start_time_seconds}`);
    }
    for (const sample of samples) {
      const capture = sample.metricsCapture ?? {}; const at = Date.parse(sample.at);
      const requested = Date.parse(capture.requestedAt); const headers = Date.parse(capture.headersAt); const received = Date.parse(capture.receivedAt);
      if (![requested, headers, received, at, quietStart, quietEnd].every(Number.isFinite)
        || requested < quietStart || headers < requested || received < headers || at < received || at > quietEnd
        || received - requested > 5000) missing.push(`${label} has unbound or invalid quiet resource capture clocks`);
      treeSamples++;
      const treeIdentity = completeProcessTreeMemory(sample, at);
      if (!treeIdentity) missing.push(`${label} has unknown quiet child-process memory`);
      else { completeTreeSamples++; treeIdentities.add(treeIdentity); }
      if (!Number.isFinite(sample.hostMemory?.available) || !(sample.hostMemory?.total > 0)
        || sample.hostMemory.available > sample.hostMemory.total) missing.push(`${label} host memory is unknown`);
      else if (sample.hostMemory.available / sample.hostMemory.total < 0.15) failures.push(`${label} has insufficient host memory`);
    }
    rss.push(samples.at(-1)?.values.process_resident_memory_bytes ?? null);
  }
  if (identities.size > 1) failures.push('Application process changed during the three-class workload');
  else if (identities.size !== 1) missing.push('Application process identity is unavailable');
  if (treeIdentities.size > 1) failures.push('Application kernel process identity changed during the three-class workload');
  // RSS includes native allocators and bounded caches. Allow warmup headroom,
  // but do not call substantial continued growth a successful soak.
  const growthBytes = rss.length === count && rss.every(value => Number.isFinite(value)) ? rss.at(-1) - rss[0] : null;
  const permittedGrowthBytes = Math.max(512 * 1024 * 1024, (rss[0] ?? 0) * 0.2);
  if (growthBytes === null) missing.push('Post-class RSS growth is unknown');
  else if (!smoke && growthBytes > permittedGrowthBytes) failures.push('Post-class RSS continues to accumulate beyond the defined headroom');
  return { status: failures.length ? 'failed' : missing.length || smoke ? 'partial' : 'passed',
    failures: [...new Set(failures)], missing: [...new Set(missing)],
    classes: classes.length, processIdentities: [...identities], rssAfterQuietWindows: rss, growthBytes, permittedGrowthBytes,
    processTreeMemory: { status: treeSamples > 0 && treeSamples === completeTreeSamples ? 'measured' : 'unknown', samples: treeSamples,
      completeSamples: completeTreeSamples, processIdentities: [...treeIdentities],
      interpretation: 'Bounded child-process snapshots, not proof that short-lived children were captured; per-process sums are non-atomic and RSS can repeat shared pages' },
    memoryInterpretation: 'RSS trend gate, not proof that every native allocation is released or that a leak is absent' };
}
