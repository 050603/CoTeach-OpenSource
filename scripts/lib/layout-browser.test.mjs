import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { desktopSizes, selectLayoutCases, runLayoutCases, openLayoutContext, deployedLayoutBuild, settleLayoutAssets } from './layout-browser.mjs';

test('desktop acceptance retains low-height, 16:10, ultrawide and 4K cases', () => {
  const sizes = desktopSizes.map(([w, h]) => `${w}x${h}`);
  assert.equal(sizes.length, 13);
  assert.equal(new Set(sizes).size, sizes.length);
  for (const size of ['768x576', '1024x576', '1280x800', '1920x1200', '3440x1440', '3840x2160']) {
    assert.ok(sizes.includes(size));
  }
});

test('filters reject partially misspelled cases instead of reporting incomplete coverage as passed', () => {
  const items = [{ id: 'desktop' }, { id: 'phone' }];
  assert.deepEqual(selectLayoutCases(items, 'desktop'), [items[0]]);
  assert.throws(() => selectLayoutCases(items, 'desktop,unknown'), /Unknown layout cases: unknown/);
  assert.throws(() => selectLayoutCases(items, ','), /At least one/);
});

test('independent layout cases respect the worker bound and settle before reporting an infrastructure failure', async () => {
  let active = 0, peak = 0;
  const complete = [];
  await runLayoutCases([1, 2, 3, 4, 5], 3, async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    complete.push(value); active--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(complete.sort(), [1, 2, 3, 4, 5]);
  let settled = false;
  await assert.rejects(runLayoutCases([1, 2], 2, async value => {
    if (value === 1) throw new Error('Infrastructure unavailable');
    await new Promise(resolve => setTimeout(resolve, 5)); settled = true;
  }), /Layout worker failed/);
  assert.ok(settled);
  await assert.rejects(runLayoutCases([1], 0, async () => {}), /workers/);
});

test('native acceptance rejects DPR simulation, missing binaries and non-desktop profiles before launch', async () => {
  const base = { viewport: { width: 1366, height: 768 }, nativeZoom: true, executablePath: '/test/chrome' };
  await assert.rejects(openLayoutContext({ ...base, dpr: 1.25 }), /tested independently/);
  await assert.rejects(openLayoutContext({ ...base, hasTouch: true }), /mobile profile/);
  await assert.rejects(openLayoutContext({ ...base, engine: 'webkit' }), /requires Chromium/);
  await assert.rejects(openLayoutContext({ ...base, executablePath: undefined }), /requires an executable/);
  await assert.rejects(openLayoutContext({ ...base, label: 'microsoft-edge', executablePath: undefined }), /absolute executable/);
  await assert.rejects(openLayoutContext({ ...base, zoom: NaN }), /Zoom/);
});

test('the audit rejects an empty browser selection and clears stale passing evidence', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'openpbl-empty-browser-test-'));
  try {
    writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ results: [{ status: '通过' }] }));
    const run = spawnSync(process.execPath, ['scripts/run-prelaunch-audit.mjs', '--desktop-compat'], {
      env: { ...process.env, PRELAUNCH_BROWSERS: ',', PRELAUNCH_OUTPUT_DIR: output }, encoding: 'utf8',
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /At least one browser/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(output, 'summary.json'), 'utf8')).results, []);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test('release evidence rejects a healthy HTTP response with no identifiable application build', async () => {
  let body = '<html>Unrelated service</html>';
  const server = createServer((_request, response) => response.end(body));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(deployedLayoutBuild(address), /build ID is missing/);
    body = String.raw`<script>self.__next_f.push([1,"0:{\"b\":\"release-fixture\"}"])</script>`;
    assert.equal(await deployedLayoutBuild(address), 'release-fixture');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('offscreen lazy images are requested and unresolved assets fail with bounded diagnostics', {
  skip: !process.env.LAYOUT_TEST_EXECUTABLE_PATH,
}, async () => {
  const server = createServer((request, response) => {
    if (request.url === '/slow.svg') return;
    response.setHeader('content-type', 'image/svg+xml');
    if (request.url === '/broken.svg') return response.end('Invalid image with a successful HTTP status');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.LAYOUT_TEST_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
    await page.setContent(`<div style="height:10000px"></div><img loading="lazy" src="${address}/asset.svg">`);
    await settleLayoutAssets(page, 2000);
    assert.equal(await page.locator('img').evaluate(img => img.complete && img.naturalWidth === 20), true);
    await page.setContent(`<div style="height:10000px"></div><img loading="lazy" src="${address}/broken.svg">`);
    await assert.rejects(settleLayoutAssets(page, 2000), /Images failed to decode.*broken\.svg/);
    await page.setContent(`<div style="height:10000px"></div><img loading="lazy" src="${address}/slow.svg">`);
    await assert.rejects(settleLayoutAssets(page, 100), /Assets did not settle within 100ms.*slow\.svg/);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
