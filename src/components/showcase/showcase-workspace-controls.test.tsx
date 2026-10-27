import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShowcaseZoomControls } from "./showcase-workspace-controls";

function ReadingSurface({ compact = true }: { compact?: boolean }) {
  const [scale, setScale] = useState(1);
  return <><div data-testid="surface" tabIndex={0}><div data-testid="document">学生作品</div><ShowcaseZoomControls compact={compact} scale={scale} onChange={setScale} /></div><button>其他操作</button></>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("floating showcase zoom", () => {
  it.each(["pointerMove", "pointerDown", "touchStart", "wheel", "scroll", "keyDown"] as const)("starts hidden and wakes on %s without changing the scale", (event) => {
    render(<ReadingSurface />);
    expect(screen.queryByRole("group", { name: "作品缩放" })).toBeNull();
    fireEvent[event](screen.getByTestId("document"), { key: "ArrowDown" });
    expect(screen.getByRole("group", { name: "作品缩放" })).toBeVisible();
    expect(screen.getByLabelText("文档缩放比例")).toHaveTextContent("100%");
    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.queryByRole("group", { name: "作品缩放" })).toBeNull();
  });

  it("stays available while adjusting, then hides without resetting the chosen scale", () => {
    render(<ReadingSurface />);
    const surface = screen.getByTestId("surface");
    fireEvent.pointerMove(surface);
    fireEvent.click(screen.getByRole("button", { name: "调整作品缩放" }));
    fireEvent.click(screen.getByRole("button", { name: "缩小作品" }));
    fireEvent.click(screen.getByRole("button", { name: "缩小作品" }));
    // Resizing the document may restore its reading anchor and emit a scroll.
    fireEvent.scroll(screen.getByTestId("document"));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("button", { name: "放大作品" })).toBeVisible();
    expect(screen.getByLabelText("文档缩放比例")).toHaveTextContent("80%");
    fireEvent.pointerDown(surface);
    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.queryByRole("group", { name: "作品缩放" })).toBeNull();
    fireEvent.wheel(surface);
    expect(screen.getByLabelText("文档缩放比例")).toHaveTextContent("80%");
    expect(screen.getByRole("button", { name: "调整作品缩放" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps keyboard focus visible and releases the timer when focus leaves", () => {
    render(<ReadingSurface />);
    fireEvent.keyDown(screen.getByTestId("surface"), { key: "Tab" });
    act(() => screen.getByRole("button", { name: "调整作品缩放" }).focus());
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("button", { name: "调整作品缩放" })).toBeVisible();
    act(() => screen.getByRole("button", { name: "其他操作" }).focus());
    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.queryByRole("group", { name: "作品缩放" })).toBeNull();
  });

  it("preserves the ordinary student zoom toolbar", () => {
    render(<ReadingSurface compact={false} />);
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("button", { name: "缩小作品" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "放大作品" }));
    expect(screen.getByLabelText("文档缩放比例")).toHaveTextContent("110%");
  });
});
