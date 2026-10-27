import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotAcceptanceProviders } from './classroom-acceptance-provider-snapshot.mjs';

function fixture() {
  const rows = [{ id: 'credential', ownerId: null, name: 'providers', provider: 'configured', secret: 'encrypted-envelope', config: { defaultModel: 'actual-model' } },
    { id: 'tutor-settings', ownerId: null, name: 'knowledge-lecture', provider: 'tutor', secret: '', config: { modelString: 'configured:actual-tutor', ttsVoice: 'actual-voice' } }];
  let readOnly = false; let stored = [];
  const source = { $transaction: async (operation, options) => {
    assert.equal(options.isolationLevel, 'RepeatableRead');
    return operation({ $executeRaw: async statement => { assert.equal(statement.join(''), 'SET TRANSACTION READ ONLY'); readOnly = true; },
      providerCredential: { findMany: async ({ where }) => { assert.ok(readOnly); assert.deepEqual(where, { ownerId: null }); return structuredClone(rows); } } });
  } };
  const target = { providerCredential: { count: async () => stored.length,
    createMany: async ({ data }) => { stored = structuredClone(data); }, findMany: async () => structuredClone(stored) } };
  return { rows, source, target, stored: () => stored };
}

test('copies actual model/voice settings and encrypted credentials from a read-only source without exposing their values', async () => {
  const f = fixture(); const result = await snapshotAcceptanceProviders(f.source, f.target);
  assert.deepEqual(f.stored(), f.rows);
  assert.equal(result.rows, 2); assert.equal(result.sha256, result.targetSha256);
  assert.deepEqual(result.sections, ['knowledge-lecture', 'providers']);
  for (const value of ['encrypted-envelope', 'actual-model', 'actual-tutor', 'actual-voice']) assert.ok(!JSON.stringify(result).includes(value));
});

test('refuses an existing target before writing any credentials', async () => {
  const f = fixture(); let written = false;
  f.target.providerCredential.count = async () => 1;
  f.target.providerCredential.createMany = async () => { written = true; };
  await assert.rejects(snapshotAcceptanceProviders(f.source, f.target), /empty disposable database/);
  assert.equal(written, false);
});

test('cannot certify an incomplete settings copy', async () => {
  const f = fixture(); f.target.providerCredential.findMany = async () => f.rows.slice(0, 1);
  await assert.rejects(snapshotAcceptanceProviders(f.source, f.target), /snapshot differs/);
});
