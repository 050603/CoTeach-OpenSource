import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Allow Docker scheduling under concurrent release checks without turning a
// correctness regression into a five-second container startup benchmark.
const DOCKER_COMMAND_TIMEOUT_MS = 30000;
const DOCKER_START_TIMEOUT_MS = 60000;
const FIXTURE_TEST_TIMEOUT_MS = 180000;
const docker = (args, options = {}) => run('docker', args, { timeout: DOCKER_COMMAND_TIMEOUT_MS, ...options });
const root = fileURLToPath(new URL('../../', import.meta.url));
const image = 'nginx:1.28.0-alpine';
const renderer = '/etc/nginx/openpbl-templates/render-config.sh';
const fixtureEnv = { ...process.env, PUBLIC_HOST: 'gateway.invalid', OPENPBL_MIGRATOR_IMAGE: 'fixture/migrator:1',
  BACKUP_S3_ENDPOINT: 'https://backup.invalid', BACKUP_S3_BUCKET: 'fixture', MANUAL_BACKUP_OFFERING_ID: 'fixture',
  OPENPBL_EDGE_LOG_GID: '1234', OPENPBL_NGINX_TEMPLATE: 'openpbl.conf.template' };

test('Compose gateways inherit one directory bind and one selected-template renderer', { timeout: FIXTURE_TEST_TIMEOUT_MS }, async t => {
  try { await docker(['compose', 'version'], { signal: t.signal }); }
  catch (error) {
    if (error.killed || error.name === 'AbortError') throw error;
    t.skip('Requires Docker Compose'); return;
  }
  for (const edge of [false, true]) {
    const files = ['docker-compose.prod.yml', 'docker-compose.ip.yml',
      ...(edge ? ['deploy/monitoring/docker-compose.nginx-edge.yml'] : [])];
    const { stdout } = await docker(['compose', '--env-file', '/dev/null', '--profile', 'certificate-bootstrap',
      ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'], { cwd: root, env: fixtureEnv, signal: t.signal });
    const services = JSON.parse(stdout).services;
    const gateway = services.nginx;
    assert.equal(gateway.network_mode, 'host');
    assert.equal(gateway.environment.OPENPBL_UPSTREAM_HOST, '127.0.0.1');
    assert.equal(gateway.environment.NGINX_INTERNAL_LISTEN, '127.0.0.1:18082');
    for (const service of [gateway, services['nginx-bootstrap']]) {
      const mount = service.volumes.filter(volume => volume.target === '/etc/nginx/openpbl-templates');
      assert.equal(mount.length, 1);
      assert.equal(mount[0].source, path.join(root, 'deploy/nginx'));
      assert.equal(mount[0].read_only, true);
      assert.ok(!service.volumes.some(volume => volume.target.startsWith('/etc/nginx/templates/')));
      assert.equal(service.command.join('\n').split(renderer).length, 2);
      assert.ok(!service.command.join('\n').includes('/docker-entrypoint.d/20-envsubst-on-templates.sh'));
    }
    assert.equal(services['nginx-bootstrap'].environment.OPENPBL_NGINX_TEMPLATE, 'bootstrap.conf.template');
    assert.ok(gateway.volumes.some(volume => volume.target === '/srv/openpbl/uploads'));
    assert.ok(gateway.volumes.some(volume => volume.target === '/etc/letsencrypt'));
    if (edge) assert.ok(gateway.volumes.some(volume => volume.target === '/etc/nginx/conf.d/00-openpbl-edge-log.conf'));
    else assert.ok(gateway.command.join('\n').includes('sleep 21600'));
  }
});

async function removeFixture(name) {
  const deadline = Date.now() + DOCKER_COMMAND_TIMEOUT_MS;
  for (;;) {
    try { await docker(['rm', '--force', name]); return; }
    catch (error) {
      if (/No such container/i.test(error.stderr ?? '')) return;
      if (Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

test('directory-mounted template replacements are rendered once without changing independent sites', { timeout: FIXTURE_TEST_TIMEOUT_MS }, async t => {
  try { await docker(['image', 'inspect', image], { signal: t.signal }); }
  catch (error) {
    if (error.killed || error.name === 'AbortError') throw error;
    t.skip(`Requires Docker and the locally installed ${image} image; no image is downloaded`); return;
  }
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.cache/nginx-template-test-'));
  const name = `openpbl-nginx-template-test-${randomUUID()}`;
  t.after(async () => {
    try { await removeFixture(name); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const fixtureDocker = args => docker(args, { signal: t.signal });
  await writeFile(path.join(directory, 'render-config.sh'), await readFile(path.join(root, 'deploy/nginx/render-config.sh')));
  const template = marker => `# ${marker}
server { listen 8080; server_name \${PUBLIC_HOST}; location / { return 200 "$uri"; } }\n`;
  for (const name of ['openpbl.conf.template', 'openpbl-http.conf.template', 'bootstrap.conf.template']) {
    await writeFile(path.join(directory, name), template(name));
  }
  const independent = 'server { listen 8090; server_name independent.invalid; }\n';
  await docker(['create', '--name', name, '--network', 'none',
    '--volume', `${directory}:/etc/nginx/openpbl-templates:ro`,
    '--env', 'PUBLIC_HOST=gateway.invalid', '--env', 'OPENPBL_UPSTREAM_HOST=127.0.0.1',
    '--env', 'NGINX_INTERNAL_LISTEN=8082', '--env', 'LOAD_TEST_CLIENT_IP=127.0.0.1',
    '--entrypoint', '/bin/sh', image, '-c', 'exec sleep 600'], { timeout: DOCKER_START_TIMEOUT_MS, signal: t.signal });
  await docker(['start', name], { timeout: DOCKER_START_TIMEOUT_MS, signal: t.signal });
  await fixtureDocker(['exec', name, 'sh', '-c', 'printf \'%s\\n\' \'server { listen 8090; server_name independent.invalid; }\' > /etc/nginx/conf.d/independent.conf']);
  const render = (selected = 'openpbl.conf.template') => fixtureDocker(['exec', '--env', `OPENPBL_NGINX_TEMPLATE=${selected}`, name, '/bin/sh', renderer]);
  const configuration = () => fixtureDocker(['exec', name, 'cat', '/etc/nginx/conf.d/default.conf']).then(result => result.stdout);
  await render();
  assert.match(await configuration(), /# openpbl\.conf\.template/);
  assert.match(await configuration(), /server_name gateway\.invalid;/);
  assert.match(await configuration(), /return 200 "\$uri"/);
  await fixtureDocker(['exec', name, 'nginx', '-t']);

  const replacement = template('atomic replacement');
  await writeFile(path.join(directory, 'replacement.tmp'), replacement);
  await rename(path.join(directory, 'replacement.tmp'), path.join(directory, 'openpbl.conf.template'));
  assert.equal((await fixtureDocker(['exec', name, 'cat', '/etc/nginx/openpbl-templates/openpbl.conf.template'])).stdout, replacement);
  await render();
  assert.match(await configuration(), /# atomic replacement/);
  await render('openpbl-http.conf.template');
  const lastGood = await configuration();
  assert.match(lastGood, /# openpbl-http\.conf\.template/);
  await writeFile(path.join(directory, 'openpbl-http.conf.template'), 'server { invalid_candidate_directive; }\n');
  await assert.rejects(render('openpbl-http.conf.template'), /unknown directive "invalid_candidate_directive"/);
  assert.equal(await configuration(), lastGood, 'A syntactically invalid candidate must never replace the active file');
  await fixtureDocker(['exec', name, 'nginx', '-t']);
  await writeFile(path.join(directory, 'openpbl-http.conf.template'), template('openpbl-http.conf.template'));
  await fixtureDocker(['exec', name, 'sh', '-c', 'printf \'%s\\n\' \'server { invalid_independent_directive; }\' > /etc/nginx/conf.d/independent.conf']);
  await assert.rejects(render('openpbl-http.conf.template'), /unknown directive "invalid_independent_directive"/);
  assert.equal(await configuration(), lastGood, 'Candidate validation must include the independent sites');
  await fixtureDocker(['exec', name, 'sh', '-c', 'printf \'%s\\n\' \'server { listen 8090; server_name independent.invalid; }\' > /etc/nginx/conf.d/independent.conf']);
  await assert.rejects(render('../../unexpected.template'), /Unknown OPENPBL_NGINX_TEMPLATE/);
  await rm(path.join(directory, 'bootstrap.conf.template'));
  await assert.rejects(render('bootstrap.conf.template'), /Missing Nginx template/);
  assert.equal(await configuration(), lastGood, 'Rejected selections must preserve the generated configuration');
  assert.equal((await fixtureDocker(['exec', name, 'cat', '/etc/nginx/conf.d/independent.conf'])).stdout, independent);
  const listing = (await fixtureDocker(['exec', name, 'find', '/etc/nginx/conf.d', '-maxdepth', '1', '-name', '*.conf'])).stdout.trim().split('\n').sort();
  assert.deepEqual(listing, ['/etc/nginx/conf.d/default.conf', '/etc/nginx/conf.d/independent.conf']);
  await fixtureDocker(['exec', name, 'nginx', '-t']);
});
