// @vitest-environment node

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import { buildImagePptxBlob } from './image-pptx';
import { useMediaGenerationStore } from '@openmaic/lib/store/media-generation';

const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('./playback-slide-image', async (importOriginal) => ({ ...await importOriginal<typeof import('./playback-slide-image')>(), renderPlaybackSlideImage: mocks.render }));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function slide(id: string, ratio = 0.625): Scene & { content: SlideContent } {
  return {
    id, stageId: 'stage', title: `中文课件 ${id}`, type: 'slide', order: 0, createdAt: 1, updatedAt: 1,
    actions: [{ id: `speech-${id}`, type: 'speech', text: `严谨定义与条件：${id} ≤ 10。` }],
    content: { type: 'slide', canvas: { id, viewportSize: 1000, viewportRatio: ratio,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Noto Sans SC' },
      elements: [{ id: `text-${id}`, type: 'text', left: 10, top: 10, width: 800, height: 100, rotate: 0,
        content: '<p>中文、公式与特殊符号：α ≤ β</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#000' }],
    } },
  };
}

beforeEach(() => { vi.clearAllMocks(); mocks.render.mockResolvedValue(png); });
afterEach(() => { vi.unstubAllGlobals(); useMediaGenerationStore.setState({ tasks: {} }); });

describe('rendered-image PPTX', () => {
  it('embeds one PNG per slide in scene order, preserves notes and the exact deck aspect ratio', async () => {
    const first = slide('first'), second = slide('second');
    const interactive = { ...slide('interactive'), content: { type: 'interactive', html: '<p>互动页</p>' } } as Scene;
    const progress = vi.fn();
    const blob = await buildImagePptxBlob([first, interactive, second], progress);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(2);
    for (const index of [1, 2]) {
      const xml = await zip.file(`ppt/slides/slide${index}.xml`)!.async('string');
      expect(xml.match(/<p:pic>/g)).toHaveLength(1);
      expect(xml).not.toContain('<a:t>');
      expect(xml).toContain('cx="9144000" cy="5715000"');
      expect(await zip.file(`ppt/notesSlides/notesSlide${index}.xml`)!.async('string'))
        .toContain(`严谨定义与条件：${index === 1 ? 'first' : 'second'} ≤ 10。`);
    }
    expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('cx="9144000" cy="5715000"');
    expect(mocks.render.mock.calls.map(([scene]) => scene.id)).toEqual(['first', 'second']);
    expect(mocks.render).toHaveBeenCalledWith(first);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { completed: 0, total: 2 }, { completed: 1, total: 2 }, { completed: 2, total: 2 },
    ]);
  });

  it('fits mixed page proportions without stretching them', async () => {
    const blob = await buildImagePptxBlob([slide('wide', 0.5), slide('square', 1)]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(xml).toContain('x="2286000" y="0"');
    expect(xml).toContain('cx="4572000" cy="4572000"');
  });

  it('inlines and caches remote visual assets through the proxy without mutating saved slides', async () => {
    vi.stubGlobal('window', { location: { href: 'https://app.test/teacher/preview', origin: 'https://app.test' } });
    vi.stubGlobal('FileReader', class {
      result = png;
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    });
    const fetcher = vi.fn().mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetcher);
    const scene = slide('assets');
    // Older saved pages can lack stage identity; concrete images need no task.
    scene.stageId = undefined as unknown as string;
    const src = 'https://images.test/教材.png';
    scene.content.canvas.background = { type: 'image', image: { src, size: 'cover' } };
    scene.content.canvas.elements.push({ id: 'image', type: 'image', src, left: 0, top: 0, width: 100, height: 100, rotate: 0, fixedRatio: true });
    await buildImagePptxBlob([scene]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/proxy-media', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ url: new URL(src).href }),
    }));
    const captured = mocks.render.mock.calls[0][0].content.canvas;
    expect(captured.background.image.src).toBe(png);
    expect(captured.elements[1].src).toBe(png);
    expect(scene.content.canvas.background.image!.src).toBe(src);
  });

  it('fails visibly on missing images instead of saving an incomplete page', async () => {
    vi.stubGlobal('window', { location: { href: 'https://app.test/', origin: 'https://app.test' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const scene = slide('broken');
    scene.content.canvas.background = { type: 'image', image: { src: '/missing.png', size: 'cover' } };
    await expect(buildImagePptxBlob([scene])).rejects.toThrow('第 1 页“中文课件 broken”导出失败：页面图片下载失败（HTTP 404）');
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it.each(['gen_img_example', 'outline-example:media-1'])('resolves completed generated media (%s) only for its own stage', async (src) => {
    const scene = slide('generated');
    scene.content.canvas.elements.push({ id: 'image', type: 'image', src, left: 0, top: 0, width: 100, height: 100, rotate: 0, fixedRatio: true });
    useMediaGenerationStore.setState({ tasks: { [src]: { elementId: src, type: 'image', status: 'done', stageId: 'stage', objectUrl: png, prompt: '', params: {}, retryCount: 0 } } });
    await buildImagePptxBlob([scene]);
    expect(mocks.render.mock.calls[0][0].content.canvas.elements[1].src).toBe(png);
    useMediaGenerationStore.setState({ tasks: { [src]: { ...useMediaGenerationStore.getState().tasks[src], stageId: 'another-stage' } } });
    await expect(buildImagePptxBlob([scene])).rejects.toThrow('页面图片尚未就绪');
  });

  it('reports the failing page and refuses empty decks', async () => {
    await expect(buildImagePptxBlob([])).rejects.toThrow('暂无可导出');
    mocks.render.mockRejectedValueOnce(new Error('字体加载超时'));
    await expect(buildImagePptxBlob([slide('font')])).rejects.toThrow('第 1 页“中文课件 font”导出失败：字体加载超时');
  });
});
