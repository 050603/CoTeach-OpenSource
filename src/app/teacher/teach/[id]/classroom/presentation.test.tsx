import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import { createClassroomTimingState, pauseClassroomTiming, transitionClassroomStageTiming } from "@/lib/classroom/timing";
import { getStagesForSystemMode } from "@/lib/system-mode";

const mocks = vi.hoisted(() => ({
  course: undefined as Course | undefined,
  updateCourse: vi.fn(),
  setUiState: vi.fn(),
  endTeaching: vi.fn(),
  flushSaves: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "projection-course" }), useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/lib/session/store", () => ({
  useCourse: () => mocks.course,
  useHydrated: () => true,
  useSession: () => ({ user: { name: "测试教师", role: "teacher" }, updateCourse: mocks.updateCourse, setUiState: mocks.setUiState, endTeaching: mocks.endTeaching, flushSaves: mocks.flushSaves, retrySave: vi.fn(), saveState: "saved" }),
}));
vi.mock("@/hooks/use-realtime-sync", () => ({ useRealtimeSync: vi.fn() }));
vi.mock("@/hooks/use-course-presence", () => ({ useCoursePresence: () => ({ onlineStudentIds: new Set<string>(), degraded: false }) }));
vi.mock("@/hooks/use-showcase-presentation", () => ({ useShowcasePresentation: () => ({ data: undefined, loading: false, runAction: vi.fn() }) }));
vi.mock("@/components/dashboard-shell", () => ({
  DashboardShell: ({ children, headerSlot, headerEndSlot, hideAiSettings, hideNotifications, immersive }: { children: ReactNode; headerSlot: ReactNode; headerEndSlot: ReactNode; hideAiSettings: boolean; hideNotifications: boolean; immersive: boolean }) => <div data-testid="shell" data-hide-ai-settings={hideAiSettings} data-hide-notifications={hideNotifications} data-immersive={immersive}>{!immersive ? <><div data-testid="header-start">{headerSlot}</div><div data-testid="header-end">{headerEndSlot}</div></> : null}{children}</div>,
  Avatar: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock("@/components/views/teacher/stage-dispatcher", () => ({
  TeacherStageView: ({ presentation, immersive, showStudentWork, selectedPracticeStudentId }: { presentation: TeacherPresentationMode; immersive: boolean; showStudentWork: boolean; selectedPracticeStudentId?: string }) => <div data-practice-student={selectedPracticeStudentId} data-testid="stage" data-presentation={presentation} data-immersive={immersive} data-student-work={showStudentWork}><input aria-label="阶段编辑草稿" defaultValue="" />{presentation === "workspace" ? <button type="button">原有阶段操作</button> : null}</div>,
}));
vi.mock("@/components/classroom/teacher-project-analytics", () => ({
  TeacherProjectAnalytics: ({ active, onStudentWork }: { active: boolean; onStudentWork: (id: string) => void }) => <section aria-label="第三阶段班级学情" hidden={!active}><input aria-label="项目学情本地选择" defaultValue="" /><button type="button" onClick={() => onStudentWork("student-target")}>查看成果</button></section>,
}));
vi.mock("@/components/views/teacher/public-discussion-workspace", () => ({
  PublicDiscussionTeacherWorkspace: ({ hidden }: { hidden: boolean }) => <section aria-label="AI 公开讨论工作台" hidden={hidden}>讨论工作台内容<input aria-label="讨论临时记录" defaultValue="" /></section>,
}));
vi.mock("@/components/classroom/teacher-classroom-pulse", () => ({ TeacherClassroomPulse: () => null }));
vi.mock("@/components/classroom/teacher-stage-dashboard", () => ({ TeacherStageDashboard: () => null, RealtimeTeachingActions: ({ stageKey }: { stageKey: string }) => <div>当前教学建议：{stageKey}</div> }));
vi.mock("@/components/classroom/teacher-presentation-analytics", () => ({
  TeacherPresentationAnalytics: ({ onDetails }: { onDetails: () => void }) => <section aria-label="班级汇总"><button type="button" onClick={onDetails}>查看明细</button></section>,
  TeacherKnowledgeAnalytics: ({ active, onQuestionReview, onKnowledgeReview }: { active: boolean; onQuestionReview: () => void; onKnowledgeReview: (pointId: string) => void }) => {
    const [details, setDetails] = useState(false);
    return <section aria-label="第二阶段班级学情" hidden={!active}>
      <div role="tablist" aria-label="班级学情内容"><button role="tab" aria-selected={!details} onClick={() => setDetails(false)}>概览</button><button role="tab" aria-selected={details} onClick={() => setDetails(true)}>学生明细</button></div>
      {details ? <input aria-label="学生明细本地选择" defaultValue="" /> : <><button onClick={() => setDetails(true)}>查看明细</button><button onClick={onQuestionReview}>查看错题</button><button onClick={() => onKnowledgeReview("point-evidence")}>查看知识点课件</button></>}
    </section>;
  },
}));
vi.mock("@/components/classroom/teacher-knowledge-review", () => ({
  TeacherClassroomReview: ({ active, focus }: { active: boolean; focus?: { sequence: number; pointId?: string; content?: "questions" | "slides" } }) => <section aria-label="课堂讲解" hidden={!active} data-focus-sequence={focus?.sequence} data-focus-point={focus?.pointId} data-focus-content={focus?.content}><input aria-label="讲解本地选择" defaultValue="" /></section>,
}));
vi.mock("@/components/classroom/classroom-chrome", () => ({
  StageGateDialog: ({ open, onConfirm, targetIndex }: { open: boolean; onConfirm: () => void; targetIndex: number }) => open ? <div role="dialog" aria-label="阶段切换确认"><span>目标阶段 {targetIndex + 1}</span><button type="button" onClick={onConfirm}>确认阶段切换</button></div> : null,
}));
vi.mock("@/lib/classroom/stage-gates", () => ({ evaluateStageGate: () => ({ canAdvance: false, blockers: [{ message: "仍有未完成学习" }], warnings: [] }) }));

import TeachClassroomPage from "./page";

function makeCourse(): Course {
  const stages = getStagesForSystemMode("new");
  return {
    id: "projection-course", name: "大屏课堂", subject: "科学", grade: "六年级", hours: 1, summary: "", drivingQuestion: "", status: "teaching", stages, currentStageIndex: 0, students: [],
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    uiState: { classroomTiming: createClassroomTimingState({ stages, totalMinutes: 60, activeStageKey: "launch" }) },
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function enterPresentation(expectedView = "teaching") {
  fireEvent.click(screen.getAllByRole("button", { name: "全屏授课" })[0]);
  expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
  expect(screen.getByTestId("stage").dataset.presentation).toBe(expectedView);
}

function openPublicDiscussion() {
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "课堂工具" })).getByRole("button", { name: "AI 公开讨论" }));
}

describe("teacher full-screen classroom integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.course = makeCourse();
    mocks.flushSaves.mockResolvedValue(true);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  });

  it.each([[0, "teaching"], [1, "analytics"], [2, "teaching"]] as const)("opens stage %i in its default %s view on entry and preserves the selected view on re-entry", (index, view) => {
    mocks.course = { ...makeCourse(), currentStageIndex: index };
    const { rerender } = render(<TeachClassroomPage />);
    enterPresentation(view);
    const selected = view === "analytics" ? "班级学情" : "授课展示";
    expect(screen.getByRole("button", { name: selected })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: view === "analytics" ? "授课展示" : "班级学情" }));
    rerender(<TeachClassroomPage />);
    expect(screen.getByTestId("stage").dataset.presentation).toBe(view === "analytics" ? "teaching" : "analytics");
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    enterPresentation(view === "analytics" ? "teaching" : "analytics");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect(mocks.setUiState).not.toHaveBeenCalled();
  });

  it("uses the loaded stage default when the course arrives after the initial render", () => {
    mocks.course = undefined;
    const { rerender } = render(<TeachClassroomPage />);
    mocks.course = { ...makeCourse(), currentStageIndex: 1 };
    rerender(<TeachClassroomPage />);
    enterPresentation("analytics");
    expect(screen.getByRole("region", { name: "第二阶段班级学情" })).toBeTruthy();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("applies each stage default after remote stage changes and clears discussion, details, and tools", () => {
    const { rerender } = render(<TeachClassroomPage />);
    enterPresentation();
    for (const index of [1, 2, 1, 0]) {
      if (mocks.course!.currentStageIndex > 2) fireEvent.click(screen.getByRole("button", { name: "课堂操作" }));
      fireEvent.click(screen.getByRole("button", { name: "工具" }));
      mocks.course = { ...mocks.course!, currentStageIndex: index };
      rerender(<TeachClassroomPage />);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByTestId("stage").dataset.presentation).toBe(index === 1 ? "analytics" : "teaching");
      expect(screen.getByRole("button", { name: index === 1 ? "班级学情" : "授课展示" })).toHaveAttribute("aria-pressed", "true");
      if (index === 1) openPublicDiscussion();
      expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
    }
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("keeps the normal classroom header compact with a single-line fullscreen action on the right", () => {
    render(<TeachClassroomPage />);

    expect(screen.getByTestId("shell")).toHaveAttribute("data-hide-ai-settings", "true");
    expect(screen.getByTestId("shell")).toHaveAttribute("data-hide-notifications", "true");
    expect(screen.queryByRole("button", { name: "学生邀请码" })).toBeNull();
    expect(screen.queryByRole("link", { name: "查看课程" })).toBeNull();
    expect(screen.getByRole("button", { name: "全屏授课" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回教学工作台" })).toHaveAttribute("href", "/teacher/teach/projection-course/setup");
    expect(screen.queryByTestId("header-start")).toBeNull();
    expect(screen.getByRole("contentinfo", { name: "课堂操作栏" })).toBeInTheDocument();
  });

  it("opens teaching by default, reveals analytics details in the same immersive stage, and never changes student projection", () => {
    render(<TeachClassroomPage />);
    const stage = screen.getByTestId("stage");
    fireEvent.change(screen.getByLabelText("阶段编辑草稿"), { target: { value: "保留中的课堂点评" } });
    enterPresentation();
    const footer = screen.getByRole("contentinfo", { name: "课堂操作栏" });
    expect(footer).toHaveAttribute("data-layout", "responsive");
    expect(within(screen.getByRole("group", { name: "左侧展示操作" })).getByRole("button", { name: "授课展示" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "右侧课堂操作" })).queryByRole("button", { name: "课堂操作" })).toBeNull();
    expect(screen.queryByRole("button", { name: "原有阶段操作" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    expect(screen.getByTestId("stage").dataset.presentation).toBe("analytics");
    expect(screen.getByRole("region", { name: "班级汇总" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));
    expect(screen.getByTestId("stage")).toBe(stage);
    expect(stage.dataset.presentation).toBe("analytics");
    expect(screen.getByRole("dialog", { name: "资料阅读明细" })).toBeTruthy();
    expect(stage.dataset.immersive).toBe("true");
    expect((screen.getByLabelText("阶段编辑草稿") as HTMLInputElement).value).toBe("保留中的课堂点评");
    fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
    expect(stage.dataset.presentation).toBe("analytics");
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    expect(stage.dataset.presentation).toBe("analytics");
    expect(stage.dataset.immersive).toBe("true");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("returns showcase analytics details to the default report interface without a duplicate workspace", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 3 };
    render(<TeachClassroomPage />);
    const stage = screen.getByTestId("stage");
    fireEvent.change(screen.getByLabelText("阶段编辑草稿"), { target: { value: "保留汇报名单与浏览位置" } });
    enterPresentation();
    expect(screen.queryByRole("button", { name: "课堂操作" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    expect(stage.closest("section")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));
    expect(screen.getByTestId("stage")).toBe(stage);
    expect(stage.dataset.presentation).toBe("teaching");
    expect(stage.closest("section")).not.toHaveAttribute("hidden");
    expect(screen.getByLabelText("阶段编辑草稿")).toHaveValue("保留汇报名单与浏览位置");
    expect(screen.getByRole("button", { name: "授课展示" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "班级学情" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "原有阶段操作" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^返回/ })).toBeNull();
    expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect(mocks.setUiState).not.toHaveBeenCalled();
  });

  it("opens public discussion from tools and retains discussion and classroom drafts", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 1 };
    render(<TeachClassroomPage />);
    fireEvent.change(screen.getByLabelText("阶段编辑草稿"), { target: { value: "保留课堂操作草稿" } });
    enterPresentation("analytics");

    expect(within(screen.getByRole("contentinfo", { name: "课堂操作栏" })).queryByRole("button", { name: "AI 公开讨论" })).toBeNull();
    openPublicDiscussion();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "班级学情" })).toHaveAttribute("aria-pressed", "false");
    const discussionWorkspace = screen.getByRole("region", { name: "AI 公开讨论工作台" });
    expect(discussionWorkspace).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("stage").closest("section")).toHaveAttribute("hidden");
    fireEvent.change(screen.getByLabelText("讨论临时记录"), { target: { value: "保留讨论状态" } });
    expect(screen.queryByRole("button", { name: "原有阶段操作" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    expect(screen.getByTestId("stage").dataset.presentation).toBe("analytics");
    expect(screen.getByTestId("stage").closest("section")).toHaveAttribute("hidden");
    expect(screen.getByRole("region", { name: "第二阶段班级学情" })).toBeVisible();
    expect((screen.getByLabelText("阶段编辑草稿") as HTMLInputElement).value).toBe("保留课堂操作草稿");
    expect(discussionWorkspace).toHaveAttribute("hidden");

    openPublicDiscussion();
    expect((screen.getByLabelText("讨论临时记录") as HTMLInputElement).value).toBe("保留讨论状态");
    expect(screen.getByTestId("stage").closest("section")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button", { name: "授课展示" }));
    expect(discussionWorkspace).toHaveAttribute("hidden");
    expect(screen.getByTestId("stage").dataset.presentation).toBe("teaching");
  });

  it("only shows the public discussion entry during knowledge teaching", () => {
    render(<TeachClassroomPage />);
    enterPresentation();
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    expect(screen.queryByRole("button", { name: "AI 公开讨论" })).toBeNull();
  });

  it.each([0, 1, 2, 3, 4])("offers one classroom review entry only in the second stage (stage %i)", (index) => {
    mocks.course = { ...makeCourse(), currentStageIndex: index };
    render(<TeachClassroomPage />);
    enterPresentation(index === 1 ? "analytics" : "teaching");
    const views = within(screen.getByRole("group", { name: "左侧展示操作" }));
    if (index === 1) {
      expect(views.getAllByRole("button").map((button) => button.textContent)).toEqual(["授课展示", "班级学情", "课堂讲解"]);
      expect(screen.queryByRole("button", { name: "课堂操作" })).toBeNull();
    } else {
      expect(views.queryByRole("button", { name: "课堂讲解" })).toBeNull();
    }
    expect(views.queryByRole("button", { name: "知识点补讲" })).toBeNull();
    expect(views.queryByRole("button", { name: "错题讲解" })).toBeNull();
  });

  it("keeps classroom review selections while switching views and fullscreen without changing student projection", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 1 };
    const { rerender } = render(<TeachClassroomPage />);
    enterPresentation("analytics");
    fireEvent.click(screen.getByRole("button", { name: "课堂讲解" }));
    const review = screen.getByRole("region", { name: "课堂讲解" });
    const selection = within(review).getByRole("textbox", { name: "讲解本地选择" });
    fireEvent.change(selection, { target: { value: "保留第二章题目与课件页" } });
    expect(screen.getByRole("button", { name: "课堂讲解" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "班级学情" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("stage").closest("section")).toHaveAttribute("hidden");
    expect(screen.queryByRole("region", { name: "第二阶段班级学情" })).toBeNull();
    expect(screen.getByTestId("shell")).toHaveAttribute("data-immersive", "true");

    for (const name of ["班级学情", "授课展示"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(review).toHaveAttribute("hidden");
      fireEvent.click(screen.getByRole("button", { name: "课堂讲解" }));
      expect(screen.getByRole("region", { name: "课堂讲解" })).toBe(review);
      expect(selection).toHaveValue("保留第二章题目与课件页");
    }
    // A realtime course update must not remount the dedicated workspace.
    mocks.course = { ...mocks.course!, updatedAt: "2026-10-19T00:00:00.000Z" };
    rerender(<TeachClassroomPage />);
    expect(selection).toHaveValue("保留第二章题目与课件页");
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    expect(review).not.toHaveAttribute("hidden");
    enterPresentation("analytics");
    expect(selection).toHaveValue("保留第二章题目与课件页");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect(mocks.setUiState).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4])("opens stage %i teaching advice through tools", (index) => {
    mocks.course = { ...makeCourse(), currentStageIndex: index };
    render(<TeachClassroomPage />);
    enterPresentation(index === 1 ? "analytics" : "teaching");
    expect(within(screen.getByRole("contentinfo", { name: "课堂操作栏" })).queryByRole("button", { name: "教学建议" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    const tools = screen.getByRole("dialog", { name: "课堂工具" });
    fireEvent.click(within(tools).getByRole("button", { name: "教学建议" }));
    expect(screen.getByRole("dialog", { name: "教学建议" })).toHaveTextContent(`当前教学建议：${mocks.course!.stages[index].key}`);
    expect(screen.getByTestId("shell")).toHaveAttribute("data-immersive", "true");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("routes analytics questions and knowledge points to the shared review without remounting it", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 1 };
    render(<TeachClassroomPage />);
    fireEvent.click(screen.getByRole("button", { name: "查看错题" }));
    const review = screen.getByRole("region", { name: "课堂讲解" });
    expect(review).not.toHaveAttribute("data-focus-content");
    const sequence = Number(review.getAttribute("data-focus-sequence"));
    const question = within(review).getByRole("textbox", { name: "讲解本地选择" });
    fireEvent.change(question, { target: { value: "第二节第三题" } });
    enterPresentation("analytics");
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    expect(review).not.toHaveAttribute("hidden");
    expect(question).toHaveValue("第二节第三题");
    expect(screen.getByTestId("stage").closest("section")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    expect(screen.getByRole("region", { name: "第二阶段班级学情" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看知识点课件" }));
    expect(screen.getByRole("region", { name: "课堂讲解" })).toBe(review);
    expect(review).toHaveAttribute("data-focus-point", "point-evidence");
    expect(review).not.toHaveAttribute("data-focus-content");
    expect(Number(review.getAttribute("data-focus-sequence"))).toBeGreaterThan(sequence);
    expect(question).toHaveValue("第二节第三题");
    expect(mocks.setUiState).not.toHaveBeenCalled();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("keeps second-stage student details inside analytics across views and fullscreen, and resets for a new stage", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 1 };
    const { rerender } = render(<TeachClassroomPage />);
    const analytics = screen.getByRole("region", { name: "第二阶段班级学情" });
    expect(within(analytics).getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(analytics).getByRole("button", { name: "查看明细" }));
    expect(within(analytics).getByRole("tab", { name: "学生明细" })).toHaveAttribute("aria-selected", "true");
    const selection = within(analytics).getByRole("textbox", { name: "学生明细本地选择" });
    fireEvent.change(selection, { target: { value: "第三名学生" } });
    fireEvent.click(screen.getByRole("button", { name: "课堂讲解" }));
    expect(analytics).toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    enterPresentation("analytics");
    expect(screen.getByRole("region", { name: "第二阶段班级学情" })).toBe(analytics);
    expect(selection).toHaveValue("第三名学生");
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    expect(selection).toHaveValue("第三名学生");
    mocks.course = { ...mocks.course!, currentStageIndex: 2 };
    rerender(<TeachClassroomPage />);
    mocks.course = { ...mocks.course!, currentStageIndex: 1 };
    rerender(<TeachClassroomPage />);
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    expect(mocks.setUiState).not.toHaveBeenCalled();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("keeps the course preview link bound to the original template", () => {
    mocks.course = { ...makeCourse(), platformContext: { offeringId: "offering", activityId: "activity", templateId: "template", templateVersionId: "version" } };
    render(<TeachClassroomPage />);
    enterPresentation();
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    const tools = within(screen.getByRole("dialog", { name: "课堂工具" }));
    const link = tools.getByRole("link", { name: "查看课程" });
    expect(link).toHaveAttribute("href", "/teacher/prepare/template/preview");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("keeps all three practice views available and highlights only the selected view", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 2 };
    const { rerender } = render(<TeachClassroomPage />);
    enterPresentation();
    const views = ["授课展示", "班级学情", "学生成果"];
    for (const name of ["学生成果", "班级学情", "授课展示", "学生成果"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      for (const label of views) expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", String(name === label));
      expect(screen.getByTestId("stage")).toHaveAttribute("data-student-work", String(name === "学生成果"));
    }
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect(mocks.setUiState).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "课堂操作" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    fireEvent.change(screen.getByLabelText("项目学情本地选择"), { target: { value: "保留学生筛选" } });
    fireEvent.click(screen.getByRole("button", { name: "查看成果" }));
    expect(screen.getByTestId("stage")).toHaveAttribute("data-practice-student", "student-target");
    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    expect(screen.getByLabelText("项目学情本地选择")).toHaveValue("保留学生筛选");
    fireEvent.click(screen.getByRole("button", { name: "学生成果" }));
    expect(screen.getByTestId("stage")).toHaveAttribute("data-student-work", "true");
    mocks.course = { ...mocks.course!, currentStageIndex: 3 };
    rerender(<TeachClassroomPage />);
    expect(screen.queryByRole("button", { name: "学生成果" })).toBeNull();
    expect(screen.getByRole("button", { name: "授课展示" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("stage")).toHaveAttribute("data-student-work", "false");
  });

  it("keeps reflection in the shared responsive footer without teaching and analytics toggles", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 4 };
    render(<TeachClassroomPage />);
    enterPresentation();
    const stage = screen.getByTestId("stage");
    expect(screen.queryByRole("button", { name: "授课展示" })).toBeNull();
    expect(screen.queryByRole("button", { name: "班级学情" })).toBeNull();
    expect(screen.getByRole("contentinfo", { name: "课堂操作栏" })).toHaveAttribute("data-layout", "responsive");
    expect(stage.dataset.presentation).toBe("teaching");
    expect(stage.closest("section")).not.toHaveAttribute("hidden");
    expect(screen.queryByRole("region", { name: "班级汇总" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "课堂操作" }));
    expect(stage.dataset.presentation).toBe("workspace");
    fireEvent.click(screen.getByRole("button", { name: "返回展示" }));
    expect(stage.dataset.presentation).toBe("teaching");
    expect(stage.closest("section")).not.toHaveAttribute("hidden");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("uses the stage gate and existing transition audit before advancing from fullscreen", async () => {
    const { rerender } = render(<TeachClassroomPage />);
    enterPresentation();
    expect(screen.queryByRole("button", { name: "课堂操作" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一教学阶段" }));
    expect(screen.getByRole("dialog", { name: "阶段切换确认" })).toBeTruthy();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认阶段切换" }));
    expect(mocks.updateCourse).toHaveBeenCalledOnce();
    const [id, patch] = mocks.updateCourse.mock.calls[0] as [string, Partial<Course>];
    expect(id).toBe("projection-course");
    expect(patch.currentStageIndex).toBe(1);
    expect(patch.stageTransitions?.[0]).toMatchObject({ fromStageKey: "launch", toStageKey: "ai-learning", gateStatus: "overridden", blockers: ["仍有未完成学习"] });
    expect(patch.uiState?.classroomTiming?.activeStageKey).toBe("ai-learning");
    mocks.course = { ...mocks.course!, ...patch };
    rerender(<TeachClassroomPage />);
    await waitFor(() => expect(screen.getByTestId("stage").dataset.presentation).toBe("analytics"));
    expect(screen.getByTestId("stage").dataset.immersive).toBe("true");
  });

  it("keeps the header time visible across views and follows the shared clock and pause state", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
      mocks.course = makeCourse();
      const { rerender } = render(<TeachClassroomPage />);
      expect(screen.getByRole("group", { name: "课堂时间" })).toBeVisible();
      enterPresentation();
      const time = screen.getByRole("group", { name: "课堂时间" });
      const stageTime = within(time).getByText("阶段剩余").parentElement!;
      const courseTime = within(time).getByText("累计授课").parentElement!;
      expect(courseTime).toHaveTextContent("00:00");
      const initialStageTime = stageTime.textContent;
      act(() => vi.advanceTimersByTime(5_000));
      expect(courseTime).toHaveTextContent("00:05");
      expect(stageTime.textContent).not.toBe(initialStageTime);

      fireEvent.click(within(time).getByRole("button", { name: "课堂计时控制" }));
      const timer = screen.getByRole("dialog", { name: "课堂计时控制" });
      const elapsed = within(timer).getByText("累计授课").closest("p")!;
      expect(elapsed).toHaveTextContent("00:05");

      fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
      expect(time).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "授课展示" }));
      expect(time).toBeVisible();
      mocks.course = { ...mocks.course!, uiState: { classroomTiming: pauseClassroomTiming(mocks.course!.uiState!.classroomTiming!) } };
      rerender(<TeachClassroomPage />);
      expect(within(time).getByText("已暂停")).toBeVisible();
      const pausedStageTime = stageTime.textContent;
      act(() => vi.advanceTimersByTime(10_000));
      expect(elapsed).toHaveTextContent("00:05");
      expect(courseTime).toHaveTextContent("00:05");
      expect(stageTime.textContent).toBe(pausedStageTime);
      expect(mocks.setUiState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows stage overtime and keeps course elapsed time when the teaching stage changes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
      mocks.course = makeCourse();
      mocks.course.uiState!.classroomTiming = createClassroomTimingState({ stages: mocks.course.stages, totalMinutes: 5, activeStageKey: "launch" });
      const { rerender } = render(<TeachClassroomPage />);
      enterPresentation();
      let time = screen.getByRole("group", { name: "课堂时间" });
      act(() => vi.advanceTimersByTime(65_000));
      expect(within(time).getByText("阶段超时").parentElement).toHaveTextContent("+00:05");
      expect(within(time).getByText("累计授课").parentElement).toHaveTextContent("01:05");
      fireEvent.click(within(time).getByRole("button", { name: "课堂计时控制" }));
      expect(within(screen.getByRole("dialog", { name: "课堂计时控制" })).getByText("累计授课").closest("p")).toHaveTextContent("01:05");

      const nextStage = mocks.course.stages[1];
      mocks.course = { ...mocks.course, currentStageIndex: 1, uiState: { classroomTiming: transitionClassroomStageTiming(mocks.course.uiState!.classroomTiming!, nextStage.key) } };
      rerender(<TeachClassroomPage />);
      time = screen.getByRole("group", { name: "课堂时间" });
      expect(within(time).queryByText("阶段超时")).toBeNull();
      expect(within(time).getByText("阶段剩余").parentElement).toHaveTextContent("01:00");
      expect(within(time).getByText("累计授课").parentElement).toHaveTextContent("01:05");
      expect(screen.queryByRole("dialog", { name: "课堂计时控制" })).toBeNull();
      fireEvent.click(within(time).getByRole("button", { name: "课堂计时控制" }));
      expect(within(screen.getByRole("dialog", { name: "课堂计时控制" })).getByText("累计授课").closest("p")).toHaveTextContent("01:05");
      act(() => vi.advanceTimersByTime(5_000));
      expect(within(time).getByText("累计授课").parentElement).toHaveTextContent("01:10");
      expect(within(screen.getByRole("dialog", { name: "课堂计时控制" })).getByText("累计授课").closest("p")).toHaveTextContent("01:10");
    } finally {
      vi.useRealTimers();
    }
  });

  it("groups the active stage name above its progress and opens the shared timer controls from the header", () => {
    mocks.course!.uiState!.classroomTiming!.stages[0].elapsedSec = 123;
    const { rerender } = render(<TeachClassroomPage />);
    enterPresentation();
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { name: "大屏课堂" })).toBeVisible();
    expect(within(header).queryByText("全屏授课")).toBeNull();
    const progress = within(header).getByRole("progressbar", { name: "教学阶段" });
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(progress).toHaveAttribute("aria-valuetext", mocks.course!.stages[0].label);
    expect(within(progress).queryByText(mocks.course!.stages[1].label)).toBeNull();

    fireEvent.click(within(header).getByRole("button", { name: "课堂计时控制" }));
    let timer = screen.getByRole("dialog", { name: "课堂计时控制" });
    fireEvent.click(within(timer).getByRole("button", { name: "暂停" }));
    expect(mocks.setUiState).toHaveBeenCalledOnce();
    mocks.course = { ...mocks.course!, uiState: mocks.setUiState.mock.calls[0][1] };
    rerender(<TeachClassroomPage />);
    fireEvent.click(within(timer).getByRole("button", { name: "继续" }));
    expect(mocks.setUiState.mock.calls[1][1].classroomTiming.status).toBe("running");
    fireEvent.click(within(timer).getByRole("button", { name: "重计本阶段" }));
    expect(mocks.setUiState.mock.calls[2][1].classroomTiming.stages[0].elapsedSec).toBe(0);
    fireEvent.keyDown(timer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "课堂计时控制" })).toBeNull();
    expect(screen.getByTestId("shell").dataset.immersive).toBe("true");

    mocks.course = { ...mocks.course!, currentStageIndex: 1 };
    rerender(<TeachClassroomPage />);
    expect(progress).toHaveAttribute("aria-valuenow", "2");
    expect(progress).toHaveAttribute("aria-valuetext", mocks.course.stages[1].label);
    expect(within(progress).queryByText(mocks.course.stages[0].label)).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: "课堂计时控制" }));
    timer = screen.getByRole("dialog", { name: "课堂计时控制" });
    fireEvent.click(within(timer).getByRole("button", { name: "关闭计时控制" }));
    expect(screen.queryByRole("dialog", { name: "课堂计时控制" })).toBeNull();
  });

  it("uses existing timer adjustments inside a fullscreen dialog", () => {
    render(<TeachClassroomPage />);
    enterPresentation();
    expect(screen.queryByRole("button", { name: "计时" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "课堂工具" })).getByRole("button", { name: "课堂计时" }));
    const dialog = screen.getByRole("dialog", { name: "课堂计时" });
    fireEvent.click(within(dialog).getByRole("button", { name: "+2 分" }));
    expect(mocks.setUiState).toHaveBeenCalledOnce();
    const firstPatch = mocks.setUiState.mock.calls[0][1] as NonNullable<Course["uiState"]>;
    const before = mocks.course!.uiState!.classroomTiming!;
    const after = firstPatch.classroomTiming!;
    expect(after.stages.find((stage) => stage.stageKey === "launch")!.adjustmentSec).toBe(before.stages.find((stage) => stage.stageKey === "launch")!.adjustmentSec + 120);
    fireEvent.click(within(dialog).getByRole("button", { name: /暂停/ }));
    expect(mocks.setUiState.mock.calls[1][1].classroomTiming.status).toBe("paused");
    expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
  });

  it.each([0, 4])("keeps end-of-class saving and confirmation available in fullscreen at stage %i", async index => {
    mocks.course = { ...makeCourse(), currentStageIndex: index };
    render(<TeachClassroomPage />);
    enterPresentation();
    const footer = within(screen.getByRole("contentinfo", { name: "课堂操作栏" }));
    if (index < mocks.course.stages.length - 1) {
      expect(footer.queryByRole("button", { name: "结束课堂" })).toBeNull();
      fireEvent.click(footer.getByRole("button", { name: "工具" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "课堂工具" })).getByRole("button", { name: "结束课堂" }));
      expect(screen.queryByRole("dialog", { name: "课堂工具" })).toBeNull();
    } else {
      fireEvent.click(footer.getByRole("button", { name: "结束课堂" }));
    }
    expect(mocks.endTeaching).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "结束课堂" }));
    await waitFor(() => expect(mocks.endTeaching).toHaveBeenCalledWith("projection-course"));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/teacher/classrooms/projection-course"));
    expect(mocks.flushSaves).toHaveBeenCalledTimes(2);
  });
});
