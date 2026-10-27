import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createMonacoBrowserBundle, publishMonacoBrowserBundle, verifyMonacoBrowserBundle } from './monaco-browser-bundle.mjs';

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, 'src/lib/browser/monaco-runtime-manifest.json'), 'utf8'));
const source = path.join(root, 'node_modules/monaco-editor/min/vs');

test('actual source-bound 104-module bundle preserves named AMD order and rejects changed source', async t => {
  const { bytes, metadata } = await createMonacoBrowserBundle(source, manifest);
  assert.equal(metadata.moduleCount, 104); assert.equal(bytes.length, metadata.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.bundleSha256);
  assert.equal(metadata.originalSourceTreeSha256, manifest.treeSha256);
  const temporary = await mkdtemp(path.join(tmpdir(), 'monaco-bundle-source-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(source, temporary, { recursive: true });
  await writeFile(path.join(temporary, 'json.worker-BizpAl9O.js'), 'define("wrong",[],function(){});');
  await assert.rejects(createMonacoBrowserBundle(temporary, manifest), /module changed/);
  await assert.rejects(createMonacoBrowserBundle(source, { ...manifest, treeSha256: 'a'.repeat(64) }), /source tree differs/);
});

test('separate published bundle verifies all representations and rejects corruption/extra files/manifest drift', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'monaco-bundle-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await publishMonacoBrowserBundle(directory, source, manifest);
  const metadata = await verifyMonacoBrowserBundle(directory, manifest);
  const target = path.join(directory, 'bundles', metadata.bundleSha256);
  const file = path.join(target, 'encoded/br/editor.main.js'); const original = await readFile(file);
  await writeFile(file, Buffer.from('invalid encoding'));
  await assert.rejects(verifyMonacoBrowserBundle(directory, manifest)); await writeFile(file, original);
  await mkdir(path.join(target, 'unexpected'));
  await writeFile(path.join(target, 'unexpected/extra.js'), 'extra');
  await assert.rejects(verifyMonacoBrowserBundle(directory, manifest)); await rm(path.join(target, 'unexpected'), { recursive: true });
  await rename(path.join(directory, 'bundles'), path.join(directory, 'saved-bundles'));
  await symlink(path.join(directory, 'saved-bundles'), path.join(directory, 'bundles'));
  await assert.rejects(verifyMonacoBrowserBundle(directory, manifest), /must not be a link/);
  await rm(path.join(directory, 'bundles')); await rename(path.join(directory, 'saved-bundles'), path.join(directory, 'bundles'));
  await writeFile(path.join(directory, 'browser-bundle-manifest.json'), JSON.stringify({ ...metadata, algorithm: 'changed' }));
  await assert.rejects(verifyMonacoBrowserBundle(directory, manifest), /manifest differs/);
});
