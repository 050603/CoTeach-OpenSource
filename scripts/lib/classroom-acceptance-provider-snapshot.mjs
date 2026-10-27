import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const fingerprint = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const selection = { where: { ownerId: null }, orderBy: { id: 'asc' } };

/** Preserve encrypted credentials AND application-specific model/voice settings.
 * The source transaction is read-only. Only the disposable target is written.
 */
export async function snapshotAcceptanceProviders(source, target) {
  const rows = await source.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return tx.providerCredential.findMany(selection);
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
  assert.ok(rows.length && rows.every(row => row.ownerId === null), 'A global provider configuration snapshot is required');
  assert.equal(await target.providerCredential.count(), 0, 'Provider snapshot target must be the empty disposable database');
  await target.providerCredential.createMany({ data: rows.map(row => {
    // Omitting a nullable JSON column preserves SQL NULL across Prisma inputs.
    const data = { ...row };
    if (data.config === null) delete data.config;
    return data;
  }) });
  const restored = await target.providerCredential.findMany(selection);
  const sourceSha256 = fingerprint(rows); const targetSha256 = fingerprint(restored);
  assert.equal(targetSha256, sourceSha256, 'The isolated provider/settings snapshot differs from its read-only source');
  return { rows: rows.length, sections: [...new Set(rows.map(row => row.name))].sort(),
    sha256: sourceSha256, targetSha256,
    source: 'read-only-deployed-configuration', target: 'disposable-database', encryptedSecrets: true };
}
