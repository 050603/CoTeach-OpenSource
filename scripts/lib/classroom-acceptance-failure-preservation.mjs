import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runFileCommand } from './classroom-acceptance-restored-app.mjs';

/** Preserve only this invocation's disposable databases before either cleanup
 * path removes them. A dump command or a preexisting file alone is not proof. */
export async function preserveAcceptanceFailureDatabases({ started, container, output,
  restoredDatabaseCreated = false, reason = 'failure', run = runFileCommand, timeoutMs = 30000 }) {
  if (!started) return { status: 'not-started', snapshots: [] };
  assert.match(container, /^openpbl-prelaunch-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(path.isAbsolute(output), 'Diagnostics require an absolute output directory');
  assert.ok(['failure', 'interrupted'].includes(reason));
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  const evidence = { reason, startedAt: new Date().toISOString(), snapshots: [] };
  const databases = [['postgres', `isolated-${reason}-database.sql`]];
  if (restoredDatabaseCreated) databases.push(['acceptance_restore', `isolated-${reason}-restored-database.sql`]);
  for (const [database, filename] of databases) {
    const file = path.join(output, filename);
    try {
      // runFileCommand streams to a private temporary file and publishes only
      // on successful process exit. Failed attempts cannot reuse an old dump.
      await run('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '--dbname', database],
        { outputFile: file, timeoutMs });
      const handle = await open(file, 'r');
      let size;
      try {
        const stat = await handle.stat(); size = stat.size;
        assert.ok(stat.isFile() && size > 0, 'Database snapshot is empty');
        const tail = Buffer.alloc(Math.min(size, 4096));
        const { bytesRead } = await handle.read(tail, 0, tail.length, size - tail.length);
        assert.ok(tail.subarray(0, bytesRead).toString().includes('-- PostgreSQL database dump complete'),
          'Database snapshot has no completion footer');
        assert.equal(stat.mode & 0o077, 0, 'Database snapshot is not private');
      } finally { await handle.close(); }
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      evidence.snapshots.push({ database, filename, status: 'preserved', bytes: size, sha256: hash.digest('hex') });
    } catch (error) {
      evidence.snapshots.push({ database, filename, status: 'failed', error: String(error.message ?? error)
        .replace(/postgres(?:ql)?:\/\/\S+/g, '[database]').slice(0, 1000) });
    }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.status = evidence.snapshots.every(row => row.status === 'preserved') ? 'preserved' : 'failed';
  const file = path.join(output, `database-${reason}-preservation.json`);
  const temporary = `${file}.partial-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return evidence;
}
