import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePreparedRuntimeBuild } from './production-runtime-release.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const legacyBuild = 'nnqWCt3nGF7C-B5617Dl4';

async function fixture(t) {
  await mkdir(path.join(repository, '.cache'), { recursive: true });
  const root = await mkdtemp(path.join(repository, '.cache/runtime-pin-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts');
  await mkdir(path.join(scripts, 'lib'), { recursive: true });
  await copyFile(new URL('./production-runtime-release.mjs', import.meta.url), path.join(scripts, 'lib/production-runtime-release.mjs'));
  await copyFile(new URL('./production-assets.mjs', import.meta.url), path.join(scripts, 'lib/production-assets.mjs'));
  const proofFile = path.join(root, 'run-proof.json');
  const callFile = path.join(root, 'calls.txt');
  const shim = path.join(scripts, 'fixture-node');
  // The real launcher is transplanted without changing its control flow.
  // Only the executable is replaced: dependencies and migrations cannot reach
  // any network/DB, while selection and final fixture JS run in this Node.
  await writeFile(shim, `#!/bin/sh
set -eu
case "$1" in
  -e) printf 'tcp-ready:%s\\n' "$4" >> "$FIXTURE_CALL_FILE"; exit 0 ;;
  scripts/run-prisma.mjs|*/scripts/run-prisma.mjs)
    printf 'migration:%s:%s\\n' "$2" "$3" >> "$FIXTURE_CALL_FILE"
    exit "\u0024{FIXTURE_MIGRATION_EXIT:-0}" ;;
  *) exec "$FIXTURE_NODE_EXECUTABLE" "$@" ;;
esac
`, { mode: 0o755 });
  const source = await readFile(new URL('../openpbl-production-service.sh', import.meta.url), 'utf8');
  const launcher = path.join(scripts, 'openpbl-production-service.sh');
  await writeFile(launcher, source.replaceAll('/usr/bin/node', `"${shim}"`));
  const secrets = path.join(root, 'fixture-secrets');
  await mkdir(secrets);
  for (const name of ['database_url', 'jwt_secret', 'provider_encryption_key', 'monitor_token']) {
    await writeFile(path.join(secrets, `${name}.txt`), `fixture-${name}\n`, { mode: 0o600 });
  }
  function server(selected, cwd) {
    return `import('node:fs').then(({ writeFileSync }) => {
      process.chdir(${JSON.stringify(cwd)});
      writeFileSync(process.env.FIXTURE_PROOF_FILE, JSON.stringify({
        selected: ${JSON.stringify(selected)}, cwd: process.cwd(),
        pin: process.env.OPENPBL_RUNTIME_BUILD_ID ?? null,
        distDirectory: process.env.NEXT_DIST_DIR ?? null,
        sharedConfigurationLoaded: process.env.DATABASE_URL === 'fixture-database_url'
          && process.env.JWT_SECRET === 'fixture-jwt_secret'
          && process.env.PROVIDER_ENCRYPTION_KEY === 'fixture-provider_encryption_key'
          && process.env.INTERNAL_MONITOR_TOKEN === 'fixture-monitor_token',
        port: process.env.PORT, host: process.env.HOSTNAME,
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
        keepAlive: process.env.KEEP_ALIVE_TIMEOUT,
        generationBackground: process.env.COURSE_GENERATION_BACKGROUND_ENABLED,
        publicDiscussion: process.env.ENABLE_PUBLIC_DISCUSSION,
        websocket: process.env.ENABLE_WEBSOCKET, websocketPort: process.env.WEBSOCKET_PORT,
        uploadDirectory: process.env.UPLOAD_DIR, classroomDirectory: process.env.CLASSROOM_DATA_DIR,
        trustedProxy: process.env.TRUST_PROXY_HEADERS,
        outboundProxy: process.env.OPENPBL_OUTBOUND_PROXY,
        deepseekProxy: process.env.OPENPBL_DEEPSEEK_PROXY,
        edgeLog: process.env.OPENPBL_NGINX_EDGE_LOG
      }));
    });\n`;
  }
  async function release(buildId) {
    const directory = path.join(root, '.openpbl-runtime/releases', buildId);
    await mkdir(path.join(directory, '.next-build'), { recursive: true });
    await writeFile(path.join(directory, '.release-ready'), `${buildId}\n`);
    await writeFile(path.join(directory, '.next-build/BUILD_ID'), `${buildId}\n`);
    await writeFile(path.join(directory, 'server.js'), server(buildId, directory));
    for (const asset of ['vendor/maic-importer/index.js', 'vendor/maic-importer/index.runtime.js', 'vendor/pdfjs/pdf.legacy.min.mjs', 'vendor/pdfjs/pdf.worker.legacy.min.mjs']) {
      const file = path.join(directory, 'public', asset);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'fixture browser asset');
    }
    return directory;
  }
  async function stage() {
    await mkdir(path.join(root, '.next-build/standalone'), { recursive: true });
    await writeFile(path.join(root, '.next-build/standalone/server.js'), 'fixture staging marker');
    await writeFile(path.join(scripts, 'run-next-production.mjs'), server('staged-default', root));
  }
  async function run(extra = {}) {
    await rm(proofFile, { force: true });
    await rm(callFile, { force: true });
    const result = spawnSync('/bin/sh', [launcher, 'run-app'], {
      timeout: 5000, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', OPENPBL_SECRET_DIR: secrets,
        FIXTURE_NODE_EXECUTABLE: process.execPath, FIXTURE_PROOF_FILE: proofFile, FIXTURE_CALL_FILE: callFile,
        OPENPBL_HOSTNAME: '127.0.0.1', OPENPBL_OUTBOUND_PROXY: 'http://fixture.invalid:19999',
        OPENPBL_PUBLIC_BASE_URL: 'https://teaching.example.invalid',
        OPENPBL_NGINX_EDGE_LOG: path.join(root, 'edge/current.ndjson'), ...extra },
    });
    const read = async file => readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { ...result, proof: JSON.parse(await read(proofFile) ?? 'null'), calls: await read(callFile) ?? '' };
  }
  return { root, release, stage, run };
}

test('the launcher requires an explicit site URL before reading secrets or migrating', async t => {
  const f = await fixture(t);
  await f.release('configured-build');
  const result = await f.run({ OPENPBL_PUBLIC_BASE_URL: '', PUBLIC_BASE_URL: '',
    OPENPBL_SECRET_DIR: path.join(f.root, 'missing-secrets') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENPBL_PUBLIC_BASE_URL.*PUBLIC_BASE_URL/);
  assert.doesNotMatch(result.stderr, /配置文件不可读/);
  assert.equal(result.calls, '');
  assert.equal(result.proof, null);
});

test('the launcher accepts the standard site URL and gives the explicit service override priority', async t => {
  const f = await fixture(t);
  await f.release('configured-build');
  for (const [serviceUrl, expected] of [
    ['', 'https://public.example.invalid'],
    ['https://service.example.invalid', 'https://service.example.invalid'],
  ]) {
    const result = await f.run({ OPENPBL_RUNTIME_BUILD_ID: 'configured-build',
      PUBLIC_BASE_URL: 'https://public.example.invalid', OPENPBL_PUBLIC_BASE_URL: serviceUrl });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.proof.publicBaseUrl, expected);
    assert.equal(result.proof.selected, 'configured-build');
    assert.equal(result.proof.pin, 'configured-build');
    assert.equal(result.proof.sharedConfigurationLoaded, true);
    assert.match(result.calls, /migration:migrate:deploy/);
  }
});

test('a prepared legacy release needs its own matching identity, not a newer Monaco manifest', async t => {
  const f = await fixture(t);
  const directory = await f.release(legacyBuild);
  assert.equal(await resolvePreparedRuntimeBuild(f.root, legacyBuild), path.join(directory, 'server.js'));
  // Both historical no-newline files and CRLF markers remain valid.
  await writeFile(path.join(directory, '.release-ready'), legacyBuild);
  await writeFile(path.join(directory, '.next-build/BUILD_ID'), `${legacyBuild}\r\n`);
  assert.equal(await resolvePreparedRuntimeBuild(f.root, legacyBuild), path.join(directory, 'server.js'));
});

test('unsafe or empty build identifiers cannot select a path', async t => {
  const f = await fixture(t);
  for (const buildId of ['', '../escape', '.', '..', 'some/id', 'some\\id', 'bad id', 'id\n', 'id\r', 'id\0', 'id;touch']) {
    await assert.rejects(resolvePreparedRuntimeBuild(f.root, buildId), /OPENPBL_RUNTIME_BUILD_ID/);
  }
});

test('missing, mismatching, oversized or unreadable release files fail instead of selecting staging', async t => {
  const f = await fixture(t);
  await f.stage();
  const cases = [
    ['no-ready', directory => rm(path.join(directory, '.release-ready'))],
    ['wrong-ready', directory => writeFile(path.join(directory, '.release-ready'), 'different\n')],
    ['wrong-build', directory => writeFile(path.join(directory, '.next-build/BUILD_ID'), 'different\n')],
    ['extra-newline', directory => writeFile(path.join(directory, '.release-ready'), 'extra-newline\n\n')],
    ['large-marker', directory => writeFile(path.join(directory, '.release-ready'), 'x'.repeat(1025))],
    ['no-server', directory => rm(path.join(directory, 'server.js'))],
    ['server-directory', async directory => { await rm(path.join(directory, 'server.js')); await mkdir(path.join(directory, 'server.js')); }],
  ];
  if (process.getuid?.() !== 0) cases.push(['unreadable-server', directory => chmod(path.join(directory, 'server.js'), 0)]);
  for (const [buildId, corrupt] of cases) {
    await t.test(buildId, async () => {
      const directory = await f.release(buildId); await corrupt(directory);
      const result = await f.run({ OPENPBL_RUNTIME_BUILD_ID: buildId });
      assert.equal(result.status, 1, result.stderr); assert.equal(result.proof, null);
      assert.equal(result.calls, '', 'Invalid pins must fail before dependency checks and migrations');
    });
  }
});

test('release, metadata and server symlinks cannot escape the fixed release directory', async t => {
  const f = await fixture(t);
  const external = await f.release('external');
  const alias = path.join(f.root, '.openpbl-runtime/releases/alias');
  await symlink(external, alias);
  await assert.rejects(resolvePreparedRuntimeBuild(f.root, 'alias'), /固定 releases/);
  for (const [index, file] of ['server.js', '.release-ready', '.next-build/BUILD_ID'].entries()) {
    const buildId = `linked-file-${index}`;
    const directory = await f.release(buildId);
    await rm(path.join(directory, file));
    await symlink(path.join(external, file), path.join(directory, file));
    await assert.rejects(resolvePreparedRuntimeBuild(f.root, buildId), /符号链接/);
  }
  const ancestor = path.join(f.root, '.openpbl-runtime');
  const moved = path.join(f.root, 'moved-runtime');
  const { rename } = await import('node:fs/promises');
  await rename(ancestor, moved); await symlink(moved, ancestor);
  await assert.rejects(resolvePreparedRuntimeBuild(f.root, 'external'), /固定 releases/);
});

test('the actual launcher pins the older release while retaining shared configuration and lifecycle', async t => {
  const f = await fixture(t);
  const selected = await f.release(legacyBuild); await f.release('newer-ready'); await f.stage();
  const result = await f.run({ OPENPBL_RUNTIME_BUILD_ID: legacyBuild });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.proof.selected, legacyBuild); assert.equal(result.proof.cwd, selected);
  assert.equal(result.proof.distDirectory, '.next-build');
  assert.equal(result.proof.sharedConfigurationLoaded, true);
  assert.equal(result.calls, 'tcp-ready:15432\ntcp-ready:16379\nmigration:migrate:deploy\n');
  assert.equal(result.proof.port, '3000'); assert.equal(result.proof.host, '127.0.0.1');
  assert.equal(result.proof.keepAlive, '65000'); assert.equal(result.proof.generationBackground, 'true');
  assert.equal(result.proof.publicDiscussion, 'true'); assert.equal(result.proof.websocket, 'true');
  assert.equal(result.proof.websocketPort, '3001'); assert.equal(result.proof.trustedProxy, 'true');
  assert.equal(result.proof.uploadDirectory, path.join(f.root, '.openpbl-data/uploads'));
  assert.equal(result.proof.classroomDirectory, path.join(f.root, '.openpbl-data/classrooms'));
  assert.equal(result.proof.outboundProxy, 'http://fixture.invalid:19999');
  assert.equal(result.proof.deepseekProxy, result.proof.outboundProxy);
  assert.equal(result.proof.edgeLog, path.join(f.root, 'edge/current.ndjson'));
  const overridden = await f.run({ OPENPBL_RUNTIME_BUILD_ID: legacyBuild, KEEP_ALIVE_TIMEOUT: '71000',
    OPENPBL_PORT: '3197', OPENPBL_WEBSOCKET_PORT: '3199', OPENPBL_ENABLE_PUBLIC_DISCUSSION: 'false', NEXT_DIST_DIR: '.different-staging' });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(overridden.proof.keepAlive, '71000'); assert.equal(overridden.proof.port, '3197');
  assert.equal(overridden.proof.websocketPort, '3199'); assert.equal(overridden.proof.publicDiscussion, 'false');
  assert.equal(overridden.proof.distDirectory, '.next-build', 'Pinned host releases use their embedded dist directory');
});

test('an explicit empty or unsafe pin never silently falls back to an existing current build', async t => {
  const f = await fixture(t); await f.stage();
  for (const buildId of ['', '../escape', 'valid\n']) {
    const result = await f.run({ OPENPBL_RUNTIME_BUILD_ID: buildId });
    assert.equal(result.status, 1, result.stderr); assert.equal(result.calls, ''); assert.equal(result.proof, null);
  }
});

test('without a pin only fully prepared releases are selected while staging may still be incomplete', async t => {
  const f = await fixture(t);
  const previous = await f.release('previous'); const newest = await f.release('newest');
  await utimes(previous, 100, 100); await utimes(newest, 200, 200);
  await f.stage();
  const staged = await f.run(); assert.equal(staged.status, 0, staged.stderr);
  assert.equal(staged.proof.selected, 'newest'); assert.equal(staged.proof.pin, null);
  assert.equal(staged.proof.distDirectory, '.next-build');
  const customStaged = await f.run({ NEXT_DIST_DIR: '.custom-staging' });
  assert.equal(customStaged.status, 0, customStaged.stderr);
  assert.equal(customStaged.proof.selected, 'newest'); assert.equal(customStaged.proof.distDirectory, '.next-build');
  await rm(path.join(f.root, '.next-build'), { recursive: true });
  const fallback = await f.run(); assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.proof.selected, 'newest'); assert.equal(fallback.proof.pin, null);
  assert.equal(fallback.proof.distDirectory, '.next-build');
  const customFallback = await f.run({ NEXT_DIST_DIR: '.different-staging' });
  assert.equal(customFallback.status, 0, customFallback.stderr);
  assert.equal(customFallback.proof.selected, 'newest'); assert.equal(customFallback.proof.distDirectory, '.next-build');
  await rm(path.join(f.root, '.openpbl-runtime'), { recursive: true });
  const missing = await f.run(); assert.equal(missing.status, 1);
  assert.equal(missing.proof, null); assert.equal(missing.calls, '');
});

test('a legacy pin missing the PDF module is rejected before dependencies or migrations', async t => {
  const f = await fixture(t);
  const release = await f.release(legacyBuild);
  await rm(path.join(release, 'public/vendor/pdfjs/pdf.legacy.min.mjs'));
  const result = await f.run({ OPENPBL_RUNTIME_BUILD_ID: legacyBuild });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing document browser asset/);
  assert.equal(result.calls, '');
  assert.equal(result.proof, null);
});

test('the launcher skips a damaged newer release and preserves a complete fallback', async t => {
  const f = await fixture(t);
  const complete = await f.release('complete');
  const damaged = await f.release('damaged');
  await rm(path.join(damaged, 'public/vendor/pdfjs/pdf.worker.legacy.min.mjs'));
  await utimes(complete, 100, 100); await utimes(damaged, 200, 200);
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.proof.selected, 'complete');
});

test('a valid pin still stops before the server when the existing migration step fails', async t => {
  const f = await fixture(t); await f.release(legacyBuild);
  const result = await f.run({ OPENPBL_RUNTIME_BUILD_ID: legacyBuild, FIXTURE_MIGRATION_EXIT: '3' });
  assert.equal(result.status, 3, result.stderr); assert.equal(result.proof, null);
  assert.equal(result.calls, 'tcp-ready:15432\ntcp-ready:16379\nmigration:migrate:deploy\n');
});

test('the CLI validates a selected release without starting it or loading service secrets', async t => {
  const f = await fixture(t); const directory = await f.release(legacyBuild);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./production-runtime-release.mjs', import.meta.url)), f.root, legacyBuild],
    { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, `${path.join(directory, 'server.js')}\n`);
  await assert.rejects(readFile(path.join(f.root, 'run-proof.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.root, 'calls.txt')), { code: 'ENOENT' });
});
