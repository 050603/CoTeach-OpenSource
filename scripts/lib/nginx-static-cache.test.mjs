import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
// These are correctness checks, not Docker startup performance limits. Local
// container creation can queue behind the other release regression fixtures.
const DOCKER_COMMAND_TIMEOUT_MS = 30000;
const DOCKER_START_TIMEOUT_MS = 60000;
const FIXTURE_TEST_TIMEOUT_MS = 180000;
const docker = (args, options = {}) => run('docker', args, { timeout: DOCKER_COMMAND_TIMEOUT_MS, ...options });
const root = fileURLToPath(new URL('../../', import.meta.url));
const image = 'nginx:1.28.0-alpine';
const files = ['deploy/nginx.conf', 'deploy/nginx/openpbl.conf.template', 'deploy/nginx/openpbl-http.conf.template'];

function resourceLocations(config) {
  return [...config.matchAll(/^    location ([^\n]+) \{\n[\s\S]*?^    \}/gm)]
    .filter(match => /\/_next\/(?:static\/|image)|\/vendor\/|^~\* \\\./.test(match[1]))
    .map(match => ({ selector: match[1], text: match[0] }));
}

for (const file of files) {
  test(`${file} preserves cache identity and non-cacheable resource errors`, async () => {
    const config = await readFile(path.join(root, file), 'utf8');
    const locations = resourceLocations(config);
    for (const prefix of ['/_next/static/', '/vendor/']) {
      const location = locations.find(item => item.selector === `^~ ${prefix}`);
      assert.ok(location, `${prefix} must take precedence over generic suffix locations`);
      assert.doesNotMatch(location.text, /(?:add_header|proxy_hide_header)\s+Cache-Control|\bexpires\s|\bproxy_ignore_headers\s/,
        `${prefix} must retain the upstream response's cache contract`);
    }
    assert.doesNotMatch(config, /add_header\s+Cache-Control\s+[^;]*\balways\s*;/,
      'A resource error must not receive a positive cache lifetime from Nginx');
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function get(port, resource, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: resource, agent: false }, response => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, cache: response.headers['cache-control'] }));
      response.once('error', reject);
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('Nginx fixture request timed out')));
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function removeFixture(name) {
  const deadline = Date.now() + DOCKER_COMMAND_TIMEOUT_MS;
  for (;;) {
    try { await docker(['rm', '--force', name]); return; }
    catch (error) {
      if (/No such container/i.test(error.stderr ?? '')) return;
      if (Date.now() >= deadline) throw error;
      // A timed-out start can still be completing in the daemon. Do not hide
      // transient "container is starting" conflicts or leave a fixture behind.
      await delay(250);
    }
  }
}

test('real Nginx preserves successful hashed assets, stable vendor URLs and resource errors', { timeout: FIXTURE_TEST_TIMEOUT_MS }, async t => {
  try { await docker(['image', 'inspect', image], { signal: t.signal }); }
  catch (error) {
    if (error.killed || error.name === 'AbortError') throw error;
    t.skip(`Requires Docker and the locally installed ${image} image; no image is downloaded`); return;
  }

  const upstream = createServer((req, res) => {
    const missing = req.url.includes('missing');
    res.statusCode = missing ? 404 : 200;
    res.setHeader('Cache-Control', missing ? 'private, no-store, max-age=0'
      : req.url.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0');
    res.end(missing ? 'Missing fixture resource' : 'Fixture browser asset');
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const cache = path.join(root, '.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, 'nginx-cache-test-'));
  const name = `openpbl-nginx-cache-test-${randomUUID()}`;
  t.after(async () => {
    try { await removeFixture(name); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const servers = [];
  for (const file of files) {
    const port = await unusedPort();
    const locations = resourceLocations(await readFile(path.join(root, file), 'utf8'));
    servers.push({ file, port, config: `server { listen 127.0.0.1:${port};
${locations.map(item => item.text).join('\n')}
location / { proxy_pass http://openpbl_app; }
}` });
  }
  await writeFile(path.join(directory, 'nginx.conf'), `pid /tmp/nginx-cache-test.pid;
error_log stderr; events { worker_connections 64; }
http { access_log off;
upstream openpbl_app { server 127.0.0.1:${upstreamPort}; }
upstream openpbl_new_app { server 127.0.0.1:${upstreamPort}; }
${servers.map(server => server.config).join('\n')}
}`);
  // Separate creation from startup so cleanup knows the container already
  // exists before a potentially slow start is issued, and can retain its logs.
  await docker(['create', '--name', name, '--network', 'host',
    '--volume', `${directory}:/tmp/openpbl-cache-test:ro`, '--entrypoint', 'nginx', image,
    '-c', '/tmp/openpbl-cache-test/nginx.conf', '-g', 'daemon off;'], { timeout: DOCKER_START_TIMEOUT_MS, signal: t.signal });
  await docker(['start', name], { timeout: DOCKER_START_TIMEOUT_MS, signal: t.signal });
  let ready = false;
  const readyDeadline = Date.now() + DOCKER_COMMAND_TIMEOUT_MS;
  while (Date.now() < readyDeadline && !t.signal.aborted) {
    try { await get(servers[0].port, '/vendor/ready.js', Math.min(5000, readyDeadline - Date.now())); ready = true; break; }
    catch { await delay(100); }
  }
  if (!ready) {
    const logs = await docker(['logs', name], { signal: t.signal }).catch(() => ({ stdout: '', stderr: '' }));
    assert.fail(`Isolated Nginx did not start: ${logs.stdout}${logs.stderr}`);
  }
  for (const server of servers) {
    for (const resource of ['/vendor/maic-importer/index.js', '/vendor/pdfjs/pdf.legacy.min.mjs']) {
      assert.deepEqual(await get(server.port, resource), { status: 200, cache: 'public, max-age=0' }, server.file);
    }
    assert.deepEqual(await get(server.port, '/_next/static/chunks/example-a1b2c3.js'),
      { status: 200, cache: 'public, max-age=31536000, immutable' }, server.file);
    for (const resource of ['/_next/static/chunks/missing.js', '/vendor/missing.js', '/vendor/missing.mjs',
      '/fonts/missing.woff2', '/missing.js', '/_next/image?url=missing']) {
      assert.deepEqual(await get(server.port, resource), { status: 404, cache: 'private, no-store, max-age=0' }, `${server.file}: ${resource}`);
    }
  }
});
