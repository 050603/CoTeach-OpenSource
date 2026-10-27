import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { EdgeLogReader, parseEdgeObservation, waitForEdgeOperation, type EdgeObservation } from "./edge-log-reader";

const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({ version: 1,
  atSeconds: "1792197393.607", requestSeconds: "1.800", method: "GET", route: "/api/server-providers",
  status: 200, ...overrides }) + "\n";
async function fixture(run: (f: { file: string; rows: EdgeObservation[]; reader: EdgeLogReader; setTime: (n: number) => void }) => Promise<void>,
  options: { maxBytes?: number; maxLineBytes?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpbl-edge-reader-"));
  const file = path.join(directory, "current.ndjson"); await writeFile(file, "");
  const rows: EdgeObservation[] = []; let now = 1792197395000;
  const reader = new EdgeLogReader(file, row => rows.push(row), { ...options, now: () => now });
  try { await run({ file, rows, reader, setTime: n => { now = n; } }); }
  finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
}

test("uses the trusted log duration, not caller clocks/IDs, and keeps millisecond epochs exact", () => {
  const row = parseEdgeObservation(record({ clientStartedAt: 1, httpRequestId: "spoof", atSeconds: "1792197393.607" }));
  assert.equal(row?.seconds, 1.8); assert.equal(row?.completedAtMs, 1792197393607);
  assert.deepEqual(Object.keys(row!).sort(), ["completedAtMs", "method", "operation", "route", "seconds", "status"]);
});
test("only accepts fixed routes/methods and finite real durations; AI writes are not ordinary saves", () => {
  for (const bad of [{ route: "/api/courses/private-id/state" }, { method: "CUSTOM" }, { requestSeconds: "-" },
    { requestSeconds: "NaN" }, { requestSeconds: "-1.000" }, { status: 0 }, { version: 2 }]) {
    assert.equal(parseEdgeObservation(record(bad)), undefined);
  }
  assert.equal(parseEdgeObservation(record({ route: "/api/ai-collaboration/code", method: "POST" }))?.operation, "mixed-ai");
  assert.equal(parseEdgeObservation(record({ route: "/api/openmaic/progress", method: "POST" }))?.operation, "write");
  assert.equal(parseEdgeObservation(record({ route: "/api/courses/:courseId/actions", method: "POST" }))?.operation, "write");
  assert.equal(parseEdgeObservation(record({ route: "/api/courses/:courseId/projection", method: "HEAD" }))?.operation, "projection");
});
test("unconfigured collection is unknown, while an accessible idle log has no invented latency samples", async () => {
  const rows: EdgeObservation[] = []; const unconfigured = new EdgeLogReader(undefined, row => rows.push(row));
  assert.equal((await unconfigured.initialize()).configured, false);
  assert.ok(Number.isNaN((await unconfigured.refresh()).collectionAvailable)); assert.equal(rows.length, 0);
  await unconfigured.close();
  await fixture(async ({ reader, rows }) => {
    await reader.initialize(); const s = await reader.refresh();
    assert.equal(s.state, "healthy-idle"); assert.equal(s.collectionAvailable, 1); assert.equal(rows.length, 0);
  });
});
test("baseline excludes prior counter lifetime; subsequent refreshes never replay acknowledged rows", () => fixture(async ({ file, reader, rows }) => {
  await writeFile(file, record({ requestSeconds: "99.000" })); await reader.initialize();
  await appendFile(file, record()); await reader.refresh(); await reader.refresh();
  assert.equal(rows.length, 1); assert.equal(rows[0].seconds, 1.8);
}));
test("bounds bytes per refresh and coalesces overlapping consumers instead of dropping queued lines", () => fixture(async ({ file, reader, rows }) => {
  await reader.initialize(); await appendFile(file, record() + record({ requestSeconds: "2.100" }));
  const a = reader.refresh(); const b = reader.refresh(); assert.equal(a, b);
  const first = await a; assert.equal(first.collectionAvailable, 0); assert.ok(first.backlogBytes > 0);
  for (let i = 0; i < 10 && reader.snapshot().backlogBytes > 0; i++) await reader.refresh();
  assert.deepEqual(rows.map(row => row.seconds), [1.8, 2.1]); assert.equal(reader.snapshot().collectionAvailable, 1);
}, { maxBytes: 100 }));
test("partial UTF-8 lines are retained once, with incomplete collection unknown until newline", () => fixture(async ({ file, reader, rows }) => {
  await reader.initialize(); const bytes = Buffer.from(record({ ignored: "课堂" }));
  const cut = bytes.indexOf(Buffer.from("课")) + 1;
  await appendFile(file, bytes.subarray(0, cut)); assert.equal((await reader.refresh()).collectionAvailable, 0);
  assert.equal(rows.length, 0); await appendFile(file, bytes.subarray(cut)); await reader.refresh();
  assert.equal(rows.length, 1); assert.equal(reader.snapshot().invalidRecords, 0);
}));
test("bad/oversized lines make coverage unknown but do not suppress later known slow samples", () => fixture(async ({ file, reader, rows, setTime }) => {
  await reader.initialize(); await appendFile(file, "{broken}\n" + "x".repeat(300) + "\n" + record());
  const s = await reader.refresh(); assert.equal(s.collectionAvailable, 0); assert.equal(s.invalidRecords, 2);
  assert.equal(rows.length, 1); assert.equal(rows[0].seconds, 1.8);
  setTime(1792197395000 + 300001); assert.equal((await reader.refresh()).collectionAvailable, 1);
}, { maxLineBytes: 256 }));
test("an oversized partial line is discarded with bounded memory and later recovers at a newline", () => fixture(async ({ file, reader, rows }) => {
  await reader.initialize(); await appendFile(file, "x".repeat(500));
  assert.equal((await reader.refresh()).collectionAvailable, 0);
  await appendFile(file, "continued\n" + record()); await reader.refresh();
  assert.equal(rows.length, 1); assert.equal(reader.snapshot().invalidRecords, 1);
}, { maxLineBytes: 256 }));
test("rename/reopen drains known old bytes, then reads new file from0 and explicitly marks rotation uncertainty", () => fixture(async ({ file, reader, rows, setTime }) => {
  await reader.initialize(); await appendFile(file, record()); await rename(file, file + ".1");
  await writeFile(file, record({ requestSeconds: "2.500" }));
  const s = await reader.refresh(); assert.deepEqual(rows.map(row => row.seconds), [1.8, 2.5]);
  assert.equal(s.rotations, 1); assert.equal(s.collectionAvailable, 0); assert.ok(s.gaps > 0);
  setTime(1792197395000 + 300001); await reader.refresh();
  assert.equal(rows.length, 2); assert.equal(reader.snapshot().collectionAvailable, 1);
}));
test("detected truncation does not silently turn the missing generation into zero", () => fixture(async ({ file, reader, rows }) => {
  await writeFile(file, "x".repeat(3000) + "\n"); await reader.initialize();
  await writeFile(file, record()); const s = await reader.refresh();
  assert.equal(s.collectionAvailable, 0); assert.ok(s.gaps > 0); assert.equal(rows.length, 1);
}));
test("unavailable files return unknown without throwing into metrics/business, and recovery does not invent history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpbl-edge-missing-"));
  const file = path.join(directory, "missing"); const rows: EdgeObservation[] = [];
  const reader = new EdgeLogReader(file, row => rows.push(row));
  try {
    assert.equal((await reader.initialize()).collectionAvailable, 0);
    assert.equal((await reader.refresh()).collectionAvailable, 0);
    await writeFile(file, record({ requestSeconds: "99.000" })); await reader.refresh();
    await appendFile(file, record()); await reader.refresh();
    assert.equal(rows.length, 1); assert.equal(rows[0].seconds, 1.8); assert.ok(reader.snapshot().gaps > 0);
  } finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
});
test("a new collector lifetime does not replay old rows after process restart", () => fixture(async ({ file, reader, rows }) => {
  await reader.initialize(); await appendFile(file, record()); await reader.refresh(); await reader.close();
  const restartedRows: EdgeObservation[] = []; const restarted = new EdgeLogReader(file, row => restartedRows.push(row));
  try {
    await restarted.initialize(); await restarted.refresh(); assert.equal(restartedRows.length, 0);
    await appendFile(file, record()); await restarted.refresh(); assert.equal(restartedRows.length, 1); assert.equal(rows.length, 1);
  } finally { await restarted.close(); }
}));
test("shutdown is idempotent and does not silently resume file collection", () => fixture(async ({ file, reader, rows }) => {
  await reader.initialize(); await reader.close(); await reader.close();
  await appendFile(file, record()); const s = await reader.refresh();
  assert.equal(s.state, "closed"); assert.equal(s.collectionAvailable, 0); assert.equal(rows.length, 0);
}));
test("a timed-out baseline keeps one actual open and late completion remains unknown until a complete fresh window", () => fixture(async ({ file }) => {
  const handle = await open(file, "r"); let release!: (value: typeof handle) => void; let calls = 0;
  const gate = new Promise<typeof handle>(resolve => { release = resolve; });
  let now = 1792197395000; const requestedAt = now;
  const delayed = new EdgeLogReader(file, () => {}, { now: () => now, openReadOnly: () => { calls++; return gate; } });
  try {
    const first = delayed.initialize(); assert.equal(delayed.initialize(), first);
    const result = await waitForEdgeOperation(first, () => delayed.markUnavailable(), 10);
    assert.equal(result.completed, false); assert.equal(delayed.snapshot().collectionAvailable, 0);
    assert.equal(delayed.initialize(), first); assert.equal(calls, 1);
    now += 70_000; release(handle); const late = await first;
    assert.equal(late.startedAtMs, requestedAt); // A late FD must not make old observations look newly started.
    assert.equal(late.initialized, true); assert.equal(late.collectionAvailable, 0); assert.ok(late.gaps > 0);
  } finally { release(handle); await delayed.close(); }
  await assert.rejects(handle.stat(), { code: "EBADF" });
}));
test("shutdown before delayed open returns closes the late real FD without reopening or publishing healthy", () => fixture(async ({ file }) => {
  const handle = await open(file, "r"); let release!: (value: typeof handle) => void; let calls = 0;
  const gate = new Promise<typeof handle>(resolve => { release = resolve; });
  const delayed = new EdgeLogReader(file, () => {}, { openReadOnly: () => { calls++; return gate; } });
  const first = delayed.initialize();
  await waitForEdgeOperation(first, () => delayed.markUnavailable(), 10);
  await delayed.close(); release(handle); await first;
  assert.equal(calls, 1); assert.equal((await delayed.refresh()).state, "closed");
  await assert.rejects(handle.stat(), { code: "EBADF" });
  await delayed.close();
}));
test("bounded optional monitoring handles late rejection instead of blocking startup/metrics or leaking rejection", async () => {
  let reject!: (error: Error) => void; let unavailable = 0;
  const work = new Promise<never>((_, fail) => { reject = fail; });
  const result = await waitForEdgeOperation(work, () => { unavailable++; }, 10);
  assert.equal(result.completed, false); assert.equal(unavailable, 1);
  reject(Error("late filesystem failure")); await Promise.resolve(); await Promise.resolve();
  assert.equal(unavailable, 1);
});
