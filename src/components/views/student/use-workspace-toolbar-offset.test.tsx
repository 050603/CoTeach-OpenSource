import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceToolbarOffset } from "./use-workspace-toolbar-offset";

let headerHeight = 64;
let resized: () => void;
const observe = vi.fn();
const disconnect = vi.fn();

function Workspace({ ready = true, stickyTop = 64 }: { ready?: boolean; stickyTop?: number }) {
  const { headerRef, toolbarTop } = useWorkspaceToolbarOffset();
  return ready ? <>
    <header ref={headerRef} style={{ position: "sticky", top: stickyTop }}>保存与提交</header>
    <div role="toolbar" style={{ top: toolbarTop }}>编辑工具</div>
    <input aria-label="当前草稿" defaultValue="未保存内容" />
  </> : <p>正在加载课堂</p>;
}

beforeEach(() => {
  headerHeight = 64;
  observe.mockClear();
  disconnect.mockClear();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return DOMRect.fromRect({ height: this.tagName === "HEADER" ? headerHeight : 0 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace toolbar position", () => {
  it("follows wrapped action rows and returns to desktop height without replacing the draft", () => {
    const { unmount } = render(<Workspace />);
    expect(screen.getByRole("toolbar")).toHaveStyle({ top: "140px" });
    expect(observe).toHaveBeenCalledWith(screen.getByRole("banner"));
    const draft = screen.getByRole("textbox", { name: "当前草稿" });
    fireEvent.change(draft, { target: { value: "学生正在编辑的内容" } });

    headerHeight = 116;
    act(() => resized());
    expect(screen.getByRole("toolbar")).toHaveStyle({ top: "192px" });
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft).toHaveValue("学生正在编辑的内容");

    headerHeight = 64;
    act(() => resized());
    expect(screen.getByRole("toolbar")).toHaveStyle({ top: "140px" });
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("measures a header mounted after course hydration and observes a changed sticky inset", () => {
    const view = render(<Workspace ready={false} />);
    expect(observe).not.toHaveBeenCalled();
    headerHeight = 116;
    view.rerender(<Workspace />);
    expect(screen.getByRole("toolbar")).toHaveStyle({ top: "192px" });
    view.rerender(<Workspace stickyTop={80} />);
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("toolbar")).toHaveStyle({ top: "208px" });
  });
});
