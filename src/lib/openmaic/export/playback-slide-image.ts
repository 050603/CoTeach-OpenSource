'use client';

import type { Scene } from '@openmaic/lib/types/stage';

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('无法读取课件图片'));
    reader.readAsDataURL(blob);
  });
}

/** Ask the isolated browser to capture the exact playback components. */
export async function renderPlaybackSlideImage(scene: Scene): Promise<string> {
  const response = await fetch('/api/openmaic/export/slide-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error || `播放器页面截图失败（HTTP ${response.status}）`);
  }
  return blobToDataUrl(await response.blob());
}
