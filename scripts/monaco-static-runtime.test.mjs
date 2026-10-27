import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { inspectMonacoTree, monacoManifestPath, publishMonacoRuntime, verifyMonacoRuntimeArtifact } from './monaco-static-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monaco-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  const source = path.join(packageRoot, 'min/vs');
  await mkdir(path.join(source, 'base/worker'), { recursive: true });
  await mkdir(path.join(source, 'nls/lang'), { recursive: true });
  await mkdir(path.join(source, 'editor'), { recursive: true });
  await writeFile(path.join(source, 'loader.js'), 'define("loader");');
  await writeFile(path.join(source, 'base/worker/workerMain.js'), 'self.onmessage = () => {};');
  await writeFile(path.join(source, 'nls/lang/zh-cn.js'), 'globalThis.locale = "zh-cn";');
  await writeFile(path.join(source, 'editor/editor.main.js'), 'define("vs/editor/editor.main",["exports"],function(e){e.editor={};});');
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'monaco-editor', version: '0.56.0' }));
  const manifest = { schemaVersion: 1, package: 'monaco-editor', version: '0.56.0', source: 'min/vs', treeHashAlgorithm: 'sha256-path-size-content-v1', ...await inspectMonacoTree(source) };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const distDir = path.join(root, 'build');
  return { root, source, manifest, packageRoot, manifestPath, distDir };
}

test('pins the entire installed browser package and exact dependency version', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(monacoManifestPath, 'utf8'));
  const dependency = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(path.join(root, 'node_modules/monaco-editor/package.json'), 'utf8'));
  assert.equal(dependency.dependencies['monaco-editor'], manifest.version);
  assert.equal(installed.version, manifest.version);
  assert.deepEqual(await inspectMonacoTree(path.join(root, 'node_modules/monaco-editor/min/vs')), {
    treeSha256: manifest.treeSha256, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes,
  });
  assert.equal(manifest.fileCount, 151);
});

test('all 151 installed browser files have verified offline encodings in the copied release', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'monaco-full-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const built = path.join(directory, 'build'); const released = path.join(directory, 'release');
  const source = await publishMonacoRuntime({ distDir: built });
  await cp(path.join(built, 'static'), path.join(released, 'static'), { recursive: true });
  assert.deepEqual(await verifyMonacoRuntimeArtifact(released, source), source);
  const encoded = JSON.parse(await readFile(path.join(released, 'static/openpbl-runtime/monaco/encoded-manifest.json'), 'utf8'));
  assert.equal(Object.keys(encoded.files).length, 151);
  const largeJavascript = Object.entries(encoded.files).filter(([name]) => name.endsWith('.js')).sort((a, b) => b[1].identity.bytes - a[1].identity.bytes)[0][1];
  assert.ok(largeJavascript.identity.bytes > 2 * 1024 * 1024);
  assert.ok(largeJavascript.br.bytes < largeJavascript.identity.bytes);
  assert.ok(largeJavascript.gzip.bytes < largeJavascript.identity.bytes);
  const bundle = JSON.parse(await readFile(path.join(released, 'static/openpbl-runtime/monaco/browser-bundle-manifest.json'), 'utf8'));
  assert.equal(bundle.originalSourceTreeSha256, source.treeSha256);
  assert.equal(bundle.moduleCount, 104);
  await rm(path.join(released, 'static/openpbl-runtime/monaco/bundles', bundle.bundleSha256, 'vs/editor.main.js'));
  await assert.rejects(verifyMonacoRuntimeArtifact(released, source), /ENOENT|deep-equal|equal/);
});

test('publishes complete nested files atomically; static snapshot survives package/workspace changes', async t => {
  const f = await fixture(t);
  await publishMonacoRuntime(f);
  const artifact = path.join(f.distDir, 'static/openpbl-runtime/monaco');
  assert.deepEqual(await readdir(path.dirname(artifact)), ['monaco']);
  assert.equal(await readFile(path.join(artifact, f.manifest.version, f.manifest.treeSha256, 'vs/base/worker/workerMain.js'), 'utf8'), 'self.onmessage = () => {};');
  // Production prepare, acceptance isolation and Docker all copy this subtree.
  const release = path.join(f.root, 'release');
  await cp(path.join(f.distDir, 'static'), path.join(release, 'static'), { recursive: true });
  await writeFile(path.join(f.source, 'loader.js'), 'new package contents');
  await rm(f.manifestPath);
  assert.deepEqual(await verifyMonacoRuntimeArtifact(release, f.manifest), f.manifest);
  assert.deepEqual(await verifyMonacoRuntimeArtifact(f.distDir), f.manifest);
});

for (const mutation of ['content', 'missing', 'extra', 'rename', 'symlink', 'version']) {
  test(`rejects unreviewed ${mutation} before publishing any artifact`, async t => {
    const f = await fixture(t);
    const loader = path.join(f.source, 'loader.js');
    if (mutation === 'content') await writeFile(loader, 'changed');
    if (mutation === 'missing') await rm(loader);
    if (mutation === 'extra') await writeFile(path.join(f.source, 'new.js'), 'new');
    if (mutation === 'rename') { await cp(loader, path.join(f.source, 'renamed.js')); await rm(loader); }
    if (mutation === 'symlink') { await rm(loader); await symlink('nls/lang/zh-cn.js', loader); }
    if (mutation === 'version') await writeFile(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'monaco-editor', version: '0.56.1' }));
    await assert.rejects(publishMonacoRuntime(f), /Monaco/);
    await assert.rejects(readdir(f.distDir), { code: 'ENOENT' });
  });
}

test('repeat generation is idempotent; damaged existing artifact is never silently repaired', async t => {
  const f = await fixture(t);
  await publishMonacoRuntime(f);
  assert.deepEqual(await publishMonacoRuntime(f), f.manifest);
  const loader = path.join(f.distDir, 'static/openpbl-runtime/monaco', f.manifest.version, f.manifest.treeSha256, 'vs/loader.js');
  await writeFile(loader, 'corruption');
  await assert.rejects(verifyMonacoRuntimeArtifact(f.distDir), /differs/);
  await assert.rejects(publishMonacoRuntime(f), /differs/);
  assert.equal(await readFile(loader, 'utf8'), 'corruption');
});

test('missing artifact or different build provenance prevents release acceptance', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyMonacoRuntimeArtifact(f.distDir), { code: 'ENOENT' });
  await publishMonacoRuntime(f);
  await assert.rejects(verifyMonacoRuntimeArtifact(f.distDir, { ...f.manifest, treeSha256: 'a'.repeat(64) }), /differs from its build/);
  await rm(path.join(f.distDir, 'static/openpbl-runtime/monaco/manifest.json'));
  await assert.rejects(publishMonacoRuntime(f), { code: 'ENOENT' });
});

test('malformed manifest paths cannot escape the versioned browser artifact', async t => {
  const f = await fixture(t);
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, version: '../private' }));
  await assert.rejects(publishMonacoRuntime(f), /Invalid Monaco/);
});

test('offline gzip/br are deterministic and decode to every unchanged source file', async t => {
  const f = await fixture(t); await publishMonacoRuntime(f);
  const base = path.join(f.distDir, 'static/openpbl-runtime/monaco');
  const encoded = JSON.parse(await readFile(path.join(base, 'encoded-manifest.json'), 'utf8'));
  assert.equal(encoded.sourceTreeSha256, f.manifest.treeSha256);
  assert.equal(Object.keys(encoded.files).length, f.manifest.fileCount);
  const second = path.join(f.root, 'second'); await publishMonacoRuntime({ ...f, distDir: second });
  for (const name of Object.keys(encoded.files)) {
    const original = await readFile(path.join(f.source, name));
    for (const encoding of ['br', 'gzip']) {
      const relative = path.join('static/openpbl-runtime/monaco/encoded', f.manifest.treeSha256, encoding, name);
      const bytes = await readFile(path.join(f.distDir, relative));
      assert.deepEqual(bytes, await readFile(path.join(second, relative)));
      assert.deepEqual(encoding === 'br' ? brotliDecompressSync(bytes) : gunzipSync(bytes), original);
    }
  }
});

for (const mutation of ['corrupt', 'missing', 'extra', 'symlink', 'metadata']) {
  test(`release rejects ${mutation} encoded representation even when original source hash is intact`, async t => {
    const f = await fixture(t); await publishMonacoRuntime(f);
    const base = path.join(f.distDir, 'static/openpbl-runtime/monaco');
    const target = path.join(base, 'encoded', f.manifest.treeSha256, 'br/loader.js');
    if (mutation === 'corrupt') await writeFile(target, 'bad');
    if (mutation === 'missing') await rm(target);
    if (mutation === 'extra') await writeFile(`${target}.extra`, 'extra');
    if (mutation === 'symlink') { await rm(target); await symlink(path.join(f.source, 'loader.js'), target); }
    if (mutation === 'metadata') {
      const location = path.join(base, 'encoded-manifest.json'); const value = JSON.parse(await readFile(location, 'utf8'));
      value.files['loader.js'].identity.sha256 = '0'.repeat(64); await writeFile(location, JSON.stringify(value));
    }
    await assert.rejects(verifyMonacoRuntimeArtifact(f.distDir));
    await assert.rejects(publishMonacoRuntime(f));
  });
}

for (const exitCode of [0, 2]) {
  test(`build wrapper publishes only after successful child exit (simulated Next exit ${exitCode})`, async t => {
    const f = await fixture(t);
    const repository = fileURLToPath(new URL('../', import.meta.url));
    await mkdir(path.join(f.root, 'scripts/lib'), { recursive: true });
    await cp(path.join(repository, 'scripts/lib/http-upstream-policy.mjs'), path.join(f.root, 'scripts/lib/http-upstream-policy.mjs'));
    await cp(path.join(repository, 'scripts/lib/monaco-browser-bundle.mjs'), path.join(f.root, 'scripts/lib/monaco-browser-bundle.mjs'));
    await cp(path.join(repository, 'scripts/run-production-task.mjs'), path.join(f.root, 'scripts/run-production-task.mjs'));
    await writeFile(path.join(f.root, 'scripts/lib/production-assets.mjs'), 'export async function snapshotProductionAssets() {} export async function verifyBuildAssetSnapshot() {} export async function verifyProductionAssets() {} export async function retainPdfRuntimeVersions() {} export async function writeReleaseAssetManifest() {} export async function writeReleaseReady() {} export async function verifyReleaseReady() {}');
    // This fixture verifies child-exit publication ordering only. Real worker
    // artifact/Prisma isolation has its own native tests; no fake proof here.
    await writeFile(path.join(f.root, 'scripts/check-course-read-worker.mjs'), 'export async function verifyCourseReadWorkerRuntime(){throw new Error("unexpected start/prepare in build fixture");}');
    await writeFile(path.join(f.root, 'scripts/lib/course-read-worker-artifact.mjs'),
      'import {writeFile} from "node:fs/promises"; export async function materializeCourseReadPrismaRuntime(p){if(!p.endsWith("/build/standalone"))throw new Error("wrong fixture output");await writeFile("worker-finalized", "fixture-only");}');
    for (const script of ['run-next-production.mjs', 'monaco-static-runtime.mjs']) {
      await cp(path.join(repository, 'scripts', script), path.join(f.root, 'scripts', script));
    }
    await mkdir(path.join(f.root, 'src/lib/browser'), { recursive: true });
    await cp(f.manifestPath, path.join(f.root, 'src/lib/browser/monaco-runtime-manifest.json'));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const entryBytes = await readFile(path.join(f.source, 'editor/editor.main.js'));
    const bundleBytes = Buffer.concat([entryBytes, Buffer.from('\n;\n')]);
    const list = `${JSON.stringify({ schemaVersion: 1, algorithm: 'named-amd-topological-concat-v1',
      modules: [{ id: 'vs/editor/editor.main', sha256: hash(entryBytes) }] })}\n`;
    await writeFile(path.join(f.root, 'scripts/lib/monaco-browser-bundle-modules.json'), list);
    await writeFile(path.join(f.root, 'src/lib/browser/monaco-browser-bundle-manifest.json'), JSON.stringify({ schemaVersion: 1,
      version: f.manifest.version, originalSourceTreeSha256: f.manifest.treeSha256, algorithm: 'named-amd-topological-concat-v1',
      moduleListSha256: hash(list), moduleCount: 1, bundleSha256: hash(bundleBytes), bytes: bundleBytes.length,
      entry: 'vs/editor/editor.main', file: 'editor.main.js' }));
    await mkdir(path.join(f.root, 'node_modules/next/dist/bin'), { recursive: true });
    await writeFile(path.join(f.root, 'node_modules/next/package.json'), '{"name":"next"}');
    await mkdir(path.join(f.root, 'node_modules/next/dist/compiled/acorn'), { recursive: true });
    await cp(path.join(repository, 'node_modules/next/dist/compiled/acorn/acorn.js'), path.join(f.root, 'node_modules/next/dist/compiled/acorn/acorn.js'));
    // This tiny child exercises orchestration only; no real Next build/service.
    await writeFile(path.join(f.root, 'node_modules/next/dist/bin/next.js'), `process.exit(${exitCode});`);
    await cp(f.packageRoot, path.join(f.root, 'node_modules/monaco-editor'), { recursive: true });
    const result = spawnSync(process.execPath, ['scripts/run-next-production.mjs', 'build'], {
      cwd: f.root, encoding: 'utf8', env: { ...process.env, NEXT_DIST_DIR: 'build' }, timeout: 10000,
    });
    assert.equal(result.status, exitCode, result.stderr);
    if (exitCode === 0) {
      assert.equal(await readFile(path.join(f.root, 'worker-finalized'), 'utf8'), 'fixture-only');
      assert.deepEqual(await verifyMonacoRuntimeArtifact(f.distDir), f.manifest);
    } else {
      await assert.rejects(readFile(path.join(f.root, 'worker-finalized')), { code: 'ENOENT' });
      await assert.rejects(readdir(f.distDir), { code: 'ENOENT' });
    }
  });
}
