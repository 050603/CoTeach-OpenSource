'use client';

import Canvas from './Canvas';
import type { StageMode } from '@openmaic/lib/types/stage';
import { ScreenCanvas } from './ScreenCanvas';

/**
 * Slide Editor - wraps Canvas with SceneProvider
 */
export function SlideEditor({ mode, fitToContainer = false }: { readonly mode: StageMode; readonly fitToContainer?: boolean }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        {mode === 'autonomous' ? <Canvas /> : <ScreenCanvas fitToContainer={fitToContainer} />}
      </div>
    </div>
  );
}
