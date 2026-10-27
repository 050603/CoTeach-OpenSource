import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// No polling, HTTP, commands, environment or command-line reads. The one timer
// only bounds an invocation's I/O; it never schedules another sample.
export const PROCESS_TREE_MEMORY_LIMITS = Object.freeze({ maxDepth: 4, maxProcesses: 64, maxThreads: 512, deadlineMs: 250 });
const nativeIo = { readFile, readdir };
const nativeClock = { monotonicNow: () => performance.now(), epochNow: () => Date.now() };
class ObservationFailure extends Error { constructor(code) { super(code); this.code = code; } }
const positiveId = value => Number.isSafeInteger(value) && value > 0;
function startTicks(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{0,23}$/.test(text)) throw new ObservationFailure('invalid-start-ticks');
  return text;
}
function identity(text, expectedPid) {
  if (typeof text !== 'string' || text.length > 8192) throw new ObservationFailure('invalid-stat');
  const end = text.lastIndexOf(')'); const open = text.indexOf('(');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const pid = Number(text.slice(0, open).trim()); const ppid = Number(fields[1]);
  if (open < 1 || end <= open || pid !== expectedPid || !positiveId(ppid) || !/^[A-Za-z]$/.test(fields[0])) throw new ObservationFailure('invalid-stat');
  if (['Z', 'X', 'x'].includes(fields[0])) throw new ObservationFailure('process-exited');
  return { pid, ppid, startTicks: startTicks(fields[19]) };
}
const sameIdentity = (a, b) => a.pid === b.pid && a.ppid === b.ppid && a.startTicks === b.startTicks;
function numericIds(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !positiveId(Number(value)))) throw new ObservationFailure('invalid-inventory');
  const ids = values.map(Number).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length) throw new ObservationFailure('invalid-inventory');
  return ids;
}
const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
function memoryValues(text) {
  if (typeof text !== 'string' || text.length > 65536) throw new ObservationFailure('invalid-smaps');
  const number = name => {
    const lines = text.split('\n').filter(line => line.startsWith(`${name}:`));
    const match = lines.length === 1 ? lines[0].match(new RegExp(`^${name}:\\s+(\\d+) kB\\s*$`)) : null;
    const bytes = match ? Number(match[1]) * 1024 : null;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  };
  return { rssBytes: number('Rss'), pssBytes: number('Pss') };
}

const failCode = error => error instanceof ObservationFailure ? error.code
  : ['EACCES', 'EPERM'].includes(error?.code) ? 'permission-denied'
    : ['ENOENT', 'ESRCH'].includes(error?.code) ? 'process-or-thread-exited' : 'io-unavailable';
function boundedIo(io, clock, durationMs) {
  const begun = clock.monotonicNow(); const startedAt = clock.epochNow();
  if (!Number.isFinite(begun) || !Number.isFinite(startedAt)) throw new TypeError('Invalid diagnostic clock');
  const controller = new AbortController(); let rejectDeadline;
  const deadline = new Promise((resolve, reject) => { void resolve; rejectDeadline = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectDeadline(new ObservationFailure('io-deadline')); }, durationMs);
  deadline.catch(() => undefined);
  const operation = async task => {
    if (controller.signal.aborted || clock.monotonicNow() - begun >= durationMs) throw new ObservationFailure('io-deadline');
    const result = await Promise.race([Promise.resolve().then(task), deadline]);
    const elapsed = clock.monotonicNow() - begun;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new ObservationFailure('invalid-clock');
    if (controller.signal.aborted || elapsed >= durationMs) throw new ObservationFailure('io-deadline');
    return result;
  };
  return { begun, startedAt, operation,
    read: file => operation(() => io.readFile(file, { encoding: 'utf8', signal: controller.signal })),
    finish: () => { clearTimeout(timer); controller.abort(); } };
}

/** Capture once when the harness owns the new ChildProcess. Subsequent samples
 * reuse this anchor rather than accepting whichever process later has the PID.
 */
export async function captureProcessTreeMemoryAnchor({ pid, io = nativeIo, clock = nativeClock }) {
  let budget;
  try {
    if (!positiveId(pid)) throw new ObservationFailure('missing-app-pid');
    budget = boundedIo(io, clock, PROCESS_TREE_MEMORY_LIMITS.deadlineMs);
    const found = identity(await budget.read(`/proc/${pid}/stat`), pid);
    return { status: 'measured', ...found, capturedAt: clock.epochNow() };
  } catch (error) { return { status: 'unknown', pid: positiveId(pid) ? pid : null, startTicks: null, reason: failCode(error) }; }
  finally { budget?.finish(); }
}

/** Linux-only diagnostic snapshot. startTicks is the caller's previously
 * established app identity, not a start time inferred from another process.
 * All paths stay in /proc; injected I/O allows pure fixtures without live reads.
 */
export async function sampleProcessTreeMemory({ pid, startTicks: expectedStart, limits: supplied = {}, io = nativeIo, clock = nativeClock }) {
  if (!positiveId(pid)) throw new TypeError('A positive app PID is required');
  const expected = startTicks(expectedStart); const limits = { ...PROCESS_TREE_MEMORY_LIMITS, ...supplied };
  for (const [key, cap] of Object.entries(PROCESS_TREE_MEMORY_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === 'maxDepth' ? 0 : 1) || limits[key] > cap) throw new RangeError(`Invalid ${key}`);
  }
  const budget = boundedIo(io, clock, limits.deadlineMs);
  const { begun, startedAt, read, operation } = budget;
  const issues = new Map(); const rows = []; const queued = new Map(); let threadCount = 0; let anchor = null;
  const issue = (scope, memberPid, code) => issues.set(`${scope}:${memberPid}:${code}`, { scope, pid: memberPid, code });
  const stat = async memberPid => identity(await read(`/proc/${memberPid}/stat`), memberPid);
  const unknownMemory = () => ({ status: 'unknown', rssBytes: null, pssBytes: null, sampledAt: null, sampleMonotonicMs: null });
  const invalidate = row => { row.identityStatus = 'unknown'; row.memory = unknownMemory(); };
  async function children(row) {
    const base = `/proc/${row.pid}/task`; const initial = numericIds(await operation(() => io.readdir(base)));
    if (!initial.includes(row.pid)) throw new ObservationFailure('main-thread-missing');
    if (threadCount + initial.length > limits.maxThreads) throw new ObservationFailure('max-threads');
    threadCount += initial.length;
    const result = new Set();
    for (const tid of initial) {
      const before = identity(await read(`${base}/${tid}/stat`), tid);
      const text = await read(`${base}/${tid}/children`);
      if (typeof text !== 'string' || text.length > 16384) throw new ObservationFailure('invalid-children');
      const ids = numericIds(text.trim() ? text.trim().split(/\s+/) : []);
      const after = identity(await read(`${base}/${tid}/stat`), tid);
      if (!sameIdentity(before, after)) throw new ObservationFailure('thread-identity-changed');
      for (const child of ids) {
        if (result.has(child)) throw new ObservationFailure('children-inventory-changed');
        result.add(child);
      }
    }
    const final = numericIds(await operation(() => io.readdir(base)));
    if (!sameIds(initial, final)) throw new ObservationFailure('threads-inventory-changed');
    return [...result].sort((a, b) => a - b);
  }
  try {
    anchor = await stat(pid);
    if (anchor.startTicks !== expected) throw new ObservationFailure('app-identity-changed');
    queued.set(pid, { pid, parentPid: null, depth: 0 });
    const queue = [...queued.values()];
    for (let index = 0; index < queue.length; index++) {
      const candidate = queue[index];
      const row = { ...candidate, startTicks: null, ppid: null, identityStatus: 'unknown', memory: unknownMemory() };
      rows.push(row);
      let before;
      try {
        before = await stat(row.pid);
        if (row.pid === pid ? !sameIdentity(anchor, before) : before.ppid !== row.parentPid) throw new ObservationFailure('parent-or-process-identity-changed');
        row.startTicks = before.startTicks; row.ppid = before.ppid;
        try {
          const values = memoryValues(await read(`/proc/${row.pid}/smaps_rollup`));
          const complete = values.rssBytes !== null && values.pssBytes !== null;
          row.memory = { status: complete ? 'measured' : 'unknown', ...values, sampledAt: clock.epochNow(), sampleMonotonicMs: clock.monotonicNow() };
          if (!complete) issue('memory', row.pid, 'missing-or-invalid-rss-pss');
        } catch (error) { issue('memory', row.pid, failCode(error)); }
        try {
          const ids = await children(row);
          if (ids.length && row.depth === limits.maxDepth) issue('inventory', row.pid, 'max-depth');
          else for (const child of ids) {
            if (queued.has(child)) { issue('inventory', row.pid, 'duplicate-or-cyclic-child'); continue; }
            if (queued.size === limits.maxProcesses) { issue('inventory', row.pid, 'max-processes'); break; }
            const next = { pid: child, parentPid: row.pid, depth: row.depth + 1 };
            queued.set(child, next); queue.push(next);
          }
        } catch (error) { issue('inventory', row.pid, failCode(error)); }
        if (!sameIdentity(before, await stat(row.pid))) throw new ObservationFailure('process-identity-changed');
        row.identityStatus = 'verified';
      } catch (error) { invalidate(row); issue('identity', row.pid, failCode(error)); }
    }
    // Revalidate every process after descendant traversal, including the root.
    for (const row of rows) {
      if (row.identityStatus !== 'verified') continue;
      try {
        if (!sameIdentity(row, await stat(row.pid))) throw new ObservationFailure('process-identity-changed');
      } catch (error) { invalidate(row); issue('identity', row.pid, failCode(error)); }
    }
  } catch (error) { issue('identity', pid, failCode(error)); }
  finally { budget.finish(); }

  const root = rows.find(row => row.pid === pid) ?? { pid, parentPid: null, depth: 0, startTicks: null, ppid: null, identityStatus: 'unknown', memory: unknownMemory() };
  const byPid = new Map(rows.map(row => [row.pid, row]));
  for (const row of rows) {
    if (row.parentPid !== null && byPid.get(row.parentPid)?.identityStatus !== 'verified') { invalidate(row); issue('identity', row.pid, 'ancestor-identity-unknown'); }
  }
  const descendants = rows.filter(row => row.pid !== pid);
  const inventoryComplete = root.identityStatus === 'verified' && ![...issues.values()].some(value => value.scope !== 'memory');
  const memoryComplete = inventoryComplete && descendants.every(row => row.identityStatus === 'verified' && row.memory.status === 'measured');
  const known = descendants.filter(row => row.identityStatus === 'verified');
  const sum = key => {
    const measured = known.filter(row => row.memory[key] !== null);
    return measured.length ? measured.reduce((total, row) => total + row.memory[key], 0) : inventoryComplete && !descendants.length ? 0 : null;
  };
  return { schemaVersion: 1, expectedApp: { pid, startTicks: expected }, startedAt, finishedAt: clock.epochNow(),
    startedMonotonicMs: begun, finishedMonotonicMs: clock.monotonicNow(), limits, root, descendants,
    inventory: { status: inventoryComplete ? 'complete' : 'unknown', descendantsCount: inventoryComplete ? descendants.length : null,
      knownStableDescendantsCount: known.length, threadsInspected: threadCount },
    descendantTotals: { status: memoryComplete ? 'measured' : 'unknown',
      rssBytes: memoryComplete ? sum('rssBytes') : null, pssBytes: memoryComplete ? sum('pssBytes') : null,
      knownStableRssSumBytes: sum('rssBytes'), knownStablePssSumBytes: sum('pssBytes') },
    issues: [...issues.values()],
    limitations: ['A bounded non-atomic snapshot; short-lived processes between samples can be missed.',
      'Root and descendants are separate; native and Worker threads belong to their process, not child processes.',
      'Per-process RSS sums can count shared pages repeatedly; summed RSS/PSS are observations at different instants, not atomic unique physical memory.',
      'Unknown inventory is never an empty tree; known partial sums do not establish total application memory.'] };
}
