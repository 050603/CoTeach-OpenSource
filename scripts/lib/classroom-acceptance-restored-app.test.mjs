import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertIsolatedRestoreDatabase, assertRestoredStudentHistory, restoredClassroomEnvironment, restoredMediaUrl, runFileCommand, stopIsolatedApplication } from './classroom-acceptance-restored-app.mjs';

test('restore environment uses separate database, Redis and writable data paths without losing connection options', () => {
  const source = { DATABASE_URL: 'postgresql://postgres@127.0.0.1:54321/disposable?schema=public&connection_limit=10',
    PROVIDER_CONFIG_DATABASE_URL: 'original-config', REDIS_URL: 'redis://127.0.0.1:54322/0', AI_AUDIT_OUTBOX_DIR: '/source-outbox',
    PROVIDER_ENCRYPTION_KEY: 'test-key', UPLOAD_DIR: '/source-uploads' };
  const restored = restoredClassroomEnvironment(source, '/tmp/isolated-restore');
  const database = new URL(restored.DATABASE_URL);
  assert.equal(database.pathname, '/acceptance_restore'); assert.equal(database.searchParams.get('connection_limit'), '10');
  assert.equal(restored.PROVIDER_CONFIG_DATABASE_URL, restored.DATABASE_URL);
  assert.equal(new URL(restored.REDIS_URL).pathname, '/1');
  assert.equal(restored.PROVIDER_ENCRYPTION_KEY, 'test-key');
  for (const name of ['UPLOAD_DIR', 'CLASSROOM_DATA_DIR', 'WHITEBOARD_DATA_DIR', 'AI_AUDIT_OUTBOX_DIR'])
    assert.ok(restored[name].startsWith('/tmp/isolated-restore/restored-files/'));
  assert.equal(source.AI_AUDIT_OUTBOX_DIR, '/source-outbox');
  assert.throws(() => restoredClassroomEnvironment({ ...source, DATABASE_URL: 'postgresql://postgres@production.example/postgres' }, '/tmp/isolated-restore'));
  assert.throws(() => restoredClassroomEnvironment({ ...source, DATABASE_URL: 'postgresql://postgres@127.0.0.1/acceptance_restore' }, '/tmp/isolated-restore'));
});

test('checks the actual restored database connection before starting its application', async () => {
  const connection = database => ({ $queryRaw: async () => [{ database, server: '172.20.0.3', port: 5432 }] });
  assert.equal((await assertIsolatedRestoreDatabase(connection('postgres'), connection('acceptance_restore'))).separateDatabase, true);
  await assert.rejects(assertIsolatedRestoreDatabase(connection('postgres'), connection('postgres')), /source database/);
  await assert.rejects(assertIsolatedRestoreDatabase(connection('postgres'), { $queryRaw: async () => [{ database: 'acceptance_restore', server: '172.20.0.4', port: 5432 }] }), /disposable PostgreSQL/);
});

test('enabled read workers use the restored database with their own role and retain the same budget without a source/production fallback', () => {
  const source = { DATABASE_URL: 'postgresql://postgres@127.0.0.1:54321/source?schema=public&connection_limit=57',
    OPENPBL_COURSE_READ_WORKERS: '2', OPENPBL_COURSE_READ_CONNECTION_BUDGET: '57', OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS: '16',
    OPENPBL_COURSE_READ_DATABASE_URL: 'postgresql://openpbl_course_read_fixture:fixture@127.0.0.1:54321/source?schema=public&connection_limit=16' };
  const restored = restoredClassroomEnvironment(source, '/tmp/isolated-restore');
  const url = new URL(restored.OPENPBL_COURSE_READ_DATABASE_URL);
  assert.equal(url.pathname, '/acceptance_restore'); assert.equal(url.username, 'openpbl_course_read_fixture');
  assert.equal(url.searchParams.get('connection_limit'), '16');
  assert.equal(restored.OPENPBL_COURSE_READ_CONNECTION_BUDGET, '57');
  assert.equal(new URL(source.OPENPBL_COURSE_READ_DATABASE_URL).pathname, '/source');
  assert.throws(() => restoredClassroomEnvironment({ ...source,
    OPENPBL_COURSE_READ_DATABASE_URL: source.OPENPBL_COURSE_READ_DATABASE_URL.replace('127.0.0.1:54321', 'production.example:5432') }, '/tmp/isolated-restore'), /TARGET_MISMATCH/);
});

test('restored history follows the public submission identity and retains all historical actor roles', () => {
  const actor = { index: 0, user: { id: 'student-0' }, saved: { id: 'database-row', payload: { view: { id: 'public-submission' } } } };
  const course = { id: 'classroom', status: 'finished', submissions: [{ id: 'public-submission', studentId: 'student-0', content: '<p>自动验收学生0</p>' }],
    aiInteractionEvents: ['student', 'ai', 'teacher', 'system'].map(actorRole => ({ actorRole, studentId: 'student-0' })),
    projectDocumentVersions: [{ id: 'version', studentId: 'student-0', submissionId: 'public-submission', status: 'submitted', docxUploadId: 'upload', docxSha256: 'a'.repeat(64) }] };
  const result = assertRestoredStudentHistory(course, actor, 'classroom');
  assert.equal(result.saved.id, 'public-submission');
  assert.deepEqual(result.eventActors, { ai: 1, student: 1, system: 1, teacher: 1 });
  assert.throws(() => assertRestoredStudentHistory({ ...course, status: 'teaching' }, actor, 'classroom'), /finished state/);
  assert.throws(() => assertRestoredStudentHistory({ ...course, projectDocumentVersions: [{ ...course.projectDocumentVersions[0], docxSha256: undefined }] }, actor, 'classroom'), /SHA-256/);
  assert.throws(() => assertRestoredStudentHistory({ ...course, aiInteractionEvents: [{ studentId: 'another-student', actorRole: 'ai' }] }, actor, 'classroom'), /student AI interactions/);
});

test('restored native playback can only read the recovered classroom on the restored origin', () => {
  assert.equal(restoredMediaUrl('http://127.0.0.1:3198', 'lesson', '/api/openmaic/classroom-media/lesson/audio.wav'),
    'http://127.0.0.1:3198/api/openmaic/classroom-media/lesson/audio.wav');
  assert.throws(() => restoredMediaUrl('http://127.0.0.1:3198', 'lesson', 'https://production.example/api/openmaic/classroom-media/lesson/audio.wav'), /isolated restored application/);
  assert.throws(() => restoredMediaUrl('http://127.0.0.1:3198', 'lesson', '/api/openmaic/classroom-media/another-lesson/audio.wav'), /restored classroom file/);
});

test('snapshot subprocesses stream large files, preserve bytes and reject partial/nonzero output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpbl-restore-stream-'));
  try {
    const snapshot = path.join(directory, 'snapshot.sql'); const restored = path.join(directory, 'restored.sql');
    await runFileCommand(process.execPath, ['-e', "process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 65)); process.stdout.write('恢复结束\\n');"], { outputFile: snapshot });
    await runFileCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { inputFile: snapshot, outputFile: restored });
    assert.deepEqual(await readFile(restored), await readFile(snapshot));
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    const failed = path.join(directory, 'failed.sql');
    await assert.rejects(runFileCommand(process.execPath, ['-e', "process.stdout.write('partial'); process.stderr.write('SQL restore failed'); process.exitCode = 1"], { outputFile: failed }), /SQL restore failed/);
    await assert.rejects(stat(failed), { code: 'ENOENT' });
    assert.ok((await readdir(directory)).every(name => !name.includes('.partial')));
    await assert.rejects(runFileCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 50 }), /timeout/);
    await assert.rejects(runFileCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { inputFile: path.join(directory, 'missing') }), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('isolated stopping handles previously signaled exits and bounds a stuck graceful shutdown', async () => {
  assert.deepEqual(await stopIsolatedApplication({ exitCode: null, signalCode: 'SIGTERM', pid: 1 }), { forced: false, alreadyExited: true });
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    assert.deepEqual(await stopIsolatedApplication(child, { graceMs: 50, killMs: 1000 }), { forced: true, alreadyExited: false });
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL'); }
});
