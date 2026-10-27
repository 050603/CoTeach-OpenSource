import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import TeachSetupWorkspace from "./setup-workspace";

const mocks = vi.hoisted(() => ({ push: vi.fn(), start: vi.fn(), update: vi.fn(), flush: vi.fn(), retry: vi.fn(), readiness: vi.fn() }));
let course: Course;
let saveState = "saved";
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "run-1" }), useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/session/store", () => ({ useHydrated: () => true, useCourse: () => course, useSession: () => ({ user: { name: "张老师" }, startTeaching: mocks.start, updateCourse: mocks.update, flushSaves: mocks.flush, retrySave: mocks.retry, saveState, lastSavedAt: undefined }) }));
vi.mock("@/components/teacher/preparation-shell", () => ({ PreparationShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-course-presence", () => ({ useCoursePresence: () => ({ onlineStudentIds: new Set() }) }));
vi.mock("@/lib/classroom/new-system-course", () => ({ getNewSystemCourseReadiness: mocks.readiness }));
vi.mock("@/components/teacher/make-artifact-mode-setting", () => ({ MakeArtifactModeSetting: () => null }));
const props = { activityId: "activity", offeringId: "offering", templateVersionId: "published-version", templateId: "template" };
const config = { groupMode: "solo" as const, totalStudents: 28, perGroup: 1, crossClass: false };
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); saveState = "saved"; mocks.flush.mockResolvedValue(true); mocks.readiness.mockReturnValue([]); mocks.start.mockReturnValue("123456");
  course = { id: "run-1", name: "河流调查", status: "ready", inviteCode: "123456", subject: "科学", grade: "七年级", hours: 2, summary: "河流调查", drivingQuestion: "如何保护河流？", currentStageIndex: 0, createdAt: "2026-09-09", updatedAt: "2026-09-09", content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } }, students: [], stages: [{ key: "launch", label: "项目启动", view: "project-launch", description: "发现问题" }], classConfig: config, platformContext: { offeringId: "offering", activityId: "activity", templateId: "template", templateVersionId: "published-version" } };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("original classroom setup integration", () => {
  it("keeps timing diagnostics visible and allows starting a reviewed classroom", async () => {
    mocks.readiness.mockReturnValue([{ id: "timing", label: "讲授时长", ok: false, message: "实际时长与教案预算有偏差。" }]);
    render(<TeachSetupWorkspace {...props} />);
    expect(screen.getByText(/实际时长与教案预算有偏差/)).toBeVisible();
    expect(screen.getByRole("button", { name: "开始课堂" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始课堂" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  });

  it("still blocks starting when the actual classroom is unavailable", () => {
    mocks.readiness.mockReturnValue([{ id: "ai-classroom", label: "知识讲授课堂", ok: false, message: "课堂页面尚未生成。" }]);
    render(<TeachSetupWorkspace {...props} />);
    expect(screen.getByText(/课堂页面尚未生成/)).toBeVisible();
    expect(screen.getByRole("button", { name: "开始课堂" })).toBeDisabled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "返回课程详情" })).toHaveAttribute("href", "/teacher/prepare/template/preview");
  });

  it("opens the original template's review panel when teacher confirmation is missing", () => {
    mocks.readiness.mockReturnValue([{ id: "teacher-review", label: "教师终审", ok: false, message: "请在预览发布页面确认当前版本可以授课。" }]);
    render(<TeachSetupWorkspace {...props} />);
    expect(screen.getByRole("button", { name: "开始课堂" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "返回课程详情" })).toHaveAttribute("href", "/teacher/prepare/template/preview?view=checks");
    expect(screen.queryByRole("link", { name: "返回备课生成" })).toBeNull();
  });

  it("allows a teaching run to use the original template's reviewed audio publication", async () => {
    const { getNewSystemCourseReadiness } = await vi.importActual<typeof import("@/lib/classroom/new-system-course")>("@/lib/classroom/new-system-course");
    course.aiLearningClassroomId = "updated-audio-classroom";
    course.content.qualityReviewRequired = true;
    course.content.teacherReview = { schemaVersion: 1, courseId: "template", classroomId: "original-classroom", signature: "a".repeat(64),
      teacherId: "teacher", confirmedAt: "2026-10-19", acceptedIssueIds: [], seal: "b".repeat(64) };
    course.content.teachingRevisionState = { schemaVersion: 1, changeType: "narration", baseClassroomRevision: 1,
      classroomRevision: 2, affectedSceneIds: [], invalidated: [], updatedAt: "2026-10-19", audioPublication: {
        schemaVersion: 1, kind: "course-audio-publication", courseId: "template", classroomId: "updated-audio-classroom", teacherId: "teacher",
        teacherReviewSeal: course.content.teacherReview.seal, seal: "c".repeat(64),
      } as never };
    mocks.readiness.mockImplementation((current: Course) => getNewSystemCourseReadiness(current).filter((check) => check.id === "teacher-review"));
    render(<TeachSetupWorkspace {...props} />);
    expect(screen.queryByText(/开课前还需完成/)).toBeNull();
    expect(screen.getByRole("button", { name: "开始课堂" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始课堂" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/teacher/teach/run-1/classroom"));
  });

  it("saves the current run's configuration without starting or navigating", async () => {
    render(<TeachSetupWorkspace {...props} />);
    fireEvent.change(screen.getByLabelText("班级总人数"), { target: { value: "36" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(mocks.flush).toHaveBeenCalledOnce());
    expect(mocks.update).toHaveBeenCalledWith("run-1", { classConfig: { ...config, totalStudents: 36 } });
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  });
  it("waits for pending configuration then the start action before navigating", async () => {
    const configuration = deferred(); const started = deferred();
    mocks.flush.mockReturnValueOnce(configuration.promise).mockReturnValueOnce(started.promise);
    render(<TeachSetupWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "开始课堂" }));
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    await act(async () => configuration.resolve(true));
    expect(mocks.start).toHaveBeenCalledWith("run-1", config);
    expect(mocks.push).not.toHaveBeenCalled();
    await act(async () => started.resolve(true));
    expect(mocks.push).toHaveBeenCalledWith("/teacher/teach/run-1/classroom");
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it.each([false, true])("does not navigate when %s pending saves fail", async (configurationSaved) => {
    mocks.flush.mockResolvedValueOnce(configurationSaved).mockResolvedValueOnce(false);
    render(<TeachSetupWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "开始课堂" }));
    expect(await screen.findByText(configurationSaved ? "开始课堂未保存，请重试" : "配置尚未保存，请重试")).toBeVisible();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledTimes(configurationSaved ? 1 : 0);
    expect(screen.getByRole("button", { name: "开始课堂" })).toBeEnabled();
  });
  it("retries a previously failed save before attempting the start", async () => {
    saveState = "error"; const retry = deferred(); mocks.retry.mockReturnValue(retry.promise);
    render(<TeachSetupWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "开始课堂" }));
    expect(mocks.retry).toHaveBeenCalledOnce(); expect(mocks.flush).not.toHaveBeenCalled();
    await act(async () => retry.resolve(true));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/teacher/teach/run-1/classroom"));
  });
  it("displays the teaching offering's invitation and offers no classroom regeneration", () => {
    render(<TeachSetupWorkspace {...props} />);
    expect(screen.getByText("123 456")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制邀请码" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /重新生成/ })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("explains a missing teaching offering invitation instead of making one", () => {
    course.inviteCode = undefined; render(<TeachSetupWorkspace {...props} />);
    expect(screen.getByText("学生通过教学班加入课程。请在课程的邀请与访问页面设置邀请码。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "复制邀请码" })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("creates a separate scheduled run for repeat teaching and leaves the finished run intact", async () => {
    course.status = "finished";
    const assign = vi.fn();
    vi.stubGlobal("window", new Proxy(window, { get: (target, key) => key === "location" ? { assign } : Reflect.get(target, key, target) }));
    const fetcher = vi.fn(async () => Response.json({ instance: { id: "run-2", status: "scheduled" } })); vi.stubGlobal("fetch", fetcher);
    render(<TeachSetupWorkspace {...props} />);
    expect(screen.getByLabelText("班级总人数")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "再次授课" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/teacher/teach/run-2/setup"));
    expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/instance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateVersionId: "published-version" }) });
    expect(course.status).toBe("finished");
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("shows a repeat-teaching failure without reopening the old run", async () => {
    course.status = "finished";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "已发布教案无法读取" }, { status: 503 })));
    render(<TeachSetupWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "再次授课" }));
    expect(await screen.findByText("已发布教案无法读取")).toBeVisible();
    expect(screen.getByRole("button", { name: "再次授课" })).toBeEnabled();
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  });
});
