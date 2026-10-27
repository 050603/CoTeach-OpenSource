import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { inspectBrowserIdentity } from './prelaunch-browser.mjs';

// CSS viewports at 100%; native zoom keeps the outer window fixed instead.
export const desktopSizes = [
  [768, 576], [1024, 576], [1024, 768], [1280, 720], [1280, 800],
  [1366, 768], [1440, 900], [1536, 864], [1920, 1080], [1920, 1200],
  [2560, 1440], [3440, 1440], [3840, 2160],
];

export function selectLayoutCases(items, filter, id = item => item.id) {
  if (!filter) return items;
  const names = filter.split(',').map(value => value.trim()).filter(Boolean);
  const unknown = names.filter(name => !items.some(item => id(item) === name));
  assert.equal(unknown.length, 0, `Unknown layout cases: ${unknown.join(', ')}`);
  assert.ok(names.length, 'At least one layout case is required');
  return items.filter(item => names.includes(id(item)));
}

export async function runLayoutCases(items, concurrency, run) {
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8, 'Layout workers must be between 1 and 8');
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
  const errors = workers.filter(worker => worker.status === 'rejected').map(worker => worker.reason);
  if (errors.length) throw new AggregateError(errors, 'Layout worker failed');
}

export async function deployedLayoutBuild(baseURL) {
  const response = await fetch(baseURL, { signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `Acceptance service returned ${response.status}`);
  const html = await response.text();
  const buildId = html.match(/\\"b\\":\\"([^"\\]+)/)?.[1];
  assert.ok(buildId, 'The deployed Next.js build ID is missing; release evidence cannot be verified');
  return buildId;
}

export async function settleLayoutAssets(page, timeoutMs = 15_000) {
  return page.evaluate(async timeout => {
    // Decode offscreen images as well; decode() alone never requests lazy images.
    for (const img of document.images) img.loading = 'eager';
    let timer;
    try {
      await Promise.race([
        Promise.all([document.fonts.ready, ...[...document.images].map(img => img.decode().catch(() => {}))]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Assets did not settle within ${timeout}ms: ${JSON.stringify({
          fonts: [...document.fonts].filter(font => font.status === 'loading').map(font => font.family),
          images: [...document.images].filter(img => !img.complete).map(img => (img.currentSrc || img.src).slice(0, 200)),
        })}`)), timeout); }),
      ]);
      const broken = [...document.images].filter(img => (img.currentSrc || img.getAttribute('src') || img.srcset)
        && (!img.complete || !img.naturalWidth)).map(img => (img.currentSrc || img.src).slice(0, 200));
      if (broken.length) throw new Error(`Images failed to decode: ${JSON.stringify(broken)}`);
    } finally { clearTimeout(timer); }
  }, timeoutMs);
}

export async function openLayoutContext({ browser, engine = 'chromium', executablePath, label = engine,
  viewport, dpr = 1, zoom = 1, nativeZoom = false, ...options }) {
  assert.ok(Number.isFinite(zoom) && zoom >= 0.8 && zoom <= 2, 'Zoom must be between 80% and 200%');
  assert.ok(Number.isFinite(dpr) && dpr >= 0.8 && dpr <= 3, 'DPR must be between 0.8 and 3');
  if (['google-chrome', 'microsoft-edge'].includes(label)) {
    assert.ok(executablePath && path.isAbsolute(executablePath), 'A branded browser requires an absolute executable path');
  }
  let profile;
  let context;
  try {
    if (nativeZoom) {
      assert.equal(engine, 'chromium', 'Native preference zoom requires Chromium');
      assert.ok(executablePath, 'Native branded zoom requires an executable path');
      assert.equal(dpr, 1, 'Native zoom and DPR emulation must be tested independently');
      assert.ok(!options.isMobile && !options.hasTouch, 'Native desktop zoom cannot use a mobile profile');
      profile = await mkdtemp(path.join(tmpdir(), 'openpbl-layout-native-'));
      await mkdir(path.join(profile, 'Default'));
      await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({
        partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } },
      }));
      context = await chromium.launchPersistentContext(profile, {
        ...options, executablePath, headless: true, viewport: null, deviceScaleFactor: undefined,
        args: [`--window-size=${viewport.width},${viewport.height}`],
      });
    } else {
      assert.ok(browser, 'A launched browser is required for viewport checks');
      context = await browser.newContext({ ...options, viewport: {
        width: Math.round(viewport.width / zoom), height: Math.round(viewport.height / zoom),
      }, deviceScaleFactor: dpr });
    }
    const identity = executablePath
      ? await inspectBrowserIdentity({ label, executablePath }, context)
      : { label, version: context.browser().version(), executablePath: null };
    return { context, identity, close: async () => {
      try { await context.close(); }
      finally { if (profile) await rm(profile, { recursive: true, force: true }); }
    } };
  } catch (error) {
    try { await context?.close(); }
    finally { if (profile) await rm(profile, { recursive: true, force: true }); }
    throw error;
  }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ zoom?: number, dpr?: number, nativeZoom?: boolean, physicalWidth?: number, physicalHeight?: number }} [options]
 */
export async function measureLayoutEnvironment(page, { zoom = 1, dpr = 1, nativeZoom = false,
  physicalWidth, physicalHeight } = {}) {
  const actual = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, outerWidth, outerHeight,
    devicePixelRatio, visualViewportScale: visualViewport?.scale,
    bodyCssZoom: getComputedStyle(document.body).zoom,
    rootCssZoom: getComputedStyle(document.documentElement).zoom,
    userAgent: navigator.userAgent, platform: navigator.platform,
  }));
  if (nativeZoom) {
    assert.equal(actual.outerWidth, physicalWidth, 'Native window width changed');
    assert.equal(actual.outerHeight, physicalHeight, 'Native window height changed');
    // Edge reserves a native border; allow that measured border, not a viewport override.
    assert.ok(Math.abs(actual.width * zoom - physicalWidth) <= 16, 'Native CSS width does not match zoom');
    assert.ok(Math.abs(actual.devicePixelRatio - zoom) < 0.01, 'Native DPR does not match zoom');
    assert.equal(actual.visualViewportScale, 1, 'Pinch zoom is not native page zoom');
    assert.equal(actual.bodyCssZoom, '1', 'Body CSS zoom cannot stand in for native zoom');
    assert.equal(actual.rootCssZoom, '1', 'Root CSS zoom cannot stand in for native zoom');
  } else {
    assert.ok(Math.abs(actual.devicePixelRatio - dpr) < 0.01, 'Unexpected emulated DPR');
  }
  return { ...actual, zoom, requestedDpr: dpr,
    zoomMode: nativeZoom ? 'native-browser-preference' : zoom === 1 ? 'viewport' : 'equivalent-css-viewport' };
}

export async function captureLayoutScreenshot(page, file, nativeZoom = false) {
  if (!nativeZoom) return page.screenshot({ path: file });
  await page.screenshot();
  const cdp = await page.context().newCDPSession(page);
  try {
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    await writeFile(file, Buffer.from(capture.data, 'base64'));
  } finally { await cdp.detach(); }
}

export async function resizeLayoutWindow(page, viewport, nativeZoom = false) {
  if (!nativeZoom) return page.setViewportSize(viewport);
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...viewport, windowState: 'normal' } });
    await page.waitForFunction(({ width, height }) => outerWidth === width && outerHeight === height, viewport);
  } finally { await cdp.detach(); }
}
