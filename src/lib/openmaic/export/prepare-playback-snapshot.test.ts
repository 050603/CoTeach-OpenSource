// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { preparePlaybackChartFonts } from './prepare-playback-snapshot';

afterEach(() => Reflect.deleteProperty(document, 'fonts'));

describe('chart font readiness before playback initialization', () => {
  it('loads actual labels and numeric ticks before allowing ECharts to measure them', async () => {
    let loaded!: () => void;
    const load = vi.fn((_font: string, _text: string) => new Promise<void>((resolve) => { loaded = resolve; }));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, ready: Promise.resolve() } });
    const scene = { content: { type: 'slide', canvas: { elements: [{ type: 'chart', data: { labels: ['理解', '迁移'], legends: ['学习表现'], series: [[30, 90]] } }] } } } as unknown as Scene;
    let ready = false;
    const waiting = preparePlaybackChartFonts(scene).then(() => { ready = true; });
    expect(load).toHaveBeenCalledWith('normal 400 16px "Noto Sans SC"', expect.stringContaining('理解'));
    expect(load.mock.calls[0][1]).toContain('0123456789');
    expect(ready).toBe(false);
    loaded();
    await waiting;
    expect(ready).toBe(true);
  });
});
