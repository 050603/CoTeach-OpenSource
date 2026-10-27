import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCourseReadWorkerRuntime } from '../check-course-read-worker.mjs';
import { COURSE_READ_WORKER_FILE, COURSE_READ_WORKER_MANIFEST, inspectCourseReadPrismaRuntime, materializeCourseReadPrismaRuntime, verifyCourseReadWorkerArtifact } from './course-read-worker-artifact.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'course-read-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = path.join(root, 'workers', COURSE_READ_WORKER_FILE);
  const manifestPath = path.join(root, 'workers', COURSE_READ_WORKER_MANIFEST);
  const client = path.join(root, 'node_modules/@prisma/client');
  const generated = path.join(root, 'node_modules/.prisma/client');
  await mkdir(path.dirname(worker), { recursive: true });
  await mkdir(path.join(client, 'runtime'), { recursive: true }); await mkdir(generated, { recursive: true });
  await writeFile(path.join(client, 'package.json'), JSON.stringify({ name: '@prisma/client', version: 'fixture', main: 'default.js' }));
  await writeFile(path.join(client, 'default.js'), 'module.exports = {};');
  await writeFile(path.join(client, 'runtime/library.js'), 'module.exports = {};');
  await writeFile(path.join(generated, 'default.js'), 'module.exports = {};');
  // Synthetic contents test artifact/transport validation only. Actual native
  // library loading is independently mandatory in the production build script.
  await writeFile(path.join(generated, 'libquery_engine-fixture.so.node'), 'synthetic-engine');
  const source = `const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs'),path=require('node:path');const {createRequire}=require('node:module');if(!workerData.selfCheck||workerData.role!=='course-read'||workerData.protocol!==1||process.env.DATABASE_URL||process.execArgv.length)throw Error('bad self-check context');const r=createRequire(path.join(process.cwd(),'workers/course-read-worker.cjs'));const c=fs.realpathSync(r.resolve('@prisma/client')),g=fs.realpathSync(createRequire(c).resolve('.prisma/client/default'));parentPort.postMessage({type:'self-check',protocol:1,prismaVersion:'fixture',clientPath:c,generatedClientPath:g,enginePaths:[path.join(path.dirname(g),'libquery_engine-fixture.so.node')]});parentPort.close();`;
  await writeFile(worker, source);
  const manifest = { protocol: 1, file: COURSE_READ_WORKER_FILE, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), target: 'node22', externalDependencies: ['@prisma/client', 'node-builtins'], externalImports: ['@prisma/client', 'node:worker_threads'], prismaVersion: 'fixture', generatedClientDirectory: 'node_modules/.prisma/client' };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, worker, manifestPath, manifest, client, generated };
}

test('copied standalone keeps exact artifact and resolves external Prisma entirely inside the release', async t => {
  const f = await fixture(t); const release = await mkdtemp(path.join(tmpdir(), 'course-read-release-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  await cp(f.root, release, { recursive: true });
  assert.deepEqual(await verifyCourseReadWorkerArtifact(release, f.manifest), f.manifest);
  const resolved = await inspectCourseReadPrismaRuntime(release);
  assert.ok(resolved.enginePaths.every(file => file.startsWith(`${release}/`)));
  await rm(f.root, { recursive: true });
  const proof = spawnSync(process.execPath, [fileURLToPath(new URL('../check-course-read-worker.mjs', import.meta.url)), '--self-check', release], { cwd: release, encoding: 'utf8', env: { NODE_PATH: '' }, timeout: 5000 });
  assert.equal(proof.status, 0, proof.stderr); assert.equal(JSON.parse(proof.stdout).engineCount, 1);
  assert.deepEqual(await verifyCourseReadWorkerRuntime(release, f.manifest), f.manifest);
});

for (const mutation of ['protocol', 'target', 'bytes', 'sha256', 'externalDependencies', 'externalImports', 'prismaVersion', 'generatedClientDirectory']) {
  test(`rejects inconsistent ${mutation} before accepting a release`, async t => {
    const f = await fixture(t); const bad = { ...f.manifest, [mutation]: mutation === 'bytes' ? 1 : mutation === 'externalImports' ? ['tsx'] : 'invalid' };
    await writeFile(f.manifestPath, JSON.stringify(bad));
    await assert.rejects(verifyCourseReadWorkerArtifact(f.root));
  });
}

test('missing generated client or engine is an incomplete artifact, never a workspace fallback', async t => {
  const f = await fixture(t); const engine = path.join(f.generated, 'libquery_engine-fixture.so.node');
  await rm(engine); await assert.rejects(verifyCourseReadWorkerArtifact(f.root), /engine missing/);
  await rm(path.join(f.generated, 'default.js')); await assert.rejects(verifyCourseReadWorkerArtifact(f.root), /Cannot find module|ENOENT/);
});

test('rejects external artifact/client symlinks and changed release provenance', async t => {
  const f = await fixture(t); const other = await fixture(t);
  await assert.rejects(verifyCourseReadWorkerArtifact(f.root, { ...f.manifest, sha256: 'different-build' }), /differs from build/);
  await rm(f.client, { recursive: true }); await symlink(other.client, f.client);
  await assert.rejects(verifyCourseReadWorkerArtifact(f.root), /client escapes runtime/);
  await rm(f.worker); await symlink(other.worker, f.worker);
  await assert.rejects(verifyCourseReadWorkerArtifact(f.root), /artifact escapes runtime/);
});

test('self-check requires its explicit message and normal exit, not ordinary worker ready', async t => {
  const f = await fixture(t);
  await writeFile(f.worker, "const {parentPort}=require('node:worker_threads');parentPort.postMessage({type:'ready',protocol:1});parentPort.close();");
  const proof = spawnSync(process.execPath, [fileURLToPath(new URL('../check-course-read-worker.mjs', import.meta.url)), '--self-check', f.root], { cwd: f.root, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(proof.status, 0);
});

test('build/tracing/prepare retain worker artifacts without reopening private-data tracing', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.predev, 'node scripts/build-document-converter-worker.mjs && node scripts/build-course-read-worker.mjs && node scripts/run-prisma.mjs ensure');
  assert.ok(pkg.scripts.build.indexOf('build-course-read-worker.mjs') < pkg.scripts.build.indexOf('run-next-production.mjs build'));
  const config = await readFile(path.join(root, 'next.config.ts'), 'utf8');
  for (const value of ['course-read-worker.cjs', 'course-read-worker-manifest.json', 'node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/**/*', '**/.cache/**', '**/static/openpbl-runtime/monaco']) assert.ok(config.includes(value));
  const prepare = await readFile(path.join(root, 'scripts/run-next-production.mjs'), 'utf8');
  assert.ok(prepare.includes('verifyCourseReadWorkerRuntime(standaloneDir)'));
  assert.ok(prepare.includes('verifyCourseReadWorkerRuntime(releaseDir, readWorkerManifest)'));
  assert.ok(prepare.includes('await materializeCourseReadPrismaRuntime(path.resolve(distDir, "standalone"))'));
});

test('NFT flattened client links traced pnpm generated peer and remains relocatable with one engine', async t => {
  const f = await fixture(t);
  f.manifest.generatedClientDirectory = 'node_modules/.pnpm/@prisma+client@fixture/node_modules/.prisma/client';
  const traced = path.join(f.root, f.manifest.generatedClientDirectory);
  await mkdir(path.dirname(traced), { recursive: true }); await rename(f.generated, traced);
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(verifyCourseReadWorkerArtifact(f.root), /MODULE_NOT_FOUND|Cannot find module|ENOENT/);
  await materializeCourseReadPrismaRuntime(f.root);
  assert.equal(path.isAbsolute(await readlink(f.generated)), false);
  await materializeCourseReadPrismaRuntime(f.root);
  const release = await mkdtemp(path.join(tmpdir(), 'course-read-nft-release-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  await cp(f.root, release, { recursive: true, verbatimSymlinks: true });
  await rm(f.root, { recursive: true });
  const info = await inspectCourseReadPrismaRuntime(release);
  assert.equal(info.generatedClientPath, path.join(release, f.manifest.generatedClientDirectory, 'default.js'));
  assert.deepEqual(await verifyCourseReadWorkerRuntime(release, f.manifest), f.manifest);
});

test('normalization refuses missing traced files, escaped paths, and incomplete existing flat destinations', async t => {
  const f = await fixture(t);
  f.manifest.generatedClientDirectory = 'node_modules/.pnpm/@prisma+client@fixture/node_modules/.prisma/client';
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(materializeCourseReadPrismaRuntime(f.root), /ENOENT/);
  const traced = path.join(f.root, f.manifest.generatedClientDirectory);
  await mkdir(path.dirname(traced), { recursive: true }); await rename(f.generated, traced);
  await mkdir(f.generated); await assert.rejects(materializeCourseReadPrismaRuntime(f.root), /Cannot find module|ENOENT/);
  await rm(f.generated, { recursive: true });
  const other = await fixture(t); await rm(traced, { recursive: true }); await symlink(other.generated, traced);
  await assert.rejects(materializeCourseReadPrismaRuntime(f.root), /escapes standalone/);
  f.manifest.generatedClientDirectory = '../node_modules/.prisma/client';
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(materializeCourseReadPrismaRuntime(f.root), /location invalid/);
});

test('normalization refuses an escaped destination parent without writing outside standalone', async t => {
  const f = await fixture(t);
  f.manifest.generatedClientDirectory = 'node_modules/.pnpm/@prisma+client@fixture/node_modules/.prisma/client';
  const traced = path.join(f.root, f.manifest.generatedClientDirectory);
  await mkdir(path.dirname(traced), { recursive: true }); await rename(f.generated, traced);
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const outside = await mkdtemp(path.join(tmpdir(), 'course-read-outside-parent-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(path.dirname(f.generated), { recursive: true }); await symlink(outside, path.dirname(f.generated));
  await assert.rejects(materializeCourseReadPrismaRuntime(f.root), /destination parent escapes standalone/);
  assert.deepEqual(await readdir(outside), []);
});
