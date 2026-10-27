'use client';

import pptxgen from 'pptxgenjs';
import type { Slide } from '@openmaic/dsl';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import { isMediaPlaceholder, useMediaGenerationStore } from '@openmaic/lib/store/media-generation';
import { blobToDataUrl, renderPlaybackSlideImage } from './playback-slide-image';

export type PptxExportProgress = { completed: number; total: number };

/** Inline visual assets before capture so CORS cannot silently omit them. */
function createImageLoader() {
  const cache = new Map<string, Promise<string>>();
  return (src: string): Promise<string> => {
    if (src.startsWith('data:')) return Promise.resolve(src);
    const cached = cache.get(src);
    if (cached) return cached;
    const pending = (async () => {
      if (isMediaPlaceholder(src)) throw new Error('页面图片尚未就绪，请完成素材生成后重试');
      const url = new URL(src, window.location.href);
      if (!['http:', 'https:', 'blob:'].includes(url.protocol)) {
        throw new Error('页面图片尚未就绪，请完成素材生成后重试');
      }
      const signal = AbortSignal.timeout(30_000);
      const response = url.origin === window.location.origin || url.protocol === 'blob:'
        ? await fetch(url.href, { credentials: 'same-origin', signal })
        : await fetch('/api/proxy-media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url.href }),
            signal,
          });
      if (!response.ok) throw new Error(`页面图片下载失败（HTTP ${response.status}）`);
      return blobToDataUrl(await response.blob());
    })();
    cache.set(src, pending);
    return pending;
  };
}

async function inlineSlideImages(slide: Slide, stageId: string, load: (src: string) => Promise<string>): Promise<Slide> {
  const background = slide.background?.type === 'image' && slide.background.image
    ? { ...slide.background, image: { ...slide.background.image, src: await load(slide.background.image.src) } }
    : slide.background;
  // The editor keeps generated-media placeholders in the document while its
  // store owns the completed URLs. Resolve only tasks belonging to this stage.
  const needsMediaStore = slide.elements.some((element) =>
    (element.type === 'image' && isMediaPlaceholder(element.src))
    || (element.type === 'video' && (element.mediaRef || isMediaPlaceholder(element.src || ''))));
  const tasks = needsMediaStore ? useMediaGenerationStore.getState().tasks : undefined;
  const elements = await Promise.all(slide.elements.map(async (element) => {
    if (element.type === 'image') {
      const task = tasks?.[element.src];
      const src = task && task.stageId === stageId && task.status === 'done' && task.objectUrl ? task.objectUrl : element.src;
      return { ...element, src: await load(src) };
    }
    if (element.type === 'shape' && element.pattern) return { ...element, pattern: await load(element.pattern) };
    if (element.type === 'video') {
      const task = tasks?.[element.mediaRef || element.src || ''];
      const resolved = task && task.stageId === stageId && task.status === 'done' ? task : undefined;
      const poster = resolved?.poster || element.poster;
      const src = resolved?.objectUrl || element.src;
      return { ...element, autoplay: false,
        src: poster ? src : src ? await load(src) : undefined,
        ...(poster ? { poster: await load(poster) } : {}) };
    }
    return element;
  }));
  return { ...slide, background, elements };
}

/** One rendered PNG per page: PowerPoint never reinterprets text, math or layout. */
export async function buildImagePptxBlob(
  scenes: Scene[],
  onProgress?: (progress: PptxExportProgress) => void,
): Promise<Blob> {
  const slides = scenes.filter((scene): scene is Scene & { content: SlideContent } => scene.content.type === 'slide');
  if (!slides.length) throw new Error('课程中暂无可导出的 PPT 页面');
  const pptx = new pptxgen();
  const width = 10;
  const height = width * (slides[0].content.canvas.viewportRatio || 0.5625);
  pptx.defineLayout({ name: 'COURSE', width, height });
  pptx.layout = 'COURSE';
  const loadImage = createImageLoader();
  onProgress?.({ completed: 0, total: slides.length });

  // Render sequentially to bound DOM and bitmap memory for long courses.
  for (const [index, scene] of slides.entries()) {
    try {
      const slide = await inlineSlideImages(scene.content.canvas, scene.stageId, loadImage);
      const data = await renderPlaybackSlideImage({ ...scene, type: 'slide', content: { ...scene.content, canvas: slide } });
      if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,')) {
        throw new Error('页面图片生成失败');
      }
      const page = pptx.addSlide();
      const ratio = slide.viewportRatio || 0.5625;
      // Mixed-size source pages retain their proportions within the deck.
      const imageWidth = Math.min(width, height / ratio);
      const imageHeight = imageWidth * ratio;
      page.background = { color: 'FFFFFF' };
      page.addImage({ data, x: (width - imageWidth) / 2, y: (height - imageHeight) / 2, w: imageWidth, h: imageHeight });
      const notes = (scene.actions ?? []).filter((action) => action.type === 'speech').map((action) => action.text).join('\n');
      if (notes) page.addNotes(notes);
      onProgress?.({ completed: index + 1, total: slides.length });
    } catch (error) {
      throw new Error(`第 ${index + 1} 页“${scene.title || '未命名'}”导出失败：${error instanceof Error ? error.message : '请重试'}`);
    }
  }
  return await pptx.write({ outputType: 'blob' }) as Blob;
}
