// Test-only independent processes: upstream, network probe, and proxy owner.
import { createServer, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { startPrelaunchProxy } from '../prelaunch-proxy.mjs';

const reply = message => new Promise((resolve, reject) => {
  process.send(message, error => error ? reject(error) : resolve());
});
const sockets = new Set(); let app; let websocket; let proxy;
const stop = async () => {
  for (const socket of sockets) socket.destroy();
  for (const socket of websocket?.clients ?? []) socket.terminate();
  await Promise.allSettled([
    proxy?.close(),
    app ? new Promise(resolve => app.close(resolve)) : undefined,
    websocket ? new Promise(resolve => websocket.close(resolve)) : undefined,
  ]);
  process.exit(0);
};
process.once('disconnect', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.on('message', async message => {
  const { id, action, value } = message;
  try {
    if (action === 'upstream') {
      app = createServer(async (incoming, response) => {
        const chunks = [];
        try { for await (const chunk of incoming) chunks.push(chunk); }
        catch { response.destroy(); return; }
        const handlerStartedAt = Date.now();
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Server-Timing', 'handler;dur=18');
        response.setHeader('X-Upstream-Pid', String(process.pid));
        response.end(JSON.stringify({ path: incoming.url, cookie: incoming.headers.cookie,
          origin: incoming.headers.origin, body: Buffer.concat(chunks).toString(), handlerStartedAt }));
      });
      app.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
      websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise(resolve => websocket.once('listening', resolve));
      websocket.on('connection', socket => { socket.on('message', bytes => socket.send(bytes)); });
      await reply({ id, ok: true, value: { appPort: app.address().port, websocketPort: websocket.address().port, pid: process.pid } });
    } else if (action === 'owner') {
      proxy = await startPrelaunchProxy(value);
      await reply({ id, ok: true, value: { port: proxy.port, pid: proxy.pid, ownerPid: process.pid } });
    } else if (action === 'exit') {
      // Deliberately exercise the owner's process-exit hook without close().
      await reply({ id, ok: true }); process.exit(0);
    } else if (action === 'probe') {
      // ACK the schedule first; the owner can block after this promise resolves.
      await reply({ id, ok: true, value: { armed: true } });
      setTimeout(() => {
        const startedAt = Date.now(); const started = performance.now(); let connectedMs;
        const outgoing = request(value.url, { agent: false }, response => {
          const ttfbMs = performance.now() - started; const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            void reply({ event: 'probe-result', id, value: { status: response.statusCode,
              startedAt, finishedAt: Date.now(), connectedMs, ttfbMs, responseEndMs: performance.now() - started,
              serverTiming: response.headers['server-timing'], upstreamPid: Number(response.headers['x-upstream-pid']),
              body: Buffer.concat(chunks).toString() } });
          });
        });
        outgoing.on('socket', socket => socket.once('connect', () => { connectedMs = performance.now() - started; }));
        outgoing.on('error', error => { void reply({ event: 'probe-result', id, error: error.message }); });
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Independent probe timed out')));
        outgoing.end();
      }, value.delayMs);
    } else throw new Error(`Unknown fixture command ${action}`);
  } catch (error) { await reply({ id, ok: false, error: error.message }); }
});
