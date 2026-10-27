import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useViewportSize } from './useViewportSize';

const initialState = useCanvasStore.getState();
beforeEach(() => useCanvasStore.setState({
  canvasPercentage: 60, canvasDragged: false, viewportSize: 1000, viewportRatio: 0.5625,
}));
afterEach(() => useCanvasStore.setState(initialState));

it.each([{ width: 1600, height: 900 }, { width: 390, height: 708 }])(
  'fits the complete projected slide in $width × $height without changing the preferred zoom',
  ({ width, height }) => {
    const element = document.createElement('div');
    Object.defineProperties(element, { clientWidth: { value: width }, clientHeight: { value: height } });
    const ref = { current: element };
    const { result, rerender } = renderHook(({ fit }) => useViewportSize(ref, fit), { initialProps: { fit: true } });
    const scale = Math.min(width / 1000, height / 562.5);
    expect(useCanvasStore.getState().canvasScale).toBeCloseTo(scale);
    expect(result.current.viewportStyles.left).toBeCloseTo((width - 1000 * scale) / 2);
    expect(result.current.viewportStyles.top).toBeCloseTo((height - 562.5 * scale) / 2);
    expect(useCanvasStore.getState().canvasPercentage).toBe(60);

    rerender({ fit: false });
    expect(useCanvasStore.getState().canvasScale).toBeCloseTo(scale * 0.6);
  },
);
