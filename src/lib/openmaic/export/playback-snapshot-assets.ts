/** Bounded asset settling shared by the off-screen snapshot pipeline. */
export interface SnapshotAssetOptions {
  timeoutMs: number;
  strictAssets: boolean;
}

export async function settleSnapshotTask<T>(
  task: PromiseLike<T>,
  label: string,
  { timeoutMs, strictAssets }: SnapshotAssetOptions,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (strictAssets) {
      throw new Error(`播放器页面： ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function waitForSnapshotFonts(container: HTMLElement, options: SnapshotAssetOptions): Promise<void> {
  // html2canvas measures in a cloned iframe but draws with the caller's
  // canvas. Each document has its own FontFaceSet: waiting for the parent
  // does not ensure that the clone has loaded the same glyph subsets.
  const ownerDocument = container.ownerDocument;
  const fontSet = ownerDocument.fonts;
  if (!fontSet) return;
  const fonts = new Map<string, Set<string>>();
  if (typeof fontSet.load === 'function') {
    for (const element of container.querySelectorAll<HTMLElement>('*')) {
      if (element.matches('style, script')) continue;
      const text = element.textContent?.trim();
      if (!text) continue;
      const style = ownerDocument.defaultView?.getComputedStyle(element) ?? getComputedStyle(element);
      if (!style.fontFamily) continue;
      const spec = `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} 16px ${style.fontFamily}`;
      const texts = fonts.get(spec) ?? new Set<string>();
      texts.add(text);
      fonts.set(spec, texts);
    }
    await settleSnapshotTask(Promise.all([...fonts].map(async ([spec, texts]) => {
      // The default FontFaceSet.load sample is a space. Passing the actual
      // text is essential for unicode-range CJK fonts and KaTeX glyph subsets.
      const text = [...texts].join('');
      await fontSet.load(spec, text);
    })), 'fonts failed to load', options);
  }
  await settleSnapshotTask(fontSet.ready, 'fonts are not ready', options);
  // A clone can still be updating other matching faces after one load resolves.
  // Validate only once the complete FontFaceSet has settled.
  if (options.strictAssets) {
    for (const [spec, texts] of fonts) {
      if (!fontSet.check(spec, [...texts].join(''))) {
        throw new Error(`播放器页面： fonts failed to load: font did not load (${spec})`);
      }
    }
  }
}

export async function waitForSnapshotImage(image: HTMLImageElement, options: SnapshotAssetOptions): Promise<void> {
  let removeListeners = () => {};
  const task = (async () => {
    if (!image.complete) {
      await new Promise<void>((resolve, reject) => {
        const loaded = () => resolve();
        const failed = () => reject(new Error('image could not be loaded'));
        removeListeners = () => {
          image.removeEventListener('load', loaded);
          image.removeEventListener('error', failed);
        };
        image.addEventListener('load', loaded, { once: true });
        image.addEventListener('error', failed, { once: true });
      });
    }
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('image has no decoded pixels');
    if (typeof image.decode === 'function') await image.decode();
  })();
  try {
    await settleSnapshotTask(task, 'image failed to decode', options);
  } finally {
    removeListeners();
  }
}

export async function waitForSnapshotImages(container: HTMLElement, options: SnapshotAssetOptions): Promise<void> {
  const images = [...container.querySelectorAll('img')];
  const urls = new Set<string>();
  for (const element of [container, ...container.querySelectorAll<HTMLElement>('*')]) {
    const background = getComputedStyle(element).backgroundImage;
    for (const match of background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) {
      const url = (match[1] ?? match[2] ?? match[3]).trim();
      if (url) urls.add(url);
    }
    if (element.matches('svg image')) {
      const url = element.getAttribute('href') || element.getAttribute('xlink:href');
      if (url) urls.add(url);
    }
  }
  for (const url of urls) {
    const image = document.createElement('img');
    image.src = url;
    images.push(image);
  }
  await Promise.all(images.map((image) => waitForSnapshotImage(image, options)));
}

export async function waitForSnapshotVideo(video: HTMLVideoElement, options: SnapshotAssetOptions): Promise<void> {
  const source = video.currentSrc || video.src;
  const crossOriginSource = source && new URL(source, video.ownerDocument.baseURI).origin !== video.ownerDocument.location.origin;
  const reloadWithCors = Boolean(crossOriginSource && video.crossOrigin !== 'anonymous');
  // A frame decoded by a no-CORS request taints the snapshot even when the
  // source permits CORS. Reload that off-screen video before reading pixels.
  if (reloadWithCors) video.crossOrigin = 'anonymous';
  if (!reloadWithCors && video.readyState >= 2 && video.videoWidth > 0) return;
  let removeListeners = () => {};
  const task = new Promise<void>((resolve, reject) => {
    if (video.error || (!video.currentSrc && !video.src)) {
      reject(new Error('video has no readable source or poster'));
      return;
    }
    const loaded = () => video.videoWidth > 0 ? resolve() : reject(new Error('video has no decoded frame'));
    const failed = () => reject(new Error('video frame could not be loaded'));
    removeListeners = () => {
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
    };
    video.addEventListener('loadeddata', loaded, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.preload = 'auto';
    video.load();
  });
  try {
    await settleSnapshotTask(task, 'video has no static frame', options);
  } finally {
    removeListeners();
  }
}
