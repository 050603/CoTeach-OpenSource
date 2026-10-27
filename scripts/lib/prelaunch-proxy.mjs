import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

/** Keep all HTTP/WS bytes outside the Playwright driver's event loop. Only
 * lifecycle/fault commands cross IPC; every command resolves after worker ACK.
 */
export async function startPrelaunchProxy({ port, appPort, websocketPort, tracePath }) {
  for (const [name, value] of Object.entries({ port, appPort, websocketPort })) {
    assert.ok(Number.isInteger(value) && value >= (name === 'port' ? 0 : 1) && value <= 65535, `Invalid ${name}`);
  }
  assert.notEqual(appPort, websocketPort);
  if (port) { assert.notEqual(port, appPort); assert.notEqual(port, websocketPort); }
  const child = fork(new URL('./prelaunch-proxy-worker.mjs', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const pending = new Map();
  let sequence = 0; let failure; let exited = false; let closePromise; let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const rejectPending = error => {
    failure ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const parentExit = () => { if (!exited) child.kill('SIGTERM'); };
  process.once('exit', parentExit);
  let exitResolve;
  const exit = new Promise(resolve => { exitResolve = resolve; });
  child.on('error', error => {
    rejectPending(error);
    if (!child.pid) { exited = true; process.off('exit', parentExit); exitResolve(); }
  });
  child.once('exit', (code, signal) => {
    exited = true; process.off('exit', parentExit);
    rejectPending(new Error(`Isolated proxy exited (${signal ?? code})${stderr ? `: ${stderr}` : ''}`));
    exitResolve({ code, signal });
  });
  child.on('disconnect', () => rejectPending(new Error('Isolated proxy IPC disconnected')));
  child.on('message', message => {
    const entry = pending.get(message?.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.ok === true) entry.resolve(message.value);
    else entry.reject(new Error(message.error ?? 'Isolated proxy command failed'));
  });
  const command = (action, value) => new Promise((resolve, reject) => {
    if (failure || exited || !child.connected) { reject(failure ?? new Error('Isolated proxy is unavailable')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`Isolated proxy ${action} ACK timed out`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, action, value }, error => {
      if (!error) return;
      const entry = pending.get(id);
      if (entry) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error); }
    });
  });
  const waitForExit = async () => {
    let timer;
    try {
      return await Promise.race([exit, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Isolated proxy did not exit')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const terminate = async () => { if (!exited) child.kill('SIGKILL'); await waitForExit(); };
  const close = () => {
    if (!closePromise) closePromise = (async () => {
      try {
        await command('close');
        const result = await waitForExit();
        assert.equal(result?.code, 0, `Isolated proxy close failed: ${result?.signal}`);
      } catch (error) { await terminate(); throw error; }
    })();
    return closePromise;
  };
  const control = (action, value) => closePromise
    ? Promise.reject(new Error('Isolated proxy is closing')) : command(action, value);
  try {
    const ready = await command('start', { port, appPort, websocketPort, tracePath });
    assert.equal(ready.pid, child.pid);
    return { port: ready.port, pid: ready.pid, close,
      disconnectWebSockets: () => control('disconnectWebSockets'),
      setWebSocketsBlocked: blocked => {
        assert.equal(typeof blocked, 'boolean');
        return control('setWebSocketsBlocked', blocked);
      },
    };
  } catch (error) { await terminate(); throw error; }
}
