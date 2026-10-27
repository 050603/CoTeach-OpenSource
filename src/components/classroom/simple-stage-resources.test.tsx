import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectionClientId } from "@/lib/realtime/projection-controller";
import type { Course } from "@/lib/session/types";
import { TeacherPresentationActionsProvider } from "./teacher-presentation-actions";
import { SimplifiedStudentStageView, SimplifiedTeacherStageView, StudentPdfResourceViewer, StudentProjectionPrecache, StudentResourceProjection, videoPrecacheRanges } from "./simple-stage-resources";

const pdfRuntime = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/browser/pdf-runtime", () => ({ loadPdfRuntime: pdfRuntime.load }));

const session = vi.hoisted(() => ({
  refresh: vi.fn(),
  setUiState: vi.fn(),
  markResourceDownloaded: vi.fn(),
  studentId: "student-1",
}));

vi.mock("@/lib/session/store", () => ({
  useSession: () => session,
}));

const course = {
  id: "course-1",
  uiState: {},
  resources: [
    { id: "launch-file", title: "启动说明.pdf", type: "PDF", size: "1 MB", stageKey: "launch", url: "/launch", downloadedBy: [] },
    { id: "reflection-file", title: "反思提示.pdf", type: "PDF", size: "1 MB", stageKey: "reflection", url: "/reflection", downloadedBy: [] },
  ],
} as unknown as Course;

describe("simplified stage resources", () => {
  it("keeps launch management and plain synchronization in separate footer groups without a resource title", () => {
    render(<footer><div data-testid="resource-actions" /><div data-testid="sync-actions" /></footer>);
    const target = screen.getByTestId("sync-actions");
    const leadingTarget = screen.getByTestId("resource-actions");
    const view = render(<TeacherPresentationActionsProvider target={target} leadingTarget={leadingTarget}>
      <SimplifiedTeacherStageView course={course} stageKey="launch" presentation="teaching" />
    </TeacherPresentationActionsProvider>);
    expect(session.setUiState).not.toHaveBeenCalled();
    expect(within(leadingTarget).getByRole("button", { name: "资料管理" })).toBeVisible();
    expect(within(target).getByRole("button", { name: "同步到学生" })).not.toHaveAttribute("data-tone", "primary");
    expect(within(screen.getByRole("contentinfo")).queryByText("启动说明.pdf")).toBeNull();
    fireEvent.click(within(target).getByRole("button", { name: "同步到学生" }));
    expect(session.setUiState).toHaveBeenCalledTimes(1);
    const patch = session.setUiState.mock.calls[0][1];
    expect(patch.resourceProjection).toMatchObject({ resourceId: "launch-file", stageKey: "launch" });
    view.rerender(<TeacherPresentationActionsProvider target={target} leadingTarget={leadingTarget}>
      <SimplifiedTeacherStageView course={{ ...course, uiState: { ...patch, projectionController: { teacherId: "teacher-1", clientId: projectionClientId() } } }} stageKey="launch" presentation="analytics" />
    </TeacherPresentationActionsProvider>);
    expect(session.setUiState).toHaveBeenCalledTimes(1);
    expect(within(target).queryByRole("button", { name: "同步到学生" })).toBeNull();
    fireEvent.click(within(target).getByRole("button", { name: "停止同步" }));
    expect(session.setUiState).toHaveBeenLastCalledWith("course-1", { resourceProjection: null });
    view.unmount();
    expect(target.childElementCount).toBe(0);
    expect(leadingTarget.childElementCount).toBe(0);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the student title card in the first stage", () => {
    const emptyCourse = { ...course, resources: [], content: { stagePlan: { stages: [{ key: "launch", title: "教师教案", durationMin: 10, requirements: "仅供教师查看的要求" }] } } } as unknown as Course;
    render(<SimplifiedStudentStageView course={emptyCourse} stageKey="launch" />);

    expect(screen.getByRole("heading", { name: "了解项目任务，完成资料阅读" }).closest("header")?.className)
      .toContain("classroom-stage-header--student-card");
    expect(screen.getByText(/明确要解决的问题、阶段目标与协作分工/)).toBeTruthy();
    expect(screen.queryByText(/教案要求|仅供教师查看的要求/)).toBeNull();
  });

  it("shows collaborative launch instructions to students and teachers without fabricating resource progress", () => {
    const collaborative = { ...course, resources: [], learningObjectives: ["解释公平实验"], content: { stagePlan: {
      source: "collaborative-preparation", totalMinutes: 45, projectTask: "设计公平实验", stages: [
        { key: "launch", title: "项目启动", durationMin: 5, requirements: "观察湿布", outputs: "提出问题", teacherActions: "教师备课笔记" },
      ],
    } } } as unknown as Course;
    const view = render(<SimplifiedStudentStageView course={collaborative} stageKey="launch" />);
    expect(screen.getByRole("region", { name: "项目启动说明" })).toBeTruthy();
    expect(screen.getByText("设计公平实验")).toBeTruthy();
    expect(screen.queryByText("本阶段暂未发布学习资料")).toBeNull();
    expect(session.markResourceDownloaded).not.toHaveBeenCalled();
    expect(session.setUiState).not.toHaveBeenCalled();
    view.rerender(<SimplifiedTeacherStageView course={collaborative} stageKey="launch" presentation="teaching" />);
    expect(screen.getByRole("region", { name: "项目启动说明" })).toBeTruthy();
    expect(screen.queryByText("教师备课笔记")).toBeNull();
  });

  it("uses one consistent three-state reading vocabulary", () => {
    const readingCourse = {
      ...course,
      resources: [
        { id: "launch-file", title: "启动说明.pdf", type: "PDF", size: "1 MB", stageKey: "launch", url: "/launch", downloadedBy: [] },
        { id: "launch-read", title: "分工提示.pdf", type: "PDF", size: "2 MB", stageKey: "launch", url: "/read", downloadedBy: ["student-1"] },
        { id: "launch-unread", title: "评价说明.pdf", type: "PDF", size: "3 MB", stageKey: "launch", url: "/unread", downloadedBy: [] },
      ],
    } as Course;
    render(<SimplifiedStudentStageView course={readingCourse} stageKey="launch" />);

    expect(screen.getByText(/1 MB · 阅读中/)).toBeTruthy();
    expect(screen.getByText("阅读中")).toBeTruthy();
    expect(screen.getByText(/2 MB · 已阅读/)).toBeTruthy();
    expect(screen.getByText(/3 MB · 未阅读/)).toBeTruthy();
    expect(screen.queryByText("已打开")).toBeNull();
    expect(screen.queryByText("未查看")).toBeNull();
    expect(session.markResourceDownloaded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /评价说明\.pdf/ }));
    expect(session.markResourceDownloaded).toHaveBeenCalledWith("course-1", "launch-unread");
  });

  it("warms only bounded video ranges and staggers the request", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn().mockResolvedValue({
      status: 206,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);
    const video = { id: "lesson-video", title: "课堂示范.mp4", type: "video/mp4", size: String(20 * 1024 * 1024), stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] };
    const videoCourse = { ...course, resources: [video] } as Course;

    expect(videoPrecacheRanges(video)).toEqual([
      "bytes=0-2097151",
      "bytes=20447232-20971519",
    ]);
    render(<StudentProjectionPrecache course={videoCourse} stageKey="launch" />);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers)).toEqual([
      { Range: "bytes=0-2097151" },
      { Range: "bytes=20447232-20971519" },
    ]);
    vi.useRealTimers();
  });

  it("lets a student open and leave an immersive reader", () => {
    render(<SimplifiedStudentStageView course={course} stageKey="launch" />);

    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));
    const dialog = screen.getByRole("dialog", { name: "全屏阅读" });
    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出全屏阅读" }));
    expect(screen.queryByRole("dialog", { name: "全屏阅读" })).toBeNull();
  });

  it("shows only the active stage files and starts a classroom projection", () => {
    render(<SimplifiedTeacherStageView course={course} stageKey="reflection" />);

    expect(screen.getAllByText("反思提示.pdf")).toHaveLength(1);
    expect(screen.queryByText("启动说明.pdf")).toBeNull();
    expect(screen.getAllByRole("heading", { name: "学习资料" })).toHaveLength(1);
    expect(screen.queryByText("轻量授课阶段")).toBeNull();
    expect(screen.queryByText(/会自动生成稳定/)).toBeNull();
    expect(screen.getByText(/PPT 请先导出为 PDF/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除学习资料 反思提示.pdf" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择与管理资料" }));
    const resources = screen.getByRole("dialog", { name: "选择与管理资料" });
    expect(within(resources).getByRole("button", { name: "删除学习资料 反思提示.pdf" })).toBeTruthy();
    fireEvent.click(within(resources).getByRole("button", { name: "关闭抽屉" }));
    fireEvent.click(screen.getByRole("button", { name: "全屏预览" }));
    expect(within(screen.getByRole("dialog", { name: "学习资料预览" })).getByRole("button", { name: "投屏" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "学习资料预览" })).getByRole("button", { name: "退出全屏阅读" }));
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    expect(session.setUiState).toHaveBeenCalledWith("course-1", {
      resourceProjection: expect.objectContaining({
        resourceId: "reflection-file",
        stageKey: "reflection",
        title: "反思提示.pdf",
        viewState: expect.objectContaining({
          page: 1,
          scrollRatio: 0,
          mediaPlaying: false,
        }),
      }),
    });
  });

  it("preserves the resource player and position across teaching and analytics without syncing students", () => {
    const videoCourse = {
      ...course,
      resources: [
        { id: "video-1", title: "演示一.mp4", type: "MP4", size: "2 MB", stageKey: "launch", url: "/video-1", downloadedBy: [] },
        { id: "video-2", title: "演示二.mp4", type: "MP4", size: "2 MB", stageKey: "launch", url: "/video-2", downloadedBy: [] },
      ],
    } as Course;
    const view = render(<SimplifiedTeacherStageView course={videoCourse} stageKey="launch" />);
    fireEvent.click(screen.getByRole("button", { name: "选择与管理资料" }));
    fireEvent.click(screen.getByRole("button", { name: /^视频\s*演示二.mp4/ }));
    expect(screen.queryByRole("dialog", { name: "选择与管理资料" })).toBeNull();
    const video = document.querySelector("video")!;
    video.currentTime = 37;
    fireEvent.click(screen.getByRole("button", { name: "全屏预览" }));
    expect(document.querySelector("video")).toBe(video);
    for (const presentation of ["teaching", "analytics", "teaching", "workspace"] as const) {
      view.rerender(<SimplifiedTeacherStageView course={videoCourse} stageKey="launch" presentation={presentation} />);
      expect(document.querySelector("video")).toBe(video);
      expect(video.currentTime).toBe(37);
      expect(document.querySelectorAll("video")).toHaveLength(1);
      expect(screen.queryByRole("dialog", { name: "学习资料预览" })).toBeNull();
    }
    expect(session.setUiState).not.toHaveBeenCalled();
    expect(session.markResourceDownloaded).not.toHaveBeenCalled();

    view.rerender(<SimplifiedTeacherStageView course={videoCourse} stageKey="launch" presentation="teaching" />);
    expect(screen.queryByRole("button", { name: /删除学习资料/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: "阅读跟进" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "选择授课资料" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "资料管理" }));
    const management = screen.getByRole("dialog", { name: "资料管理" });
    expect(within(management).getByRole("button", { name: /^视频\s*演示二.mp4/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(management).getByRole("button", { name: "关闭抽屉" }));
    fireEvent.click(screen.getByRole("button", { name: "同步到学生" }));
    expect(session.setUiState).toHaveBeenCalledWith("course-1", { resourceProjection: expect.objectContaining({ resourceId: "video-2" }) });
  });

  it("uses only the requested stage task as the presentation fallback", () => {
    const emptyCourse = { ...course, resources: [], stages: [{ key: "launch", label: "项目启动", description: "讨论校园节能问题", view: "project-launch" }, { key: "reflection", label: "学习反思", description: "总结本次实践", view: "reflection" }] } as Course;
    const view = render(<SimplifiedTeacherStageView course={emptyCourse} stageKey="launch" presentation="teaching" />);
    expect(screen.getByText("讨论校园节能问题")).toBeTruthy();
    expect(screen.queryByText("总结本次实践")).toBeNull();
    view.rerender(<SimplifiedTeacherStageView course={emptyCourse} stageKey="unknown" presentation="teaching" />);
    expect(screen.getByText("本阶段尚未添加学习资料或任务。")).toBeTruthy();
    expect(screen.queryByText("讨论校园节能问题")).toBeNull();
  });

  it("uses one authoritative video controller in immersive projection", () => {
    const videoCourse = {
      ...course,
      resources: [
        { id: "lesson-video", title: "课堂示范.mp4", type: "MP4", size: "58 MB", stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] },
      ],
    } as Course;
    const view = render(<SimplifiedTeacherStageView course={videoCourse} stageKey="launch" />);

    fireEvent.click(screen.getByRole("button", { name: "全屏预览" }));
    const dialog = screen.getByRole("dialog", { name: "学习资料预览" });
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(document.querySelector("video")?.getAttribute("src")).toBe("/api/uploads/lesson-video");
    expect(document.querySelector("video")?.getAttribute("preload")).toBe("metadata");
    expect(document.querySelector("video")?.controls).toBe(true);
    expect(document.querySelector("video")?.closest(".teacher-resource-video")).toBeTruthy();
    expect(document.querySelector("video")?.closest(".teacher-resource-video-container")).toBeTruthy();
    expect(within(dialog).getByText("全屏播放")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "投屏" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "退出全屏播放" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "投屏" }));
    const projectedCourse = {
      ...videoCourse,
      uiState: {
        projectionController: { teacherId: "teacher-1", clientId: projectionClientId() },
        resourceProjection: {
          resourceId: "lesson-video",
          stageKey: "launch",
          title: "课堂示范.mp4",
          startedAt: new Date().toISOString(),
          viewState: {
            mediaTime: 12,
            mediaPlaying: false,
            mediaPlaybackRate: 1,
            updatedAt: new Date().toISOString(),
            revision: 2,
          },
        },
      },
    } as Course;
    view.rerender(<SimplifiedTeacherStageView course={projectedCourse} stageKey="launch" />);

    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(within(screen.getByRole("dialog", { name: "学习资料预览" })).getByText("实时投屏控制")).toBeTruthy();
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, value: 18, writable: true });
    Object.defineProperty(video, "playbackRate", { configurable: true, value: 1.25, writable: true });
    fireEvent.play(video);
    expect(session.setUiState).toHaveBeenLastCalledWith("course-1", {
      resourceProjection: expect.objectContaining({
        viewState: expect.objectContaining({ mediaPlaying: true, mediaTime: 18, mediaPlaybackRate: 1.25 }),
      }),
    });
    fireEvent.ended(video);
    expect(session.setUiState).toHaveBeenLastCalledWith("course-1", {
      resourceProjection: expect.objectContaining({
        viewState: expect.objectContaining({ mediaPlaying: false, mediaTime: 18 }),
      }),
    });
  });

  it("shows a paused projected video without an authorization cover", () => {
    const resource = { id: "lesson-video", title: "课堂示范.mp4", type: "MP4", size: "58 MB", stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] };
    const projection = {
      resourceId: resource.id,
      stageKey: "launch",
      title: resource.title,
      startedAt: new Date().toISOString(),
      viewState: { mediaTime: 0, mediaPlaying: false, mediaPlaybackRate: 1, updatedAt: new Date().toISOString(), revision: 3 },
    };

    const view = render(<StudentResourceProjection course={course} projection={projection} resource={resource} />);

    expect(document.querySelector("video")?.getAttribute("src")).toBe("/api/uploads/lesson-video");
    expect(document.querySelector("video")?.muted).toBe(true);
    expect(screen.queryByRole("button", { name: /同步播放|同步声音/ })).toBeNull();
    view.unmount();
    expect(document.querySelector("video")).toBeNull();
  });

  it("falls back to muted picture sync when the browser blocks sound autoplay", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("autoplay blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const resource = { id: "lesson-video", title: "课堂示范.mp4", type: "MP4", size: "58 MB", stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] };
    const playingProjection = {
      resourceId: resource.id,
      stageKey: "launch",
      title: resource.title,
      startedAt: new Date().toISOString(),
      viewState: { mediaTime: 8, mediaPlaying: true, mediaPlaybackRate: 1, updatedAt: new Date().toISOString(), revision: 4 },
    };
    const view = render(<StudentResourceProjection course={course} projection={playingProjection} resource={resource} />);
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
    Object.defineProperty(video, "duration", { configurable: true, value: 120 });

    fireEvent.loadedMetadata(video);

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(video.muted).toBe(true);
    expect(screen.getByRole("button", { name: "点击开启同步声音" })).toBeTruthy();

    view.rerender(<StudentResourceProjection
      course={course}
      projection={{ ...playingProjection, viewState: { ...playingProjection.viewState, mediaPlaying: false, revision: 5 } }}
      resource={resource}
    />);
    await waitFor(() => expect(pause).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "点击开启同步声音" })).toBeNull();
  });

  it("asks whether an uploaded PDF is a slide deck and submits slide mode", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "POST"
        ? { ok: true, json: async () => ({ id: "new-pdf", title: "课堂演示.pdf" }) }
        : { ok: false, status: 404 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    session.refresh.mockResolvedValue(undefined);
    render(<SimplifiedTeacherStageView course={course} stageKey="reflection" />);

    fireEvent.change(screen.getByLabelText("上传资料"), {
      target: {
        files: [new File(["%PDF-1.7"], "课堂演示.pdf", { type: "application/pdf" })],
      },
    });

    expect(screen.getByRole("dialog", { name: "这份 PDF 如何用于课堂？" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /幻灯片演示/ }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1] as { body: FormData };
    expect(request.body.get("pdfDisplayMode")).toBe("slides");
  });

  it("switches an existing PDF to slide playback without re-uploading it", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PATCH"
        ? { ok: true, json: async () => ({ id: "reflection-file", displayMode: "slides" }) }
        : { ok: false, status: 404 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    session.refresh.mockResolvedValue(undefined);
    render(<SimplifiedTeacherStageView course={course} stageKey="reflection" />);

    fireEvent.click(screen.getByRole("button", { name: "逐页演示" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patchCall?.[0]).toBe("/api/uploads/reflection-file");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ displayMode: "slides" });
    expect(session.refresh).toHaveBeenCalledWith("teacher");
  });
});

describe("launch PDF controls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
    pdfRuntime.load.mockResolvedValue({ getDocument: () => ({ promise: Promise.resolve({ numPages: 2, getPage: async () => ({ getViewport: () => ({ width: 960, height: 540 }) }) }) }) });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function launch(displayMode: "slides" | "document" = "slides") {
    await act(async () => {
      render(<SimplifiedTeacherStageView course={{ ...course, resources: [{ ...course.resources![0]!, displayMode }] }} stageKey="launch" presentation="teaching" />);
    });
    const toolbar = screen.getByRole("toolbar", { name: "课件操作" });
    return { toolbar, surface: toolbar.parentElement! };
  }

  it.each(["slides", "document"] as const)("hides idle %s controls and reveals them for movement, scrolling and touch without manual toggles", async displayMode => {
    const { toolbar, surface } = await launch(displayMode);
    expect(screen.queryByRole("button", { name: /收起课件操作|显示课件操作/ })).toBeNull();
    for (const activity of [() => fireEvent.pointerMove(surface), () => fireEvent.wheel(surface), () => fireEvent.scroll(surface), () => fireEvent.pointerDown(surface, { pointerType: "touch" })]) {
      act(() => vi.advanceTimersByTime(1_800));
      expect(toolbar).not.toBeVisible();
      expect(screen.getByRole("group", { name: "课件翻页" })).toBeVisible();
      activity();
      expect(toolbar).toBeVisible();
      act(() => vi.advanceTimersByTime(1_799));
      expect(toolbar).toBeVisible();
    }
  });

  it("keeps page input usable and hides again when reading resumes", async () => {
    const { toolbar, surface } = await launch();
    act(() => within(toolbar).getByRole("spinbutton", { name: "跳转页码" }).focus());
    act(() => vi.advanceTimersByTime(10_000));
    expect(toolbar).toBeVisible();
    fireEvent.wheel(surface);
    act(() => vi.advanceTimersByTime(1_800));
    expect(toolbar).not.toBeVisible();
  });

  it("keeps side arrows available while idle and enforces the first and last page", async () => {
    const { toolbar } = await launch();
    const navigation = within(screen.getByRole("group", { name: "课件翻页" }));
    const previous = navigation.getByRole("button", { name: "上一页课件" });
    const next = navigation.getByRole("button", { name: "下一页课件" });
    expect(previous).toBeDisabled();
    act(() => vi.advanceTimersByTime(1_800));
    expect(toolbar).not.toBeVisible();
    fireEvent.pointerDown(next);
    fireEvent.click(next);
    expect(within(toolbar).getByRole("spinbutton", { name: "跳转页码" })).toHaveValue(2);
    expect(next).toBeDisabled();
    expect(previous).toBeEnabled();
    fireEvent.click(previous);
    expect(within(toolbar).getByRole("spinbutton", { name: "跳转页码" })).toHaveValue(1);
    expect(previous).toBeDisabled();
  });
});

describe("compact PDF reading input", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["touch", "mouse"])("keeps the intended hide behavior after %s leaves the reader", async (pointerType) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
    pdfRuntime.load.mockResolvedValue({ getDocument: () => ({ promise: Promise.resolve({ numPages: 2, getPage: vi.fn() }) }) });
    render(<StudentPdfResourceViewer url="/contact-fixture.pdf" title="观察记录" progressKey={`contact-${pointerType}`} onReady={vi.fn()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "PDF 阅读工具" });
    const reader = screen.getByRole("region", { name: "PDF 页面" }).parentElement!;
    vi.useFakeTimers();
    function pointer(type: "pointerdown" | "pointerout") {
      const event = new MouseEvent(type, { bubbles: true, relatedTarget: type === "pointerout" ? document.body : null });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      fireEvent(reader, event);
    }
    pointer("pointerdown");
    pointer("pointerout");
    expect(toolbar).toHaveAttribute("data-visible", String(pointerType === "touch"));
    if (pointerType === "touch") {
      act(() => vi.advanceTimersByTime(1_799));
      expect(toolbar).toHaveAttribute("data-visible", "true");
      act(() => vi.advanceTimersByTime(1));
      expect(toolbar).toHaveAttribute("data-visible", "false");
    }
  });
});
