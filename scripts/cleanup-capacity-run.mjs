import { loadReconstructedCleanup, reconstructedUserOrder, validateReconstructedOwnedRoots } from './lib/capacity-reconstructed-cleanup.mjs';
/** Remove only terminal, UUID-owned capacity fixtures. Defaults to a dry run. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink, lstat, readdir, rmdir, mkdir, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const runPattern = new RegExp(`^capacity-${uuid}$`);
const identifier = (value) => { assert.match(value, /^[A-Za-z_][A-Za-z_0-9]*$/); return `"${value}"`; };
export function rowKeyExpression(columns = ['id']) {
  assert.ok(Array.isArray(columns) && columns.length > 0, 'A stable primary key is required');
  const names = columns.map(identifier);
  return columns.length === 1 && columns[0] === 'id' ? '"id"' : `jsonb_build_array(${names.join(', ')})::text`;
}

export function fixturePolicy(report, kind = 'classroom-capacity') {
  assert.match(report.runId, runPattern, 'Report must identify one capacity UUID');
  assert.ok(['classroom-capacity', 'projection-contention'].includes(kind), 'Unknown cleanup fixture kind');
  if (report.kind !== undefined) assert.equal(report.kind, kind, 'Report kind disagrees with explicit cleanup kind');
  return { kind, title: `${kind === 'projection-contention' ? '投屏混合验收' : '并发验收'} ${report.runId}`,
    classroomId: `${report.runId}-${kind === 'projection-contention' ? 'projection-load' : 'lesson'}` };
}

export function validateReport(report, abortedRun, kind = 'classroom-capacity') {
  const policy = fixturePolicy(report, kind);
  if (kind === 'projection-contention') {
    // Historical probe reports have no kind field. Never infer their identity
    // from a loose prefix: callers must explicitly opt into this fixture type.
    assert.equal(abortedRun, report.runId, 'Projection cleanup requires --abort-run with the complete run ID');
    assert.ok(['failed', 'latency-failed', 'measured'].includes(report.outcome), 'Projection report must be terminal');
    assert.equal(report.origin, 'https://coteach.cn', 'Unexpected projection probe origin');
    assert.ok(typeof report.startedAt === 'string' && typeof report.finishedAt === 'string'
      && Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt))
      && new Date(report.startedAt).toISOString() === report.startedAt && new Date(report.finishedAt).toISOString() === report.finishedAt
      && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'Projection report requires a valid finishedAt');
    assert.ok(Number.isInteger(report.rounds) && report.rounds >= 2 && report.rounds <= 60);
    const originalProbe = report.heartbeats === undefined && report.includeState === undefined && report.modes === undefined
      && report.workload === 'real HTTP/42 WebSocket receivers; no mocked API; artificial same-tick quiz/progress/draft burst';
    if (!originalProbe) assert.equal(typeof report.heartbeats, 'boolean');
    if (report.includeState !== undefined) assert.equal(typeof report.includeState, 'boolean');
    if (report.modes !== undefined) assert.ok(Array.isArray(report.modes) && report.modes.length > 0
      && new Set(report.modes).size === report.modes.length && report.modes.every(mode => ['draft', 'mixed'].includes(mode)));
    const workload = `real HTTP/42 WebSocket receivers; no mocked API; practice=40 draft${report.includeState !== false ? '+40 state' : ''}${report.heartbeats ? '+40 heartbeat' : ''}; extra cross-stage stress=those plus40 quiz+40 progress`;
    assert.ok(report.workload === workload || originalProbe, 'Unknown projection probe workload manifest');
    for (const field of ['batches', 'databaseWaitSamples', 'errors']) assert.ok(Array.isArray(report[field]), `Missing projection ${field}`);
    assert.ok(report.fixture && typeof report.fixture === 'object', 'Projection fixture manifest is required');
    for (const field of ['offeringId', 'templateId', 'instanceId', 'activityId', 'chapterId']) {
      assert.match(report.fixture[field], new RegExp(`^${uuid}$`), `Invalid projection fixture ${field}`);
    }
    assert.equal(report.fixture.classroomId, policy.classroomId);
    assert.ok(Array.isArray(report.fixture.userIds) && report.fixture.userIds.length === 42, 'Projection fixture requires all 42 user IDs');
  } else {
    const reconciled = report.outcome === 'passed' && report.checks?.some(
      (check) => check.name === 'per-student-database-file-reconciliation' && check.status === '通过');
    const aborted = abortedRun === report.runId && ['failed', 'partial'].includes(report.outcome);
    assert.ok(reconciled || aborted, 'Require successful reconciliation or --abort-run matching a failed/partial terminal report');
    if (report.fixture?.classroomId) assert.equal(report.fixture.classroomId, policy.classroomId);
  }
  for (const id of report.fixture?.userIds ?? []) assert.match(id, new RegExp(`^${uuid}$`));
  if (report.fixture?.userIds) assert.equal(new Set(report.fixture.userIds).size, report.fixture.userIds.length, 'Duplicate fixture user IDs');
  return policy;
}

export function validateUsers(runId, users, kind = 'classroom-capacity', manifestUserIds) {
  fixturePolicy({ runId }, kind);
  const projection = kind === 'projection-contention';
  if (projection) assert.ok(Array.isArray(manifestUserIds) && manifestUserIds.length === 42, 'Projection user ownership requires its complete manifest');
  const namePattern = new RegExp(`^${runId}-${projection ? 'projection-([0-9]|[1-3][0-9]|4[01])' : '[0-9]+'}$`);
  for (const user of users) {
    assert.match(user.username, namePattern, 'Refusing a user outside the exact run prefix');
    assert.equal(user.usernameKey, user.username);
    if (projection) {
      const index = Number(user.username.match(namePattern)[1]);
      assert.equal(typeof user.id, 'string', 'Projection user ID is required');
      assert.equal(user.id, manifestUserIds?.[index], 'Projection user ID disagrees with its manifest index');
      assert.equal(user.role, index < 2 ? 'TEACHER' : 'STUDENT', 'Projection user role disagrees with its fixture index');
    }
  }
}

export function validateProjectionRecords(report, { offerings, templates, chapter, activity, instance }) {
  const { title, classroomId } = fixturePolicy(report, 'projection-contention');
  const fixture = report.fixture;
  for (const offering of offerings) {
    assert.equal(offering.id, fixture.offeringId); assert.equal(offering.name, title); assert.equal(offering.description, report.runId);
  }
  for (const template of templates) {
    assert.equal(template.id, fixture.templateId); assert.equal(template.title, title); assert.equal(template.ownerId, fixture.userIds[0]);
  }
  if (chapter) {
    assert.equal(chapter.id, fixture.chapterId); assert.equal(chapter.offeringId, fixture.offeringId);
    assert.equal(chapter.title, '独立混合锁验收'); assert.equal(chapter.position, 0);
  }
  if (activity) {
    assert.equal(activity.id, fixture.activityId); assert.equal(activity.chapterId, fixture.chapterId);
    assert.equal(activity.title, title); assert.equal(activity.type, 'CLASSROOM'); assert.equal(activity.position, 0);
  }
  if (instance) {
    assert.equal(instance.id, fixture.instanceId); assert.equal(instance.activityId, fixture.activityId);
    assert.equal(instance.templateVersion.templateId, fixture.templateId);
    assert.equal(instance.templateVersion.snapshot?.design?.aiLearningClassroomId, classroomId);
  }
}

export function validateOwnedProjectionRoots(report, owned) {
  for (const [table, field] of [
    ['CourseOffering', 'offeringId'], ['ClassroomTemplate', 'templateId'], ['ClassroomInstance', 'instanceId'], ['Chapter', 'chapterId'], ['Activity', 'activityId'],
  ]) assert.ok([...(owned.get(table) ?? [])].every(id => id === report.fixture[field]), `Unexpected projection ${table}`);
  assert.ok([...(owned.get('User') ?? [])].every(id => report.fixture.userIds.includes(id)), 'Unexpected projection User');
}

export function deletionOrder(owned, edges) {
  const remaining = new Set([...owned].filter(([, ids]) => ids.size).map(([table]) => table));
  const result = [];
  while (remaining.size) {
    const leaves = [...remaining].filter((table) => !edges.some(
      (edge) => edge.parent === table && edge.child !== table && remaining.has(edge.child)));
    assert.ok(leaves.length, 'Cyclic fixture dependencies require manual inspection; no records deleted');
    for (const table of leaves) { remaining.delete(table); result.push(table); }
  }
  return result;
}

export async function planAndDelete(tx, report, execute, kind, { now = Date.now(), beforeDelete } = {}) {
  const runId = report.runId;
  const policy = fixturePolicy(report, kind);
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', runId);
  const users = await tx.user.findMany({ where: { username: { startsWith: `${runId}-` } }, select: { id: true, username: true, usernameKey: true, role: true } });
  if (report.reconstructedCleanup && users.length) report.fixture.userIds = reconstructedUserOrder(report, users);
  validateUsers(runId, users, kind, report.fixture?.userIds);
  const userIds = users.map((user) => user.id);
  if (report.fixture?.userIds) {
    assert.ok(userIds.every((id) => report.fixture.userIds.includes(id)), 'Run users disagree with fixture manifest');
    // Missing IDs are allowed only for idempotent cleanup; an existing ID must
    // always still belong to this run, even when its username was changed.
    const manifestUsers = await tx.user.findMany({ where: { id: { in: report.fixture.userIds } }, select: { id: true, username: true, usernameKey: true, role: true } });
    validateUsers(runId, manifestUsers, kind, report.fixture.userIds);
  }
  const offerings = await tx.courseOffering.findMany({ where: { description: runId }, select: { id: true, name: true, description: true } });
  const templates = await tx.classroomTemplate.findMany({ where: { ownerId: { in: userIds }, title: { contains: runId } }, select: { id: true, ownerId: true, title: true } });
  for (const offering of offerings) assert.equal(offering.name, policy.title);
  for (const template of templates) assert.equal(template.title, policy.title);
  if (report.fixture?.offeringId) {
    const value = await tx.courseOffering.findUnique({ where: { id: report.fixture.offeringId } });
    assert.ok(!value || (value.description === runId && value.name === policy.title), 'Offering is not owned by this run');
    assert.ok(offerings.every((item) => item.id === report.fixture.offeringId));
  }
  if (report.fixture?.templateId) {
    const value = await tx.classroomTemplate.findUnique({ where: { id: report.fixture.templateId } });
    assert.ok(!value || (userIds.includes(value.ownerId) && value.title === policy.title), 'Template is not owned by this run');
    assert.ok(templates.every((item) => item.id === report.fixture.templateId));
  }
  if (report.reconstructedCleanup && !users.length && !offerings.length && !templates.length) {
    // A completed cleanup remains idempotent. Renamed users or surviving roots
    // are not an empty run and must never enter this path.
    for (const [table, values] of [
      ['User', report.fixture.userIds], ['CourseOffering', [report.fixture.offeringId]],
      ['ClassroomTemplate', [report.fixture.templateId]], ['ClassroomInstance', [report.fixture.instanceId]],
      ['Chapter', [report.fixture.chapterId]], ['Activity', [report.fixture.activityId, report.fixture.surveyId].filter(Boolean)],
    ]) assert.equal((await tx.$queryRawUnsafe(`SELECT id FROM ${identifier(table)} WHERE id=ANY($1::text[]) LIMIT 1`, values)).length, 0,
      'Some historical cleanup roots survive; refusing incomplete ownership');
  }
  if (report.reconstructedCleanup && users.length) {
    assert.equal(offerings.length, 1); assert.equal(templates.length, 1);
    assert.equal(templates[0].ownerId, report.fixture.userIds[0]);
    const chapter = await tx.chapter.findUniqueOrThrow({ where: { id: report.fixture.chapterId }, select: { offeringId: true } });
    assert.equal(chapter.offeringId, report.fixture.offeringId);
    const activity = await tx.activity.findUniqueOrThrow({ where: { id: report.fixture.activityId }, select: { chapterId: true, type: true } });
    assert.equal(activity.chapterId, report.fixture.chapterId); assert.equal(activity.type, 'CLASSROOM');
    if (report.fixture.surveyId) {
      const survey = await tx.activity.findUniqueOrThrow({ where: { id: report.fixture.surveyId }, select: { chapterId: true, type: true } });
      assert.equal(survey.chapterId, report.fixture.chapterId); assert.equal(survey.type, 'FORM');
    }
    const instances = await tx.$queryRawUnsafe(`SELECT ci.id, ci."activityId", tv."templateId",
      tv.snapshot#>>'{design,aiLearningClassroomId}' AS "classroomId"
      FROM "ClassroomInstance" ci JOIN "ClassroomTemplateVersion" tv ON tv.id=ci."templateVersionId" WHERE ci.id=$1`, report.fixture.instanceId);
    assert.equal(instances.length, 1); assert.equal(instances[0].activityId, report.fixture.activityId);
    assert.equal(instances[0].templateId, report.fixture.templateId); assert.equal(instances[0].classroomId, policy.classroomId);
  }
  if (kind === 'projection-contention') {
    validateProjectionRecords(report, { offerings, templates,
      chapter: await tx.chapter.findUnique({ where: { id: report.fixture.chapterId } }),
      activity: await tx.activity.findUnique({ where: { id: report.fixture.activityId } }),
      instance: await tx.classroomInstance.findUnique({ where: { id: report.fixture.instanceId }, include: {
        templateVersion: { select: { templateId: true, snapshot: true } },
      } }),
    });
  }
  const owned = new Map([
    ['User', new Set(userIds)], ['CourseOffering', new Set(offerings.map((item) => item.id))],
    ['ClassroomTemplate', new Set(templates.map((item) => item.id))],
  ]);
  const generationJobs = await tx.$queryRawUnsafe('SELECT id FROM "GenerationJob" WHERE "targetId"=ANY($1::text[])',
    [...userIds, ...offerings.map(row => row.id), ...templates.map(row => row.id), ...Object.values(report.fixture ?? {}).filter(value => typeof value === 'string')]);
  owned.set('GenerationJob', new Set(generationJobs.map(row => row.id)));
  const primaryKeys = await tx.$queryRawUnsafe(`SELECT tab.relname AS "tableName", array_agg(col.attname::text ORDER BY key.ord) AS columns
    FROM pg_index pk JOIN pg_class tab ON tab.oid=pk.indrelid JOIN pg_namespace ns ON ns.oid=tab.relnamespace
    CROSS JOIN LATERAL unnest(pk.indkey) WITH ORDINALITY key(attnum, ord)
    JOIN pg_attribute col ON col.attrelid=tab.oid AND col.attnum=key.attnum
    WHERE pk.indisprimary AND ns.nspname='public' GROUP BY tab.relname`);
  const rowKeys = Object.fromEntries(primaryKeys.map(row => [row.tableName, row.columns]));
  const keyOf = table => { assert.ok(rowKeys[table], `No stable primary key for ${table}`); return rowKeyExpression(rowKeys[table]); };
  const edges = await tx.$queryRawUnsafe(`
    SELECT child.relname AS child, parent.relname AS parent,
           child_column.attname AS "childColumn", parent_column.attname AS "parentColumn",
           cardinality(fk.conkey) AS columns
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid=fk.conrelid
    JOIN pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_namespace namespace ON namespace.oid=child.relnamespace
    JOIN pg_attribute child_column ON child_column.attrelid=child.oid AND child_column.attnum=fk.conkey[1]
    JOIN pg_attribute parent_column ON parent_column.attrelid=parent.oid AND parent_column.attnum=fk.confkey[1]
    WHERE fk.contype='f' AND namespace.nspname='public'
  `);
  for (const edge of edges) {
    assert.equal(edge.columns, 1, 'Composite foreign key requires manual inspection');
    assert.equal(edge.parentColumn, 'id', 'Unsupported foreign key; refusing cleanup');
  }
  // Discover only descendants of verified roots. Never follow a foreign key
  // upward into an unrelated course or account.
  const visitedParents = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const traversalKey = `${edge.parent}.${edge.parentColumn}->${edge.child}.${edge.childColumn}`;
      const visited = visitedParents.get(traversalKey) ?? new Set();
      const parentIds = [...(owned.get(edge.parent) ?? [])].filter(id => !visited.has(id));
      if (!parentIds.length) continue;
      parentIds.forEach(id => visited.add(id));
      visitedParents.set(traversalKey, visited);
      const rows = await tx.$queryRawUnsafe(
        `SELECT ${keyOf(edge.child)} AS id FROM ${identifier(edge.child)} WHERE ${identifier(edge.childColumn)} = ANY($1::text[])`, parentIds);
      if (!owned.has(edge.child)) owned.set(edge.child, new Set());
      const ids = owned.get(edge.child);
      for (const { id } of rows) if (!ids.has(id)) { ids.add(id); changed = true; }
    }
    assert.ok([...owned.values()].reduce((sum, ids) => sum + ids.size, 0) <= 500000, 'Fixture is unexpectedly large');
  }
  // A fixture descendant with any FK into unrelated data is shared data.
  // Refuse the entire transaction before issuing a delete.
  for (const edge of edges) {
    const ids = [...(owned.get(edge.child) ?? [])];
    if (!ids.length) continue;
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${keyOf(edge.child)} AS id FROM ${identifier(edge.child)} WHERE ${keyOf(edge.child)}=ANY($1::text[]) AND ${identifier(edge.childColumn)} IS NOT NULL AND NOT (${identifier(edge.childColumn)}=ANY($2::text[])) LIMIT 1`,
      ids, [...(owned.get(edge.parent) ?? [])]);
    assert.equal(rows.length, 0, `${edge.child} references non-fixture ${edge.parent}; refusing cleanup`);
  }
  if (report.fixture?.instanceId) assert.ok(
    [...(owned.get('ClassroomInstance') ?? [])].every((id) => id === report.fixture.instanceId), 'Unexpected classroom instance');
  if (kind === 'projection-contention') validateOwnedProjectionRoots(report, owned);
  if (report.reconstructedCleanup && users.length) validateReconstructedOwnedRoots(report, owned);
  const assets = await tx.fileAsset.findMany({ where: { id: { in: [...(owned.get('FileAsset') ?? [])] } }, select: { id: true, storageKey: true, sha256: true } });
  const order = deletionOrder(owned, edges);
  const counts = Object.fromEntries(order.map((table) => [table, owned.get(table).size]));
  await assertRunInactive(tx, owned, now, rowKeys);
  const result = { runId, kind, counts, assets, rowKeys, ownedIds: Object.fromEntries([...owned].map(([table, ids]) => [table, [...ids].sort()])),
    ...(report.reconstructedCleanup ? { reconstructedCleanup: report.reconstructedCleanup } : {}), databaseDeleted: false, completedAt: new Date(now).toISOString() };
  if (beforeDelete) await beforeDelete(result, tx);
  if (execute) {
    for (const table of order) await tx.$executeRawUnsafe(`DELETE FROM ${identifier(table)} WHERE ${keyOf(table)}=ANY($1::text[])`, [...owned.get(table)]);
    result.databaseDeleted = true;
  }
  return result;
}

export const RECENT_ACTIVITY_MS = 15 * 60 * 1000;

/** The historical TEACHING flag is not a lease; actual recent activity is. */
export async function assertRunInactive(tx, owned, now = Date.now(), rowKeys = {}) {
  const tables = [...owned].filter(([, ids]) => ids.size).map(([table]) => table);
  if (!tables.length) return;
  const timestamps = await tx.$queryRawUnsafe(`SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
      AND column_name=ANY($2::text[]) AND data_type LIKE 'timestamp%'`, tables,
    ['updatedAt', 'createdAt', 'lastLoginAt', 'lastEnteredAt', 'occurredAt', 'submittedAt']);
  const cutoff = new Date(now - RECENT_ACTIVITY_MS);
  const timeColumns = new Map();
  for (const { tableName, columnName } of timestamps) {
    assert.ok(owned.has(tableName), 'Activity inspection escaped fixture scope');
    if (!timeColumns.has(tableName)) timeColumns.set(tableName, []);
    timeColumns.get(tableName).push(columnName);
  }
  for (const [tableName, columns] of timeColumns) {
    const recent = columns.map(column => `${identifier(column)}>$2`).join(' OR ');
    const rows = await tx.$queryRawUnsafe(`SELECT ${rowKeyExpression(rowKeys[tableName])} AS id FROM ${identifier(tableName)} WHERE ${rowKeyExpression(rowKeys[tableName])}=ANY($1::text[]) AND (${recent}) LIMIT 1`,
      [...owned.get(tableName)], cutoff);
    assert.equal(rows.length, 0, `${tableName} has activity within 15 minutes; stop the run and wait before cleanup`);
  }
  for (const table of ['AiTask', 'GenerationJob']) {
    const ids = [...(owned.get(table) ?? [])];
    if (!ids.length) continue;
    const rows = await tx.$queryRawUnsafe(`SELECT id FROM ${identifier(table)} WHERE id=ANY($1::text[]) AND status=ANY($2::text[]) LIMIT 1`,
      ids, ['PENDING', 'QUEUED', 'RUNNING']);
    assert.equal(rows.length, 0, `${table} still has unfinished queued work; refusing cleanup`);
  }
}

const defaultRoot = path.resolve(import.meta.dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
async function statOrNull(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertSafeDirectories(rootDir) {
  for (const relative of ['.openpbl-data', '.openpbl-data/uploads', '.openpbl-data/classrooms']) {
    const info = await statOrNull(path.join(rootDir, relative));
    if (info) assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Refusing a symlink or non-directory storage root');
  }
}

/** Plan exact bytes before database deletion; never recursively delete a new file. */
export async function prepareFilePlan(rootDir, policy, assets) {
  await assertSafeDirectories(rootDir);
  const files = [];
  async function addFile(relative) {
    const absolute = path.join(rootDir, relative), info = await statOrNull(absolute);
    if (!info) return;
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Refusing a symlink or non-regular cleanup file');
    files.push({ path: relative, sha256: digest(await readFile(absolute)), size: info.size });
  }
  for (const asset of assets) {
    assert.ok(asset.storageKey && path.basename(asset.storageKey) === asset.storageKey && !['.', '..'].includes(asset.storageKey));
    const relative = path.join('.openpbl-data/uploads', asset.storageKey);
    await addFile(relative);
    const file = files.find(row => row.path === relative);
    if (file && asset.sha256) assert.equal(file.sha256, asset.sha256, 'Upload checksum differs from its database record');
  }
  await addFile(path.join('.openpbl-data/classrooms', `${policy.classroomId}.json`));
  async function walk(relative) {
    const absolute = path.join(rootDir, relative), info = await statOrNull(absolute);
    if (!info) return;
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Refusing a symlink classroom directory');
    for (const name of await readdir(absolute)) {
      const child = path.join(relative, name), childInfo = await lstat(path.join(rootDir, child));
      assert.ok(!childInfo.isSymbolicLink(), 'Refusing a symlink inside classroom storage');
      if (childInfo.isDirectory()) await walk(child); else await addFile(child);
    }
  }
  await walk(path.join('.openpbl-data/classrooms', policy.classroomId));
  return files;
}

export function literalReferencePattern(needles) {
  assert.ok(needles.length && needles.every(value => typeof value === 'string' && value.length));
  return needles.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/** JSON/URL references do not all have foreign keys. Keep their shared bytes. */
export async function assertNoSharedReferences(db, plan, rootDir) {
  const needles = [fixturePolicy(plan, plan.kind).classroomId, ...plan.assets.flatMap(asset => [asset.id, asset.storageKey])];
  const checks = [
    ['ClassroomTemplateVersion', ['snapshot', 'mediaRefs']], ['CourseOffering', ['coverImageUrl']],
    ['ClassroomInstance', ['runtimeConfig']], ['GenerationJob', ['request', 'result', 'trace', 'qualityReport']],
  ];
  for (const [table, fields] of checks) {
    const text = fields.map(field => `coalesce(${identifier(field)}::text,'')`).join(" || ' ' || ");
    // One literal alternation evaluates the possibly large JSON projection
    // once per row, rather than reserializing it for every asset needle.
    const pattern = literalReferencePattern(needles);
    const rows = await db.$queryRawUnsafe(`/* cleanup:shared-json */ SELECT id FROM ${identifier(table)} WHERE NOT (id=ANY($1::text[]))
      AND (${text}) ~ $2 LIMIT 1`, plan.ownedIds[table] ?? [], pattern);
    assert.equal(rows.length, 0, `Retained ${table} references this run's files; refusing cleanup`);
  }
  const classroomDir = path.join(rootDir, '.openpbl-data/classrooms');
  const ownName = `${fixturePolicy(plan, plan.kind).classroomId}.json`;
  const entries = await readdir(classroomDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of entries) {
    if (!name.endsWith('.json') || name === ownName) continue;
    const filename = path.join(classroomDir, name), info = await lstat(filename);
    assert.ok(!info.isSymbolicLink(), 'Cannot verify retained classroom symlink');
    if (!info.isFile()) continue;
    const text = await readFile(filename, 'utf8');
    assert.ok(!needles.some(needle => text.includes(needle)), 'A retained classroom file references this run; refusing cleanup');
  }
}

async function atomicReceipt(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function validateReceipt(receipt, report, kind, reportDigest) {
  assert.equal(receipt.runId, report.runId, 'Cleanup receipt belongs to another run');
  assert.equal(receipt.kind, kind, 'Cleanup receipt belongs to another fixture kind');
  assert.equal(receipt.reportDigest, reportDigest, 'Cleanup receipt belongs to a different source manifest');
  assert.ok(receipt.ownedIds && Array.isArray(receipt.files) && Array.isArray(receipt.assets), 'Incomplete cleanup plan receipt');
  for (const [table, ids] of Object.entries(receipt.ownedIds)) { identifier(table); assert.ok(Array.isArray(ids)); }
}

export async function completeFileCleanup({ db, plan, rootDir = defaultRoot, receiptPath, saveReceipt = atomicReceipt }) {
  await assertSafeDirectories(rootDir);
  await assertNoSharedReferences(db, plan, rootDir);
  for (const asset of plan.assets) assert.equal(await db.fileAsset.count({ where: { OR: [{ id: asset.id }, { storageKey: asset.storageKey }] } }), 0,
    'Removed upload was referenced again; refusing file deletion');
  const policy = fixturePolicy(plan, plan.kind);
  for (const asset of plan.assets) assert.ok(typeof asset.storageKey === 'string' && asset.storageKey.length
    && path.basename(asset.storageKey) === asset.storageKey && !['.', '..'].includes(asset.storageKey), 'Unsafe upload key in cleanup receipt');
  for (const file of plan.files) {
    const upload = plan.assets.some(asset => file.path === path.join('.openpbl-data/uploads', asset.storageKey));
    const classroom = path.join('.openpbl-data/classrooms', policy.classroomId);
    assert.ok(upload || file.path === `${classroom}.json` || file.path.startsWith(`${classroom}${path.sep}`), 'Cleanup file escaped its recorded run');
    assert.ok(!file.path.split(path.sep).some(part => part === '..'), 'Unsafe cleanup file path');
    // Check every parent directory again, including nested media directories.
    for (let parent = path.dirname(file.path); parent !== '.'; parent = path.dirname(parent)) {
      const info = await statOrNull(path.join(rootDir, parent));
      if (info) assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Cleanup parent became a symlink');
    }
    const filename = path.join(rootDir, file.path), info = await statOrNull(filename);
    if (!info) continue;
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Cleanup file became a symlink');
    assert.equal(digest(await readFile(filename)), file.sha256, 'Cleanup file changed after its deletion plan');
    await unlink(filename);
  }
  async function removeEmpty(relative) {
    const filename = path.join(rootDir, relative), info = await statOrNull(filename);
    if (!info) return;
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Classroom directory became a symlink');
    for (const child of await readdir(filename)) {
      const childInfo = await lstat(path.join(filename, child));
      assert.ok(childInfo.isDirectory() && !childInfo.isSymbolicLink(), 'Unplanned file remains; refusing recursive deletion');
      await removeEmpty(path.join(relative, child));
    }
    await rmdir(filename);
  }
  await removeEmpty(path.join('.openpbl-data/classrooms', policy.classroomId));
  plan.filesDeleted = true;
  await saveReceipt(receiptPath, plan);
  return plan;
}

/** Importable orchestration supports restored, isolated databases and file roots. */
export async function cleanupCapacityRun({ db, report, kind = report.kind ?? 'classroom-capacity', rootDir = defaultRoot,
  receiptPath, abortedRun, execute = false, now = Date.now(), transaction, saveReceipt = atomicReceipt }) {
  report = structuredClone(report);
  if (report.reconstructedCleanup) {
    const source = report.reconstructedCleanup;
    report = await loadReconstructedCleanup({ type: source.type, purpose: source.purpose, runId: report.runId,
      originalReportMissing: source.originalReportMissing, originalReportSha256: source.originalReportSha256,
      inventoryPath: source.inventoryPath, inventorySha256: source.inventorySha256 }, rootDir, abortedRun);
    fixturePolicy(report, kind);
  } else validateReport(report, abortedRun, kind);
  const reportDigest = digest(JSON.stringify(report));
  const transact = transaction ?? (work => db.$transaction(work, { isolationLevel: 'Serializable', timeout: 60000 }));
  assert.ok(!execute || receiptPath, 'Execution requires a durable receipt path');
  const previous = execute ? await readFile(receiptPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  if (previous) {
    validateReceipt(previous, report, kind, reportDigest);
    const recovered = await transact(async tx => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', report.runId);
      let remaining = 0, planned = 0;
      for (const [table, ids] of Object.entries(previous.ownedIds)) {
        planned += ids.length;
        if (ids.length) remaining += (await tx.$queryRawUnsafe(`SELECT ${rowKeyExpression(previous.rowKeys?.[table])} AS id FROM ${identifier(table)} WHERE ${rowKeyExpression(previous.rowKeys?.[table])}=ANY($1::text[])`, ids)).length;
      }
      assert.ok(remaining === 0 || remaining === planned, 'Cleanup plan rows only partially survive; refusing retry');
      if (remaining) { assert.equal(previous.databaseDeleted, false, 'Previously deleted rows reappeared'); return null; }
      for (const [table, field] of [['User', 'username'], ['CourseOffering', 'description']]) {
        const condition = field === 'username' ? 'starts_with("username", $1)' : '"description"=$1';
        assert.equal((await tx.$queryRawUnsafe(`SELECT id FROM ${identifier(table)} WHERE ${condition} LIMIT 1`, field === 'username' ? `${report.runId}-` : report.runId)).length, 0,
          'A root was recreated after the database cleanup');
      }
      previous.databaseDeleted = true;
      return previous;
    });
    if (recovered) {
      await saveReceipt(receiptPath, recovered);
      return completeFileCleanup({ db, plan: recovered, rootDir, receiptPath, saveReceipt });
    }
  }
  const result = await transact(tx => planAndDelete(tx, report, execute, kind, { now, beforeDelete: async (plan, scopedDb) => {
    plan.reportDigest = reportDigest;
    plan.files = await prepareFilePlan(rootDir, fixturePolicy(report, kind), plan.assets);
    await assertNoSharedReferences(scopedDb, plan, rootDir);
    if (execute) await saveReceipt(receiptPath, plan);
  } }));
  if (!execute) return result;
  await saveReceipt(receiptPath, result);
  return completeFileCleanup({ db, plan: result, rootDir, receiptPath, saveReceipt });
}

async function main() {
  const args = process.argv.slice(2), reportPath = args.find(arg => !arg.startsWith('--'));
  assert.ok(reportPath, 'Usage: node scripts/cleanup-capacity-run.mjs REPORT.json [--kind=projection-contention] [--execute] [--abort-run=capacity-UUID] [--reconstructed-cleanup-manifest] [--plan=PATH]');
  const input = JSON.parse(await readFile(reportPath, 'utf8'));
  const reconstructed = args.includes('--reconstructed-cleanup-manifest');
  const abortedRun = args.find(arg => arg.startsWith('--abort-run='))?.slice('--abort-run='.length);
  assert.ok(reconstructed || input.type !== 'reconstructed-cleanup-manifest', 'Reconstructed cleanup requires its explicit mode flag');
  const report = reconstructed ? await loadReconstructedCleanup(input, defaultRoot, abortedRun) : input;
  const kind = args.find(arg => arg.startsWith('--kind='))?.slice('--kind='.length) ?? (reconstructed ? report.kind : 'classroom-capacity');
  if (reconstructed) fixturePolicy(report, kind); else validateReport(report, abortedRun, kind);
  const execute = args.includes('--execute');
  const receiptPath = path.join(path.dirname(path.resolve(reportPath)), reconstructed ? `${report.runId}-reconstructed-cleanup.json` : 'cleanup.json');
  const databaseUrl = process.env.CAPACITY_DATABASE_URL || (await readFile(path.join(defaultRoot, 'deploy/secrets/database_url.txt'), 'utf8')).trim();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const result = await cleanupCapacityRun({ db, report, kind, receiptPath, abortedRun, execute });
    const planPath = args.find(arg => arg.startsWith('--plan='))?.slice('--plan='.length);
    if (planPath) {
      assert.notEqual(path.resolve(planPath), path.resolve(reportPath), 'A plan must not overwrite its source report');
      assert.notEqual(path.resolve(planPath), receiptPath, 'A preview plan must not overwrite its execution receipt');
      await atomicReceipt(path.resolve(planPath), result);
    }
    console.log(JSON.stringify({ runId: result.runId, kind, dryRun: !execute, counts: result.counts, uploads: result.assets.length,
      ...(result.reconstructedCleanup ? { reconstructedCleanup: result.reconstructedCleanup } : {}) }));
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
