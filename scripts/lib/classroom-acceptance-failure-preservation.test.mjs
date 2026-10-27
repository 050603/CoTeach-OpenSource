import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preserveAcceptanceFailureDatabases } from './classroom-acceptance-failure-preservation.mjs';
import { runFileCommand } from './classroom-acceptance-restored-app.mjs';

const container = 'openpbl-prelaunch-12345678-1234-4234-8234-123456789012';
const dump = '-- synthetic diagnostic fixture\nSELECT 1;\n-- PostgreSQL database dump complete\n';
async function directory(t) {
  const output = await mkdtemp(path.join(tmpdir(), 'acceptance-preservation-'));
  t.after(() => rm(output, { recursive: true, force: true })); return output;
}

test('the signal path awaits both private snapshots and records independent content proof', async t => {
  const output = await directory(t); const calls = [];
  const result = await preserveAcceptanceFailureDatabases({ started: true, container, output,
    reason: 'interrupted', restoredDatabaseCreated: true, run: async (command, args, options) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      await runFileCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '--', dump], options);
    } });
  assert.equal(result.status, 'preserved', JSON.stringify(result)); assert.equal(result.snapshots.length, 2);
  assert.deepEqual(calls.map(call => call.args.at(-1)), ['postgres', 'acceptance_restore']);
  for (const call of calls) {
    assert.equal(call.command, 'docker'); assert.equal(call.args[1], container); assert.equal(call.timeoutMs, 30000);
  }
  for (const row of result.snapshots) {
    assert.equal(await readFile(path.join(output, row.filename), 'utf8'), dump);
    assert.equal((await stat(path.join(output, row.filename))).mode & 0o077, 0);
    assert.equal(row.bytes, Buffer.byteLength(dump)); assert.match(row.sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'database-interrupted-preservation.json'), 'utf8')), result);
});

test('a failed dump cannot claim an old snapshot and does not prevent the other database attempt', async t => {
  const output = await directory(t);
  await writeFile(path.join(output, 'isolated-failure-database.sql'), dump, { mode: 0o600 });
  const result = await preserveAcceptanceFailureDatabases({ started: true, container, output,
    restoredDatabaseCreated: true, run: async (_command, args, options) => {
      if (args.at(-1) === 'postgres') throw new Error('isolated pg_dump failure');
      await runFileCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '--', dump], options);
    } });
  assert.equal(result.status, 'failed'); assert.equal(result.snapshots[0].status, 'failed');
  assert.equal(result.snapshots[0].sha256, undefined); assert.equal(result.snapshots[1].status, 'preserved');
});

test('truncated or public dumps stay failed even when the command exits successfully', async t => {
  for (const [contents, mode] of [['SELECT 1;\n', 0o600], [dump, 0o644]]) {
    const output = await directory(t);
    const result = await preserveAcceptanceFailureDatabases({ started: true, container, output,
      run: async (_command, _args, options) => writeFile(options.outputFile, contents, { mode }) });
    assert.equal(result.status, 'failed'); assert.equal(result.snapshots[0].sha256, undefined);
  }
});

test('unstarted cleanup does not access a database and unrelated containers are rejected', async t => {
  const output = await directory(t); let called = false; const run = async () => { called = true; };
  assert.deepEqual(await preserveAcceptanceFailureDatabases({ started: false, container: 'production', output, run }),
    { status: 'not-started', snapshots: [] });
  await assert.rejects(preserveAcceptanceFailureDatabases({ started: true, container: 'production', output, run }));
  await assert.rejects(preserveAcceptanceFailureDatabases({ started: true, container, output, run, timeoutMs: 120000 }));
  assert.equal(called, false);
});
