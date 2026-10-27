import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course, TeacherResourceScene, TeacherResourceProjection } from "@/lib/session/types";
import type { OpenMaicResourcePlayer } from "./openmaic-resource-player";
import { DEFAULT_STAGES } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  setUiState: vi.fn(), resources: [] as TeacherResourceScene[],
  playerProps: undefined as undefined | ComponentProps<typeof OpenMaicResourcePlayer>,
}));
vi.mock("@/lib/session/store", () => ({
  useSession: () => ({ addActivity: vi.fn(), refresh: vi.fn(), setUiState: mocks.setUiState }),
}));
vi.mock("@/lib/openmaic-bridge/teacher-resources", () => ({
  getTeacherResourcesForStage: () => mocks.resources,
  teacherResourceTypeLabel: () => "演示",
}));
vi.mock("./openmaic-resource-player", () => ({
  OpenMaicResourcePlayer: (props: typeof mocks.playerProps) => { mocks.playerProps = props; return <div>资源播放器</div>; },
}));

vi.mock("@openmaic/lib/store/interaction-sync", () => ({
  useInteractionSyncStore: (selector: (state: { versions: Record<string, number>; states: Record<string, unknown> }) => unknown) => selector({ versions: {}, states: {} }),
}));

import { StudentProjectedTeacherResource, TeacherStageResources } from "./teacher-stage-resources";

const course: Course = {
  id: "course-1",
  name: "测试课程",
  subject: "科学",
  grade: "六年级",
  hours: 3,
  summary: "测试",
  drivingQuestion: "如何解决问题？",
  status: "teaching",
  stages: DEFAULT_STAGES,
  currentStageIndex: 0,
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  students: [],
  createdAt: "",
  updatedAt: "",
};

describe("TeacherStageResources", () => {
  beforeEach(() => { mocks.resources = []; mocks.setUiState.mockClear(); mocks.playerProps = undefined; });

  it("observes another teacher without writing local empty interaction or idle playback, and offers explicit takeover", () => {
    mocks.resources = [{ id: "interactive-1", type: "interactive", role: "teaching-aid", title: "互动", description: "", keyPoints: [] }];
    const projection = { classroomId: "room-1", sceneId: "interactive-1", stageKey: "launch", title: "互动", sceneType: "interactive" as const, startedAt: "now", interactionState: { value: "teacher-a" } };
    const projected = { ...course, teacherClassroomId: "room-1", uiState: { teacherResourceProjection: projection, projectionController: { teacherId: "teacher-a", clientId: "other-tab" } } };
    const view = render(<TeacherStageResources course={projected} stageKey="launch" />);
    expect(mocks.setUiState).not.toHaveBeenCalled();
    expect(mocks.playerProps?.experience).toBe("projected-readonly");
    mocks.playerProps?.onPlaybackStateChange?.({ engineMode: "idle", snapshot: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [] } });
    view.rerender(<TeacherStageResources course={{ ...projected, uiState: { ...projected.uiState, teacherResourceProjection: { ...projection, interactionState: { value: "new" } } } }} stageKey="launch" />);
    expect(mocks.setUiState).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /停止投屏/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "接管并投屏" }));
    expect(mocks.setUiState).toHaveBeenCalledWith("course-1", expect.objectContaining({ teacherResourceProjection: expect.objectContaining({ sceneId: "interactive-1" }) }), { takeover: true });
  });
  it("collapses and expands the whole stage resource area", () => {
    render(<TeacherStageResources course={course} stageKey="launch" />);

    const trigger = screen.getByRole("button", { name: /本阶段授课资源/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("本阶段暂无生成的授课资源。")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("本阶段暂无生成的授课资源。")).toBeNull();
  });
});

describe("StudentProjectedTeacherResource", () => {
  const projection: TeacherResourceProjection = {
    classroomId: "room-1", sceneId: "slide-1", stageKey: "ai-learning", title: "观察与记录",
    sceneType: "slide", startedAt: "now", mode: "forced", version: 3, engineMode: "idle",
    playback: { sceneId: "slide-1", sceneIndex: 0, actionIndex: 0, consumedDiscussions: [] },
    interactionState: { value: "teacher" },
  };

  it("uses the shared projection surface and keeps teacher playback and interaction read-only", () => {
    const originalOverflow = document.body.style.overflow;
    const view = render(<StudentProjectedTeacherResource projection={projection} projectionVersion={8} />);
    expect(screen.getByRole("dialog", { name: "教师投屏：观察与记录" })).toBeTruthy();
    expect(screen.getByText("同步中")).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent("跟随教师 · 知识点补讲");
    expect(screen.queryByRole("button", { name: "收起投屏" })).toBeNull();
    expect(mocks.playerProps).toMatchObject({
      experience: "projected-readonly", classroomId: "room-1", sceneId: "slide-1",
      playbackState: { version: 8, engineMode: "idle", snapshot: projection.playback },
      interactionState: projection.interactionState,
    });
    expect(mocks.playerProps?.onPlaybackStateChange).toBeUndefined();
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe(originalOverflow);
  });

  it("allows a student to close optional viewing without stopping teacher projection", () => {
    const onClose = vi.fn();
    render(<StudentProjectedTeacherResource projection={{ ...projection, mode: "optional" }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "收起投屏" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.playerProps?.playbackState?.version).toBe(3);
  });
});
