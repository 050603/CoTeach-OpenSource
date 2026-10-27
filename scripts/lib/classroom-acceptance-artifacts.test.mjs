import test from 'node:test';
import assert from 'node:assert/strict';
import { assertArtifactReplay } from './classroom-acceptance-artifacts.mjs';

test('replaying an upload retains the acknowledged immutable version and submission time', () => {
  const accepted = { versionId: 'version-1', uploadId: 'upload-1', sequence: 1, requestId: 'request-1', submittedAt: '2026-10-16T00:00:00Z' };
  assertArtifactReplay(accepted, { ...accepted });
  for (const key of ['versionId', 'uploadId', 'sequence', 'requestId', 'submittedAt']) {
    assert.throws(() => assertArtifactReplay(accepted, { ...accepted, [key]: key === 'sequence' ? 2 : 'changed' }), /Artifact replay changed/);
  }
  assert.throws(() => assertArtifactReplay({}, {}), /Original artifact receipt lacks/);
});
