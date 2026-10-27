import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { snapshotProductionAssets, verifyProductionAssets } from './production-assets.mjs';
import { resolvePreparedRuntimeBuild } from './production-runtime-release.mjs';

const assets = [
  'vendor/maic-importer/index.js',
  'vendor/maic-importer/index.runtime.js',
  'vendor/pdfjs/pdf.legacy.min.mjs',
  'vendor/pdfjs/pdf.worker.legacy.min.mjs',
  'vendor/pdfjs/4.8.69/pdf.legacy.min.mjs',
  'vendor/pdfjs/4.8.69/pdf.worker.legacy.min.mjs',
];

async function fixture(t) {
  await mkdir(new URL('../../.cache/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../../.cache/document-browser-release-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts');
  const standalone = path.join(root, '.next-build/standalone');
  await mkdir(path.join(scripts, 'lib'), { recursive: true });
  await mkdir(path.join(standalone, 'workers'), { recursive: true });
  await mkdir(path.join(root, '.next-build/static'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/next/dist/bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/next/package.json'), '{"name":"next"}');
  await writeFile(path.join(root, 'node_modules/next/dist/bin/next.js'), 'throw new Error("Next must not start during prepare");');
  await copyFile(new URL('../run-next-production.mjs', import.meta.url), path.join(scripts, 'run-next-production.mjs'));
  await copyFile(new URL('../run-production-task.mjs', import.meta.url), path.join(scripts, 'run-production-task.mjs'));
  await copyFile(new URL('./production-assets.mjs', import.meta.url), path.join(scripts, 'lib/production-assets.mjs'));
  await copyFile(new URL('./http-upstream-policy.mjs', import.meta.url), path.join(scripts, 'lib/http-upstream-policy.mjs'));
  // Worker and Monaco integrity have independent integration coverage. This
  // fixture executes real release copying and document-asset admission only.
  await writeFile(path.join(scripts, 'monaco-static-runtime.mjs'), 'export async function publishMonacoRuntime() {} export async function verifyMonacoRuntimeArtifact() {}');
  await writeFile(path.join(scripts, 'check-course-read-worker.mjs'), 'export async function verifyCourseReadWorkerRuntime() {}');
  await writeFile(path.join(scripts, 'lib/course-read-worker-artifact.mjs'), 'export async function materializeCourseReadPrismaRuntime() {}');
  await writeFile(path.join(standalone, 'server.js'), 'throw new Error("Server must not start during prepare");');
  await writeFile(path.join(root, '.next-build/BUILD_ID'), 'fixture-build\n');
  await mkdir(path.join(standalone, '.next-build'), { recursive: true });
  await writeFile(path.join(standalone, '.next-build/BUILD_ID'), 'fixture-build\n');
  await writeFile(path.join(root, '.next-build/static/chunk.js'), 'fixture browser chunk');
  await mkdir(path.join(root, 'src/lib/browser'), { recursive: true });
  await writeFile(path.join(root, 'src/lib/browser/pdf-runtime-version.json'), '{"version":"4.8.69"}');
  const worker = 'fixture worker';
  await writeFile(path.join(standalone, 'workers/docx-converter.cjs'), worker);
  await writeFile(path.join(standalone, 'workers/docx-converter-manifest.json'), JSON.stringify({
    protocol: 1, sha256: createHash('sha256').update(worker).digest('hex'),
  }));
  await writeFile(path.join(standalone, 'workers/course-read-worker.cjs'), 'fixture read worker');
  await writeFile(path.join(standalone, 'workers/course-read-worker-manifest.json'), '{"fixture":true}');
  await cp(path.join(standalone, 'workers'), path.join(root, 'workers'), { recursive: true });
  for (const asset of assets) {
    const file = path.join(root, 'public', asset);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `// ${asset}\n`);
  }
  await snapshotProductionAssets(root, '.next-build');
  const release = path.join(root, '.openpbl-runtime/releases/fixture-build');
  const ready = path.join(release, '.release-ready');
  function prepare() {
    return spawnSync(process.execPath, ['scripts/run-next-production.mjs', 'prepare'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, NEXT_DIST_DIR: '.next-build' },
    });
  }
  return { root, release, ready, prepare };
}

test('prepare uses the build snapshot even after workspace public files change or disappear', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'public', assets[0]), 'a later checkout changed this file');
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(f.ready, 'utf8')).buildId, 'fixture-build');
  for (const asset of assets) {
    assert.equal(await readFile(path.join(f.release, 'public', asset), 'utf8'), `// ${asset}\n`);
  }
  await verifyProductionAssets(f.release, '.next-build');
  assert.equal(await resolvePreparedRuntimeBuild(f.root, 'fixture-build'), path.join(f.release, 'server.js'));
  // A prepared artifact is self-contained; later workspace cleanup cannot
  // invalidate its admission or change its already-copied modules.
  await rm(path.join(f.root, 'public'), { recursive: true });
  const repeated = f.prepare();
  assert.equal(repeated.status, 0, repeated.stderr);
});

test('a manifest-backed pin cannot bypass integrity checks when its chunks or manifest are damaged', async t => {
  const f = await fixture(t);
  assert.equal(f.prepare().status, 0);
  const chunk = path.join(f.release, '.next-build/static/chunk.js');
  await writeFile(chunk, 'corrupt chunk');
  await assert.rejects(resolvePreparedRuntimeBuild(f.root, 'fixture-build'), /Production runtime assets/);
  await writeFile(chunk, 'fixture browser chunk');
  await writeFile(path.join(f.release, '.next-build/runtime-assets.json'), '{"schemaVersion":0}');
  await assert.rejects(resolvePreparedRuntimeBuild(f.root, 'fixture-build'), /manifest/);
  await rm(path.join(f.release, '.next-build/runtime-assets.json'));
  await assert.rejects(resolvePreparedRuntimeBuild(f.root, 'fixture-build'), { code: 'ENOENT' });
});

for (const asset of assets) {
  test(`prepare refuses missing snapshot ${asset} without publishing a ready release`, async t => {
    const f = await fixture(t);
    await rm(path.join(f.root, '.next-build/public', asset));
    const result = f.prepare();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Build runtime snapshot/);
    await assert.rejects(readFile(f.ready), { code: 'ENOENT' });
  });
}

test('prepare rejects an existing ready release whose PDF.js files are missing or empty', async t => {
  const f = await fixture(t);
  assert.equal(f.prepare().status, 0);
  const main = path.join(f.release, 'public', assets[2]);
  await rm(main);
  const missing = f.prepare();
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes(`Missing document browser asset: ${main}`));
  await writeFile(main, '');
  const empty = f.prepare();
  assert.equal(empty.status, 1);
  assert.ok(empty.stderr.includes(`Missing document browser asset: ${main}`));
});

test('corrupt browser chunks block prepare before a ready marker can be published', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.next-build/static/chunk.js'), 'different build');
  const result = f.prepare();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Build runtime snapshot/);
  await assert.rejects(readFile(f.ready), { code: 'ENOENT' });
});

test('a copied release is not marked ready when its final dependency validation fails', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'scripts/monaco-static-runtime.mjs'), 'export async function publishMonacoRuntime() {} export async function verifyMonacoRuntimeArtifact(root) { if(root.includes("releases")) throw new Error("fixture final artifact failure"); }');
  const result = f.prepare();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture final artifact failure/);
  await assert.rejects(readFile(f.ready), { code: 'ENOENT' });
});

test('prepare retains a prior PDF module/worker pair after a clean dependency upgrade', async t => {
  const f = await fixture(t);
  assert.equal(f.prepare().status, 0);
  await rm(path.join(f.root, 'public/vendor/pdfjs/4.8.69'), { recursive: true });
  await writeFile(path.join(f.root, 'src/lib/browser/pdf-runtime-version.json'), '{"version":"4.9.0"}');
  for (const name of ['pdf.legacy.min.mjs', 'pdf.worker.legacy.min.mjs']) {
    const file = path.join(f.root, 'public/vendor/pdfjs/4.9.0', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `next version: ${name}`);
  }
  await writeFile(path.join(f.root, '.next-build/BUILD_ID'), 'next-build\n');
  await writeFile(path.join(f.root, '.next-build/standalone/.next-build/BUILD_ID'), 'next-build\n');
  await snapshotProductionAssets(f.root, '.next-build');
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  const next = path.join(f.root, '.openpbl-runtime/releases/next-build');
  for (const asset of assets.slice(4)) {
    assert.equal(await readFile(path.join(next, 'public', asset), 'utf8'), `// ${asset}\n`);
  }
  await verifyProductionAssets(next, '.next-build');
});
