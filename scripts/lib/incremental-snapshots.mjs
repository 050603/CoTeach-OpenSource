import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const restoredName = 'acceptance_incremental_restore';
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    'Snapshot paths must remain inside their explicit run directory');
  return child;
};
const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

/** Keep the exported PostgreSQL snapshot alive until its dump and all model
 * fingerprints finish. Restore the original online capture, never a newer dump.
 * Prisma may be the generated namespace or the whole generated-client module.
 */
export function createIncrementalSnapshot({ output, root, temporary, container, env, db, Prisma,
  runFileCommand, command, stopApplication, json, sha, fileManifest }) {
  for (const directory of [output, root, temporary]) assert.ok(path.isAbsolute(directory));
  assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/);
  assert.equal(path.basename(temporary), container, 'Temporary resources must belong to this container run');
  const sourceURL = new URL(env.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(sourceURL.protocol));
  assert.equal(sourceURL.hostname, '127.0.0.1');
  assert.ok(sourceURL.port && sourceURL.port !== '5432', 'Snapshot cannot use the default database port');
  const sourceName = decodeURIComponent(sourceURL.pathname.slice(1));
  assert.match(sourceName, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
  assert.notEqual(sourceName, restoredName);
  assert.equal(env.OPENPBL_VERIFICATION_MARKER, container);
  const models = Object.values(Prisma.ModelName ?? Prisma.Prisma?.ModelName ?? {}).sort();
  assert.ok(models.length, 'Generated Prisma model names are required');
  const Client = Prisma.PrismaClient ?? db.constructor;
  assert.equal(typeof Client, 'function');
  for (const fn of [runFileCommand, command, stopApplication, json, sha, fileManifest]) assert.equal(typeof fn, 'function');
  const directories = { uploads: env.UPLOAD_DIR, classrooms: env.CLASSROOM_DATA_DIR,
    whiteboards: env.WHITEBOARD_DATA_DIR, 'ai-audit-outbox': env.AI_AUDIT_OUTBOX_DIR };
  for (const directory of Object.values(directories)) {
    assert.ok(directory && path.isAbsolute(directory)); within(temporary, directory);
  }
  assert.equal(new Set(Object.values(directories).map(directory => path.resolve(directory))).size, 4);
  const labels = new Set();
  let online, onlineAttempted = false, busy = false;
  const save = (filename, value) => writeFile(within(output, filename), `${json(value)}\n`, { mode: 0o600 });
  const identity = async client => (await client.$queryRaw`SELECT current_database() AS database,
    inet_server_addr()::text AS server, inet_server_port() AS port`)[0];
  const assertMarker = async client => {
    const rows = await client.$queryRaw`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${container}`;
    assert.equal(rows.length, 1, 'Snapshot requires this exact disposable database marker');
  };
  const manifest = async client => {
    const result = [];
    for (const name of models) {
      const delegate = name[0].toLowerCase() + name.slice(1);
      assert.equal(typeof client[delegate]?.findMany, 'function', `Missing Prisma delegate ${name}`);
      const rows = await client[delegate].findMany();
      const canonical = rows.map(row => JSON.stringify(sorted(JSON.parse(json(row))))).sort();
      result.push({ model: name, records: rows.length, sha256: sha(json(canonical)), rowHashes: canonical.map(sha).sort() });
    }
    return result;
  };
  const safeTree = async (directory, base = directory) => {
    const info = await lstat(directory);
    assert.equal(info.isSymbolicLink(), false, 'Snapshot must not follow symbolic links');
    assert.ok(info.isDirectory() || info.isFile(), 'Snapshot accepts only ordinary files and directories');
    if (directory !== base) within(base, directory);
    if (info.isDirectory()) for (const item of await readdir(directory)) await safeTree(path.join(directory, item), base);
  };
  const sourceFiles = async () => {
    const result = {};
    for (const [name, directory] of Object.entries(directories)) {
      within(await realpath(temporary), await realpath(directory));
      await safeTree(directory);
      result[name] = await fileManifest(directory);
      for (const item of result[name]) {
        assert.ok(typeof item.path === 'string'); within(directory, path.resolve(directory, item.path));
        assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0); assert.match(item.sha256, /^[a-f0-9]{64}$/);
      }
    }
    return result;
  };
  const captureFiles = async (label, evidence) => {
    for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
    const destination = within(output, path.join(output, `${label}-backup-files`));
    evidence.fileCaptureAttempts = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const attemptDirectory = within(output, `${destination}.attempt-${attempt}`);
      const detail = { attempt, startedAt: new Date().toISOString(), directory: path.relative(output, attemptDirectory), status: 'running' };
      evidence.fileCaptureAttempts.push(detail);
      await mkdir(attemptDirectory, { mode: 0o700 });
      try {
        const before = await sourceFiles();
        for (const [name, directory] of Object.entries(directories)) await cp(directory, path.join(attemptDirectory, name), {
          recursive: true, dereference: false, verbatimSymlinks: true,
          filter: async source => { assert.equal((await lstat(source)).isSymbolicLink(), false, 'Snapshot rejects symbolic links'); return true; },
        });
        const after = await sourceFiles(), backup = {};
        await safeTree(attemptDirectory);
        for (const name of Object.keys(directories)) backup[name] = await fileManifest(path.join(attemptDirectory, name));
        assert.deepEqual(after, before, 'Runtime files changed while backing up');
        assert.deepEqual(backup, before, 'Copied files do not match the observed source');
        await rename(attemptDirectory, destination);
        detail.status = 'captured'; detail.finishedAt = new Date().toISOString();
        evidence.fileBoundary = { startedAt: detail.startedAt, finishedAt: detail.finishedAt,
          consistency: 'All four source manifests matched before and after copy, and every backup byte matched; separate from the PostgreSQL MVCC boundary' };
        return { directory: destination, manifest: before };
      } catch (error) {
        detail.status = 'failed'; detail.error = String(error.message ?? error).slice(0, 1500); detail.finishedAt = new Date().toISOString();
        if (attempt === 3 || !/changed while backing|do not match|ENOENT|EBUSY/.test(detail.error)) throw error;
        await delay(100);
      }
    }
    throw new Error('Runtime file capture did not complete');
  };
  const capture = async (label, evidence) => {
    const sql = within(output, path.join(output, `${label}-database.sql`));
    const tableFile = within(output, path.join(output, `${label}-database-manifest.json`));
    const filesFile = within(output, path.join(output, `${label}-file-manifest.json`));
    let tables, files;
    await db.$transaction(async tx => {
      const [boundary] = await tx.$queryRaw`SELECT pg_export_snapshot() AS snapshot,
        pg_current_snapshot()::text AS visibility, clock_timestamp() AS captured_at`;
      assert.match(boundary.snapshot, /^[a-zA-Z0-9-]+$/);
      evidence.databaseBoundary = { ...boundary, isolationLevel: 'REPEATABLE READ',
        consistency: 'pg_dump --snapshot and every Prisma model fingerprint share this exported MVCC snapshot' };
      const jobs = await Promise.allSettled([
        runFileCommand('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '--dbname', sourceName,
          '--snapshot', boundary.snapshot], { outputFile: sql, env, cwd: root, timeoutMs: 240_000 }),
        manifest(tx).then(value => { tables = value; }),
        captureFiles(label, evidence).then(value => { files = value; }),
      ]);
      const failed = jobs.filter(item => item.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(item => item.reason), failed.map(item => String(item.reason.message ?? item.reason)).join('; '));
    }, { isolationLevel: 'RepeatableRead', maxWait: 30_000, timeout: 300_000 });
    await save(tableFile, tables); await save(filesFile, files.manifest);
    const checkpoint = { label, snapshotFile: sql, snapshotSha256: sha(await readFile(sql)),
      databaseManifestFile: tableFile, databaseManifestSha256: sha(await readFile(tableFile)),
      fileManifestFile: filesFile, fileManifestSha256: sha(await readFile(filesFile)), filesDirectory: files.directory,
      tables, files: files.manifest, databaseBoundary: evidence.databaseBoundary, fileBoundary: evidence.fileBoundary };
    await save(path.join(output, `${label}-capture.json`), checkpoint);
    evidence.snapshotFile = path.relative(output, sql); evidence.snapshotSha256 = checkpoint.snapshotSha256;
    evidence.backupFiles = path.relative(output, files.directory);
    return checkpoint;
  };
  const rowDelta = (before, after) => {
    const counts = values => { const result = new Map(); for (const value of values) result.set(value, (result.get(value) ?? 0) + 1); return result; };
    const old = counts(before), current = counts(after);
    let added = 0, removed = 0;
    for (const [key, count] of current) added += Math.max(0, count - (old.get(key) ?? 0));
    for (const [key, count] of old) removed += Math.max(0, count - (current.get(key) ?? 0));
    return { addedRowVersions: added, removedRowVersions: removed };
  };
  return async ({ label, restore = false }) => {
    assert.match(label, /^[a-z][a-z0-9-]{0,63}$/);
    assert.equal(busy, false, 'Snapshot operations must run sequentially');
    assert.equal(labels.has(label), false, 'Snapshot labels cannot overwrite prior evidence'); labels.add(label); busy = true;
    const evidence = { label, restore, status: 'running', startedAt: new Date().toISOString(), sourceQuiesced: false,
      restoredApplicationBooted: false };
    let restored, claimed = false;
    try {
      await mkdir(output, { recursive: true });
      assert.equal(await realpath(output), path.resolve(output), 'Snapshot output must not be an aliased directory');
      assert.equal(await realpath(temporary), path.resolve(temporary), 'Run directory must not be aliased');
      await writeFile(path.join(output, `${label}-snapshot.json`), `${json(evidence)}\n`, { flag: 'wx', mode: 0o600 });
      claimed = true;
      await assertMarker(db);
      const sourceIdentity = await identity(db); assert.equal(sourceIdentity.database, sourceName);
      evidence.sourceIdentity = sourceIdentity;
      if (!restore) {
        onlineAttempted = true;
        assert.equal(online, undefined, 'An online baseline was already captured');
        const checkpoint = await capture(label, evidence);
        evidence.status = 'captured'; evidence.allPrismaModels = checkpoint.tables.length;
        evidence.totalRows = checkpoint.tables.reduce((sum, item) => sum + item.records, 0);
        evidence.files = Object.values(checkpoint.files).reduce((sum, items) => sum + items.length, 0);
        online = checkpoint;
        return evidence;
      }
      await stopApplication(); evidence.sourceQuiesced = true;
      assert.ok(online || !onlineAttempted, 'Online capture failed; a newer stopped snapshot cannot replace it');
      const checkpoint = online ?? await capture(label, evidence);
      evidence.restoreSource = online ? 'original-online-capture' : 'quiesced-diagnostic-fallback';
      evidence.restoreLabel = checkpoint.label; evidence.databaseBoundary = checkpoint.databaseBoundary;
      evidence.fileBoundary = checkpoint.fileBoundary; evidence.snapshotFile = path.relative(output, checkpoint.snapshotFile);
      for (const [filename, expected] of [[checkpoint.snapshotFile, checkpoint.snapshotSha256],
        [checkpoint.databaseManifestFile, checkpoint.databaseManifestSha256], [checkpoint.fileManifestFile, checkpoint.fileManifestSha256]]) {
        within(output, filename); assert.equal(sha(await readFile(filename)), expected, 'Captured backup evidence changed before restore');
      }
      await command('docker', ['exec', container, 'createdb', '-U', 'postgres', restoredName]);
      await runFileCommand('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', restoredName,
        '-v', 'ON_ERROR_STOP=1'], { inputFile: checkpoint.snapshotFile, env, cwd: root });
      const restoreURL = new URL(env.DATABASE_URL); restoreURL.pathname = `/${restoredName}`;
      restored = new Client({ datasourceUrl: restoreURL.href });
      const restoredIdentity = await identity(restored);
      assert.equal(restoredIdentity.database, restoredName); assert.notEqual(sourceIdentity.database, restoredIdentity.database);
      assert.equal(sourceIdentity.server, restoredIdentity.server); assert.equal(sourceIdentity.port, restoredIdentity.port);
      await assertMarker(restored); evidence.restoredIdentity = restoredIdentity;
      const target = await manifest(restored);
      const tables = checkpoint.tables.map((item, index) => ({ model: item.model, records: item.records,
        sha256: item.sha256, restoredRecords: target[index].records, restoredSha256: target[index].sha256 }));
      await save(path.join(output, `${label}-restored-database-manifest.json`), tables);
      for (const table of tables) { assert.equal(table.restoredRecords, table.records, table.model); assert.equal(table.restoredSha256, table.sha256, table.model); }
      const restoredRoot = within(temporary, path.join(temporary, 'restored-files'));
      await mkdir(restoredRoot, { mode: 0o700 });
      const fileResults = {};
      await safeTree(checkpoint.filesDirectory);
      for (const name of Object.keys(directories)) {
        const backup = within(output, path.join(checkpoint.filesDirectory, name));
        const expected = checkpoint.files[name], observed = await fileManifest(backup);
        assert.deepEqual(observed, expected, `${name} online backup changed before restoration`);
        await cp(backup, path.join(restoredRoot, name), { recursive: true, dereference: false, verbatimSymlinks: true });
        const actual = await fileManifest(path.join(restoredRoot, name));
        fileResults[name] = { snapshot: expected, backup: observed, restored: actual };
        assert.deepEqual(actual, expected, `${name} restoration changed the online file snapshot`);
      }
      await save(path.join(output, `${label}-restored-file-manifest.json`), fileResults);
      const current = await db.$transaction(tx => manifest(tx), { isolationLevel: 'RepeatableRead', timeout: 300_000 });
      const databaseDelta = checkpoint.tables.map((item, index) => ({ model: item.model, snapshotRecords: item.records,
        currentRecords: current[index].records, snapshotSha256: item.sha256, currentSha256: current[index].sha256,
        ...rowDelta(item.rowHashes, current[index].rowHashes) }));
      const liveFiles = await sourceFiles();
      const fileDelta = Object.keys(directories).map(name => {
        const change = rowDelta(checkpoint.files[name].map(item => json(item)), liveFiles[name].map(item => json(item)));
        return { directory: name, snapshotFiles: checkpoint.files[name].length, currentFiles: liveFiles[name].length,
          addedFileVersions: change.addedRowVersions, removedFileVersions: change.removedRowVersions };
      });
      evidence.sourceAfterSnapshot = { interpretation: 'Later source changes are reported separately; restore is compared only to the original snapshot',
        changedModels: databaseDelta.filter(item => item.snapshotSha256 !== item.currentSha256).length,
        deltaRowVersions: databaseDelta.reduce((sum, item) => sum + item.addedRowVersions + item.removedRowVersions, 0),
        deltaFileVersions: fileDelta.reduce((sum, item) => sum + item.addedFileVersions + item.removedFileVersions, 0),
        database: databaseDelta, files: fileDelta };
      await save(path.join(output, `${label}-source-after-snapshot.json`), evidence.sourceAfterSnapshot);
      Object.assign(evidence, { status: 'reconciled', allPrismaModels: tables.length,
        totalRows: tables.reduce((sum, item) => sum + item.records, 0),
        files: Object.values(checkpoint.files).reduce((sum, items) => sum + items.length, 0),
        restoredDatabase: restoredName, restoredApplicationBooted: false });
      return evidence;
    } catch (error) {
      evidence.status = 'failed'; evidence.error = String(error.stack ?? error).replace(/postgres(?:ql)?:\/\/\S+/g, '[database]').slice(0, 5000);
      throw error;
    } finally {
      let disconnectError;
      try { await restored?.$disconnect(); }
      catch (error) {
        disconnectError = error; evidence.status = 'failed';
        evidence.disconnectError = String(error.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/g, '[database]').slice(0, 1000);
      }
      try {
        evidence.finishedAt = new Date().toISOString();
        if (claimed) await save(path.join(output, `${label}-snapshot.json`), evidence);
      } finally { busy = false; }
      if (disconnectError) throw disconnectError;
    }
  };
}
