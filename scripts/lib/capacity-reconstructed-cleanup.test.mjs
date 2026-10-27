import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconstructedCleanupScope, loadReconstructedCleanup, reconstructedUserOrder, validateReconstructedOwnedRoots, INVENTORY_RELATIVE } from './capacity-reconstructed-cleanup.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const runId = `capacity-${id(1)}`;
const inventoryPath = 'docs/audits/2026-09-27-classroom-remediation/pending-fixture-cleanup.json';
function fixture(kind = 'classroom-capacity') {
  const entity = n => ({ id: id(n), exists: true, ownershipMatches: true });
  const count = kind === 'projection-contention' ? 42 : 4;
  const row = { runId, kind, outcome: kind === 'projection-contention' ? 'latency-failed' : 'partial', report: `test-results/capacity/${runId}/report.json`, reportSha256: 'a'.repeat(64), cleanupStatus: 'pending-not-executed', cleanupReceipt: null, ownershipIssues: [],
    entities: { offering: entity(10), template: entity(11), instance: entity(12), chapter: entity(13), activity: entity(14), survey: kind === 'classroom-capacity' ? entity(15) : null, lectureAudio: entity(16), users: Array.from({length: count}, (_, i) => entity(100+i)) },
    classroomFile: { id: `${runId}-${kind === 'projection-contention' ? 'projection-load' : 'lesson'}` } };
  const inventory = { readOnly: true, pending: [row] };
  const bytes = Buffer.from(JSON.stringify(inventory));
  const manifest = { type: 'reconstructed-cleanup-manifest', purpose: 'cleanup-only', runId, originalReportMissing: true, originalReportSha256: row.reportSha256, inventoryPath, inventorySha256: createHash('sha256').update(bytes).digest('hex') };
  return { row, inventory, bytes, manifest };
}
test('inventory-only scope preserves missing-report provenance without recovering ACKs or performance', () => {
  for (const kind of ['classroom-capacity', 'projection-contention']) {
    const { manifest, bytes } = fixture(kind); const scope = reconstructedCleanupScope(manifest, bytes, runId);
    assert.equal(scope.kind, kind); assert.equal(scope.reconstructedCleanup.businessEvidenceRecovered, false);
    assert.equal(scope.expected, undefined); assert.equal(scope.outcome, undefined); assert.equal(scope.checks, undefined);
  }
});
test('rejects incorrect evidence mode, hashes, source, acknowledgements and abort UUID', () => {
  const { manifest, bytes } = fixture();
  for (const [key, value] of Object.entries({ type: 'report', purpose: 'performance', originalReportMissing: false, inventoryPath: '../other.json', inventorySha256: 'b'.repeat(64), originalReportSha256: 'c'.repeat(64), expected: {}, fixture: {}, runId: `capacity-${id(999)}` })) {
    assert.throws(() => reconstructedCleanupScope({ ...manifest, [key]: value }, bytes, runId));
  }
  assert.throws(() => reconstructedCleanupScope(manifest, bytes));
});
test('rejects inventories with missing roots/users, changed ownership, duplicate run or nonterminal state', () => {
  for (const change of [row => { delete row.entities.offering; }, row => { row.entities.users[0].ownershipMatches = false; }, row => { row.entities.users.push(row.entities.users[0]); }, row => { row.outcome = 'running'; }, row => { row.cleanupReceipt = {}; }, row => { row.ownershipIssues.push('mismatch'); }]) {
    const { inventory, manifest } = fixture(); change(inventory.pending[0]); const bytes = Buffer.from(JSON.stringify(inventory));
    manifest.inventorySha256 = createHash('sha256').update(bytes).digest('hex'); assert.throws(() => reconstructedCleanupScope(manifest, bytes, runId));
  }
  const { inventory, manifest } = fixture(); inventory.pending.push(inventory.pending[0]); const bytes = Buffer.from(JSON.stringify(inventory));
  manifest.inventorySha256 = createHash('sha256').update(bytes).digest('hex'); assert.throws(() => reconstructedCleanupScope(manifest, bytes, runId));
});
test('requires all users, exact indexed names and roles, independent of inventory array order', () => {
  for (const kind of ['classroom-capacity', 'projection-contention']) {
    const { manifest, bytes } = fixture(kind); const scope = reconstructedCleanupScope(manifest, bytes, runId);
    const users = scope.fixture.userIds.map((value,i) => ({ id:value, username:`${runId}-${kind === 'projection-contention' ? 'projection-' : ''}${i}`, usernameKey:`${runId}-${kind === 'projection-contention' ? 'projection-' : ''}${i}`, role:i < 2 ? 'TEACHER' : 'STUDENT' }));
    assert.deepEqual(reconstructedUserOrder(scope, [...users].reverse()), scope.fixture.userIds);
    assert.throws(() => reconstructedUserOrder(scope, users.slice(1)));
    assert.throws(() => reconstructedUserOrder(scope, users.map((u,i) => i ? u : {...u,role:'STUDENT'})));
    assert.throws(() => reconstructedUserOrder(scope, users.map((u,i) => i ? u : {...u,username:`${runId}-foreign`})));
  }
});
test('owned closure cannot add another root or omit recorded lecture asset', () => {
  const { manifest, bytes } = fixture(); const scope = reconstructedCleanupScope(manifest, bytes, runId); const f = scope.fixture;
  const owned = new Map([['CourseOffering',new Set([f.offeringId])],['ClassroomTemplate',new Set([f.templateId])],['ClassroomInstance',new Set([f.instanceId])],['Chapter',new Set([f.chapterId])],['Activity',new Set([f.activityId,f.surveyId])],['User',new Set(f.userIds)],['FileAsset',new Set([f.lectureAudioId])]]);
  validateReconstructedOwnedRoots(scope, owned); owned.get('Activity').add(id(999)); assert.throws(() => validateReconstructedOwnedRoots(scope, owned));
  owned.get('Activity').delete(id(999)); owned.get('FileAsset').clear(); assert.throws(() => validateReconstructedOwnedRoots(scope, owned));
});
test('mode rejects either existing original report path instead of substituting inventory evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'cleanup-inventory-test-')); t.after(() => rm(root,{recursive:true,force:true}));
  const { manifest, bytes } = fixture(); await mkdir(path.dirname(path.join(root,INVENTORY_RELATIVE)),{recursive:true}); await writeFile(path.join(root,INVENTORY_RELATIVE),bytes);
  await loadReconstructedCleanup(manifest,root,runId);
  for (const base of ['test-results/capacity','.openpbl-data/capacity-evidence']) {
    const filename=path.join(root,base,runId,'report.json');await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,'{}');
    await assert.rejects(loadReconstructedCleanup(manifest,root,runId), /Original report exists/);await rm(filename);
  }
});
