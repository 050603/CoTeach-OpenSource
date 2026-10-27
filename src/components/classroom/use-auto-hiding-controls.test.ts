import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoHidingControls } from "./use-auto-hiding-controls";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("auto-hiding reading controls", () => {
  it("hides when idle and restarts the entire delay after interaction", () => {
    const { result } = renderHook(() => useAutoHidingControls(true));
    expect(result.current.visible).toBe(true);
    act(() => vi.advanceTimersByTime(1_000));
    act(() => result.current.reveal());
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.visible).toBe(true);
    act(() => vi.advanceTimersByTime(800));
    expect(result.current.visible).toBe(false);
  });

  it("keeps controls available while hovered or focused, including selecting a scale", () => {
    const { result } = renderHook(() => useAutoHidingControls(true));
    act(() => { result.current.hold("pointer"); result.current.hold("focus"); });
    act(() => { vi.advanceTimersByTime(10_000); result.current.hide(); });
    expect(result.current.visible).toBe(true);
    act(() => result.current.release("pointer"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.visible).toBe(true);
    act(() => result.current.release("focus"));
    act(() => vi.advanceTimersByTime(1_800));
    expect(result.current.visible).toBe(false);
  });

  it("hides immediately when reading resumes and can be revealed again", () => {
    const { result } = renderHook(() => useAutoHidingControls(true));
    act(() => result.current.hide());
    expect(result.current.visible).toBe(false);
    act(() => result.current.reveal());
    expect(result.current.visible).toBe(true);
    act(() => vi.advanceTimersByTime(1_800));
    expect(result.current.visible).toBe(false);
  });

  it("dismisses held controls and allows the next interaction to hide normally", () => {
    const { result } = renderHook(() => useAutoHidingControls(true));
    act(() => { result.current.hold("pointer"); result.current.hold("focus"); });
    act(() => result.current.dismiss());
    expect(result.current.visible).toBe(false);
    act(() => result.current.reveal());
    act(() => vi.advanceTimersByTime(1_800));
    expect(result.current.visible).toBe(false);
  });

  it("keeps ordinary toolbars visible when auto-hide is disabled", () => {
    const { result } = renderHook(() => useAutoHidingControls(false));
    act(() => { result.current.hide(); result.current.dismiss(); vi.advanceTimersByTime(10_000); });
    expect(result.current.visible).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending timers when unmounted", () => {
    const { result, unmount } = renderHook(() => useAutoHidingControls(true));
    act(() => result.current.reveal());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
