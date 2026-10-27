import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTeacherPresentation } from "./use-teacher-presentation";

let fullscreenElement: Element | null;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fullscreenElement = null;
  requestFullscreen = vi.fn(async () => { fullscreenElement = document.documentElement; document.dispatchEvent(new Event("fullscreenchange")); });
  exitFullscreen = vi.fn(async () => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  document.body.style.overflow = "";
});

describe("teacher presentation fullscreen lifecycle", () => {
  it("requests document fullscreen so body portals remain visible and restores scrolling on exit", async () => {
    document.body.style.overflow = "auto";
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(fullscreenElement).toBe(document.documentElement);
    expect(result.current.active).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await act(() => result.current.exit());
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(result.current.active).toBe(false);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("reports rejected fullscreen without changing the window layout", async () => {
    requestFullscreen.mockRejectedValue(new Error("Denied"));
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    expect(result.current.active).toBe(false);
    expect(result.current.notice).toContain("浏览器未允许全屏");
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("reports browsers without the Fullscreen API and stays windowed", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: undefined });
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    expect(result.current.active).toBe(false);
    expect(result.current.notice).toContain("浏览器不支持全屏");
  });

  it("follows native Escape and does not treat nested video fullscreen as leaving presentation", async () => {
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    act(() => { fullscreenElement = document.createElement("video"); document.dispatchEvent(new Event("fullscreenchange")); });
    expect(result.current.active).toBe(true);
    act(() => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
    expect(result.current.active).toBe(false);
  });

  it("exits a late fullscreen request when the user already left presentation", async () => {
    let resolveRequest!: () => void;
    requestFullscreen.mockImplementation(() => new Promise<void>((resolve) => { resolveRequest = () => { fullscreenElement = document.documentElement; resolve(); }; }));
    const { result } = renderHook(useTeacherPresentation);
    let pending!: Promise<void>;
    act(() => { pending = result.current.enter(); });
    await act(() => result.current.exit());
    await act(async () => { resolveRequest(); await pending; });
    expect(result.current.active).toBe(false);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(fullscreenElement).toBeNull();
  });

  it("cleans up native fullscreen when the classroom unmounts", async () => {
    const { result, unmount } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    unmount();
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("");
  });

  it("honors a new enter request while a previous native exit is pending", async () => {
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    let finishExit!: () => void;
    exitFullscreen.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishExit = () => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); resolve(); };
    }));
    let leaving!: Promise<void>;
    let entering!: Promise<void>;
    act(() => { leaving = result.current.exit(); });
    expect(result.current.exiting).toBe(true);
    act(() => { entering = result.current.enter(); });
    await act(async () => { finishExit(); await leaving; await entering; });
    expect(requestFullscreen).toHaveBeenCalledTimes(2);
    expect(result.current.active).toBe(true);
    expect(result.current.exiting).toBe(false);
    expect(fullscreenElement).toBe(document.documentElement);
  });

  it("restores focus to the replacement of an unmounted fullscreen trigger", async () => {
    const original = document.createElement("button");
    original.id = "work-fullscreen-trigger";
    document.body.append(original);
    original.focus();
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    original.remove();
    const replacement = document.createElement("button");
    replacement.id = original.id;
    document.body.append(replacement);
    await act(() => result.current.exit());
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(replacement);
    replacement.remove();
  });

  it("keeps the exit control when the browser refuses to exit", async () => {
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    exitFullscreen.mockRejectedValueOnce(new Error("Denied"));
    await act(() => result.current.exit());
    expect(result.current.active).toBe(true);
    await act(() => result.current.exit());
    expect(result.current.active).toBe(false);
  });
});
