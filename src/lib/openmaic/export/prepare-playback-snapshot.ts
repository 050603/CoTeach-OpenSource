'use client';

import type { Scene } from '@openmaic/lib/types/stage';
import { settleSnapshotTask, waitForSnapshotFonts, waitForSnapshotImage, waitForSnapshotImages, waitForSnapshotVideo } from './playback-snapshot-assets';

const options = { timeoutMs: 30_000, strictAssets: true };
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** ECharts caches label widths during initialization, before SVG text exists.
 * Load its font first so a cold export has the same grid as a warm player. */
export async function preparePlaybackChartFonts(scene: Scene): Promise<void> {
  if (scene.content.type !== 'slide' || !document.fonts) return;
  const charts = scene.content.canvas.elements.filter((element) => element.type === 'chart');
  if (!charts.length) return;
  const text = charts.map((chart) => JSON.stringify(chart.data)).join('') + '0123456789.%+-';
  await settleSnapshotTask(document.fonts.load('normal 400 16px "Noto Sans SC"', text), '图表字体加载失败', options);
  await settleSnapshotTask(document.fonts.ready, '图表字体尚未就绪', options);
}

/** Settle the real playback DOM; Chromium captures its pixels without redrawing SVG/CSS. */
export async function preparePlaybackSnapshot(root: HTMLElement): Promise<void> {
  await nextFrame();
  await nextFrame();
  await waitForSnapshotFonts(root, options);
  await waitForSnapshotImages(root, options);
  await Promise.all([...root.querySelectorAll('video')].map(async (video) => {
    if (video.poster) {
      const poster = new Image();
      poster.src = video.poster;
      await waitForSnapshotImage(poster, options);
    } else {
      await waitForSnapshotVideo(video, options);
    }
    video.controls = false;
  }));
  const charts = root.querySelectorAll<HTMLElement>('.chart');
  if (charts.length) {
    const { getInstanceByDom } = await import('echarts/core');
    for (const chart of charts) {
      const instance = getInstanceByDom(chart);
      if (!instance) throw new Error('图表尚未完成加载');
      instance.resize({ animation: { duration: 0 } });
      instance.getZr().flush();
    }
  }
  await nextFrame();
  await nextFrame();
}
