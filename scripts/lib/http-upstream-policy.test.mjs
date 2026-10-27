import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { HTTP_UPSTREAM_POLICY, createHttpUpstreamAgent } from './http-upstream-policy.mjs';

async function listen(handler) {
  const server = createServer(handler); let count = 0;
  const sockets = new WeakMap();
  server.on('connection', socket => sockets.set(socket, ++count));
  server.keepAliveTimeout = HTTP_UPSTREAM_POLICY.serverKeepAliveMs;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const agent = createHttpUpstreamAgent();
  return { server, agent, sockets, port: server.address().port,
    async close() { agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const send = ({ agent, port }, method, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const req = request({ host: '127.0.0.1', port, path: '/', method, agent,
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }) }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    response.on('error', reject);
  });
  req.on('error', reject); req.end(data);
});

test('an upstream connection survives the former five-second idle boundary and preserves a subsequent POST', { timeout: 12000 }, async () => {
  let application; const requests = [];
  application = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: req.method, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ connection: application.sockets.get(req.socket), body }));
  });
  try {
    const first = await send(application, 'GET');
    assert.equal(first.status, 200); assert.match(first.headers['keep-alive'], /^timeout=65(?:,|$)/);
    await delay(5250);
    const immutable = { requestId: 'retained-request', version: 2, content: '已确认的原始内容' };
    const second = await send(application, 'POST', immutable);
    assert.equal(second.status, 200); assert.equal(second.body.connection, first.body.connection);
    assert.deepEqual(second.body.body, immutable);
    assert.deepEqual(requests, [{ method: 'GET', body: null }, { method: 'POST', body: immutable }]);
  } finally { await application.close(); }
});

test('an explicitly aborted response poisons its socket and never triggers a hidden POST replay', { timeout: 5000 }, async () => {
  let application; let posts = 0; let abandonedConnection;
  application = await listen(async (req, res) => {
    for await (const chunk of req) assert.ok(chunk.length > 0);
    if (req.method === 'POST') {
      posts++; abandonedConnection = application.sockets.get(req.socket);
      res.setHeader('Content-Type', 'application/json'); res.write('{"accepted":');
      return;
    }
    res.end(JSON.stringify({ connection: application.sockets.get(req.socket) }));
  });
  try {
    await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: application.port, path: '/', method: 'POST', agent: application.agent }, response => {
        const socket = response.socket;
        socket.once('close', resolve);
        response.on('error', () => undefined);
        response.once('data', () => req.destroy());
      });
      req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); }); req.end('retained-body');
    });
    const next = await send(application, 'GET');
    assert.equal(posts, 1); assert.equal(next.status, 200);
    assert.notEqual(next.body.connection, abandonedConnection);
  } finally { await application.close(); }
});

test('all production launchers and Nginx templates retain the same bounded idle policy', async () => {
  const text = name => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
  const shell = await text('scripts/openpbl-production-service.sh');
  assert.ok(shell.includes(`export KEEP_ALIVE_TIMEOUT="\u0024{KEEP_ALIVE_TIMEOUT:-${HTTP_UPSTREAM_POLICY.serverKeepAliveMs}}"`));
  assert.match(await text('Dockerfile'), new RegExp(`KEEP_ALIVE_TIMEOUT=${HTTP_UPSTREAM_POLICY.serverKeepAliveMs}\\s`));
  for (const file of ['deploy/nginx.conf', 'deploy/nginx/openpbl.conf.template', 'deploy/nginx/openpbl-http.conf.template']) {
    const config = await text(file);
    const app = config.match(/upstream (?:openpbl_app|openpbl_new_app) \{([\s\S]*?)^\}/m)?.[1];
    assert.ok(app, file);
    assert.match(app, new RegExp(`keepalive ${HTTP_UPSTREAM_POLICY.maxIdleSockets};`));
    assert.match(app, new RegExp(`keepalive_timeout ${HTTP_UPSTREAM_POLICY.upstreamIdleMs / 1000}s;`));
    assert.ok(HTTP_UPSTREAM_POLICY.serverKeepAliveMs > HTTP_UPSTREAM_POLICY.upstreamIdleMs);
  }
  const agent = createHttpUpstreamAgent();
  try { assert.equal(agent.maxSockets, Infinity, 'Idle retention must not cap active model requests'); }
  finally { agent.destroy(); }
});
