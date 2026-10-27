import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveMakeStageLearningMetrics,
  formatAverageInteractionCount,
  TimerPanel,
} from "./classroom-page-parts";
import type { ClassroomTimingSnapshot } from "@/lib/classroom/timing";
import type { Course } from "@/lib/session/types";
import { DEFAULT_STAGES } from "@/lib/session/types";

const classroom = vi.hoisted(() => ({
  course: undefined as Course | undefined,
  flushSaves: vi.fn(), endTeaching: vi.fn(), retrySave: vi.fn(), replace: vi.fn(),
  updateCourse: vi.fn(), setUiState: vi.fn(), initializeClassroomTiming: vi.fn(),
  saveState: "saved",
  saveError: undefined as string | undefined,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "save-course" }), useRouter: () => ({ replace: classroom.replace }) }));
vi.mock("@/lib/session/store", () => ({
  useCourse: () => classroom.course, useHydrated: () => true,
  useSession: () => ({ user: { name: "测试教师" }, updateCourse: classroom.updateCourse, setUiState: classroom.setUiState, initializeClassroomTiming: classroom.initializeClassroomTiming, endTeaching: classroom.endTeaching, flushSaves: classroom.flushSaves, retrySave: classroom.retrySave, saveState: classroom.saveState, saveError: classroom.saveError }),
}));
vi.mock("@/hooks/use-realtime-sync", () => ({ useRealtimeSync: vi.fn() }));
vi.mock("@/hooks/use-course-presence", () => ({ useCoursePresence: () => ({ onlineStudentIds: new Set(), degraded: false }) }));
vi.mock("@/hooks/use-showcase-presentation", () => ({ useShowcasePresentation: () => ({ data: undefined }) }));
vi.mock("@/components/dashboard-shell", () => ({ DashboardShell: ({ children, headerSlot }: { children: ReactNode; headerSlot: ReactNode }) => <div>{headerSlot}{children}</div>, Avatar: () => null }));
vi.mock("@/components/views/teacher/stage-dispatcher", () => ({ TeacherStageView: () => null }));
vi.mock("@/components/classroom/teacher-classroom-pulse", () => ({ TeacherClassroomPulse: () => null }));
vi.mock("@/components/classroom/teacher-stage-dashboard", () => ({ TeacherStageDashboard: () => null, RealtimeTeachingActions: () => null }));
vi.mock("@/components/classroom/teacher-presentation-analytics", () => ({ TeacherPresentationAnalytics: () => null, TeacherKnowledgeAnalytics: () => null }));
vi.mock("@/components/views/teacher/public-discussion-workspace", () => ({ PublicDiscussionTeacherWorkspace: () => null }));

import TeachClassroomPage from "./page";

function openEndConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "课堂工具" })).getByRole("button", { name: "结束课堂" }));
  expect(screen.queryByRole("dialog", { name: "课堂工具" })).toBeNull();
}

describe("ending a classroom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classroom.updateCourse.mockReset();
    classroom.setUiState.mockReset();
    classroom.initializeClassroomTiming.mockReset().mockResolvedValue(true);
    classroom.saveState = "saved";
    classroom.saveError = undefined;
    classroom.course = {
      id: "save-course", name: "失败恢复课堂", status: "teaching", currentStageIndex: 0,
      stages: DEFAULT_STAGES, students: [], content: { knowledgePoints: [] },
      uiState: { classroomTiming: { schemaVersion: 1, status: "paused", stages: [] } },
    } as unknown as Course;
    classroom.flushSaves.mockResolvedValue(true);
  });

  it("requests conditional initialization without inventing a client clock or replaying projection fields", () => {
    classroom.course = { ...classroom.course!, stageVersion: 1, uiState: { projectionVersion: 1 } };
    render(<TeachClassroomPage />);
    expect(classroom.initializeClassroomTiming).toHaveBeenCalledExactlyOnceWith("save-course");
    expect(classroom.updateCourse).not.toHaveBeenCalled();
    expect(classroom.setUiState).not.toHaveBeenCalled();
    expect(classroom.course.uiState).toEqual({ projectionVersion: 1 });
  });

  it("shows unsaved-data failures inside the confirmation and retries before ending", async () => {
    classroom.flushSaves.mockResolvedValueOnce(false);
    render(<TeachClassroomPage />);
    openEndConfirmation();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "结束课堂" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("课堂数据尚未保存，请重试");
    expect(classroom.endTeaching).not.toHaveBeenCalled();
    expect(classroom.replace).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "结束课堂" }));
    await waitFor(() => expect(classroom.replace).toHaveBeenCalledWith("/teacher/classrooms/save-course"));
    expect(classroom.endTeaching).toHaveBeenCalledOnce();
  });

  it("keeps a failed finish acknowledgement in the dialog until its saved retry succeeds", async () => {
    classroom.flushSaves.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const view = render(<TeachClassroomPage />);
    openEndConfirmation();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "结束课堂" }));
    expect(await within(screen.getByRole("alertdialog")).findByRole("alert")).toHaveTextContent("结束课堂未保存，请重试");
    expect(classroom.replace).not.toHaveBeenCalled();
    classroom.course = { ...classroom.course!, status: "finished" };
    classroom.saveState = "error";
    view.rerender(<TeachClassroomPage />);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "结束课堂" }));
    await waitFor(() => expect(classroom.replace).toHaveBeenCalledWith("/teacher/classrooms/save-course"));
    expect(classroom.retrySave).toHaveBeenCalledOnce();
    expect(classroom.endTeaching).toHaveBeenCalledOnce();
  });

  it.each(["pending activity", "finish acknowledgement"])("shows the current server error for a failed %s and keeps retry available", async (failure) => {
    classroom.flushSaves.mockResolvedValueOnce(failure === "finish acknowledgement");
    if (failure === "finish acknowledgement") classroom.flushSaves.mockResolvedValueOnce(false);
    const view = render(<TeachClassroomPage />);
    openEndConfirmation();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "结束课堂" }));
    await within(dialog).findByRole("alert");
    classroom.saveState = "error";
    classroom.saveError = "课堂记录暂时无法保存，请检查连接。";
    view.rerender(<TeachClassroomPage />);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(classroom.saveError);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("可再次点击“结束课堂”重试");
    expect(within(dialog).getByRole("button", { name: "结束课堂" })).toBeEnabled();
    expect(classroom.replace).not.toHaveBeenCalled();
  });
});

const snapshot: ClassroomTimingSnapshot = {
  status: "running",
  coursePlannedSec: 3_600,
  courseElapsedSec: 600,
  courseRemainingSec: 3_000,
  scheduleVarianceSec: -60,
  projectedEndAt: "2026-07-28T02:00:00.000Z",
  activeStage: {
    stageKey: "ai-learning",
    label: "AI 授知",
    status: "active",
    plannedSec: 900,
    elapsedSec: 600,
    remainingSec: 300,
    overrunSec: 0,
    progressPercent: 67,
  },
  stages: [
    {
      stageKey: "launch",
      label: "项目启动",
      status: "completed",
      plannedSec: 300,
      elapsedSec: 240,
      remainingSec: 0,
      overrunSec: 0,
      progressPercent: 100,
    },
    {
      stageKey: "ai-learning",
      label: "AI 授知",
      status: "active",
      plannedSec: 900,
      elapsedSec: 600,
      remainingSec: 300,
      overrunSec: 0,
      progressPercent: 67,
    },
  ],
};

describe("TimerPanel", () => {
  it("shows the active-stage countdown and exposes budget adjustments", () => {
    const onAdjust = vi.fn();
    const onTogglePause = vi.fn();
    const onReset = vi.fn();
    render(
      <TimerPanel
        snapshot={snapshot}
        onAdjust={onAdjust}
        onReset={onReset}
        onTogglePause={onTogglePause}
      />,
    );

    expect(screen.getByText("05:00")).toBeTruthy();
    expect(screen.getByText(/知识讲授 · 阶段剩余/)).toBeTruthy();
    expect(screen.getByText("课程已用 / 计划")).toBeTruthy();
    expect(screen.getByText(/提前 1 分/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "-2 分" }));
    fireEvent.click(screen.getByRole("button", { name: "+2 分" }));
    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    fireEvent.click(screen.getByRole("button", { name: /重计/ }));
    expect(onAdjust).toHaveBeenNthCalledWith(1, -120);
    expect(onAdjust).toHaveBeenNthCalledWith(2, 120);
    expect(onTogglePause).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe("classroom learning metrics", () => {
  it("separates submission, learning alerts, and average AI interactions", () => {
    const course = {
      students: [{ id: "student-1" }, { id: "student-2" }],
      submissions: [],
      projectDocumentVersions: [
        { stageKey: "make", status: "submitted", studentId: "student-1" },
      ],
      projectPdfVersions: [],
      aiInteractionEvents: [
        { stageKey: "make", actorRole: "student", eventType: "request", source: "sidebar", studentId: "student-1" },
        { stageKey: "make", actorRole: "student", eventType: "request", source: "proactive-comment", studentId: "student-1" },
        { stageKey: "make", actorRole: "student", eventType: "request", source: "selection", studentId: "student-2" },
        { stageKey: "make", actorRole: "ai", eventType: "response", studentId: "student-1" },
        { stageKey: "make", actorRole: "ai", eventType: "comment", source: "proactive-comment", studentId: "student-1" },
        { stageKey: "make", actorRole: "ai", eventType: "comment", source: "proactive-comment", studentId: "student-2" },
        { stageKey: "make", actorRole: "student", eventType: "decision", payload: { decision: "adopted" }, studentId: "student-1" },
        { stageKey: "make", actorRole: "student", eventType: "decision", payload: { decision: "rejected" }, studentId: "student-2" },
      ],
      learningSignals: [
        { stageKey: "make", status: "open", severity: "warning", studentId: "student-2" },
        { stageKey: "make", status: "open", severity: "high", studentId: "student-2" },
        { stageKey: "make", status: "resolved", severity: "high", studentId: "student-1" },
      ],
    } as unknown as Course;

    const metrics = deriveMakeStageLearningMetrics(course);

    expect(metrics.submittedStudentIds).toEqual(new Set(["student-1"]));
    expect(metrics.alertedStudentIds).toEqual(new Set(["student-2"]));
    expect(metrics.interactionEvents).toHaveLength(3);
    expect(formatAverageInteractionCount(metrics.averageInteractionCount)).toBe("1.5");
    expect(metrics.proactiveInterventionEvents).toHaveLength(2);
    expect(formatAverageInteractionCount(metrics.averageProactiveInterventionCount)).toBe("1");
    expect(metrics.studentInitiatedConversationEvents).toHaveLength(2);
    expect(metrics.initiatingStudentIds).toEqual(new Set(["student-1", "student-2"]));
    expect(metrics.suggestionDecisionEvents).toHaveLength(2);
    expect(metrics.adoptedSuggestionEvents).toHaveLength(1);
    expect(metrics.suggestionAcceptanceRate).toBe(50);
  });
});
