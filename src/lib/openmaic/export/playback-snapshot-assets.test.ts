// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  waitForSnapshotFonts,
  waitForSnapshotImage,
  waitForSnapshotImages,
  waitForSnapshotVideo,
} from './playback-snapshot-assets';

const strict = { strictAssets: true, timeoutMs: 100 };
const lenient = { strictAssets: false, timeoutMs: 100 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  Reflect.deleteProperty(document, 'fonts');
});

function fontContainer() {
  const container = document.createElement('div');
  container.innerHTML = '<p style="font-family: Noto Sans SC; font-weight: 700">教学关系（条件）</p>';
  document.body.appendChild(container);
  return container;
}

function imageState(image: HTMLImageElement, complete: boolean, width: number) {
  Object.defineProperties(image, {
    complete: { configurable: true, value: complete },
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: width ? 360 : 0 },
  });
}

describe('snapshot asset readiness', () => {
  it('requests the actual Chinese glyphs and waits for their font load', async () => {
    let finish!: () => void;
    const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, check: () => true, ready: Promise.resolve() } });
    let ready = false;
    const waiting = waitForSnapshotFonts(fontContainer(), strict).then(() => { ready = true; });
    await Promise.resolve();
    expect(load).toHaveBeenCalledWith(expect.stringContaining('700 16px'), '教学关系（条件）');
    expect(ready).toBe(false);
    finish();
    await waiting;
    expect(ready).toBe(true);
  });

  it('waits for a cloned iframe document font set and reads that document styles', async () => {
    const parentLoad = vi.fn().mockRejectedValue(new Error('parent fonts must not be used'));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: parentLoad, check: () => false, ready: new Promise(() => {}) },
    });
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const cloneDocument = iframe.contentDocument!;
    cloneDocument.body.innerHTML = '<style>p{font-family:"Clone Font";font-weight:700}</style><div id="canvas"><p>克隆文档 α ≤ β</p></div>';
    const cloneStyles = vi.spyOn(iframe.contentWindow!, 'getComputedStyle');
    const parentStyles = vi.spyOn(window, 'getComputedStyle');
    let finishLoad!: () => void;
    let finishReady!: () => void;
    let fontSetReady = false;
    const cloneLoad = vi.fn(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
    const cloneCheck = vi.fn(() => fontSetReady);
    Object.defineProperty(cloneDocument, 'fonts', {
      configurable: true,
      value: {
        load: cloneLoad,
        check: cloneCheck,
        ready: new Promise<void>((resolve) => { finishReady = resolve; }),
      },
    });
    let ready = false;
    const waiting = waitForSnapshotFonts(cloneDocument.getElementById('canvas')!, strict)
      .then(() => { ready = true; });
    expect(cloneLoad).toHaveBeenCalledWith(expect.stringContaining('700 16px "Clone Font"'), '克隆文档 α ≤ β');
    expect(cloneStyles).toHaveBeenCalled();
    expect(parentStyles).not.toHaveBeenCalled();
    expect(parentLoad).not.toHaveBeenCalled();
    expect(ready).toBe(false);
    finishLoad();
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(cloneCheck).not.toHaveBeenCalled();
    fontSetReady = true;
    finishReady();
    await waiting;
    expect(ready).toBe(true);
    expect(cloneCheck).toHaveBeenCalledWith(expect.stringContaining('700 16px "Clone Font"'), '克隆文档 α ≤ β');
  });

  it('rejects failed or timed out fonts in strict mode and retains lenient behavior', async () => {
    const load = vi.fn().mockRejectedValue(new Error('font network error'));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, ready: Promise.resolve() } });
    const container = fontContainer();
    await expect(waitForSnapshotFonts(container, strict)).rejects.toThrow('font network error');
    await expect(waitForSnapshotFonts(container, lenient)).resolves.toBeUndefined();

    vi.useFakeTimers();
    load.mockImplementation(() => new Promise(() => {}));
    const timedOut = expect(waitForSnapshotFonts(container, strict)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
  });

  it('waits for image decoding rather than treating the load event as complete', async () => {
    const image = document.createElement('img');
    imageState(image, true, 640);
    let decoded!: () => void;
    image.decode = vi.fn(() => new Promise<void>((resolve) => { decoded = resolve; }));
    let ready = false;
    const waiting = waitForSnapshotImage(image, strict).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    decoded();
    await waiting;
    expect(ready).toBe(true);
  });

  it('rejects already broken images immediately and bounds stalled image loads', async () => {
    const image = document.createElement('img');
    imageState(image, true, 0);
    await expect(waitForSnapshotImage(image, strict)).rejects.toThrow('no decoded pixels');
    await expect(waitForSnapshotImage(image, lenient)).resolves.toBeUndefined();

    vi.useFakeTimers();
    imageState(image, false, 0);
    const remove = vi.spyOn(image, 'removeEventListener');
    const timedOut = expect(waitForSnapshotImage(image, strict)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(remove).toHaveBeenCalledWith('load', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('propagates image decode errors and image network failures', async () => {
    const image = document.createElement('img');
    imageState(image, true, 640);
    image.decode = vi.fn().mockRejectedValue(new Error('invalid image bytes'));
    await expect(waitForSnapshotImage(image, strict)).rejects.toThrow('invalid image bytes');

    imageState(image, false, 0);
    const failed = expect(waitForSnapshotImage(image, strict)).rejects.toThrow('could not be loaded');
    image.dispatchEvent(new Event('error'));
    await failed;
  });

  it.each([
    '<div style="background-image:url(/missing-background.png)"></div>',
    '<svg><image href="/missing-pattern.png" /></svg>',
  ])('checks CSS backgrounds and SVG image patterns as well as img tags: %s', async (markup) => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
    const container = document.createElement('div');
    container.innerHTML = markup;
    document.body.appendChild(container);
    await expect(waitForSnapshotImages(container, strict)).rejects.toThrow('image failed to decode');
  });

  it('loads a video first frame without requiring playback', async () => {
    const video = document.createElement('video');
    video.src = '/lesson.mp4';
    const play = vi.spyOn(video, 'play');
    vi.spyOn(video, 'load').mockImplementation(() => {
      Object.defineProperty(video, 'videoWidth', { configurable: true, value: 640 });
      video.dispatchEvent(new Event('loadeddata'));
    });
    await expect(waitForSnapshotVideo(video, strict)).resolves.toBeUndefined();
    expect(video.preload).toBe('auto');
    expect(play).not.toHaveBeenCalled();
  });

  it('rejects video sources without a readable first frame instead of leaving a blank slide', async () => {
    const video = document.createElement('video');
    await expect(waitForSnapshotVideo(video, strict)).rejects.toThrow('no readable source or poster');
    video.src = '/unreadable.mp4';
    vi.spyOn(video, 'load').mockImplementation(() => video.dispatchEvent(new Event('error')));
    await expect(waitForSnapshotVideo(video, strict)).rejects.toThrow('frame could not be loaded');
  });

  it('reloads a decoded cross-origin video with CORS before capturing its first frame', async () => {
    const video = document.createElement('video');
    video.src = 'https://media.test/lesson.webm';
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 640 },
    });
    const load = vi.spyOn(video, 'load').mockImplementation(() => {
      expect(video.crossOrigin).toBe('anonymous');
      video.dispatchEvent(new Event('loadeddata'));
    });
    await expect(waitForSnapshotVideo(video, strict)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
    // A frame that was already decoded with CORS can be reused.
    await expect(waitForSnapshotVideo(video, strict)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
  });
});
