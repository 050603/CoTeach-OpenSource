import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COURSE_READ_WORKER_FILE, COURSE_READ_WORKER_MANIFEST, inspectCourseReadPrismaRuntime } from './lib/course-read-worker-artifact.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function buildCourseReadWorker({ root = repository, outputRoot = root } = {}) {
  const directory = path.join(outputRoot, 'workers');
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, '.course-read-build-'));
  const isolated = await mkdtemp(path.join(tmpdir(), 'openpbl-course-read-bundle-'));
  try {
    const outfile = path.join(staging, COURSE_READ_WORKER_FILE);
    const result = await build({
      absWorkingDir: root, entryPoints: [path.join(root, 'src/lib/courses/course-read-worker-entry.ts')], outfile,
      bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true,
      external: ['@prisma/client', '@prisma/client/*'],
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning', sourcemap: false,
      plugins: [{ name: 'server-only-node-runtime', setup(builder) {
        builder.onResolve({ filter: /^server-only$/ }, () => ({ path: require.resolve('next/dist/compiled/server-only/empty.js') }));
      } }],
    });
    assert.ok(!result.warnings.some(warning => warning.id === 'empty-import-meta'), 'Course read worker retains import.meta that cannot run in a CJS artifact');
    for (const input of Object.keys(result.metafile.inputs)) {
      assert.ok(!/(?:^|\/)src\/app\/.*\/route\.[cm]?[jt]sx?$|(?:^|\/)src\/instrumentation\.[cm]?[jt]s$/.test(input), `Course read worker must not bundle HTTP routes/instrumentation: ${input}`);
    }
    const externalImports = [...new Set(Object.values(result.metafile.outputs).flatMap(file => file.imports.map(dependency => {
      assert.ok(dependency.external && (builtins.has(dependency.path) || /^@prisma\/client(?:\/|$)/.test(dependency.path)), `Course read worker retains unsupported dependency: ${dependency.path}`);
      return dependency.path;
    })))].sort();
    assert.ok(externalImports.includes('@prisma/client'), 'Course read worker must retain the isolated Prisma client');
    const prisma = await inspectCourseReadPrismaRuntime(root);
    const bytes = await readFile(outfile);
    const manifest = { protocol: 1, file: COURSE_READ_WORKER_FILE, sha256: digest(bytes), bytes: bytes.length,
      target: 'node22', externalDependencies: ['@prisma/client', 'node-builtins'], externalImports, prismaVersion: prisma.prismaVersion,
      generatedClientDirectory: path.relative(root, path.dirname(prisma.generatedClientPath)).split(path.sep).join('/') };
    await writeFile(path.join(staging, COURSE_READ_WORKER_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    // Copy actual package contents, not links into the workspace. The generated
    // client and native engine are dynamic dependencies of @prisma/client.
    await mkdir(path.join(isolated, 'workers'), { recursive: true });
    await cp(outfile, path.join(isolated, 'workers', COURSE_READ_WORKER_FILE));
    await cp(path.dirname(prisma.packagePath), path.join(isolated, 'node_modules/@prisma/client'), { recursive: true, dereference: true });
    await cp(path.dirname(prisma.generatedClientPath), path.join(isolated, 'node_modules/.prisma/client'), { recursive: true, dereference: true });
    const proof = spawnSync(process.execPath, [fileURLToPath(new URL('./check-course-read-worker.mjs', import.meta.url)), '--self-check', isolated], {
      cwd: isolated, env: { NODE_ENV: 'production', TZ: 'UTC', NODE_PATH: '' }, encoding: 'utf8', timeout: 25_000,
    });
    assert.equal(proof.error, undefined, `Course read worker isolated self-check failed: ${proof.error?.message}`);
    assert.equal(proof.status, 0, `Course read worker cannot boot outside workspace: ${proof.stderr}`);
    const checked = JSON.parse(proof.stdout.trim());
    assert.equal(checked.protocol, 1); assert.equal(checked.prismaVersion, manifest.prismaVersion); assert.ok(checked.engineCount > 0);
    // Publish the manifest last. Any interrupted replacement fails closed on
    // hash mismatch rather than allowing a mixed build through prepare/start.
    await rename(outfile, path.join(directory, COURSE_READ_WORKER_FILE));
    await rename(path.join(staging, COURSE_READ_WORKER_MANIFEST), path.join(directory, COURSE_READ_WORKER_MANIFEST));
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || args.length === 2 && args[0] === '--output-root', 'Usage: build-course-read-worker.mjs [--output-root directory]');
  const manifest = await buildCourseReadWorker(args.length ? { outputRoot: path.resolve(args[1]) } : {});
  console.log(`Course read worker verified with external Prisma/native engine and no source/loader: ${manifest.bytes} bytes (${manifest.sha256})`);
}
