import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createMetadataJournal, diagnosticRoute, readNativeHttpRequestId } from './prelaunch-http-diagnostics.mjs';
import { createHttpUpstreamAgent } from './http-upstream-policy.mjs';

// Connection headers describe one hop, not the browser-to-app chain. Leave
// credentials, cookies, origin, body framing length and end-to-end headers intact.
// WebSocket upgrade uses its separate raw tunnel and does not call this helper.
function forwardingHeaders(original) {
  const headers = { ...original };
  const nominated = String(headers.connection ?? '').split(',').map(name => name.trim().toLowerCase());
  for (const name of ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...nominated]) {
    delete headers[name];
  }
  return headers;
}

// A real, loopback-only reverse proxy lets the unmodified production browser
// bundle use its same-origin /ws URL against disposable application services.
async function startPrelaunchProxyServer({ port, appPort, websocketPort, tracePath }) {
  for (const [name, value] of Object.entries({ port, appPort, websocketPort })) {
    assert.ok(Number.isInteger(value) && value >= (name === 'port' ? 0 : 1) && value <= 65535, `Invalid ${name}`);
  }
  assert.notEqual(appPort, websocketPort);
  if (port) {
    assert.notEqual(port, appPort);
    assert.notEqual(port, websocketPort);
  }
  if (tracePath !== undefined) assert.ok(typeof tracePath === 'string' && path.isAbsolute(tracePath), 'Invalid diagnostic path');
  const journal = tracePath ? createMetadataJournal(tracePath) : null;
  const tracePrefix = `acceptance-${randomUUID().slice(0, 8)}-${process.pid}`;
  const connections = new WeakMap(); let connectionSequence = 0; let requestSequence = 0;
  const sockets = new Set();
  const websocketSockets = new Set();
  // Own the pool so proxy.close() releases idle upstream sockets too. As with
  // nginx keepalive, the shared policy bounds idle sockets, not active work.
  // Node 22/24 globalAgent already keeps sockets alive; this makes ownership
  // and normal/aborted lifecycle explicit rather than assuming no prior reuse.
  const upstreamAgent = createHttpUpstreamAgent();
  let websocketsBlocked = false;
  const proxy = createServer((incoming, outgoing) => {
    const route = journal && diagnosticRoute(incoming.method, (incoming.url ?? '/').split('?', 1)[0]);
    const started = performance.now();
    const trace = route ? { traceId: `${tracePrefix}-${++requestSequence}`, proxyPid: process.pid,
      requestEpochMs: Date.now(), method: incoming.method, route,
      incomingConnection: connections.get(incoming.socket) ?? null,
      upstreamBodyBytes: null, upstreamBodyComplete: null, upstreamBodyEncoding: null } : null;
    const mark = name => { if (trace && trace[name] === undefined) trace[name] = performance.now() - started; };
    const headers = forwardingHeaders(incoming.headers);
    // Only add a diagnostic ID when absent. Existing callers' IDs and all body
    // idempotency keys are untouched; scoped routes do not use this header as a key.
    if (trace && headers['x-request-id'] === undefined) {
      headers['x-request-id'] = trace.traceId; trace.appCorrelationId = trace.traceId;
    }
    const responseHeaders = original => {
      const forwarded = forwardingHeaders(original);
      if (!trace) return forwarded;
      const previous = forwarded['server-timing'];
      const timing = `acceptance-proxy-headers;dur=${(performance.now() - started).toFixed(3)};desc="trace=${trace.traceId};ingressEpochMs=${trace.requestEpochMs}"`;
      return { ...forwarded, 'server-timing': [...(Array.isArray(previous) ? previous : previous ? [previous] : []), timing].join(', ') };
    };
    const upstream = request({ hostname: '127.0.0.1', port: appPort, method: incoming.method,
      path: incoming.url, headers, agent: upstreamAgent }, response => {
      mark('upstreamHeadersMs'); if (trace) {
        trace.upstreamStatus = response.statusCode;
        trace.upstreamBodyBytes = 0; trace.upstreamBodyComplete = false;
        const encoding = response.headers['content-encoding'];
        trace.upstreamBodyEncoding = encoding === undefined ? 'identity'
          : ['identity', 'br', 'gzip', 'deflate'].includes(encoding) ? encoding : 'unknown';
        const httpRequestId = readNativeHttpRequestId(response.headers['x-openpbl-http-request-id']);
        if (httpRequestId) trace.httpRequestId = httpRequestId;
      }
      outgoing.writeHead(response.statusCode ?? 502, responseHeaders(response.headers));
      response.pipe(outgoing);
      if (trace) {
        // Count the existing pipe's compressed body chunks without copying or
        // retaining bytes. This is upstream body size, not browser delivery or
        // HTTP framing. Aborted responses retain their observed prefix only.
        response.on('data', chunk => { mark('upstreamFirstBodyMs'); trace.upstreamBodyBytes += chunk.byteLength; });
        response.once('end', () => { mark('upstreamEndMs'); trace.upstreamBodyComplete = response.complete; });
      }
    });
    if (trace) {
      upstream.once('socket', socket => {
        mark('upstreamSocketMs'); trace.upstreamReusedSocket = upstream.reusedSocket;
        if (socket.connecting) socket.once('connect', () => mark('upstreamConnectMs'));
      });
      upstream.once('finish', () => mark('upstreamRequestWrittenMs'));
      outgoing.once('finish', () => mark('downstreamFinishMs'));
      outgoing.once('close', () => {
        mark('downstreamCloseMs'); trace.downstreamStatus = outgoing.statusCode;
        trace.responseFinished = outgoing.writableFinished; journal.write(trace);
      });
    }
    upstream.on('error', error => {
      if (trace) trace.errorCode = /^E[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UPSTREAM_ERROR';
      if (!outgoing.headersSent) outgoing.writeHead(502, responseHeaders({}));
      outgoing.end('Isolated application unavailable');
    });
    incoming.once('aborted', () => upstream.destroy());
    outgoing.once('close', () => {
      // A normal response close is not a browser cancellation. Node already
      // guards released requests today; avoid relying on that event ordering.
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  proxy.on('connection', socket => {
    if (journal) connections.set(socket, { id: ++connectionSequence, acceptedEpochMs: Date.now() });
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (incoming, socket, head) => {
    if (new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (websocketsBlocked) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port: websocketPort }, () => {
      const headers = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
      }
      upstream.write(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    websocketSockets.add(socket);
    sockets.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => { websocketSockets.delete(socket); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', () => { proxy.off('error', reject); resolve(); });
  });
  const disconnectWebSockets = () => Promise.all([...websocketSockets].map(socket => new Promise(resolve => {
    socket.once('close', resolve); socket.destroy();
  })));
  let closePromise;
  return {
    port: proxy.address().port,
    disconnectWebSockets,
    setWebSocketsBlocked: async blocked => {
      assert.equal(typeof blocked, 'boolean');
      websocketsBlocked = blocked;
      if (blocked) await disconnectWebSockets();
    },
    close: () => closePromise ??= (async () => {
      upstreamAgent.destroy();
      await new Promise((resolve, reject) => {
        proxy.close(error => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      await journal?.close();
    })(),
  };
}


// A missing parent channel is a shutdown signal, including parent SIGKILL.
// No HTTP administration endpoint is added to the application or proxy.
assert.ok(process.send, 'The isolated proxy worker requires its parent IPC channel');
let proxy; let queue = Promise.resolve(); let stopping;
const send = message => new Promise((resolve, reject) => {
  if (!process.connected) { reject(new Error('Proxy parent disconnected')); return; }
  process.send(message, error => error ? reject(error) : resolve());
});
const stop = (code = 0) => stopping ??= (async () => {
  const fallback = setTimeout(() => process.exit(1), 3000); fallback.unref();
  try { await proxy?.close(); }
  catch { code = 1; }
  finally { if (process.connected) process.disconnect(); process.exit(code); }
})();
process.once('disconnect', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.on('message', message => {
  queue = queue.then(async () => {
    const { id, action, value } = message ?? {};
    try {
      assert.ok(Number.isSafeInteger(id) && id > 0, 'Invalid proxy command ID');
      if (action === 'start') {
        assert.ok(!proxy && !stopping, 'Isolated proxy already started or stopped');
        proxy = await startPrelaunchProxyServer(value);
        await send({ id, ok: true, value: { port: proxy.port, pid: process.pid } });
      } else if (action === 'close') {
        await proxy?.close();
        await send({ id, ok: true });
        await stop();
      } else {
        assert.ok(proxy && !stopping, 'Isolated proxy is not running');
        if (action === 'disconnectWebSockets') await proxy.disconnectWebSockets();
        else if (action === 'setWebSocketsBlocked') await proxy.setWebSocketsBlocked(value);
        else throw new Error(`Unsupported proxy command: ${action}`);
        await send({ id, ok: true });
      }
    } catch (error) { await send({ id, ok: false, error: String(error.message) }); }
  }).catch(() => stop(1));
});
