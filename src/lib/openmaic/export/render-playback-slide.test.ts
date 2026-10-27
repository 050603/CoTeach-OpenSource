// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('../generation/slide-browser', () => ({ launchSlideBrowser: mocks.launch }));
import { assertPlaybackSlideScene, closePlaybackSlideBrowser, renderPlaybackSlide } from './render-playback-slide';

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 2000, height: 1126, channels: 3, background: '#fff' } }).png().toBuffer();
});

function scene(): Scene & { type: 'slide'; content: SlideContent } {
  return { id: 'page', stageId: 'course', type: 'slide', title: '页面', order: 0,
    content: { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625,
      theme: { fontName: 'Arial', fontColor: '#333', themeColors: [], backgroundColor: '#fff' },
      elements: [{ id: 'arrow', type: 'line', left: 20, top: 20, width: 3, start: [0, 0], end: [100, 0],
        points: ['', 'arrow'], color: '#111', style: 'solid' }] } } };
}

function browserFixture() {
  const contexts: ReturnType<typeof contextFixture>[] = [];
  const browser = { isConnected: vi.fn(() => true), close: vi.fn(async () => undefined),
    newContext: vi.fn(async () => { const context = contextFixture(); contexts.push(context); return context; }) };
  return { browser, contexts };
}

function contextFixture() {
  const locator = { waitFor: vi.fn(async () => undefined), boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 1000, height: 562.5 })) };
  const page = { setDefaultTimeout: vi.fn(), goto: vi.fn(async () => undefined), waitForFunction: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined), locator: vi.fn(() => locator), screenshot: vi.fn(async (): Promise<Buffer> => png) };
  return { route: vi.fn(async (..._args: unknown[]) => undefined), routeWebSocket: vi.fn(async (..._args: unknown[]) => undefined),
    close: vi.fn(async () => undefined), newPage: vi.fn(async () => page), page, locator };
}

describe('native playback slide capture', () => {
  let fixture: ReturnType<typeof browserFixture>;
  beforeEach(() => {
    vi.useRealTimers();
    fixture = browserFixture();
    mocks.launch.mockReset().mockResolvedValue(fixture.browser);
    vi.stubEnv('OPENPBL_SLIDE_EXPORT_URL', 'http://127.0.0.1:3199/a-different-path?ignored=yes');
    vi.stubEnv('OPENPBL_LAYOUT_AUDIT_URL', '');
  });
  afterEach(async () => {
    await closePlaybackSlideBrowser();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('captures exact device pixels and reuses only Chromium across isolated contexts', async () => {
    const input = scene();
    expect(await sharp(await renderPlaybackSlide(input)).metadata()).toMatchObject({ width: 2000, height: 1125 });
    await renderPlaybackSlide(input);
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(fixture.browser.newContext).toHaveBeenCalledTimes(2);
    expect(fixture.browser.newContext).toHaveBeenCalledWith({ viewport: { width: 1000, height: 563 }, deviceScaleFactor: 2,
      locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
    for (const context of fixture.contexts) {
      expect(context.page.goto).toHaveBeenCalledWith('http://127.0.0.1:3199/internal/slide-export', expect.anything());
      expect(context.page.evaluate).toHaveBeenCalledWith(expect.any(Function), input);
      expect(context.page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ scale: 'device', type: 'png',
        clip: { x: 0, y: 0, width: 1000, height: 563 } }));
      expect(context.close).toHaveBeenCalledOnce();
    }
  });

  it('allows local renderer/static/fonts while blocking business APIs, remote media and sockets', async () => {
    await renderPlaybackSlide(scene());
    const context = fixture.contexts[0];
    const handler = context.route.mock.calls[0][1] as unknown as (route: unknown) => Promise<void>;
    const check = async (url: string, method = 'GET') => {
      const route = { request: () => ({ url: () => url, method: () => method }), continue: vi.fn(), abort: vi.fn() };
      await handler(route);
      return route;
    };
    for (const path of ['/internal/slide-export', '/_next/static/chunks/app.js', '/_next/static/media/noto.woff2', '/fonts/openmaic/SourceHanSans.woff2']) {
      expect((await check(`http://127.0.0.1:3199${path}`)).continue).toHaveBeenCalledOnce();
    }
    for (const url of ['http://127.0.0.1:3199/api/platform/session', 'http://127.0.0.1:3199/_next/image?url=x',
      'http://127.0.0.1:3199/fonts/secret.json', 'http://127.0.0.1:3000/_next/static/x.js', 'https://media.example/movie.mp4']) {
      expect((await check(url)).abort).toHaveBeenCalledWith('blockedbyclient');
    }
    expect((await check('http://127.0.0.1:3199/_next/static/%2e%2e%2f%2e%2e%2fapi/platform/session')).abort).toHaveBeenCalledOnce();
    expect((await check('http://127.0.0.1:3199/internal/slide-export', 'POST')).abort).toHaveBeenCalledOnce();
    const socketHandler = context.routeWebSocket.mock.calls[0][1] as unknown as (socket: unknown) => void;
    const socket = { url: () => 'ws://127.0.0.1:3301/api/private', close: vi.fn() };
    socketHandler(socket);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('serializes jobs until the preceding page context has closed', async () => {
    let finish!: () => void;
    const context = contextFixture();
    context.page.screenshot.mockImplementationOnce(() => new Promise<Buffer>((resolve) => { finish = () => resolve(png); }));
    fixture.browser.newContext.mockResolvedValueOnce(context);
    const first = renderPlaybackSlide(scene());
    await vi.waitFor(() => expect(context.page.screenshot).toHaveBeenCalledOnce());
    const second = renderPlaybackSlide(scene());
    await Promise.resolve();
    expect(fixture.browser.newContext).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.close.mock.invocationCallOrder[0]).toBeLessThan(fixture.browser.newContext.mock.invocationCallOrder[1]);
  });

  it('closes a failed context and browser, then recovers on the next request', async () => {
    const context = contextFixture();
    context.page.evaluate.mockRejectedValueOnce(new Error('图片解码失败'));
    fixture.browser.newContext.mockResolvedValueOnce(context);
    await expect(renderPlaybackSlide(scene())).rejects.toThrow('图片解码失败');
    expect(context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    expect(await renderPlaybackSlide(scene())).toBeInstanceOf(Buffer);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched canvas instead of silently cropping it', async () => {
    const context = contextFixture();
    context.locator.boundingBox.mockResolvedValueOnce({ x: 0, y: 0, width: 1000, height: 563 });
    fixture.browser.newContext.mockResolvedValueOnce(context);
    await expect(renderPlaybackSlide(scene())).rejects.toThrow('画布尺寸不匹配');
    expect(context.page.screenshot).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('bounds renderer readiness and cleans up when it never resolves', async () => {
    vi.useFakeTimers();
    const context = contextFixture();
    context.page.evaluate.mockImplementationOnce(() => new Promise(() => undefined));
    fixture.browser.newContext.mockResolvedValueOnce(context);
    const capture = renderPlaybackSlide(scene());
    const rejection = expect(capture).rejects.toThrow('渲染超时');
    await vi.advanceTimersByTimeAsync(30_001);
    await rejection;
    expect(context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it('closes idle Chromium and launches again when later work arrives', async () => {
    vi.useFakeTimers();
    await renderPlaybackSlide(scene());
    await vi.advanceTimersByTimeAsync(30_001);
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    await renderPlaybackSlide(scene());
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('uses the audit origin for E2E compatibility and rejects a non-loopback destination', async () => {
    vi.stubEnv('OPENPBL_SLIDE_EXPORT_URL', '');
    vi.stubEnv('OPENPBL_LAYOUT_AUDIT_URL', 'http://localhost:3200/internal/slide-layout-audit');
    await renderPlaybackSlide(scene());
    expect(fixture.contexts[0].page.goto).toHaveBeenCalledWith('http://localhost:3200/internal/slide-export', expect.anything());
    vi.stubEnv('OPENPBL_SLIDE_EXPORT_URL', 'https://example.com');
    await expect(renderPlaybackSlide(scene())).rejects.toThrow('loopback');
    expect(fixture.browser.newContext).toHaveBeenCalledOnce();
  });

  it('keeps valid lines without height and large chart values while rejecting invalid dimensions/geometry', () => {
    const input = scene();
    expect(() => assertPlaybackSlideScene(input)).not.toThrow();
    const legacyScene = { ...input, stageId: undefined };
    expect(() => assertPlaybackSlideScene(legacyScene)).not.toThrow();
    const numericCanvas = { ...input.content, type: 'slide' as const,
      canvas: { ...(input.content.type === 'slide' ? input.content.canvas : {}), customStatistic: 1e12 } };
    expect(() => assertPlaybackSlideScene({ ...input, content: numericCanvas })).not.toThrow();
    if (input.content.type !== 'slide') throw new Error('Fixture must be a slide');
    for (const patch of [{ viewportSize: Infinity }, { viewportRatio: -1 }, { viewportSize: 10000 },
      { elements: [{ ...input.content.canvas.elements[0], start: [0, Infinity] }] }]) {
      expect(() => assertPlaybackSlideScene({ ...input, content: { ...input.content, canvas: { ...input.content.canvas, ...patch } } })).toThrow();
    }
  });
});
