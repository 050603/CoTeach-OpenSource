import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const helper = new URL('./classroom-acceptance-promise-lifecycle.mjs', import.meta.url).href;
const imports = `import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { observePendingResponse, withCleanupRejectionGuard } from ${JSON.stringify(helper)};`;
async function child(source, { signal, timeout = 10000 } = {}) {
  const app = spawn(process.execPath, ['--unhandled-rejections=throw', '--input-type=module', '-e', imports + source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let signalled = false; let repeat;
  app.stdout.on('data', chunk => {
    stdout += chunk;
    if (signal && !signalled && stdout.includes('ready\n')) {
      signalled = true; app.kill(signal);
      repeat = setTimeout(() => app.kill(signal), 20);
    }
  });
  app.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => app.kill('SIGKILL'), timeout);
  try {
    const result = await new Promise((resolve, reject) => { app.once('error', reject); app.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })); });
    return { ...result, stdout, stderr };
  } finally { clearTimeout(deadline); clearTimeout(repeat); if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL'); }
}

test('an observed waiter still rejects with the exact error when awaited after a failed click', async () => {
  const result = await child(`
    const failure = new Error('closed pending response');
    const original = Promise.reject(failure);
    const response = observePendingResponse(original);
    assert.equal(response, original);
    await delay(30);
    await assert.rejects(response, error => error === failure);
    console.log('later await still rejected');
  `);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /later await still rejected/);
});

test('normal unobserved rejection remains fatal before installing cleanup protection', async () => {
  const result = await child(`Promise.reject(new Error('normal-run-failure')); await delay(100);`);
  assert.equal(result.code, 1); assert.match(result.stderr, /normal-run-failure/);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`repeated ${signal} preserves one ordered cleanup despite orphaned rejection`, async () => {
    const result = await child(`
      let cleaning;
      const order = [];
      let rejected = 0;
      const interrupt = () => {
        if (cleaning) return cleaning;
        cleaning = withCleanupRejectionGuard(async () => {
          order.push('stop-writer');
          Promise.reject(new Error('browser closed while click pending'));
          await delay(70);
          order.push('preserve-database');
          await delay(70);
          order.push('delete-owned-resources');
          assert.equal(rejected, 1);
          console.log(JSON.stringify({ order, rejected, interrupted: 'failed' }));
          process.exit(${code});
        }, () => { rejected++; });
        return cleaning;
      };
      process.on('${signal}', () => { void interrupt(); });
      console.log('ready');
      await delay(5000);
    `, { signal });
    assert.equal(result.code, code, result.stderr); assert.equal(result.signal, null);
    const evidence = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(evidence, { order: ['stop-writer', 'preserve-database', 'delete-owned-resources'], rejected: 1, interrupted: 'failed' });
  });
}

test('cleanup guard removes listeners on success and preserves fatal rejection afterwards', async () => {
  const result = await child(`
    const baseline = process.listenerCount('unhandledRejection');
    await withCleanupRejectionGuard(async () => { Promise.reject(new Error('during')); await delay(20); }, () => {});
    assert.equal(process.listenerCount('unhandledRejection'), baseline);
    Promise.reject(new Error('after-cleanup-failure')); await delay(100);
  `);
  assert.equal(result.code, 1); assert.match(result.stderr, /after-cleanup-failure/);
});

test('a failing cleanup and diagnostic sink cannot leak its temporary handler', async () => {
  const result = await child(`
    const baseline = process.listenerCount('unhandledRejection');
    const failure = new Error('cleanup failed');
    await assert.rejects(withCleanupRejectionGuard(async () => {
      Promise.reject(new Error('orphan')); await delay(20); throw failure;
    }, () => { throw new Error('diagnostic sink failed'); }), error => error === failure);
    assert.equal(process.listenerCount('unhandledRejection'), baseline);
  `);
  assert.equal(result.code, 0, result.stderr);
});

const chrome = process.env.PRELAUNCH_PROMISE_TEST_CHROME || path.resolve('.cache/browsers/chrome/opt/google/chrome/chrome');
test('real Chrome page close rejects the observed response waiter without orphaning it', { skip: !existsSync(chrome) }, async () => {
  const playwright = new URL('../../node_modules/playwright/index.mjs', import.meta.url).href;
  const result = await child(`
    const { chromium } = await import(${JSON.stringify(playwright)});
    const browser = await chromium.launch({ executablePath: ${JSON.stringify(chrome)}, headless: true, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      const response = observePendingResponse(page.waitForResponse(() => false, { timeout: 60000 }));
      await page.close();
      await delay(30);
      await assert.rejects(response, /closed/);
      console.log('native waiter rejected after close');
    } finally { await browser.close(); }
  `, { timeout: 20000 });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /native waiter rejected after close/);
});

test('cleanup protection does not intercept an unrelated synchronous exception', async () => {
  const result = await child(`
    await withCleanupRejectionGuard(async () => {
      setTimeout(() => { throw new Error('synchronous-fatal'); }, 5);
      await delay(100);
    }, () => {});
  `);
  assert.equal(result.code, 1); assert.match(result.stderr, /synchronous-fatal/);
});
