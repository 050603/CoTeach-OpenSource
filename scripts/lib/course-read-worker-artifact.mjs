import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';

export const COURSE_READ_WORKER_FILE = 'course-read-worker.cjs';
export const COURSE_READ_WORKER_MANIFEST = 'course-read-worker-manifest.json';
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file.startsWith(`${root}${path.sep}`);
const generatedDirectoryPattern = /^node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?\.prisma\/client$/;

/** Build-only layout normalization. Link only dependencies already traced into this standalone. */
export async function materializeCourseReadPrismaRuntime(runtimeRoot) {
  const root = await realpath(runtimeRoot);
  const manifest = JSON.parse(await readFile(path.join(root, 'workers', COURSE_READ_WORKER_MANIFEST), 'utf8'));
  assert.ok(generatedDirectoryPattern.test(manifest.generatedClientDirectory), 'Course read worker generated client location invalid');
  const source = await realpath(path.join(root, manifest.generatedClientDirectory));
  assert.ok(inside(root, source), 'Course read worker generated client escapes standalone');
  // Never silently substitute the workspace or another installed client.
  await stat(path.join(source, 'default.js'));
  const destination = path.join(root, 'node_modules/.prisma/client');
  let exists = false;
  try {
    await lstat(destination);
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists) {
    // An existing incomplete destination is an artifact error, not permission
    // to replace it with another client or hide a broken prior publication.
    assert.equal((await inspectCourseReadPrismaRuntime(root)).prismaVersion, manifest.prismaVersion, 'Course read worker Prisma version mismatch');
    return;
  }
  assert.ok(inside(root, await realpath(path.dirname(path.dirname(destination)))), 'Course read worker node_modules escapes standalone');
  await mkdir(path.dirname(destination), { recursive: true });
  assert.ok(inside(root, await realpath(path.dirname(destination))), 'Course read worker destination parent escapes standalone');
  const staging = await mkdtemp(path.join(path.dirname(destination), '.course-read-prisma-'));
  try {
    // The link is relative to its final directory, so immutable release copies
    // retain one native engine and never point back at the build/workspace.
    await symlink(path.relative(path.dirname(destination), source), path.join(staging, 'client'), 'dir');
    await rename(path.join(staging, 'client'), destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  assert.equal((await inspectCourseReadPrismaRuntime(root)).prismaVersion, manifest.prismaVersion, 'Course read worker Prisma version mismatch');
}

/** Resolve the actual external client from the worker's runtime, never a build-tree fallback. */
export async function inspectCourseReadPrismaRuntime(runtimeRoot) {
  const root = await realpath(runtimeRoot);
  const resolve = createRequire(path.join(root, 'workers', COURSE_READ_WORKER_FILE));
  const clientPath = await realpath(resolve.resolve('@prisma/client'));
  assert.ok(inside(root, clientPath), 'Course read worker Prisma client escapes runtime');
  const clientRequire = createRequire(clientPath);
  const generatedClientPath = await realpath(clientRequire.resolve('.prisma/client/default'));
  const libraryPath = await realpath(clientRequire.resolve('@prisma/client/runtime/library'));
  const packagePath = await realpath(clientRequire.resolve('@prisma/client/package.json'));
  for (const file of [generatedClientPath, libraryPath, packagePath]) assert.ok(inside(root, file), 'Course read worker Prisma dependency escapes runtime');
  const generatedRoot = path.dirname(generatedClientPath);
  const enginePaths = (await readdir(generatedRoot)).filter(name => /^libquery_engine-.*\.(?:so\.node|dylib\.node)$|^query_engine-.*\.dll\.node$/.test(name)).sort().map(name => path.join(generatedRoot, name));
  assert.ok(enginePaths.length, 'Course read worker native Prisma engine missing');
  for (const file of enginePaths) {
    assert.ok(inside(root, await realpath(file)), 'Course read worker Prisma engine escapes runtime');
    assert.ok((await stat(file)).size > 0, 'Course read worker Prisma engine empty');
  }
  return { prismaVersion: JSON.parse(await readFile(packagePath, 'utf8')).version, clientPath, generatedClientPath, libraryPath, packagePath, enginePaths };
}

export async function verifyCourseReadWorkerArtifact(runtimeRoot, expectedManifest) {
  const root = await realpath(runtimeRoot);
  const directory = path.join(root, 'workers');
  for (const file of [COURSE_READ_WORKER_FILE, COURSE_READ_WORKER_MANIFEST]) assert.ok(inside(root, await realpath(path.join(directory, file))), 'Course read worker artifact escapes runtime');
  const manifest = JSON.parse(await readFile(path.join(directory, COURSE_READ_WORKER_MANIFEST), 'utf8'));
  const bytes = await readFile(path.join(directory, COURSE_READ_WORKER_FILE));
  assert.equal(manifest.protocol, 1, 'Course read worker protocol mismatch');
  assert.equal(manifest.file, COURSE_READ_WORKER_FILE, 'Course read worker file mismatch');
  assert.equal(manifest.target, 'node22', 'Course read worker target mismatch');
  assert.ok(generatedDirectoryPattern.test(manifest.generatedClientDirectory), 'Course read worker generated client location invalid');
  assert.deepEqual(manifest.externalDependencies, ['@prisma/client', 'node-builtins'], 'Course read worker dependency contract mismatch');
  assert.ok(Array.isArray(manifest.externalImports) && manifest.externalImports.includes('@prisma/client') && manifest.externalImports.every(value => typeof value === 'string' && (builtins.has(value) || /^@prisma\/client(?:\/|$)/.test(value))), 'Course read worker unexpected external import');
  assert.equal(manifest.bytes, bytes.length, 'Course read worker byte count mismatch');
  assert.equal(manifest.sha256, digest(bytes), 'Course read worker SHA mismatch');
  if (expectedManifest) assert.deepEqual(manifest, expectedManifest, 'Course read worker release differs from build');
  const prisma = await inspectCourseReadPrismaRuntime(runtimeRoot);
  assert.equal(manifest.prismaVersion, prisma.prismaVersion, 'Course read worker Prisma version mismatch');
  return manifest;
}
