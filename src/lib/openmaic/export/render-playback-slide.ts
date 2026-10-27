import type { Browser, BrowserContext } from 'playwright-core';
import sharp from 'sharp';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import { launchSlideBrowser } from '../generation/slide-browser';

const RENDER_PATH = '/internal/slide-export';
const CAPTURE_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_CANVAS_SIDE = 4096;
const MAX_CANVAS_AREA = 8_388_608;
const ELEMENT_TYPES = new Set(['text', 'image', 'shape', 'line', 'chart', 'table', 'latex', 'video', 'audio', 'code']);
let browser: Browser | undefined;
let queue: Promise<void> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function coordinate(value: unknown): value is number {
  return finite(value) && Math.abs(value) <= 100_000;
}

function point(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(coordinate);
}

/** Reject malformed geometry before Chromium allocates a bitmap. Keep the
 * authored content intact: large chart values and off-canvas elements are valid. */
export function assertPlaybackSlideScene(value: unknown): asserts value is Scene & { type: 'slide'; content: SlideContent } {
  if (!record(value) || value.type !== 'slide' || typeof value.id !== 'string'
    || (value.stageId !== undefined && typeof value.stageId !== 'string') || !record(value.content) || value.content.type !== 'slide'
    || !record(value.content.canvas)) throw new Error('仅支持有效的 PPT 页面');
  const canvas = value.content.canvas;
  const width = canvas.viewportSize === undefined ? 1000 : canvas.viewportSize;
  const ratio = canvas.viewportRatio === undefined ? 0.5625 : canvas.viewportRatio;
  if (!finite(width) || !finite(ratio) || width < 1 || ratio <= 0
    || width > MAX_CANVAS_SIDE || width * ratio < 1 || width * ratio > MAX_CANVAS_SIDE
    || width * width * ratio > MAX_CANVAS_AREA) throw new Error('PPT 页面尺寸超出支持范围');
  if (!record(canvas.theme) || typeof canvas.theme.fontName !== 'string' || typeof canvas.theme.fontColor !== 'string'
    || !Array.isArray(canvas.elements) || canvas.elements.length > 2000) throw new Error('PPT 页面缺少主题或有效元素');

  for (const element of canvas.elements) {
    if (!record(element) || typeof element.id !== 'string' || !ELEMENT_TYPES.has(String(element.type))
      || !coordinate(element.left) || !coordinate(element.top) || !coordinate(element.width) || element.width < 0
      || (element.type !== 'line' && (!coordinate(element.height) || element.height < 0))
      || (element.rotate !== undefined && !coordinate(element.rotate))) throw new Error('PPT 元素类型或几何数据无效');
    if (element.type === 'line' && (!point(element.start) || !point(element.end)
      || !Array.isArray(element.points) || element.points.length !== 2
      || element.points.some((item) => !['', 'arrow', 'dot'].includes(item)))) throw new Error('PPT 线条数据无效');
    if (element.type === 'line') {
      for (const key of ['broken', 'broken2', 'curve']) {
        if (element[key] !== undefined && !point(element[key])) throw new Error('PPT 线条控制点无效');
      }
      if (element.cubic !== undefined && (!Array.isArray(element.cubic)
        || element.cubic.length !== 2 || !element.cubic.every(point))) throw new Error('PPT 线条控制点无效');
    }
    if (element.type === 'shape' && (typeof element.path !== 'string' || !point(element.viewBox)
      || (element.viewBox as number[]).some((side) => side <= 0))) throw new Error('PPT 形状数据无效');
    if (element.type === 'text' && typeof element.content !== 'string') throw new Error('PPT 文本数据无效');
    if (element.type === 'image' && typeof element.src !== 'string') throw new Error('PPT 图片数据无效');
    if (element.type === 'latex' && typeof element.latex !== 'string') throw new Error('PPT 公式数据无效');
    if (element.type === 'code' && (!Array.isArray(element.lines) || element.lines.some((line) =>
      !record(line) || typeof line.id !== 'string' || typeof line.content !== 'string'))) throw new Error('PPT 代码数据无效');
  }
  // JSON may contain 1e309, and nested styles/paths also influence layout.
  const pending: Array<{ value: unknown; depth: number }> = [{ value: canvas, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > 200_000 || current.depth > 64) throw new Error('PPT 页面数据过于复杂');
    if (typeof current.value === 'number' && !finite(current.value)) throw new Error('PPT 页面包含无效数值');
    if (current.value && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function renderUrl(): URL {
  const configured = process.env.OPENPBL_SLIDE_EXPORT_URL?.trim() || process.env.OPENPBL_LAYOUT_AUDIT_URL?.trim();
  const url = new URL(configured || `http://127.0.0.1:${process.env.PORT?.trim() || '3000'}`);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('PPT 截图服务必须使用本机 loopback 地址');
  return new URL(RENDER_PATH, url.origin);
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

async function resetBrowser(): Promise<void> {
  const current = browser;
  browser = undefined;
  await current?.close().catch(() => undefined);
}

/** Close only after queued screenshots finish; useful for orderly worker/test shutdown. */
export function closePlaybackSlideBrowser(): Promise<void> {
  return serialized(async () => {
    clearIdleTimer();
    await resetBrowser();
  });
}

async function restrictNetwork(context: BrowserContext, target: URL): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return route.abort('blockedbyclient'); }
    // Do not let an encoded traversal escape the static-resource allowlist
    // when Next.js decodes the path after browser routing has approved it.
    const safePath = !/[\\\0%]/.test(path) && !path.split('/').some((part) => part === '.' || part === '..');
    const allowedPath = safePath && (path === RENDER_PATH || path.startsWith('/_next/static/')
      || /^\/fonts\/[^?]*\.(?:woff2?|ttf|otf)$/i.test(path));
    if (request.method() === 'GET' && url.origin === target.origin && allowedPath) return route.continue();
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    // Next's development client waits for HMR before mounting the page.
    // Production captures never need a WebSocket connection.
    if (process.env.NODE_ENV !== 'production' && url.host === target.host && url.pathname === '/_next/webpack-hmr') {
      socket.connectToServer();
    } else {
      socket.close();
    }
  });
}

async function bounded<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('播放器页面渲染超时')), CAPTURE_TIMEOUT_MS);
      timer.unref?.();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Capture the actual playback components, including browser SVG rendering.
 * Only Chromium is reused: every page receives a fresh context with no user cookies. */
export async function renderPlaybackSlide(scene: Scene): Promise<Buffer> {
  assertPlaybackSlideScene(scene);
  const target = renderUrl();
  const canvas = scene.content.canvas;
  const width = canvas.viewportSize || 1000;
  const height = width * (canvas.viewportRatio || 0.5625);
  return serialized(async () => {
    clearIdleTimer();
    let context: BrowserContext | undefined;
    let failed = false;
    try {
      if (!browser?.isConnected()) browser = await launchSlideBrowser();
      context = await browser.newContext({
        viewport: { width: Math.ceil(width), height: Math.ceil(height) },
        deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce',
        serviceWorkers: 'block', acceptDownloads: false,
      });
      await restrictNetwork(context, target);
      const page = await context.newPage();
      page.setDefaultTimeout(CAPTURE_TIMEOUT_MS);
      await page.goto(target.href, { waitUntil: 'load', timeout: 20_000 });
      await page.waitForFunction(() => typeof window.__openPblRenderExportSlide === 'function', undefined, { timeout: 10_000 });
      await bounded(page.evaluate(async (input) => {
        if (!window.__openPblRenderExportSlide) throw new Error('播放器截图入口尚未就绪');
        await window.__openPblRenderExportSlide(input);
      }, scene));
      const root = page.locator('[data-pptx-export-canvas]');
      await root.waitFor({ state: 'visible' });
      const bounds = await root.boundingBox();
      if (!bounds || Math.abs(bounds.width - width) > 0.1 || Math.abs(bounds.height - height) > 0.1) {
        throw new Error('播放器截图画布尺寸不匹配');
      }
      // Chromium truncates fractional CSS clips before applying device scale.
      // Capture the enclosing pixels and crop losslessly at physical resolution.
      const png = await page.screenshot({ type: 'png', scale: 'device', animations: 'disabled',
        clip: { x: bounds.x, y: bounds.y, width: Math.ceil(width), height: Math.ceil(height) },
        timeout: CAPTURE_TIMEOUT_MS });
      return await sharp(png).extract({ left: 0, top: 0, width: Math.round(width * 2), height: Math.round(height * 2) }).png().toBuffer();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await context?.close().catch(() => undefined);
      if (failed) await resetBrowser();
      else {
        idleTimer = setTimeout(() => { void closePlaybackSlideBrowser(); }, IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      }
    }
  });
}
