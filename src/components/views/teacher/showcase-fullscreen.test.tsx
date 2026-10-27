import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTeacherPresentation } from "@/hooks/use-teacher-presentation";
import { getStagesForSystemMode } from "@/lib/system-mode";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({ runAction: vi.fn(), updateViewState: vi.fn() }));
const artifact = { kind: "document" as const, versionId: "a1", title: "学生作品", sequence: 1, submittedAt: "2026-10-26", displayModes: ["continuous" as const] };
vi.mock("@/hooks/use-showcase-presentation", () => ({ useShowcasePresentation: () => ({
  loading: false, runAction: mocks.runAction, updateViewState: mocks.updateViewState,
  data: { students: [{ studentId: "s1", name: "小林", artifacts: [artifact] }], queue: [], presentations: [], activePresentation: null },
}) }));
vi.mock("@/components/showcase/showcase-artifact-viewer", () => ({ ShowcaseArtifactViewer: ({ mode, initialViewState, onViewStateChange }: { mode: string; initialViewState?: { page?: number }; onViewStateChange: (patch: { page: number }) => void }) => <div data-testid="viewer" data-mode={mode} data-page={initialViewState?.page}><button onClick={() => onViewStateChange({ page: 2 })}>翻到第二页</button></div> }));
import { NewShowcaseTeacherView } from "./showcase-reporting";

const course = { id: "c1", name: "测试课", status: "teaching", stages: getStagesForSystemMode("new"), currentStageIndex: 3,
  students: [], groups: [], content: { knowledgePoints: [], lessonOutline: [] },
} as unknown as Course;

function Classroom() {
  const fullscreen = useTeacherPresentation();
  return <><button onClick={() => void fullscreen.enter()}>授课全屏</button><NewShowcaseTeacherView course={course} fullscreen={fullscreen} /></>;
}

let fullscreenElement: Element | null;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fullscreenElement = null;
  requestFullscreen = vi.fn(async () => { fullscreenElement = document.documentElement; document.dispatchEvent(new Event("fullscreenchange")); });
  exitFullscreen = vi.fn(async () => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ recommendedStudentIds: [], candidates: [], revision: "r1" })));
});
afterEach(() => {
  cleanup();
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  vi.unstubAllGlobals();
});

const localOverlay = () => screen.getByRole("dialog", { name: "作品全屏展示：学生作品" });

describe("showcase shares the classroom's native fullscreen controller", () => {
  it("enters native fullscreen in one click and restores reading position and scrolling on return", async () => {
    document.body.style.overflow = "auto";
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    await waitFor(() => expect(fullscreenElement).toBe(document.documentElement));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(within(localOverlay()).getByTestId("viewer")).toHaveAttribute("data-mode", "self");
    expect(screen.queryByRole("button", { name: "浏览器全屏" })).toBeNull();
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "翻到第二页" }));
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "返回作品浏览" }));
    await waitFor(() => expect(fullscreenElement).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("viewer")).toHaveAttribute("data-page", "2");
    expect(document.body.style.overflow).toBe("auto");
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(mocks.updateViewState).not.toHaveBeenCalled();
    document.body.style.overflow = "";
  });

  it("preserves fullscreen that the teacher entered before opening a work", async () => {
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "授课全屏" }));
    await waitFor(() => expect(fullscreenElement).toBe(document.documentElement));
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "返回作品浏览" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(fullscreenElement).toBe(document.documentElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("follows native Escape without sending a public showcase action", async () => {
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    await waitFor(() => expect(within(localOverlay()).getByRole("button", { name: "退出全屏" })).toBeTruthy());
    act(() => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("exits through the single fullscreen control and returns to browsing", async () => {
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    await waitFor(() => expect(within(localOverlay()).getByRole("button", { name: "退出全屏" })).toBeTruthy());
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "退出全屏" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it.each(["denied", "unsupported"])("keeps a usable window preview and a retry control when fullscreen is %s", async (reason) => {
    if (reason === "denied") requestFullscreen.mockRejectedValueOnce(new Error("Denied"));
    else Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: undefined });
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    await waitFor(() => expect(within(localOverlay()).getByRole("status", { name: "全屏提示" })).toHaveTextContent(reason === "denied" ? "浏览器未允许全屏" : "浏览器不支持全屏"));
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "翻到第二页" }));
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "进入全屏" }));
    await waitFor(() => expect(fullscreenElement).toBe(document.documentElement));
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "返回作品浏览" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("viewer")).toHaveAttribute("data-page", "2");
    expect(mocks.updateViewState).not.toHaveBeenCalled();
  });

  it("cancels a fullscreen request that resolves after returning to browsing", async () => {
    let complete!: () => void;
    requestFullscreen.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = () => { fullscreenElement = document.documentElement; document.dispatchEvent(new Event("fullscreenchange")); resolve(); }; }));
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "返回作品浏览" }));
    await act(async () => { complete(); });
    expect(fullscreenElement).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("uses Escape to close the zoom controls before closing the work preview", async () => {
    requestFullscreen.mockRejectedValueOnce(new Error("Denied"));
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    await waitFor(() => expect(within(localOverlay()).getByRole("status", { name: "全屏提示" })).toHaveTextContent("浏览器未允许全屏"));
    fireEvent.pointerMove(within(localOverlay()).getByTestId("viewer"));
    const zoom = within(localOverlay()).getByRole("button", { name: "调整作品缩放" });
    fireEvent.click(zoom);
    fireEvent.keyDown(zoom, { key: "Escape" });
    expect(zoom).toHaveAttribute("aria-expanded", "false");
    expect(localOverlay()).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a new preview open when the previous preview's native exit finishes late", async () => {
    render(<Classroom />);
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    await waitFor(() => expect(within(localOverlay()).getByRole("button", { name: "退出全屏" })).toBeTruthy());
    let finishExit!: () => void;
    exitFullscreen.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishExit = () => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); resolve(); };
    }));
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "返回作品浏览" }));
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    await act(async () => { finishExit(); });
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(2));
    expect(localOverlay()).toBeTruthy();
    expect(fullscreenElement).toBe(document.documentElement);
    fireEvent.click(within(localOverlay()).getByRole("button", { name: "返回作品浏览" }));
    await waitFor(() => expect(fullscreenElement).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
