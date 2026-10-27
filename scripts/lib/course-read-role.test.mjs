import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSameCourseReadDatabase, courseReadExperimentPrimaryURL, courseReadWorkerSettings, provisionCourseReadEnvironment,
  provisionCourseReadRole, readCourseReadEnvironmentFile, retargetCourseReadDatabaseURL } from './course-read-role.mjs';

const primary = 'postgresql://fixture_admin@127.0.0.1:54321/source?schema=public&sslmode=prefer';
const password = 'fixture_only_nonsecret_password_for_role';
const role = 'openpbl_course_read_fixture';
const settings = { OPENPBL_COURSE_READ_WORKERS: '2', OPENPBL_COURSE_READ_CONNECTION_BUDGET: '57', OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS: '16' };
const flags = { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: false };
const proof = { ordinaryRole: true, noMemberships: true, ownsNoObjects: true, noSchemaCreate: true, noDatabaseCreate: true,
  noTableWrites: true, noColumnWrites: true, noSequenceWrites: true, temporaryAllowed: true };
function database({ existing = [], permission = proof, login = 'on', failure } = {}) {
  let queries = 0; const state = { writes: 0, committed: false, rolledBack: false, disconnected: 0, loginConnections: 0, urls: [] };
  const admin = { $disconnect: async () => { state.disconnected++; }, $transaction: async action => {
    const tx = { $queryRaw: async () => {
      const index = queries++ % 4;
      if (index === 0) return [{ database: 'source', owner: 'fixture_admin' }];
      if (index === 2) return existing;
      return [];
    }, $executeRawUnsafe: async () => { state.writes++; if (failure) throw failure; }, $queryRawUnsafe: async () => [permission] };
    try { await action(tx); state.committed = true; } catch (error) { state.rolledBack = true; throw error; }
  } };
  const connect = url => {
    state.urls.push(url);
    if (new URL(url).username === 'fixture_admin') return admin;
    state.loginConnections++;
    return { $queryRaw: async () => [{ role, database: 'source', readOnlyDefault: login }], $disconnect: async () => { state.disconnected++; } };
  };
  return { admin, connect, state };
}

test('default zero does not require credentials or create administrative connections; enabled requires explicit complete budget', async () => {
  assert.deepEqual(courseReadWorkerSettings({}), { enabled: false, workers: 0 });
  assert.deepEqual(courseReadWorkerSettings(settings), { enabled: true, workers: 2, budget: 57, perWorkerConnections: 16 });
  let connected = false;
  assert.deepEqual(await provisionCourseReadEnvironment({ env: {}, connect: () => { connected = true; } }), { status: 'disabled', changed: false });
  assert.equal(connected, false);
  for (const overrides of [{ OPENPBL_COURSE_READ_WORKERS: '3' }, { OPENPBL_COURSE_READ_CONNECTION_BUDGET: undefined },
    { OPENPBL_COURSE_READ_CONNECTION_BUDGET: '32' }, { OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS: 'NaN' }]) {
    assert.throws(() => courseReadWorkerSettings({ ...settings, ...overrides }), /COURSE_READ_/);
  }
});

test('read identity stays on the same host/port/database/public schema and restore rewrites only the database', () => {
  const reader = 'postgresql://openpbl_course_read_fixture:fixture@127.0.0.1:54321/source?schema=public&connection_limit=16&sslmode=prefer';
  assert.equal(assertSameCourseReadDatabase(primary, reader).username, role);
  const restored = new URL(retargetCourseReadDatabaseURL(primary, reader, primary.replace('/source?', '/acceptance_restore?')));
  assert.equal(restored.pathname, '/acceptance_restore');
  assert.equal(restored.username, role); assert.equal(restored.password, 'fixture');
  assert.equal(restored.searchParams.get('connection_limit'), '16');
  assert.equal(restored.searchParams.get('sslmode'), 'prefer');
  for (const altered of [reader.replace('54321', '54322'), reader.replace('127.0.0.1', 'another.example'), reader.replace('/source?', '/other?'),
    reader.replace(role, 'fixture_admin'), reader.replace('schema=public', 'schema=another'), `${reader}&schema=another`]) {
    assert.throws(() => assertSameCourseReadDatabase(primary, altered), /COURSE_READ_/);
  }
  assert.throws(() => retargetCourseReadDatabaseURL(primary, reader, primary), /RESTORE_TARGET/);
});

test('only an explicit isolated experimental budget sets the common initial primary connection limit', () => {
  assert.equal(courseReadExperimentPrimaryURL(primary, {}), primary);
  const a = courseReadExperimentPrimaryURL(primary, { ...settings, OPENPBL_COURSE_READ_WORKERS: '0' });
  const b = courseReadExperimentPrimaryURL(primary, settings);
  assert.equal(a, b);
  assert.equal(new URL(a).searchParams.get('connection_limit'), '57');
  assert.equal(new URL(a).username, 'fixture_admin');
  assert.throws(() => courseReadExperimentPrimaryURL(primary.replace('127.0.0.1', 'production.example'), settings), /REQUIRES_LOOPBACK/);
});

test('managed role provisioning verifies live target and read-only login, returns a dedicated limited URL without altering primary', async () => {
  const db = database(); const before = primary;
  const result = await provisionCourseReadRole({ db: db.admin, primaryDatabaseURL: primary, roleName: role, password, workers: 2, perWorkerConnections: 16, connect: db.connect });
  assert.equal(result.created, true);
  assert.equal(result.roleName, role);
  assert.equal(result.proof.temporaryAllowed, true);
  const url = new URL(result.readDatabaseURL);
  assert.equal(url.username, role); assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.searchParams.get('connection_limit'), '16');
  assert.equal(url.searchParams.get('sslmode'), 'prefer');
  assert.match(url.searchParams.get('options'), /default_transaction_read_only=on/);
  assert.equal(new URL(db.state.urls[0]).searchParams.get('connection_limit'), '1');
  assert.equal(primary, before); assert.equal(db.state.loginConnections, 1); assert.equal(db.state.disconnected, 1);
});

test('existing unmarked, elevated or unknown roles fail before grants and login; managed ordinary roles can be reused', async () => {
  for (const existing of [[{ marker: 'another-role', ...flags }], [{ marker: 'openpbl-course-read-role:v1', ...flags, rolsuper: true }],
    [{ marker: 'openpbl-course-read-role:v1', ...flags, rolinherit: null }]]) {
    const db = database({ existing });
    await assert.rejects(provisionCourseReadRole({ db: db.admin, primaryDatabaseURL: primary, roleName: role, password, workers: 2, perWorkerConnections: 16, connect: db.connect }), /EXISTING_ROLE_UNSAFE/);
    assert.equal(db.state.writes, 0); assert.equal(db.state.loginConnections, 0); assert.equal(db.state.rolledBack, true);
  }
  const db = database({ existing: [{ marker: 'openpbl-course-read-role:v1', ...flags }] });
  const reused = await provisionCourseReadRole({ db: db.admin, primaryDatabaseURL: primary, roleName: role, password, workers: 2, perWorkerConnections: 16, connect: db.connect });
  assert.equal(reused.created, false);
});

test('any write/create/ownership/membership or unknown privilege result rolls back instead of publishing a ready role', async () => {
  for (const key of Object.keys(proof).filter(key => key !== 'temporaryAllowed')) {
    for (const value of [false, null]) {
      const db = database({ permission: { ...proof, [key]: value } });
      await assert.rejects(provisionCourseReadRole({ db: db.admin, primaryDatabaseURL: primary, roleName: role, password, workers: 2, perWorkerConnections: 16, connect: db.connect }), /PRIVILEGES_UNSAFE/);
      assert.equal(db.state.rolledBack, true); assert.equal(db.state.loginConnections, 0);
    }
  }
});

test('private env survives a failed first provision disabled, then reuses the exact password on a successful retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpbl-course-read-role-')); const file = path.join(directory, 'reader.env');
  try {
    const failing = database({ failure: new Error('fixture database unavailable') });
    await assert.rejects(provisionCourseReadEnvironment({ env: { ...settings, DATABASE_URL: primary }, environmentFile: file, roleName: role, connect: failing.connect }), /DATABASE_FAILED/);
    const pending = await readCourseReadEnvironmentFile(file);
    assert.equal(pending.OPENPBL_COURSE_READ_WORKERS, '0');
    const oldPassword = new URL(pending.OPENPBL_COURSE_READ_DATABASE_URL).password;
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const ready = database();
    const report = await provisionCourseReadEnvironment({ env: { ...settings, DATABASE_URL: primary }, environmentFile: file, roleName: role, connect: ready.connect });
    assert.equal(report.status, 'ready'); assert.equal(report.passwordReused, true);
    assert.equal(report.primaryConnections, 25); assert.equal(report.readerConnections, 32);
    const configured = await readCourseReadEnvironmentFile(file);
    assert.equal(configured.OPENPBL_COURSE_READ_WORKERS, '2');
    assert.equal(new URL(configured.OPENPBL_COURSE_READ_DATABASE_URL).password, oldPassword);
    assert.ok(!JSON.stringify(report).includes(oldPassword));
    assert.ok(!JSON.stringify(report).includes('postgresql://'));
    const oldBytes = await readFile(file, 'utf8'); const badLogin = database({ login: 'off' });
    await assert.rejects(provisionCourseReadEnvironment({ env: { ...settings, DATABASE_URL: primary }, environmentFile: file, roleName: role, connect: badLogin.connect }), /LOGIN_VERIFICATION_FAILED/);
    assert.equal(await readFile(file, 'utf8'), oldBytes);
    assert.deepEqual(await readdir(directory), ['reader.env']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private environment rejects insecure files, symlinks, duplicates and a different target without connecting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpbl-course-read-private-')); const file = path.join(directory, 'reader.env');
  try {
    await writeFile(file, 'do not accept', { mode: 0o644 });
    await assert.rejects(readCourseReadEnvironmentFile(file), /NOT_PRIVATE/);
    await rm(file); await symlink(path.join(directory, 'absent'), file);
    await assert.rejects(readCourseReadEnvironmentFile(file));
    await rm(file);
    const db = database();
    await provisionCourseReadEnvironment({ env: { ...settings, DATABASE_URL: primary }, environmentFile: file, roleName: role, connect: db.connect });
    await assert.rejects(provisionCourseReadEnvironment({ env: { ...settings, DATABASE_URL: primary.replace('/source?', '/other?') }, environmentFile: file, roleName: role, connect: () => assert.fail('must not connect') }), /TARGET_MISMATCH/);
    const contents = await readFile(file, 'utf8');
    await writeFile(file, `${contents}OPENPBL_COURSE_READ_WORKERS="2"\n`); await chmod(file, 0o600);
    await assert.rejects(readCourseReadEnvironmentFile(file), /FILE_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
