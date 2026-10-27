import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { startPrelaunchProxy } from './prelaunch-proxy.mjs';

test('isolated proxy forwards real HTTP and WebSocket traffic with origin and session intact', async t => {
  const app = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ path: request.url, cookie: request.headers.cookie,
      origin: request.headers.origin, body: Buffer.concat(chunks).toString() }));
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(websocket, 'listening');
  const proxy = await startPrelaunchProxy({ port: 0, appPort: app.address().port, websocketPort: websocket.address().port });
  t.after(async () => {
    await proxy.close();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => websocket.close(resolve))]);
  });
  const origin = `http://127.0.0.1:${proxy.port}`;
  const headers = { Cookie: 'isolated-session=synthetic', Origin: origin };
  const response = await fetch(`${origin}/api/example?view=student`, { method: 'POST', headers, body: 'submission' });
  assert.deepEqual(await response.json(), { path: '/api/example?view=student', cookie: headers.Cookie, origin, body: 'submission' });
  websocket.on('connection', (socket, request) => {
    assert.equal(request.headers.cookie, headers.Cookie);
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers.host, `127.0.0.1:${proxy.port}`);
    socket.on('message', message => socket.send(message));
  });
  const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws?role=student`, { headers });
  await once(client, 'open');
  client.send('real classroom event');
  const [message] = await once(client, 'message');
  assert.equal(message.toString(), 'real classroom event');
  const disconnected = once(client, 'close');
  await proxy.setWebSocketsBlocked(true);
  await disconnected;
  assert.equal((await fetch(`${origin}/still-available`)).status, 200);
  const unavailable = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`, { headers });
  const [unavailableError] = await once(unavailable, 'error');
  assert.match(unavailableError.message, /503/);
  await proxy.setWebSocketsBlocked(false);
  const restored = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`, { headers });
  await once(restored, 'open');
  restored.send('reconnected classroom event');
  assert.equal((await once(restored, 'message'))[0].toString(), 'reconnected classroom event');
  const restoredClosed = once(restored, 'close');
  await proxy.disconnectWebSockets();
  await restoredClosed;
  const forbidden = new WebSocket(`ws://127.0.0.1:${proxy.port}/other`, { headers });
  const [error] = await once(forbidden, 'error');
  assert.match(error.message, /404/);
});

test('isolated proxy rejects invalid ports and self-forwarding', async () => {
  await assert.rejects(startPrelaunchProxy({ port: 3198, appPort: 3198, websocketPort: 3199 }));
  await assert.rejects(startPrelaunchProxy({ port: 3198, appPort: 3197, websocketPort: -1 }));
});


function fixtureProcess(t) {
  const child = fork(new URL('./fixtures/prelaunch-proxy-process-fixture.mjs', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let nextId = 0;
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  });
  const call = (action, value) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => finish(new Error(`Fixture ${action} timed out`)), 10000);
    const onExit = () => finish(new Error(`Fixture exited during ${action}`));
    const onMessage = message => {
      if (message.id === id && !message.event) finish(message.ok ? null : new Error(message.error), message.value);
    };
    const finish = (error, result) => {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
      if (error) reject(error); else resolve(result);
    };
    child.on('message', onMessage); child.once('exit', onExit);
    child.send({ id, action, value }, error => { if (error) finish(error); });
  });
  return { child, call };
}

async function waitForClosedPort(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${port}/closed`, { signal: AbortSignal.timeout(200) }); }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED') return; }
    await delay(25);
  }
  assert.fail('Proxy port remained open after its owner exited');
}

test('independent proxy and upstream respond while the browser driver event loop is blocked', { timeout: 15000 }, async t => {
  const upstream = fixtureProcess(t); const ports = await upstream.call('upstream');
  const proxy = await startPrelaunchProxy({ port: 0, appPort: ports.appPort, websocketPort: ports.websocketPort });
  t.after(() => proxy.close());
  assert.notEqual(proxy.pid, process.pid); assert.notEqual(proxy.pid, ports.pid);
  const probe = fixtureProcess(t);
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No independent probe result')), 10000);
    probe.child.on('message', function listener(message) {
      if (message.event !== 'probe-result') return;
      clearTimeout(timer); probe.child.off('message', listener);
      if (message.error) reject(new Error(message.error)); else resolve({ ...message.value, observedAt: Date.now() });
    });
  });
  // Both servers and the network clock live in other processes. A proxy in this
  // process would not read/forward the request until after the blocking wait.
  await probe.call('probe', { url: `http://127.0.0.1:${proxy.port}/during-driver-block`, delayMs: 100 });
  const blockedAt = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  const unblockedAt = Date.now();
  const response = await received;
  t.diagnostic(JSON.stringify({ driverPid: process.pid, proxyPid: proxy.pid, blockedAt, unblockedAt, response }));
  assert.equal(response.status, 200); assert.equal(response.upstreamPid, ports.pid);
  assert.equal(response.serverTiming, 'handler;dur=18', 'Upstream timing diagnostics must survive unchanged');
  assert.ok(response.startedAt >= blockedAt && response.finishedAt < unblockedAt,
    JSON.stringify({ blockedAt, unblockedAt, response }));
  assert.ok(response.observedAt >= unblockedAt, 'The driver should only observe the result after unblocking');
  assert.ok(response.connectedMs >= 0 && response.ttfbMs >= response.connectedMs && response.responseEndMs >= response.ttfbMs);
  assert.ok(response.responseEndMs < 600, `Independent network response took ${response.responseEndMs} ms`);
  assert.equal(JSON.parse(response.body).path, '/during-driver-block');
});

test('proxy lifecycle ACK is idempotent and closes existing HTTP/WS sockets before returning', { timeout: 10000 }, async t => {
  const upstream = fixtureProcess(t); const ports = await upstream.call('upstream');
  const proxy = await startPrelaunchProxy({ port: 0, appPort: ports.appPort, websocketPort: ports.websocketPort });
  t.after(() => proxy.close());
  const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`); await once(socket, 'open');
  const socketClosed = once(socket, 'close');
  const http = connect({ host: '127.0.0.1', port: proxy.port }); t.after(() => http.destroy());
  http.on('error', () => undefined); await once(http, 'connect');
  const httpClosed = new Promise(resolve => http.once('close', resolve));
  http.write(`POST /incomplete HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nContent-Length: 100\r\n\r\npending`);
  await proxy.close(); await Promise.all([socketClosed, httpClosed]); await proxy.close();
  await waitForClosedPort(proxy.port);
  await assert.rejects(proxy.disconnectWebSockets(), /closing/);
});

for (const mode of ['exit', 'SIGKILL']) {
  test(`proxy worker cleans up after owner ${mode} without a business control endpoint`, { timeout: 15000 }, async t => {
    const upstream = fixtureProcess(t); const ports = await upstream.call('upstream');
    const owner = fixtureProcess(t);
    const proxy = await owner.call('owner', { port: 0, appPort: ports.appPort, websocketPort: ports.websocketPort });
    let closed = false;
    t.after(() => {
      // Safety cleanup only if the regression assertion itself fails.
      if (!closed) try { process.kill(proxy.pid, 'SIGKILL'); } catch { /* already reaped */ }
    });
    assert.notEqual(proxy.pid, proxy.ownerPid);
    assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/ready`)).status, 200);
    const exited = once(owner.child, 'exit');
    if (mode === 'exit') await owner.call('exit'); else owner.child.kill(mode);
    await exited; await waitForClosedPort(proxy.port); closed = true;
  });
}

test('worker death rejects future controls and startup bind failures do not hang', { timeout: 15000 }, async t => {
  const upstream = fixtureProcess(t); const ports = await upstream.call('upstream');
  await assert.rejects(startPrelaunchProxy({ port: ports.appPort, appPort: ports.websocketPort, websocketPort: 1 }), /EADDRINUSE/);
  const proxy = await startPrelaunchProxy({ port: 0, appPort: ports.appPort, websocketPort: ports.websocketPort });
  t.after(() => proxy.close().catch(() => undefined));
  process.kill(proxy.pid, 'SIGKILL'); await waitForClosedPort(proxy.port);
  await assert.rejects(proxy.setWebSocketsBlocked(true), /exited|disconnected|unavailable|closed/i);
  await assert.rejects(proxy.close(), /exited|disconnected|unavailable|closed/i);
});


test('optional timing journal preserves streaming data, headers and request IDs across completion and abort', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'acceptance-proxy-timing-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const tracePath = path.join(folder, 'proxy.ndjson');
  const seen = []; const chunks = [Buffer.from([0, 255, 195, 169]), Buffer.from([7, 8, 9])];
  const release = Promise.withResolvers(); const abortedUpstream = Promise.withResolvers();
  t.after(() => release.resolve());
  const app = createServer(async (request, response) => {
    const data = []; for await (const chunk of request) data.push(chunk);
    seen.push({ id: request.headers['x-request-id'], cookie: request.headers.cookie,
      origin: request.headers.origin, body: Buffer.concat(data).toString() });
    response.setHeader('Server-Timing', 'handler;dur=7.50, progress-read;dur=1.25');
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('X-Upstream-Header', 'retained');
    response.setHeader('x-openpbl-http-request-id', `http-${'a'.repeat(32)}-${seen.length}`);
    response.write(chunks[0]);
    if (request.url.includes('abort=true')) {
      response.once('close', () => abortedUpstream.resolve()); return;
    }
    if (seen.length === 1) await release.promise;
    response.end(chunks[1]);
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(websocket, 'listening');
  const proxy = await startPrelaunchProxy({ port: 0, appPort: app.address().port, websocketPort: websocket.address().port, tracePath });
  t.after(async () => {
    release.resolve(); await proxy.close();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => websocket.close(resolve))]);
  });
  const origin = `http://127.0.0.1:${proxy.port}`;
  const payload = JSON.stringify({ requestId: 'unchanged-business-id', document: 'private-body-text' });
  const first = await fetch(`${origin}/api/openmaic/progress`, { method: 'POST',
    headers: { Cookie: 'private-cookie', Origin: origin }, body: payload, signal: AbortSignal.timeout(5000) });
  assert.equal(first.status, 200); assert.equal(first.headers.get('x-upstream-header'), 'retained');
  const timing = first.headers.get('server-timing');
  assert.ok(timing.startsWith('handler;dur=7.50, progress-read;dur=1.25, acceptance-proxy-headers;dur='));
  const traceId = /desc="trace=([^;]+);ingressEpochMs=\d+"/.exec(timing)?.[1]; assert.ok(traceId);
  const reader = first.body.getReader();
  const firstPieces = []; let firstBytes = 0;
  while (firstBytes < chunks[0].length) {
    const part = await reader.read(); assert.equal(part.done, false);
    firstPieces.push(Buffer.from(part.value)); firstBytes += part.value.length;
  }
  assert.deepEqual(Buffer.concat(firstPieces), chunks[0], 'First bytes must arrive before producer is released');
  release.resolve(); const rest = [];
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest.push(Buffer.from(chunk.value)); }
  assert.deepEqual(Buffer.concat(rest), chunks[1]);
  const second = await fetch(`${origin}/api/server-providers?secret=do-not-retain`, {
    headers: { 'x-request-id': 'original-client-request-id' }, signal: AbortSignal.timeout(5000),
  });
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), Buffer.concat(chunks));
  assert.equal(seen[0].id, traceId); assert.equal(seen[0].body, payload);
  assert.equal(seen[0].cookie, 'private-cookie'); assert.equal(seen[0].origin, origin);
  assert.equal(second.headers.get('x-openpbl-http-request-id'), `http-${'a'.repeat(32)}-2`);
  assert.equal(seen[1].id, 'original-client-request-id', 'Existing request identity must survive unchanged');
  const controller = new AbortController();
  const interrupted = await fetch(`${origin}/api/openmaic/classroom?abort=true`, { signal: controller.signal });
  const interruptedTrace = /desc="trace=([^;]+);/.exec(interrupted.headers.get('server-timing'))?.[1]; assert.ok(interruptedTrace);
  const interruptedReader = interrupted.body.getReader(); await interruptedReader.read(); controller.abort();
  await assert.rejects(interruptedReader.read(), error => error.name === 'AbortError');
  await abortedUpstream.promise;
  await proxy.close();
  const text = await readFile(tracePath, 'utf8'); const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map(row => row.traceId)).size, 3);
  assert.deepEqual(rows.map(row => row.httpRequestId).sort(), [1, 2, 3].map(i => `http-${'a'.repeat(32)}-${i}`));
  const completed = rows.find(row => row.traceId === traceId);
  assert.equal(completed.appCorrelationId, traceId); assert.equal(completed.responseFinished, true);
  assert.equal(completed.upstreamStatus, 200); assert.equal(completed.downstreamStatus, 200);
  assert.equal(completed.upstreamBodyBytes, Buffer.concat(chunks).byteLength);
  assert.equal(completed.upstreamBodyComplete, true); assert.equal(completed.upstreamBodyEncoding, 'identity');
  assert.ok(completed.upstreamSocketMs >= 0);
  assert.ok(completed.upstreamHeadersMs >= completed.upstreamSocketMs);
  assert.ok(completed.upstreamFirstBodyMs >= completed.upstreamHeadersMs);
  assert.ok(completed.downstreamFinishMs >= completed.upstreamFirstBodyMs);
  assert.ok(completed.incomingConnection.acceptedEpochMs <= completed.requestEpochMs);
  assert.equal(rows.find(row => row.route === '/api/server-providers').appCorrelationId, undefined);
  const aborted = rows.find(row => row.traceId === interruptedTrace);
  assert.equal(aborted.responseFinished, false);
  assert.equal(aborted.upstreamBodyBytes, chunks[0].byteLength); assert.equal(aborted.upstreamBodyComplete, false);
  for (const value of ['private-cookie', 'private-body-text', 'unchanged-business-id', 'do-not-retain', 'original-client-request-id']) {
    assert.ok(!text.includes(value), `Forbidden metadata leak: ${value}`);
  }
});

test('proxy body accounting preserves encoded bytes and distinguishes empty HEAD/304 from missing upstream evidence', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'acceptance-proxy-body-size-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const tracePath = path.join(folder, 'proxy.ndjson');
  const body = Buffer.from('classroom-public-response\n'.repeat(10_000));
  const compressed = gzipSync(body);
  const app = createServer((request, response) => {
    response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Length', compressed.byteLength);
    response.statusCode = request.url.endsWith('conditional') ? 304 : 200;
    response.end(compressed);
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(websocket, 'listening');
  const proxy = await startPrelaunchProxy({ port: 0, appPort: app.address().port, websocketPort: websocket.address().port, tracePath });
  t.after(async () => {
    await proxy.close(); app.closeAllConnections();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => websocket.close(resolve))]);
  });
  const origin = `http://127.0.0.1:${proxy.port}`;
  assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/server-providers?body`)).arrayBuffer()), body);
  const publicAsset = `/_next/static/openpbl-runtime/monaco/0.56.0/${'a'.repeat(64)}/vs/loader.js`;
  assert.equal(await (await fetch(`${origin}${publicAsset}`, { method: 'HEAD' })).text(), '');
  assert.equal((await fetch(`${origin}/api/server-providers?conditional`)).status, 304);
  await proxy.close();
  const rows = (await readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 3);
  const full = rows.find(row => row.method === 'GET' && row.upstreamStatus === 200);
  assert.equal(full.upstreamBodyBytes, compressed.byteLength);
  assert.notEqual(full.upstreamBodyBytes, body.byteLength);
  assert.equal(full.upstreamBodyComplete, true); assert.equal(full.upstreamBodyEncoding, 'gzip');
  const head = rows.find(row => row.method === 'HEAD');
  assert.equal(head.upstreamBodyBytes, 0); assert.equal(head.upstreamBodyComplete, true);
  const conditional = rows.find(row => row.upstreamStatus === 304);
  assert.equal(conditional.upstreamBodyBytes, 0); assert.equal(conditional.upstreamBodyComplete, true);
  const missingTracePath = path.join(folder, 'missing-upstream.ndjson');
  const missing = await startPrelaunchProxy({ port: 0, appPort: app.address().port, websocketPort: websocket.address().port, tracePath: missingTracePath });
  t.after(() => missing.close());
  app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
  assert.equal((await fetch(`http://127.0.0.1:${missing.port}/api/server-providers`)).status, 502);
  await missing.close();
  const unknown = JSON.parse((await readFile(missingTracePath, 'utf8')).trim());
  assert.equal(unknown.upstreamBodyBytes, null); assert.equal(unknown.upstreamBodyComplete, null);
  assert.equal(unknown.upstreamBodyEncoding, null);
});

for (const connection of ['keep-alive', 'close']) {
  test(`HTTP hops reuse upstream sockets independently of downstream ${connection}, preserving auth and aborts`, { timeout: 10000 }, async t => {
    const sockets = new Map(); const seen = []; let accepted = 0; let cancelled = false;
    const app = createServer(async (request, response) => {
      request.on('error', () => undefined);
      seen.push({ socket: sockets.get(request.socket), connection: request.headers.connection });
      if (request.url === '/abort') {
        response.once('close', () => { cancelled = !response.writableFinished; });
        response.write('first chunk'); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      response.setHeader('Connection', 'keep-alive, x-upstream-hop');
      response.setHeader('X-Upstream-Hop', 'must-not-cross-hop');
      response.setHeader('Set-Cookie', ['session=retained; HttpOnly', 'second=retained']);
      response.setHeader('Server-Timing', 'handler;dur=3');
      response.end(JSON.stringify({ cookie: request.headers.cookie, origin: request.headers.origin,
        authorization: request.headers.authorization, host: request.headers.host,
        requestId: request.headers['x-request-id'], hop: request.headers['x-client-hop'] ?? null,
        body: Buffer.concat(chunks).toString() }));
    });
    app.on('connection', socket => { sockets.set(socket, ++accepted); socket.once('close', () => sockets.delete(socket)); });
    app.listen(0, '127.0.0.1'); await once(app, 'listening');
    const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(websocket, 'listening');
    const proxy = await startPrelaunchProxy({ port: 0, appPort: app.address().port, websocketPort: websocket.address().port });
    const client = new Agent({ keepAlive: true });
    t.after(async () => {
      client.destroy(); await proxy.close();
      for (const socket of sockets.keys()) socket.destroy();
      await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => websocket.close(resolve))]);
    });
    const origin = `http://127.0.0.1:${proxy.port}`;
    const headers = { connection: `${connection}, x-client-hop`, 'x-client-hop': 'must-not-cross-hop',
      cookie: 'session=synthetic', origin, authorization: 'Bearer synthetic-fixture', 'x-request-id': 'same-request-id' };
    const normal = () => new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/normal`, { method: 'POST', headers, agent: client }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.once('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers.connection, connection, 'Downstream connection policy stays local to this hop');
            assert.equal(response.headers['x-upstream-hop'], undefined);
            assert.deepEqual(response.headers['set-cookie'], ['session=retained; HttpOnly', 'second=retained']);
            assert.equal(response.headers['server-timing'], 'handler;dur=3');
            assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { cookie: headers.cookie, origin,
              authorization: headers.authorization, host: `127.0.0.1:${proxy.port}`,
              requestId: 'same-request-id', hop: null, body: 'immutable submission body' });
            resolve();
          } catch (error) { reject(error); }
        });
      }); request.once('error', reject); request.end('immutable submission body');
    });
    for (let index = 0; index < 4; index++) { await normal(); await delay(10); }
    assert.equal(accepted, 1, 'Completed requests must reuse a single upstream connection');
    assert.ok(seen.every(item => item.connection === 'keep-alive'));
    await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/abort`, { agent: client, headers }, response => {
        response.on('error', () => undefined);
        response.once('data', () => { response.destroy(); resolve(); });
      }); request.once('error', reject); request.end();
    });
    for (let index = 0; !cancelled && index < 100; index++) await delay(10);
    assert.equal(cancelled, true, 'Browser cancellation releases the active upstream response');
    await normal(); assert.equal(accepted, 2, 'The aborted socket cannot serve the next request');
    await proxy.close();
    for (let index = 0; sockets.size && index < 100; index++) await delay(10);
    assert.equal(sockets.size, 0, 'Proxy shutdown also closes its idle upstream pool');
  });
}

test('aborting an incomplete browser upload releases its upstream request', { timeout: 10000 }, async t => {
  const received = Promise.withResolvers(); const aborted = Promise.withResolvers();
  const app = createServer((request, response) => {
    request.on('error', () => undefined);
    request.once('data', () => received.resolve());
    request.once('aborted', () => { response.destroy(); aborted.resolve(); });
    request.resume();
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(websocket, 'listening');
  const proxy = await startPrelaunchProxy({ port: 0, appPort: app.address().port, websocketPort: websocket.address().port });
  t.after(async () => {
    await proxy.close(); app.closeAllConnections();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => websocket.close(resolve))]);
  });
  const request = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/partial',
    headers: { 'content-length': '100' } });
  request.on('error', () => undefined); request.write('partial'); await received.promise;
  request.destroy(); await aborted.promise;
});
