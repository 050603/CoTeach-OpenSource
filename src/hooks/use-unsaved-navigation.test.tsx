import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useUnsavedNavigation } from "./use-unsaved-navigation";

const navigate = vi.fn();
function Editor() {
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ proceed: () => void } | null>(null);
  useUnsavedNavigation({ dirty, navigate, onRequest: setPending });
  return <><input aria-label="课程名称" onChange={() => setDirty(true)} /><a href="/teacher/templates">课程库</a>
    <a href="#evidence">查看证据</a><a href="/teacher/textbooks" target="_blank">新窗口教材</a>
    {pending ? <div role="dialog"><button onClick={() => setPending(null)}>取消</button><button onClick={() => pending.proceed()}>放弃修改</button></div> : null}</>;
}

beforeEach(() => { navigate.mockClear(); history.replaceState(null, "", "/teacher/prepare/course/verify/edit"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("unsaved preparation navigation", () => {
  it("guards client links and refresh, but leaves in-page reading and new windows alone", () => {
    render(<Editor />);
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "修改" } });
    fireEvent.click(screen.getByRole("link", { name: "查看证据" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "新窗口教材" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "课程库" }));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("课程名称")).toHaveValue("修改");
    fireEvent.click(screen.getByRole("link", { name: "课程库" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(navigate).toHaveBeenCalledWith("/teacher/templates");
    const approvedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(approvedUnload);
    expect(approvedUnload.defaultPrevented).toBe(false);
  });

  it("restores a dirty editor before asking about browser Back and traverses only after approval", () => {
    const replace = history.replaceState.bind(history);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});
    render(<Editor />);
    const firstState = { ...history.state };
    history.pushState({ __NA: true }, "", "/teacher/prepare/course/verify/edit?section=knowledge");
    const editingState = { ...history.state };
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "修改" } });
    const routerPop = vi.fn();
    window.addEventListener("popstate", routerPop);
    act(() => {
      replace(firstState, "", "/teacher/prepare/course/verify/edit");
      window.dispatchEvent(new PopStateEvent("popstate", { state: firstState }));
    });
    expect(go).toHaveBeenLastCalledWith(1);
    expect(routerPop).not.toHaveBeenCalled();
    // A pending router commit must not give the visited entry the editor's index.
    history.replaceState({ __NA: true }, "", "/teacher/prepare/course/verify/edit");
    expect(history.state.__coteachPreparationPosition).toBe(firstState.__coteachPreparationPosition);
    act(() => {
      replace(editingState, "", "/teacher/prepare/course/verify/edit?section=knowledge");
      window.dispatchEvent(new PopStateEvent("popstate", { state: editingState }));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(location.search).toBe("?section=knowledge");
    expect(routerPop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    act(() => {
      replace(firstState, "", "/teacher/prepare/course/verify/edit");
      window.dispatchEvent(new PopStateEvent("popstate", { state: firstState }));
      replace(editingState, "", "/teacher/prepare/course/verify/edit?section=knowledge");
      window.dispatchEvent(new PopStateEvent("popstate", { state: editingState }));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(go).toHaveBeenLastCalledWith(-1);
    act(() => {
      replace(firstState, "", "/teacher/prepare/course/verify/edit");
      window.dispatchEvent(new PopStateEvent("popstate", { state: firstState }));
    });
    expect(routerPop).toHaveBeenCalledOnce();
    window.removeEventListener("popstate", routerPop);
  });
});
