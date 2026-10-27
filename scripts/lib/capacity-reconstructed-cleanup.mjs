/** Inventory-backed deletion scope only: never a replacement performance/ACK report. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
export const INVENTORY_RELATIVE = '.openpbl-data/capacity-evidence/historical-cleanup/preserved-inventory.json';
const historicalInventoryRelative = 'docs/audits/2026-09-27-classroom-remediation/pending-fixture-cleanup.json';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
export function reconstructedCleanupScope(manifest, inventoryBytes, abortedRun) {
  assert.equal(manifest.type, 'reconstructed-cleanup-manifest');
  assert.equal(manifest.originalReportMissing, true);
  assert.equal(manifest.purpose, 'cleanup-only');
  assert.ok([INVENTORY_RELATIVE, historicalInventoryRelative].includes(manifest.inventoryPath), 'Unexpected inventory provenance path');
  assert.equal(manifest.inventorySha256, hash(inventoryBytes), 'Inventory checksum differs');
  assert.equal(abortedRun, manifest.runId, 'Require exact --abort-run');
  assert.match(manifest.runId?.slice(9) ?? '', uuid); assert.ok(manifest.runId.startsWith('capacity-'));
  for (const key of ['expected', 'checks', 'metrics', 'performance', 'acknowledgements', 'fixture']) assert.equal(manifest[key], undefined, 'Do not supply reconstructed business evidence');
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.readOnly, true);
  const entries = inventory.pending.filter(row => row.runId === manifest.runId);
  assert.equal(entries.length, 1, 'Run must occur exactly once in preserved inventory');
  const row = entries[0];
  assert.equal(row.reportSha256, manifest.originalReportSha256); assert.match(row.reportSha256, /^[0-9a-f]{64}$/);
  assert.ok(['classroom-capacity', 'projection-contention'].includes(row.kind));
  assert.ok(['failed', 'partial', 'latency-failed', 'measured'].includes(row.outcome));
  assert.equal(row.cleanupStatus, 'pending-not-executed'); assert.equal(row.cleanupReceipt, null);
  assert.deepEqual(row.ownershipIssues, []);
  assert.equal(row.report, `test-results/capacity/${row.runId}/report.json`);
  const fixture = {};
  for (const [name, field] of [['offering','offeringId'], ['template','templateId'], ['instance','instanceId'], ['chapter','chapterId'], ['activity','activityId'], ['survey','surveyId'], ['lectureAudio','lectureAudioId']]) {
    const entity = row.entities[name];
    if (!entity && ['survey', 'lectureAudio'].includes(name)) continue;
    assert.equal(entity?.exists, true); assert.equal(entity?.ownershipMatches, true); assert.match(entity.id, uuid); fixture[field] = entity.id;
  }
  fixture.userIds = row.entities.users.map(user => { assert.equal(user.exists, true); assert.equal(user.ownershipMatches, true); assert.match(user.id, uuid); return user.id; });
  assert.equal(new Set(fixture.userIds).size, fixture.userIds.length);
  assert.ok(row.kind === 'projection-contention' ? fixture.userIds.length === 42 : fixture.userIds.length >= 3 && fixture.userIds.length <= 42);
  fixture.classroomId = `${row.runId}-${row.kind === 'projection-contention' ? 'projection-load' : 'lesson'}`;
  assert.equal(row.classroomFile.id, fixture.classroomId);
  return { runId: row.runId, kind: row.kind, fixture, reconstructedCleanup: {
    type: manifest.type, purpose: manifest.purpose, originalReportMissing: true,
    inventoryPath: manifest.inventoryPath, preservedInventoryPath: INVENTORY_RELATIVE, inventorySha256: manifest.inventorySha256,
    originalReportSha256: row.reportSha256, historicalOutcome: row.outcome,
    businessEvidenceRecovered: false,
  } };
}
export async function loadReconstructedCleanup(manifest, root, abortedRun) {
  const report = reconstructedCleanupScope(manifest, await readFile(path.join(root, INVENTORY_RELATIVE)), abortedRun);
  for (const base of ['test-results/capacity', '.openpbl-data/capacity-evidence']) {
    const file = path.join(root, base, report.runId, 'report.json');
    try { await lstat(file); assert.fail('Original report exists; use the normal report mode'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return report;
}
export function reconstructedUserOrder(report, users) {
  assert.deepEqual(users.map(user => user.id).sort(), [...report.fixture.userIds].sort(), 'All inventory users must still exist exactly');
  const ordered = [];
  const prefix = `${report.runId}-${report.kind === 'projection-contention' ? 'projection-' : ''}`;
  for (const user of users) {
    assert.equal(user.usernameKey, user.username); assert.ok(user.username.startsWith(prefix));
    const suffix = user.username.slice(prefix.length); assert.match(suffix, /^(0|[1-9][0-9]*)$/);
    const index = Number(suffix); assert.ok(index < users.length && !ordered[index], 'User indices must be unique and bounded');
    assert.equal(user.role, index < 2 ? 'TEACHER' : 'STUDENT'); ordered[index] = user.id;
  }
  assert.equal(ordered.filter(Boolean).length, users.length); return ordered;
}
export function validateReconstructedOwnedRoots(report, owned) {
  for (const [table, ids] of [
    ['CourseOffering', [report.fixture.offeringId]], ['ClassroomTemplate', [report.fixture.templateId]],
    ['ClassroomInstance', [report.fixture.instanceId]], ['Chapter', [report.fixture.chapterId]],
    ['Activity', [report.fixture.activityId, report.fixture.surveyId].filter(Boolean)], ['User', report.fixture.userIds],
  ]) assert.deepEqual([...(owned.get(table) ?? [])].sort(), [...ids].sort(), `Reconstructed scope differs for ${table}`);
  if (report.fixture.lectureAudioId) assert.ok(owned.get('FileAsset')?.has(report.fixture.lectureAudioId), 'Teacher lecture asset missing from fixture closure');
}
