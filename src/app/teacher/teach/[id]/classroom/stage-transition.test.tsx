import { StrictMode, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveStatus } from "@/components/ui";
import type { Course } from "@/lib/session/types";
import { DEFAULT_STAGES } from "@/lib/session/types";
import type { ShowcasePresentationController } from "@/hooks/use-showcase-presentation";

const classroom = vi.hoisted(() => ({
  routeId: "A", course: undefined as Course | undefined, fullscreen: false,
  updateCourse: vi.fn(), flushSaves: vi.fn(), retrySave: vi.fn(), endTeaching: vi.fn(),
  saveState: "saved" as "saved" | "error", saveError: undefined as string | undefined,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: classroom.routeId }), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/session/store", () => ({
  useCourse: () => classroom.course, useHydrated: () => true,
  useSession: () => ({ ...classroom, user: { name: "教师", role: "teacher" }, setUiState: vi.fn() }),
}));
vi.mock("@/hooks/use-realtime-sync", () => ({ useRealtimeSync: vi.fn() }));
vi.mock("@/hooks/use-course-presence", () => ({ useCoursePresence: () => ({ onlineStudentIds: new Set(), degraded: false }) }));
vi.mock("@/hooks/use-teacher-presentation", () => ({ useTeacherPresentation: () => ({ active: classroom.fullscreen, enter: vi.fn(), exit: vi.fn() }) }));
vi.mock("@/components/dashboard-shell", () => ({
  DashboardShell: ({ children, headerSlot, saveStatus, immersive }: { children: ReactNode; headerSlot: ReactNode; saveStatus: ComponentProps<typeof SaveStatus>; immersive: boolean }) => <div>{!immersive ? <>{headerSlot}<SaveStatus {...saveStatus} /></> : null}{children}</div>,
  Avatar: () => null,
}));
vi.mock("@/components/classroom/classroom-chrome", () => ({
  StageGateDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>确认阶段切换</button>,
}));
vi.mock("@/components/views/teacher/stage-dispatcher", () => ({
  TeacherStageView: ({ course, showcaseController }: { course: Course; showcaseController: ShowcasePresentationController }) => <div data-testid="stage-content">{course.stages[course.currentStageIndex].key === "showcase"
    ? showcaseController.loading ? "正在读取汇报状态…" : showcaseController.error ?? showcaseController.data?.presentingStudentName
    : "项目实践内容"}</div>,
}));
vi.mock("@/components/classroom/teacher-classroom-pulse", () => ({ TeacherClassroomPulse: () => null }));
vi.mock("@/components/classroom/teacher-stage-dashboard", () => ({ TeacherStageDashboard: () => null, RealtimeTeachingActions: () => null }));
vi.mock("@/components/classroom/teacher-presentation-analytics", () => ({ TeacherPresentationAnalytics: () => null, TeacherKnowledgeAnalytics: () => null }));
vi.mock("@/components/classroom/teacher-knowledge-review", () => ({ TeacherClassroomReview: () => null }));
vi.mock("@/components/views/teacher/public-discussion-workspace", () => ({ PublicDiscussionTeacherWorkspace: () => null }));

import TeachClassroomPage from "./page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function course(id = "A", index = 2): Course {
  return { id, name: "阶段切换课堂", status: "teaching", currentStageIndex: index, stages: DEFAULT_STAGES,
    students: [], content: { knowledgePoints: [] }, uiState: { classroomTiming: { schemaVersion: 1, stages: [] } },
  } as unknown as Course;
}
function confirmStage() {
  fireEvent.change(screen.getByLabelText("当前教学阶段"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "确认阶段切换" }));
}
function showcaseResponse() {
  return Response.json({ courseId: classroom.routeId, stageKey: "showcase", students: [], ownArtifacts: [], presentations: [], queue: [], minutesPerStudent: 3, presentingStudentName: "已读取的汇报内容" });
}
beforeEach(() => {
  vi.clearAllMocks();
  classroom.routeId = "A";
  classroom.fullscreen = false;
  classroom.course = course();
  classroom.saveState = "saved";
  classroom.saveError = undefined;
  classroom.updateCourse.mockImplementation((_id: string, patch: Partial<Course>) => { classroom.course = { ...classroom.course!, ...patch }; });
  classroom.flushSaves.mockReset().mockResolvedValue(true);
  classroom.retrySave.mockReset().mockResolvedValue(undefined);
  window.history.replaceState({}, "", "/teacher/teach/A/classroom");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => showcaseResponse()));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe.each([false, true])("stage save barrier (fullscreen: %s)", fullscreen => {
  it("waits for save confirmation, then starts the initial read immediately", async () => {
    classroom.fullscreen = fullscreen;
    const saved = deferred<boolean>(), read = deferred<Response>();
    classroom.flushSaves.mockReturnValueOnce(saved.promise);
    vi.mocked(fetch).mockReturnValueOnce(read.promise);
    render(<TeachClassroomPage />);
    confirmStage();
    expect(screen.getByRole("status")).toHaveTextContent("正在切换到成果汇报…");
    expect(screen.queryByTestId("stage-content")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("当前教学阶段")).toBeDisabled();
    expect(within(screen.getByRole("contentinfo", { name: "课堂操作栏" })).queryByRole("button", { name: "结束课堂" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    const tools = screen.getByRole("dialog", { name: "课堂工具" });
    expect(within(tools).getByRole("button", { name: "结束课堂" })).toBeDisabled();
    fireEvent.keyDown(tools, { key: "Escape" });
    await act(async () => { saved.resolve(true); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("stage-content")).toHaveTextContent("正在读取汇报状态…");
    await act(async () => { read.resolve(showcaseResponse()); });
    expect(screen.getByTestId("stage-content")).toHaveTextContent("已读取的汇报内容");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["inline", "save status"])("recovers a failed save from %s without duplicating the transition", async entry => {
    classroom.fullscreen = fullscreen;
    classroom.saveState = "error";
    classroom.saveError = "阶段保存服务暂时不可用";
    classroom.flushSaves.mockResolvedValueOnce(false);
    const retry = deferred<void>();
    classroom.retrySave.mockReturnValueOnce(retry.promise);
    render(<TeachClassroomPage />);
    confirmStage();
    expect(await screen.findByRole("alert")).toHaveTextContent(classroom.saveError);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: entry === "inline" ? "重试阶段切换" : "重试" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在切换到成果汇报…");
    expect(classroom.retrySave).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { retry.resolve(); });
    await waitFor(() => expect(screen.getByTestId("stage-content")).toHaveTextContent("已读取的汇报内容"));
    expect(classroom.updateCourse).toHaveBeenCalledOnce();
    expect(classroom.course?.stageTransitions).toHaveLength(1);
  });
});

it("loads a classroom already in showcase without a save barrier", async () => {
  classroom.course = course("A", 3);
  render(<TeachClassroomPage />);
  await waitFor(() => expect(screen.getByTestId("stage-content")).toHaveTextContent("已读取的汇报内容"));
  expect(classroom.flushSaves).not.toHaveBeenCalled();
  expect(classroom.updateCourse).not.toHaveBeenCalled();
});

it("retires old save callbacks across A→B→A even while the new transition is pending", async () => {
  const first = deferred<boolean>(), second = deferred<boolean>();
  classroom.flushSaves.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = render(<TeachClassroomPage />);
  confirmStage();
  classroom.routeId = "B";
  classroom.course = course("B");
  view.rerender(<TeachClassroomPage />);
  classroom.routeId = "A";
  classroom.course = course();
  view.rerender(<TeachClassroomPage />);
  confirmStage();
  await act(async () => { first.resolve(true); });
  expect(screen.getByRole("status")).toHaveTextContent("正在切换到成果汇报…");
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => { second.resolve(true); });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
});

it("does not read showcase after the page is left during a pending save", async () => {
  const saved = deferred<boolean>();
  classroom.flushSaves.mockReturnValueOnce(saved.promise);
  const view = render(<TeachClassroomPage />);
  confirmStage();
  view.unmount();
  await act(async () => { saved.resolve(true); });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["saving", "error"])("restores the original optimistic transition after navigation while %s", async status => {
  const saved = deferred<boolean>();
  classroom.flushSaves.mockReturnValue(saved.promise);
  const view = render(<TeachClassroomPage />);
  confirmStage();
  if (status === "error") {
    await act(async () => { saved.resolve(false); });
    await screen.findByRole("button", { name: "重试阶段切换" });
  }
  const optimistic = classroom.course;
  classroom.routeId = "B";
  classroom.course = course("B");
  view.rerender(<TeachClassroomPage />);
  classroom.routeId = "A";
  classroom.course = optimistic;
  view.rerender(<TeachClassroomPage />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByTestId("stage-content")).toBeNull();
  if (status === "error") {
    classroom.flushSaves.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "重试阶段切换" }));
  } else {
    expect(screen.getByRole("status")).toHaveTextContent("正在切换到成果汇报…");
    await act(async () => { saved.resolve(true); });
  }
  await waitFor(() => expect(screen.getByTestId("stage-content")).toHaveTextContent("已读取的汇报内容"));
  expect(classroom.updateCourse).toHaveBeenCalledOnce();
  expect(classroom.course?.stageTransitions).toHaveLength(1);
});

it("settles a retained save after StrictMode replays mount effects", async () => {
  const saved = deferred<boolean>();
  classroom.flushSaves.mockReturnValue(saved.promise);
  const view = render(<TeachClassroomPage />);
  confirmStage();
  view.unmount();
  render(<StrictMode><TeachClassroomPage /></StrictMode>);
  expect(screen.getByRole("status")).toHaveTextContent("正在切换到成果汇报…");
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => { saved.resolve(true); });
  await waitFor(() => expect(screen.getByTestId("stage-content")).toHaveTextContent("已读取的汇报内容"));
  expect(classroom.updateCourse).toHaveBeenCalledOnce();
});
