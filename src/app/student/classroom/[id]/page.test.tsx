import { useEffect, type PropsWithChildren } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course, TeacherResourceProjection } from "@/lib/session/types";
import StudentClassroomPage from "./page";

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0, replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "course" }), useRouter: () => ({ replace: lifecycle.replace }) }));
vi.mock("@/hooks/use-realtime-sync", () => ({ useRealtimeSync: vi.fn() }));
vi.mock("@/hooks/use-course-presence", () => ({ useCoursePresence: vi.fn() }));
vi.mock("@/lib/session/store", () => ({
  useCourse: () => course, useHydrated: () => true,
  useSession: () => ({ user: { name: "Student" }, studentName: "Student", joinedCourseId: "course" }),
}));
vi.mock("@/components/dashboard-shell", () => ({ DashboardShell: ({ children, headerSlot }: PropsWithChildren<{ headerSlot?: React.ReactNode }>) => <main>{headerSlot}{children}</main> }));
vi.mock("@/components/ui", () => ({ Pill: ({ children }: PropsWithChildren) => <span>{children}</span>, PrimaryButton: ({ children, onClick }: PropsWithChildren<{ onClick?: () => void }>) => <button onClick={onClick}>{children}</button> }));
vi.mock("@/components/openmaic-bridge/teacher-stage-resources", () => ({ StudentProjectedTeacherResource: ({ onClose }: { onClose?: () => void }) => <div>教师投屏播放器{onClose ? <button onClick={onClose}>收起投屏</button> : null}</div> }));
vi.mock("@/components/views/student/stage-dispatcher", () => ({ StudentStageView: function PersonalPlayer() {
  useEffect(() => { lifecycle.mounts++; return () => { lifecycle.unmounts++; }; }, []);
  return <div>个人学习播放器</div>;
} }));
vi.mock("@/components/classroom/simple-stage-resources", () => ({ StudentProjectionPrecache: () => null, StudentResourceProjection: () => <div>上传资源投屏</div> }));
vi.mock("@/components/classroom/classroom-ui", () => ({ StageEmptyState: () => null }));
vi.mock("@/components/classroom/student-classroom-header-status", () => ({ StudentClassroomHeaderStatus: () => null }));
vi.mock("@/components/views/student/public-discussion-overlay", () => ({ PublicDiscussionStudentOverlay: () => null }));
vi.mock("@/components/classroom/student-classroom-finished-state", () => ({ StudentClassroomFinishedState: () => <div>课后只读回看</div> }));

const course = {
  id: "course", status: "teaching", currentStageIndex: 0,
  stages: [{ key: "ai-learning", label: "知识讲授", view: "ai-learning" }], uiState: {}, resources: [],
} as unknown as Course;
const projection = (mode: "forced" | "optional"): TeacherResourceProjection => ({
  classroomId: "classroom", sceneId: "teacher-slide", sceneType: "slide", stageKey: "ai-learning", title: "Teacher", startedAt: "2026-09-26T00:00:00Z", mode,
});

describe("student classroom player ownership", () => {
  beforeEach(() => { lifecycle.mounts = 0; lifecycle.unmounts = 0; course.uiState = {}; course.status = "teaching"; });
  afterEach(cleanup);

  it("shows review after the classroom ends and ignores stale live projections", () => {
    course.status = "finished";
    course.resources = [{ id: "upload" }] as Course["resources"];
    course.uiState = { teacherResourceProjection: projection("forced"), resourceProjection: { resourceId: "upload", title: "Old projection", stageKey: "ai-learning", startedAt: "2026-09-26T00:00:00Z" } };
    render(<StudentClassroomPage />);
    expect(screen.getByText("课后只读回看")).toBeVisible();
    expect(screen.getByText("只读回看")).toBeVisible();
    expect(screen.queryByText("上传资源投屏")).toBeNull();
    expect(screen.queryByText("教师投屏播放器")).toBeNull();
    expect(lifecycle.mounts).toBe(0);
  });

  it("unmounts personal learning during forced projection and remounts it only when projection ends", () => {
    const view = render(<StudentClassroomPage />);
    expect(lifecycle.mounts).toBe(1);
    course.uiState = { projectionVersion: 1, teacherResourceProjection: projection("forced") };
    view.rerender(<StudentClassroomPage />);
    expect(screen.queryByText("个人学习播放器")).toBeNull();
    expect(screen.getByText("教师投屏播放器")).toBeTruthy();
    expect(view.container.querySelector("section")).toBeNull();
    expect(screen.queryByRole("button", { name: "收起投屏" })).toBeNull();
    expect(lifecycle.unmounts).toBe(1);
    course.uiState = { ...course.uiState, projectionVersion: 2 };
    view.rerender(<StudentClassroomPage />);
    expect(lifecycle.mounts).toBe(1);
    course.uiState = { projectionVersion: 3, teacherResourceProjection: null };
    view.rerender(<StudentClassroomPage />);
    expect(screen.getByText("个人学习播放器")).toBeTruthy();
    expect(view.container.querySelector("section")).toContainElement(screen.getByText("个人学习播放器"));
    expect(screen.queryByText("教师投屏播放器")).toBeNull();
    expect(lifecycle.mounts).toBe(2);
    course.uiState = { projectionVersion: 4 };
    view.rerender(<StudentClassroomPage />);
    expect(lifecycle.mounts).toBe(2);
  });

  it("keeps personal learning mounted until optional projection is opened, and restores it on collapse", () => {
    course.uiState = { teacherResourceProjection: projection("optional") };
    render(<StudentClassroomPage />);
    expect(screen.getByText("个人学习播放器")).toBeTruthy();
    expect(screen.queryByText("教师投屏播放器")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看投屏" }));
    expect(screen.getByText("教师投屏播放器")).toBeTruthy();
    expect(screen.queryByText("个人学习播放器")).toBeNull();
    expect(lifecycle.unmounts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "收起投屏" }));
    expect(screen.getByText("个人学习播放器")).toBeTruthy();
    expect(lifecycle.mounts).toBe(2);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看投屏" }));
  });

  it("preserves uploaded resource projection and ignores teacher projection from a different stage", () => {
    course.uiState = { teacherResourceProjection: { ...projection("forced"), stageKey: "launch" } };
    const view = render(<StudentClassroomPage />);
    expect(screen.getByText("个人学习播放器")).toBeTruthy();
    course.resources = [{ id: "upload" }] as Course["resources"];
    course.uiState = { resourceProjection: { resourceId: "upload", title: "Uploaded resource", stageKey: "ai-learning", startedAt: "2026-09-26T00:00:00Z" } };
    view.rerender(<StudentClassroomPage />);
    expect(screen.getByText("上传资源投屏")).toBeTruthy();
    expect(screen.queryByText("个人学习播放器")).toBeNull();
  });
});
