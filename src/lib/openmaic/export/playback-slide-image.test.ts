// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { renderPlaybackSlideImage } from './playback-slide-image';

afterEach(() => vi.unstubAllGlobals());
const scene = { id: 'page', content: { type: 'slide', canvas: { elements: [] } } } as unknown as Scene;

describe('playback page image transport', () => {
  it('sends the exact page to the authenticated renderer and returns the PNG data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['pixels'], { type: 'image/png' }) });
    vi.stubGlobal('fetch', fetcher);
    expect(await renderPlaybackSlideImage(scene)).toBe('data:image/png;base64,cGl4ZWxz');
    expect(fetcher).toHaveBeenCalledWith('/api/openmaic/export/slide-image', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ scene }), headers: { 'Content-Type': 'application/json' }, signal: expect.any(AbortSignal),
    }));
  });

  it('reports a renderer failure instead of interpreting the error body as image data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: '播放器字体加载失败' }) }));
    await expect(renderPlaybackSlideImage(scene)).rejects.toThrow('播放器字体加载失败');
  });
});
