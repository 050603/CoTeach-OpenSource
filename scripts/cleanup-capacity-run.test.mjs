import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, validateUsers, deletionOrder, fixturePolicy, validateProjectionRecords, validateOwnedProjectionRoots } from './cleanup-capacity-run.mjs';

const runId = 'capacity-12345678-1234-1234-1234-123456789abc';

test('cleanup rejects running, unverified and unrelated reports', () => {
  assert.throws(() => validateReport({ runId, outcome: 'running' }, runId));
  assert.throws(() => validateReport({ runId, outcome: 'passed', checks: [] }));
  assert.throws(() => validateReport({ runId: 'production', outcome: 'failed' }, 'production'));
  assert.throws(() => validateReport({ runId, outcome: 'failed' }, `${runId}-other`));
  validateReport({ runId, outcome: 'failed' }, runId);
  validateReport({ runId, outcome: 'passed', checks: [{ name: 'per-student-database-file-reconciliation', status: '通过' }] });
});

test('user ownership requires the complete run prefix and numeric fixture suffix', () => {
  validateUsers(runId, [{ username: `${runId}-0`, usernameKey: `${runId}-0` }]);
  assert.throws(() => validateUsers(runId, [{ username: `${runId}-real-teacher`, usernameKey: `${runId}-real-teacher` }]));
  assert.throws(() => validateUsers(runId, [{ username: 'formal-student', usernameKey: 'formal-student' }]));
});

test('partial smoke runs require explicit abort of the complete matching run ID', () => {
  const report = { runId, outcome: 'partial', checks: [{ name: 'per-student-database-file-reconciliation', status: '通过' }] };
  assert.throws(() => validateReport(report));
  assert.throws(() => validateReport(report, 'capacity-12345678'));
  assert.throws(() => validateReport(report, 'capacity-12345678-1234-1234-1234-123456789abd'));
  validateReport(report, runId);
});

test('explicit abort of a partial run does not bypass fixture ownership validation', () => {
  assert.throws(() => validateReport({ runId, outcome: 'partial', fixture: { classroomId: 'formal-classroom' } }, runId));
  assert.throws(() => validateReport({ runId, outcome: 'partial', fixture: { userIds: ['formal-student'] } }, runId));
  validateReport({ runId, outcome: 'partial', fixture: { classroomId: `${runId}-lesson`, userIds: ['12345678-1234-1234-1234-123456789abc'] } }, runId);
});

test('deletes dependents first and rejects a cross-table cycle before deletion', () => {
  const owned = new Map([['User', new Set(['u'])], ['Enrollment', new Set(['e'])], ['Submission', new Set(['s'])]]);
  assert.deepEqual(deletionOrder(owned, [{ parent: 'User', child: 'Enrollment' }, { parent: 'Enrollment', child: 'Submission' }]), ['Submission', 'Enrollment', 'User']);
  assert.throws(() => deletionOrder(owned, [{ parent: 'User', child: 'Enrollment' }, { parent: 'Enrollment', child: 'User' }]));
});

const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const projectionReport = () => ({ runId, origin: 'https://coteach.cn', outcome: 'latency-failed', rounds: 2, heartbeats: true, includeState: true, modes: ['draft', 'mixed'],
  startedAt: '2026-09-27T01:00:00.000Z', finishedAt: '2026-09-27T01:05:00.000Z', batches: [], errors: [], databaseWaitSamples: [],
  workload: 'real HTTP/42 WebSocket receivers; no mocked API; practice=40 draft+40 state+40 heartbeat; extra cross-stage stress=those plus40 quiz+40 progress',
  fixture: { offeringId: id(100), templateId: id(101), instanceId: id(102), activityId: id(103), chapterId: id(104),
    classroomId: `${runId}-projection-load`, userIds: Array.from({ length: 42 }, (_, index) => id(index + 1)) } });
const projectionUsers = report => report.fixture.userIds.map((userId, index) => ({ id: userId, username: `${runId}-projection-${index}`,
  usernameKey: `${runId}-projection-${index}`, role: index < 2 ? 'TEACHER' : 'STUDENT' }));
const projectionRecords = report => {
  const fixture = report.fixture, { title } = fixturePolicy(report, 'projection-contention');
  return { offerings: [{ id: fixture.offeringId, name: title, description: runId }],
    templates: [{ id: fixture.templateId, title, ownerId: fixture.userIds[0] }],
    chapter: { id: fixture.chapterId, offeringId: fixture.offeringId, title: '独立混合锁验收', position: 0 },
    activity: { id: fixture.activityId, chapterId: fixture.chapterId, title, type: 'CLASSROOM', position: 0 },
    instance: { id: fixture.instanceId, activityId: fixture.activityId, templateVersion: { templateId: fixture.templateId,
      snapshot: { design: { aiLearningClassroomId: fixture.classroomId } } } } };
};

test('projection report requires explicit kind and complete abort ID, including measured reports', () => {
  for (const outcome of ['latency-failed', 'measured', 'failed']) {
    const report = { ...projectionReport(), outcome };
    assert.throws(() => validateReport(report, runId));
    assert.throws(() => validateReport(report, undefined, 'projection-contention'));
    assert.throws(() => validateReport(report, `${runId}-other`, 'projection-contention'));
    const before = structuredClone(report);
    const policy = validateReport(report, runId, 'projection-contention');
    assert.equal(policy.classroomId, `${runId}-projection-load`);
    assert.equal(policy.title, `投屏混合验收 ${runId}`);
    assert.deepEqual(report, before, 'Validating must not rewrite the historical report or outcome');
  }
  assert.throws(() => validateReport(projectionReport(), runId, 'projection'));
  assert.throws(() => validateReport({ ...projectionReport(), kind: 'classroom-capacity' }, runId, 'projection-contention'));
});

test('projection rejects active, missing/invalid finish, unknown workload and incomplete manifests', () => {
  const mutations = [
    r => { r.outcome = 'running'; }, r => { r.outcome = 'partial'; }, r => { delete r.finishedAt; r.endedAt = r.startedAt; },
    r => { r.finishedAt = '2026-09-26T00:00:00.000Z'; }, r => { r.finishedAt = 'invalid'; },
    r => { r.fixture.classroomId = `${runId}-lesson`; }, r => { r.fixture.classroomId = '../real-course'; },
    r => { delete r.fixture.chapterId; }, r => { r.fixture.instanceId = 'real-course'; },
    r => { r.fixture.userIds.pop(); }, r => { r.fixture.userIds[41] = r.fixture.userIds[0]; },
    r => { r.fixture.userIds[41] = 'non-uuid'; }, r => { r.workload = 'arbitrary load'; }, r => { r.modes = ['unknown']; },
  ];
  for (const mutate of mutations) {
    const report = projectionReport(); mutate(report);
    assert.throws(() => validateReport(report, runId, 'projection-contention'));
  }
});

test('projection supports the two exact historical probe shapes without weakening ownership', () => {
  const original = projectionReport(); delete original.includeState; delete original.modes; delete original.heartbeats;
  original.workload = 'real HTTP/42 WebSocket receivers; no mocked API; artificial same-tick quiz/progress/draft burst';
  validateReport(original, runId, 'projection-contention');
  const noState = projectionReport(); noState.includeState = false;
  noState.workload = noState.workload.replace('+40 state', '');
  validateReport(noState, runId, 'projection-contention');
});

test('projection users require fixed 0..41 suffixes, exact manifest indices and teacher/student roles', () => {
  const report = projectionReport();
  validateUsers(runId, projectionUsers(report), 'projection-contention', report.fixture.userIds);
  validateUsers(runId, [projectionUsers(report)[10]], 'projection-contention', report.fixture.userIds); // Idempotent cleanup may see a subset.
  for (const suffix of ['0', 'projection-42', 'projection-01', 'projection-0-extra', 'projection-admin']) {
    const user = { ...projectionUsers(report)[0], username: `${runId}-${suffix}`, usernameKey: `${runId}-${suffix}` };
    assert.throws(() => validateUsers(runId, [user], 'projection-contention', report.fixture.userIds));
  }
  for (const index of [0, 1, 2, 41]) {
    const user = projectionUsers(report)[index]; user.role = index < 2 ? 'STUDENT' : 'TEACHER';
    assert.throws(() => validateUsers(runId, [user], 'projection-contention', report.fixture.userIds));
  }
  const wrongId = { ...projectionUsers(report)[0], id: report.fixture.userIds[1] };
  assert.throws(() => validateUsers(runId, [wrongId], 'projection-contention', report.fixture.userIds));
  assert.throws(() => validateUsers(runId, projectionUsers(report), 'projection-contention'));
  assert.throws(() => validateUsers(runId, projectionUsers(report)));
});

test('projection database records reject wrong titles, cross-course relations, owners and manifest IDs', () => {
  const report = projectionReport(); validateProjectionRecords(report, projectionRecords(report));
  const mutations = [
    r => { r.offerings[0].name = `并发验收 ${runId}`; }, r => { r.templates[0].title += ' other'; },
    r => { r.offerings[0].description = 'real-course'; }, r => { r.offerings[0].id = id(200); },
    r => { r.templates[0].id = id(200); }, r => { r.templates[0].ownerId = report.fixture.userIds[1]; },
    r => { r.chapter.title = '正式课程'; }, r => { r.chapter.offeringId = id(200); },
    r => { r.chapter.id = id(200); }, r => { r.activity.id = id(200); }, r => { r.activity.chapterId = id(200); },
    r => { r.activity.title = '正式课程'; }, r => { r.activity.type = 'ASSIGNMENT'; },
    r => { r.instance.id = id(200); }, r => { r.instance.activityId = id(200); },
    r => { r.instance.templateVersion.templateId = id(200); },
    r => { r.instance.templateVersion.snapshot.design.aiLearningClassroomId = '../other'; },
  ];
  for (const mutate of mutations) {
    const records = projectionRecords(report); mutate(records);
    assert.throws(() => validateProjectionRecords(report, records));
  }
  validateProjectionRecords(report, { offerings: [], templates: [], chapter: null, activity: null, instance: null });
});

test('projection descendant traversal cannot add another classroom, offering, activity, template or user', () => {
  const report = projectionReport();
  const owned = new Map([['User', new Set(report.fixture.userIds)], ...[
    ['CourseOffering', 'offeringId'], ['ClassroomTemplate', 'templateId'], ['ClassroomInstance', 'instanceId'], ['Chapter', 'chapterId'], ['Activity', 'activityId'],
  ].map(([table, key]) => [table, new Set([report.fixture[key]])])]);
  validateOwnedProjectionRoots(report, owned);
  for (const [table, values] of owned) {
    const changed = new Map(owned); changed.set(table, new Set([...values, id(200)]));
    assert.throws(() => validateOwnedProjectionRoots(report, changed));
  }
});

// These tests run real file planning/recovery around an isolated transactional
// store. Production foreign-key SQL is separately exercised on restored data.
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cleanupCapacityRun, rowKeyExpression, assertRunInactive, literalReferencePattern } from './cleanup-capacity-run.mjs';

function memoryDatabase(initial, edges = [], keys = {}) {
  let state = structuredClone(initial);
  let deleteFailure = false;
  const key = (table, row) => keys[table] ? JSON.stringify(keys[table].map(column => row[column])) : row.id;
  function client(store) {
    const find = (table, predicate) => (store[table] ?? []).filter(predicate).map(row => structuredClone(row));
    return {
      user: { findMany: async ({ where }) => find('User', row => where.username ? row.username.startsWith(where.username.startsWith) : where.id.in.includes(row.id)) },
      courseOffering: { findMany: async ({ where }) => find('CourseOffering', row => row.description === where.description), findUnique: async ({ where }) => find('CourseOffering', row => row.id === where.id)[0] ?? null },
      classroomTemplate: { findMany: async ({ where }) => find('ClassroomTemplate', row => where.ownerId.in.includes(row.ownerId) && row.title.includes(where.title.contains)), findUnique: async ({ where }) => find('ClassroomTemplate', row => row.id === where.id)[0] ?? null },
      fileAsset: {
        findMany: async ({ where }) => find('FileAsset', row => where.id.in.includes(row.id)),
        count: async ({ where }) => find('FileAsset', row => where.OR.some(filter => Object.entries(filter).every(([column, value]) => row[column] === value))).length,
      },
      $executeRawUnsafe: async (sql, ids) => {
        if (sql.includes('pg_advisory_xact_lock')) return 1;
        const table = /^DELETE FROM "(\w+)"/.exec(sql)?.[1];
        assert.ok(table, `Unexpected write query: ${sql}`);
        if (deleteFailure) { deleteFailure = false; throw new Error('simulated database deletion failure'); }
        store[table] = find(table, row => !ids.includes(key(table, row)));
        return 1;
      },
      $queryRawUnsafe: async (sql, a, b) => {
        if (sql.includes('FROM pg_index')) return Object.keys(store).map(tableName => ({ tableName, columns: keys[tableName] ?? ['id'] }));
        if (sql.includes('FROM pg_constraint')) return edges.map(edge => ({ columns: 1, parentColumn: 'id', ...edge }));
        if (sql.includes('FROM information_schema.columns')) return a.flatMap(tableName => (store[tableName] ?? []).some(row => row.updatedAt) ? [{ tableName, columnName: 'updatedAt' }] : []);
        const table = /FROM "(\w+)"/.exec(sql)?.[1];
        assert.ok(table, `Unexpected read query: ${sql}`);
        if (sql.includes('"targetId"=ANY')) return find(table, row => a.includes(row.targetId)).map(row => ({ id: row.id }));
        if (sql.includes('cleanup:shared-json')) return find(table, row => !a.includes(row.id) && new RegExp(b).test(JSON.stringify(row))).slice(0, 1);
        if (sql.includes('starts_with')) return find(table, row => row.username.startsWith(a)).slice(0, 1);
        if (sql.includes('"description"=$1')) return find(table, row => row.description === a).slice(0, 1);
        if (sql.includes(' IS NOT NULL AND NOT ')) {
          const column = /AND "(\w+)" IS NOT NULL/.exec(sql)[1];
          return find(table, row => a.includes(key(table, row)) && row[column] != null && !b.includes(row[column])).slice(0, 1);
        }
        const descendant = /WHERE "(\w+)" = ANY/.exec(sql);
        if (descendant) return find(table, row => a.includes(row[descendant[1]])).map(row => ({ id: key(table, row) }));
        if (sql.includes('>$2')) return find(table, row => a.includes(key(table, row)) && new Date(row.updatedAt) > b).slice(0, 1);
        if (sql.includes('AND status=ANY')) return find(table, row => a.includes(key(table, row)) && b.includes(row.status)).slice(0, 1);
        return find(table, row => a.includes(key(table, row))).map(row => ({ id: key(table, row) }));
      },
    };
  }
  const db = {
    get state() { return state; },
    set failDelete(value) { deleteFailure = value; },
    $transaction: async work => { const candidate = structuredClone(state), result = await work(client(candidate)); state = candidate; return result; },
  };
  for (const name of ['fileAsset', '$queryRawUnsafe']) db[name] = name === 'fileAsset' ? { count: input => client(state).fileAsset.count(input) } : (...args) => client(state)[name](...args);
  return db;
}

async function cleanupFixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'capacity-cleanup-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const policy = fixturePolicy({ runId });
  const report = { runId, outcome: 'failed', fixture: { userIds: [id(1)], offeringId: id(2), templateId: id(3), classroomId: policy.classroomId } };
  const asset = { id: id(4), storageKey: 'synthetic-test-upload.txt', uploadedById: id(1), sha256: createHash('sha256').update('synthetic upload').digest('hex') };
  const initial = {
    User: [{ id: id(1), username: `${runId}-0`, usernameKey: `${runId}-0`, role: 'TEACHER' }],
    CourseOffering: [{ id: id(2), name: policy.title, description: runId }],
    ClassroomTemplate: [{ id: id(3), title: policy.title, ownerId: id(1) }],
    FileAsset: [asset], GenerationJob: [], ClassroomTemplateVersion: [], ClassroomInstance: [],
    AiTaskRequestAlias: [{ participationId: id(1), clientRequestId: 'synthetic-client-request' }],
  };
  const edges = [
    { parent: 'User', child: 'ClassroomTemplate', childColumn: 'ownerId' },
    { parent: 'User', child: 'FileAsset', childColumn: 'uploadedById' },
    { parent: 'User', child: 'AiTaskRequestAlias', childColumn: 'participationId' },
  ];
  const keys = { AiTaskRequestAlias: ['participationId', 'clientRequestId'] };
  const db = memoryDatabase(initial, edges, keys);
  const upload = path.join(rootDir, '.openpbl-data/uploads', asset.storageKey);
  const classroom = path.join(rootDir, '.openpbl-data/classrooms', `${policy.classroomId}.json`);
  await mkdir(path.dirname(upload), { recursive: true }); await mkdir(path.dirname(classroom), { recursive: true });
  await writeFile(upload, 'synthetic upload'); await writeFile(classroom, JSON.stringify({ id: policy.classroomId }));
  const receiptPath = path.join(rootDir, 'private-evidence', `${runId}-cleanup.json`);
  return { db, report, rootDir, receiptPath, abortedRun: runId, upload, classroom, initial, edges, keys };
}

test('stable row keys include composite primary keys without requiring an id column', () => {
  assert.equal(rowKeyExpression(), '"id"');
  assert.equal(rowKeyExpression(['participationId', 'clientRequestId']), 'jsonb_build_array("participationId", "clientRequestId")::text');
  assert.throws(() => rowKeyExpression([])); assert.throws(() => rowKeyExpression(['id; DELETE']));
});

test('default dry-run exposes exact owned keys without deleting data, files or creating a receipt', async t => {
  const fixture = await cleanupFixture(t), before = structuredClone(fixture.db.state);
  const result = await cleanupCapacityRun(fixture);
  assert.equal(result.databaseDeleted, false); assert.deepEqual(fixture.db.state, before);
  assert.equal(result.ownedIds.AiTaskRequestAlias.length, 1);
  assert.deepEqual(result.rowKeys.AiTaskRequestAlias, ['participationId', 'clientRequestId']);
  assert.equal(await readFile(fixture.upload, 'utf8'), 'synthetic upload');
  await assert.rejects(readFile(fixture.receiptPath), { code: 'ENOENT' });
});

test('execution removes only planned rows and bytes and can be repeated', async t => {
  const fixture = await cleanupFixture(t);
  const result = await cleanupCapacityRun({ ...fixture, execute: true });
  assert.equal(result.databaseDeleted, true); assert.equal(result.filesDeleted, true);
  assert.equal(fixture.db.state.User.length, 0); assert.equal(fixture.db.state.AiTaskRequestAlias.length, 0);
  await assert.rejects(readFile(fixture.upload), { code: 'ENOENT' });
  const retried = await cleanupCapacityRun({ ...fixture, execute: true });
  assert.equal(retried.filesDeleted, true);
});

test('cross-course ownership fails before deletion or a deletion plan receipt', async t => {
  const fixture = await cleanupFixture(t);
  fixture.initial.Enrollment = [{ id: id(10), userId: id(1), offeringId: id(99) }];
  fixture.initial.CourseOffering.push({ id: id(99), name: 'protected classroom', description: 'formal' });
  fixture.edges.push({ parent: 'User', child: 'Enrollment', childColumn: 'userId' }, { parent: 'CourseOffering', child: 'Enrollment', childColumn: 'offeringId' });
  fixture.db = memoryDatabase(fixture.initial, fixture.edges, fixture.keys);
  const before = structuredClone(fixture.db.state);
  await assert.rejects(cleanupCapacityRun({ ...fixture, execute: true }), /references non-fixture CourseOffering/);
  assert.deepEqual(fixture.db.state, before);
  await assert.rejects(readFile(fixture.receiptPath), { code: 'ENOENT' });
});

test('database failure rolls back while the prepared plan supports a safe retry', async t => {
  const fixture = await cleanupFixture(t), before = structuredClone(fixture.db.state);
  fixture.db.failDelete = true;
  await assert.rejects(cleanupCapacityRun({ ...fixture, execute: true }), /simulated database/);
  assert.deepEqual(fixture.db.state, before);
  assert.equal(JSON.parse(await readFile(fixture.receiptPath, 'utf8')).databaseDeleted, false);
  assert.equal((await cleanupCapacityRun({ ...fixture, execute: true })).filesDeleted, true);
});

test('a crash after transaction commit resumes from the precommit assets and row keys', async t => {
  const fixture = await cleanupFixture(t);
  const saveReceipt = async (filename, plan) => {
    if (plan.databaseDeleted) throw new Error('simulated process interruption after commit');
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, JSON.stringify(plan));
  };
  await assert.rejects(cleanupCapacityRun({ ...fixture, execute: true, saveReceipt }), /after commit/);
  assert.equal(fixture.db.state.User.length, 0);
  assert.equal(await readFile(fixture.upload, 'utf8'), 'synthetic upload');
  const retried = await cleanupCapacityRun({ ...fixture, execute: true });
  assert.equal(retried.filesDeleted, true);
});

test('changed upload bytes interrupt file deletion and preserve the retry receipt', async t => {
  const fixture = await cleanupFixture(t);
  const saveReceipt = async (filename, plan) => {
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, JSON.stringify(plan));
    if (plan.databaseDeleted) await writeFile(fixture.upload, 'changed bytes');
  };
  await assert.rejects(cleanupCapacityRun({ ...fixture, execute: true, saveReceipt }), /changed after its deletion plan/);
  const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'));
  assert.equal(receipt.databaseDeleted, true); assert.equal(receipt.filesDeleted, undefined);
  assert.equal(await readFile(fixture.upload, 'utf8'), 'changed bytes');
  await writeFile(fixture.upload, 'synthetic upload');
  assert.equal((await cleanupCapacityRun({ ...fixture, execute: true })).filesDeleted, true);
});

test('retained JSON references and storage symlinks prevent deletion', async t => {
  for (const reference of ['database', 'classroom', 'symlink']) {
    const fixture = await cleanupFixture(t), before = structuredClone(fixture.db.state);
    if (reference === 'database') fixture.db.state.ClassroomTemplateVersion.push({ id: id(90), snapshot: { src: fixturePolicy(fixture.report).classroomId } });
    if (reference === 'classroom') await writeFile(path.join(path.dirname(fixture.classroom), 'retained.json'), JSON.stringify({ upload: 'synthetic-test-upload.txt' }));
    if (reference === 'symlink') { await rm(fixture.upload); await symlink(fixture.classroom, fixture.upload); }
    const protectedState = reference === 'database' ? structuredClone(fixture.db.state) : before;
    await assert.rejects(cleanupCapacityRun({ ...fixture, execute: true }), /references this run|symlink/);
    assert.deepEqual(fixture.db.state, protectedState);
  }
});

test('recent writes and unfinished queued tasks refuse cleanup within exact owned rows', async () => {
  const owned = new Map([['AiTask', new Set([id(1)])]]);
  const now = Date.parse('2026-10-22T10:00:00Z');
  const queries = [];
  const recentTx = { $queryRawUnsafe: async (sql, ids) => {
    queries.push(ids);
    return sql.includes('information_schema') ? [{ tableName: 'AiTask', columnName: 'updatedAt' }] : [{ id: id(1) }];
  } };
  await assert.rejects(assertRunInactive(recentTx, owned, now), /activity within 15 minutes/);
  assert.deepEqual(queries[1], [id(1)]);
  const queuedTx = { $queryRawUnsafe: async sql => sql.includes('information_schema') ? [] : [{ id: id(1) }] };
  await assert.rejects(assertRunInactive(queuedTx, owned, now), /unfinished queued work/);
  await assertRunInactive({ $queryRawUnsafe: async () => [] }, owned, now);
});

test('shared reference regex preserves literal substring matching for metacharacter filenames', () => {
  const needles = ['file+a[1].png', 'uuid-123', 'path\\name?'];
  const pattern = new RegExp(literalReferencePattern(needles));
  for (const value of needles) assert.ok(pattern.test(`prefix ${value} suffix`));
  for (const value of ['fileaaaa1Xpng', 'uuidX123', 'pathname']) assert.equal(pattern.test(value), false);
});

test('a file-stage interruption after an earlier unlink retries only the remaining planned bytes', async t => {
  const fixture = await cleanupFixture(t), original = await readFile(fixture.classroom);
  const saveReceipt = async (filename, plan) => {
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, JSON.stringify(plan));
    if (plan.databaseDeleted) await writeFile(fixture.classroom, 'modified classroom');
  };
  await assert.rejects(cleanupCapacityRun({ ...fixture, execute: true, saveReceipt }), /changed after its deletion plan/);
  await assert.rejects(readFile(fixture.upload), { code: 'ENOENT' });
  await writeFile(fixture.classroom, original);
  assert.equal((await cleanupCapacityRun({ ...fixture, execute: true })).filesDeleted, true);
});
