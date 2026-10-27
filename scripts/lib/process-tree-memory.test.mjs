import test from 'node:test';
import assert from 'node:assert/strict';
import { captureProcessTreeMemoryAnchor, sampleProcessTreeMemory } from './process-tree-memory.mjs';

function stat(pid, ppid, start = pid * 10, state = 'S') {
  const fields = Array(22).fill('0');
  Object.assign(fields, { 0: state, 1: String(ppid), 19: String(start) });
  return `${pid} (fixture ) process) ${fields.join(' ')}`;
}
function fixture(definitions = [{ pid: 100, ppid: 1, tids: { 100: [] }, rss: 100, pss: 80 }]) {
  const files = new Map(); const directories = new Map(); const calls = [];
  let now = 10;
  for (const { pid, ppid, start = pid * 10, tids = { [pid]: [] }, rss = 20, pss = 10 } of definitions) {
    files.set(`/proc/${pid}/stat`, stat(pid, ppid, start));
    files.set(`/proc/${pid}/smaps_rollup`, `Rss: ${rss} kB\nPss: ${pss} kB\nAnonymous: 3 kB\n`);
    directories.set(`/proc/${pid}/task`, Object.keys(tids));
    for (const [tid, children] of Object.entries(tids)) {
      files.set(`/proc/${pid}/task/${tid}/stat`, stat(Number(tid), ppid, Number(tid) * 10));
      files.set(`/proc/${pid}/task/${tid}/children`, children.join(' '));
    }
  }
  const load = async (map, file) => {
    calls.push(file);
    if (!map.has(file)) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' });
    const value = map.get(file);
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value() : value;
  };
  return { files, directories, calls, clock: { monotonicNow: () => now, epochNow: () => 100000 + now },
    advance: ms => { now += ms; }, io: { readFile: file => load(files, file), readdir: file => load(directories, file) } };
}
const sample = (fs, extra = {}) => sampleProcessTreeMemory({ pid: 100, startTicks: '1000', io: fs.io, clock: fs.clock, ...extra });
const hasIssue = (result, code) => result.issues.some(issue => issue.code === code);
const tree = () => fixture([
  { pid: 100, ppid: 1, tids: { 100: [], 101: [200] }, rss: 100, pss: 80 },
  { pid: 200, ppid: 100, tids: { 200: [300] }, rss: 40, pss: 25 },
  { pid: 300, ppid: 200, rss: 20, pss: 12 },
]);

test('launch-time anchor captures the owned process generation once and fails closed without a live identity', async () => {
  const fs = fixture(); const anchor = await captureProcessTreeMemoryAnchor({ pid: 100, io: fs.io, clock: fs.clock });
  assert.deepEqual(anchor, { status: 'measured', pid: 100, ppid: 1, startTicks: '1000', capturedAt: 100010 });
  assert.deepEqual(fs.calls, ['/proc/100/stat']);
  fs.files.set('/proc/100/stat', stat(100, 1, 2000));
  const changed = await sample(fs, { startTicks: anchor.startTicks });
  assert.equal(changed.inventory.status, 'unknown');
  assert.equal(changed.root.memory.rssBytes, null);
  const missing = await captureProcessTreeMemoryAnchor({ pid: 999, io: fs.io, clock: fs.clock });
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.startTicks, null);
  assert.equal(missing.reason, 'process-or-thread-exited');
  const invalid = await captureProcessTreeMemoryAnchor({ pid: undefined, io: fs.io, clock: fs.clock });
  assert.equal(invalid.status, 'unknown');
  assert.equal(invalid.pid, null);
});

test('all TIDs discover real descendants, never native threads; root and sums remain separate', async () => {
  const fs = tree(); const result = await sample(fs);
  assert.equal(result.inventory.status, 'complete');
  assert.equal(result.inventory.descendantsCount, 2);
  assert.equal(result.inventory.threadsInspected, 4);
  assert.deepEqual(result.descendants.map(row => [row.pid, row.parentPid, row.startTicks, row.depth]), [[200, 100, '2000', 1], [300, 200, '3000', 2]]);
  assert.equal(result.root.memory.rssBytes, 102400);
  assert.deepEqual(result.descendantTotals, { status: 'measured', rssBytes: 61440, pssBytes: 37888, knownStableRssSumBytes: 61440, knownStablePssSumBytes: 37888 });
  assert.equal(result.issues.length, 0);
  assert.ok(!fs.calls.some(file => /environ|cmdline|\/proc\/101\//.test(file)));
});

test('complete stable empty inventory alone proves zero descendants at this sampled interval', async () => {
  const result = await sample(fixture());
  assert.equal(result.inventory.status, 'complete');
  assert.equal(result.inventory.descendantsCount, 0);
  assert.equal(result.descendantTotals.rssBytes, 0);
  assert.equal(result.descendantTotals.pssBytes, 0);
  assert.match(result.limitations.join(' '), /short-lived/);
});

test('missing root anchor cannot read a reused application or manufacture an empty tree', async () => {
  const fs = tree(); const result = await sample(fs, { startTicks: 999 });
  assert.equal(result.inventory.status, 'unknown');
  assert.equal(result.inventory.descendantsCount, null);
  assert.equal(result.root.memory.rssBytes, null);
  assert.equal(result.descendantTotals.rssBytes, null);
  assert.deepEqual(fs.calls, ['/proc/100/stat']);
});

test('permissions and thread exits keep child inventory unknown instead of zero', async () => {
  for (const code of ['EACCES', 'ENOENT']) {
    const fs = fixture();
    fs.files.set('/proc/100/task/100/children', Object.assign(new Error('no fixture access'), { code }));
    const result = await sample(fs);
    assert.equal(result.root.identityStatus, 'verified');
    assert.equal(result.inventory.status, 'unknown');
    assert.equal(result.inventory.descendantsCount, null);
    assert.equal(result.descendantTotals.rssBytes, null);
    assert.ok(hasIssue(result, code === 'EACCES' ? 'permission-denied' : 'process-or-thread-exited'));
  }
});

test('child memory cannot survive PID reuse or parent changes; descendants of an unstable ancestor are unknown', async () => {
  for (const change of [() => stat(200, 100, 9999), () => stat(200, 9, 2000)]) {
    const fs = tree(); let reads = 0;
    fs.files.set('/proc/200/stat', () => ++reads <= 2 ? stat(200, 100, 2000) : change());
    const result = await sample(fs);
    assert.equal(result.inventory.status, 'unknown');
    assert.equal(result.descendantTotals.rssBytes, null);
    assert.ok(result.descendants.every(row => row.identityStatus === 'unknown' && row.memory.rssBytes === null && row.memory.pssBytes === null));
    assert.ok(hasIssue(result, 'process-identity-changed'));
    assert.ok(hasIssue(result, 'ancestor-identity-unknown'));
  }
});

test('root generation changes after traversal invalidates all recorded descendant memory', async () => {
  const fs = tree(); let reads = 0;
  fs.files.set('/proc/100/stat', () => ++reads < 4 ? stat(100, 1) : stat(100, 1, 9000));
  const result = await sample(fs);
  assert.equal(result.root.identityStatus, 'unknown');
  assert.equal(result.root.memory.rssBytes, null);
  assert.ok(result.descendants.every(row => row.memory.rssBytes === null));
  assert.equal(result.descendantTotals.pssBytes, null);
});

test('missing or malformed PSS retains stable known RSS but never a complete memory total', async () => {
  for (const text of ['Rss: 4 kB\n', 'Rss: 4 kB\nPss: NaN kB\n', 'Rss: 4 kB\nPss: 2 kB\nPss: 2 kB\n']) {
    const fs = tree(); fs.files.set('/proc/300/smaps_rollup', text);
    const result = await sample(fs);
    assert.equal(result.inventory.status, 'complete');
    assert.equal(result.descendants[1].identityStatus, 'verified');
    assert.equal(result.descendants[1].memory.rssBytes, 4096);
    assert.equal(result.descendants[1].memory.pssBytes, null);
    assert.equal(result.descendantTotals.status, 'unknown');
    assert.equal(result.descendantTotals.rssBytes, null);
    assert.equal(result.descendantTotals.knownStableRssSumBytes, 45056);
    assert.ok(hasIssue(result, 'missing-or-invalid-rss-pss'));
  }
});

test('unreadable smaps does not prevent other live identities or hide its unknown memory', async () => {
  const fs = tree(); fs.files.set('/proc/200/smaps_rollup', Object.assign(new Error('restricted fixture'), { code: 'EPERM' }));
  const result = await sample(fs);
  assert.equal(result.inventory.status, 'complete');
  assert.equal(result.inventory.descendantsCount, 2);
  assert.equal(result.descendants[0].memory.rssBytes, null);
  assert.equal(result.descendants[1].memory.pssBytes, 12288);
  assert.equal(result.descendantTotals.rssBytes, null);
});

test('process/thread/depth budgets bound traversal and never pass truncated totals', async () => {
  for (const [limits, code] of [[{ maxProcesses: 1 }, 'max-processes'], [{ maxDepth: 1 }, 'max-depth'], [{ maxThreads: 1 }, 'max-threads']]) {
    const fs = tree(); const result = await sample(fs, { limits });
    assert.equal(result.inventory.status, 'unknown');
    assert.equal(result.inventory.descendantsCount, null);
    assert.equal(result.descendantTotals.rssBytes, null);
    assert.ok(hasIssue(result, code));
    if (limits.maxProcesses === 1) assert.ok(!fs.calls.some(file => file.startsWith('/proc/200/')));
  }
});

test('changing thread inventory, reused TID and cyclic child entries stay unknown', async () => {
  const setups = [
    fs => { let reads = 0; fs.directories.set('/proc/100/task', () => ++reads === 1 ? ['100', '101'] : ['100']); },
    fs => { let reads = 0; fs.files.set('/proc/100/task/101/stat', () => stat(101, 1, ++reads === 1 ? 1010 : 2020)); },
    fs => { fs.files.set('/proc/100/task/101/children', '100'); },
  ];
  for (const setup of setups) {
    const fs = tree(); setup(fs); const result = await sample(fs);
    assert.equal(result.inventory.status, 'unknown');
    assert.equal(result.descendantTotals.rssBytes, null);
  }
});

test('elapsed I/O budget stops further operations and hanging injected I/O returns unknown within its deadline', async () => {
  const fs = tree(); const original = fs.io.readFile;
  fs.io.readFile = async file => { const result = await original(file); fs.advance(20); return result; };
  const result = await sample(fs, { limits: { deadlineMs: 5 } });
  assert.equal(result.inventory.status, 'unknown');
  assert.ok(hasIssue(result, 'io-deadline'));
  assert.deepEqual(fs.calls, ['/proc/100/stat']);
  const hanging = fixture(); let calls = 0;
  hanging.io.readFile = () => { calls++; return new Promise(() => {}); };
  const late = await sample(hanging, { limits: { deadlineMs: 5 } });
  assert.equal(late.inventory.status, 'unknown');
  assert.equal(late.root.memory.rssBytes, null);
  assert.ok(hasIssue(late, 'io-deadline'));
  assert.equal(calls, 1);
});

test('zero observed memory is distinct from missing, and repeated calls do not retain prior child values', async () => {
  const fs = tree(); const first = await sample(fs);
  assert.equal(first.descendantTotals.rssBytes, 61440);
  fs.files.set('/proc/100/task/101/children', '');
  fs.files.set('/proc/100/smaps_rollup', 'Rss: 0 kB\nPss: 0 kB\n');
  const next = await sample(fs);
  assert.equal(next.root.memory.rssBytes, 0);
  assert.equal(next.inventory.descendantsCount, 0);
  assert.deepEqual(next.descendants, []);
  assert.equal(next.descendantTotals.rssBytes, 0);
  await assert.rejects(sample(fs, { pid: 0 }), /positive app PID/);
  await assert.rejects(sample(fs, { limits: { maxProcesses: 10000 } }), /Invalid maxProcesses/);
});
