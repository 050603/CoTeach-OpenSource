// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { SlideExportClient } from './slide-export-client';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), fonts: vi.fn() }));
vi.mock('@openmaic/lib/export/prepare-playback-snapshot', () => ({ preparePlaybackSnapshot: mocks.prepare, preparePlaybackChartFonts: mocks.fonts }));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ I18nProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas', () => ({ ReadonlySlideCanvas: () => <div>播放器组件</div> }));
vi.mock('@/components/openmaic/slide-renderer/components/element/CodeElement/BaseCodeElement', () => ({ prepareCodeHighlighting: vi.fn() }));

const scene = { id: 'page', content: { type: 'slide', canvas: { viewportSize: 640, viewportRatio: 0.75, elements: [] } } } as unknown as Scene;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('isolated playback export canvas', () => {
  it('stays empty until supplied a page, preserves native dimensions and waits for assets', async () => {
    let prepared!: () => void;
    mocks.prepare.mockImplementation(() => new Promise<void>((resolve) => { prepared = resolve; }));
    const { container } = render(<SlideExportClient />);
    expect(container.querySelector('main')).toBeNull();
    let completed = false;
    let waiting!: Promise<void>;
    await act(async () => { waiting = window.__openPblRenderExportSlide!(scene).then(() => { completed = true; }); });
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalled());
    expect(container.querySelector('main')?.style.width).toBe('640px');
    expect(container.querySelector('main')?.style.height).toBe('480px');
    expect(completed).toBe(false);
    prepared();
    await waiting;
    expect(completed).toBe(true);
  });

  it('propagates preparation errors and unregisters the browser entry on unmount', async () => {
    mocks.prepare.mockRejectedValue(new Error('图片无法加载'));
    const { unmount } = render(<SlideExportClient />);
    let waiting!: Promise<void>;
    await act(async () => { waiting = window.__openPblRenderExportSlide!(scene); waiting.catch(() => undefined); });
    await expect(waiting).rejects.toThrow('图片无法加载');
    unmount();
    expect(window.__openPblRenderExportSlide).toBeUndefined();
  });
});
