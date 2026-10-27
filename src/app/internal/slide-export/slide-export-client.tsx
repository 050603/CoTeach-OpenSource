'use client';

import { useEffect, useRef, useState } from 'react';
import type { Scene } from '@openmaic/lib/types/stage';
import { I18nProvider } from '@openmaic/lib/hooks/use-i18n';
import { ReadonlySlideCanvas } from '@/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas';
import { preparePlaybackChartFonts, preparePlaybackSnapshot } from '@openmaic/lib/export/prepare-playback-snapshot';
import { prepareCodeHighlighting } from '@/components/openmaic/slide-renderer/components/element/CodeElement/BaseCodeElement';
import { settleSnapshotTask } from '@openmaic/lib/export/playback-snapshot-assets';

declare global {
  interface Window {
    __openPblRenderExportSlide?: (scene: Scene) => Promise<void>;
  }
}

export function SlideExportClient() {
  const [scene, setScene] = useState<Scene | null>(null);
  const root = useRef<HTMLElement>(null);
  const pending = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null);
  useEffect(() => {
    window.__openPblRenderExportSlide = async (nextScene) => {
      if (nextScene.content.type !== 'slide') throw new Error('仅支持 PPT 页面');
      await preparePlaybackChartFonts(nextScene);
      if (nextScene.content.canvas.elements.some((element) => element.type === 'code')) {
        await settleSnapshotTask(prepareCodeHighlighting(), '代码高亮未完成', { timeoutMs: 30_000, strictAssets: true });
      }
      return new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setScene(nextScene);
      });
    };
    return () => { delete window.__openPblRenderExportSlide; };
  }, []);

  useEffect(() => {
    if (!scene || !root.current) return;
    const result = pending.current;
    void preparePlaybackSnapshot(root.current).then(() => result?.resolve(), (error) => result?.reject(error));
  }, [scene]);

  if (scene?.content.type !== 'slide') return null;
  const width = scene.content.canvas.viewportSize || 1000;
  const height = width * (scene.content.canvas.viewportRatio || 0.5625);
  return <main ref={root} data-pptx-export-canvas style={{ position: 'relative', width, height, overflow: 'hidden', background: '#fff' }}>
    <I18nProvider locale="zh-CN"><ReadonlySlideCanvas scene={scene} /></I18nProvider>
  </main>;
}
