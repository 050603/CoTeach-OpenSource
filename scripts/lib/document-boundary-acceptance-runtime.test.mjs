import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveDocumentAcceptanceRuntime } from './document-boundary-acceptance-runtime.mjs';
import { documentBrowserAssets } from './production-assets.mjs';

test('acceptance copies the validated immutable release including its own browser assets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'document-acceptance-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'ready-build_123'; const release = path.join(root, '.openpbl-runtime', 'releases', id);
  await mkdir(path.join(release, '.next-build'), { recursive: true });
  await Promise.all([writeFile(path.join(release, 'server.js'), '// synthetic runtime'),
    writeFile(path.join(release, '.release-ready'), `${id}\n`), writeFile(path.join(release, '.next-build', 'BUILD_ID'), id)]);
  for (const asset of documentBrowserAssets) {
    const file = path.join(release, 'public', asset);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '// synthetic browser asset');
  }
  assert.deepEqual(await resolveDocumentAcceptanceRuntime(root, { releaseId: id, buildDir: 'mutable-stage' }),
    { source: release, buildDir: '.next-build', buildId: id, sourceKind: 'prepared-release' });
  await writeFile(path.join(release, '.release-ready'), 'other-build');
  await assert.rejects(resolveDocumentAcceptanceRuntime(root, { releaseId: id }), /不一致|Production release ready marker is invalid/);
  await rm(path.join(release, '.release-ready'));
  await assert.rejects(resolveDocumentAcceptanceRuntime(root, { releaseId: id }));
});

test('acceptance rejects arbitrary release paths, aliases and explicit empty identities', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'document-acceptance-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ['', '/tmp/runtime', '../escape', 'build/name']) {
    await assert.rejects(resolveDocumentAcceptanceRuntime(root, { releaseId: id }));
  }
  const releases = path.join(root, '.openpbl-runtime', 'releases');
  await mkdir(releases, { recursive: true });
  await symlink(root, path.join(releases, 'alias'));
  await assert.rejects(resolveDocumentAcceptanceRuntime(root, { releaseId: 'alias' }), /固定 releases/);
  assert.deepEqual(await resolveDocumentAcceptanceRuntime(root),
    { source: path.join(root, '.next-build', 'standalone'), buildDir: '.next-build', buildId: null, sourceKind: 'build-standalone' });
  await assert.rejects(resolveDocumentAcceptanceRuntime(root, { buildDir: '/tmp/standalone' }));
});
