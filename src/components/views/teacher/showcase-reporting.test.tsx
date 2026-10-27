import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course, ShowcasePresentationSnapshot } from "@/lib/session/types";
import type { ShowcaseData, ShowcaseQueueItem } from "@/lib/showcase/types";
import type { ShowcaseRecommendations } from "@/lib/showcase/recommendation-types";
import { getStagesForSystemMode } from "@/lib/system-mode";

type MockState = { loading: boolean; error?: string; data: ShowcaseData; needsTakeover?: boolean };
const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined, runAction: vi.fn(), updateViewState: vi.fn(), reload: vi.fn(), takeControl: vi.fn(), fetch: vi.fn(), upsertRubricScore: vi.fn() }));
vi.mock("@/lib/session/store", () => ({ useSession: () => ({ upsertRubricScore: mocks.upsertRubricScore }) }));
vi.mock("@/hooks/use-showcase-presentation", () => ({ useShowcasePresentation: () => ({ ...mocks.state, runAction: mocks.runAction, updateViewState: mocks.updateViewState, reload: mocks.reload, takeControl: mocks.takeControl }) }));
vi.mock("@/components/showcase/showcase-artifact-viewer", () => ({ ShowcaseArtifactViewer: ({ artifact, displayMode, mode, presentationLayout, initialViewState, scale, onViewStateChange }: { artifact: { versionId: string }; displayMode?: string; mode: string; presentationLayout?: boolean; scale?: number; initialViewState?: { page?: number }; onViewStateChange?: (patch: { page: number }) => void }) => <div data-scale={scale} data-display-mode={displayMode} data-mode={mode} data-presentation-layout={presentationLayout} data-initial-page={initialViewState?.page} data-testid="artifact-viewer" data-version-id={artifact.versionId}><button onClick={() => onViewStateChange?.({ page: 2 })} type="button">模拟翻页</button></div> }));
vi.mock("@/components/showcase/showcase-projection-status", () => ({ ShowcaseProjectionStatus: () => <span>投屏已启动 · 作品已打开 2/2</span> }));
import { TeacherPresentationActionsProvider } from "@/components/classroom/teacher-presentation-actions";
import { NewShowcaseTeacherView } from "./showcase-reporting";

const now = "2026-09-05T10:00:00.000Z";
const artifact = { kind: "document" as const, versionId: "a1", title: "校园节水方案", sequence: 1, submittedAt: now, displayModes: ["continuous" as const] };
const pdfArtifact = { kind: "pdf" as const, versionId: "pdf-1", title: "校园节水汇报.pdf", sequence: 2, submittedAt: now, displayModes: ["continuous" as const, "slides" as const] };
const course: Course = {
  id: "course-1", name: "测试课", subject: "科学", grade: "六年级", hours: 2, summary: "", drivingQuestion: "", status: "teaching", stages: getStagesForSystemMode("new"), currentStageIndex: 3,
  students: [{ id: "s1", name: "小林", joinedAt: now, stageProgress: {} }, { id: "s2", name: "小周", joinedAt: now, stageProgress: {} }],
  groups: [{ id: "g1", name: "小林的个人项目", topic: "节水", keywords: [], selectedForms: [], members: [{ studentId: "s1", name: "小林" }], createdAt: now, updatedAt: now }],
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } }, createdAt: now, updatedAt: now,
};
const first: ShowcaseQueueItem = { studentId: "s1", studentName: "小林", groupId: "g1", position: 1, status: "waiting", artifacts: [artifact], primaryArtifactTitle: artifact.title };
const second: ShowcaseQueueItem = { ...first, studentId: "s2", studentName: "小周", groupId: "g2", position: 2, artifacts: [pdfArtifact] };
const active: ShowcasePresentationSnapshot = { id: "p1", courseId: course.id, groupId: "g1", studentId: "s1", studentName: "小林", artifactKind: "document", artifactVersionId: "a1", artifactTitle: artifact.title, displayMode: "continuous", status: "active", revision: 2, requestedAt: now, updatedAt: now };
function baseState(overrides: Partial<ShowcaseData> = {}): MockState {
  return { loading: false, data: { courseId: course.id, stageKey: "showcase", students: [{ studentId: "s1", name: "小林", groupId: "g1", isAssigned: false, artifacts: [artifact, pdfArtifact] }, { studentId: "s2", name: "小周", groupId: "g2", isAssigned: false, artifacts: [pdfArtifact] }], ownArtifacts: [], activePresentation: null, presentations: [], queue: [first], queueConfig: { schemaVersion: 1, orderedStudentIds: ["s1"], minutesPerStudent: 5, updatedAt: now }, minutesPerStudent: 5, currentQueueItem: null, nextQueueItem: first, ...overrides } };
}
function recommendations(overrides: Partial<ShowcaseRecommendations> = {}): ShowcaseRecommendations {
  return { courseId: course.id, targetCount: 3, targetSource: "default", recommendedStudentIds: ["s2"], candidates: [{ studentId: "s2", studentName: "小周", artifactVersionId: "pdf-1", artifactKind: "pdf", analysisStatus: "complete", qualityScore: 95, aiRequestCount: 18, reasons: [{ kind: "quality", text: "结论与实验数据对应清晰", location: "第 2 页", quote: "每天节水 20 升" }, { kind: "ai-interactions", text: "AI 协作请求 18 次" }] }], pendingCount: 0, updatedAt: now, revision: "r1", ...overrides };
}

beforeEach(() => { vi.clearAllMocks(); mocks.state = baseState(); mocks.runAction.mockResolvedValue(baseState().data); mocks.fetch.mockImplementation(async (url: string) => Response.json(url.endsWith("/presentation") ? mocks.state?.data : recommendations())); vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.querySelectorAll('[data-testid="showcase-footer"]').forEach((element) => element.remove()); });

function openStudentRoster() {
  if (!screen.queryByRole("dialog", { name: "选择汇报学生" })) {
    fireEvent.click(screen.getByRole("button", { name: "选择学生" }));
  }
}

async function browseRecommendedStudent() {
  openStudentRoster();
  fireEvent.click(screen.getByRole("tab", { name: "推荐人选" }));
  fireEvent.click(await screen.findByRole("button", { name: "浏览小周作品" }));
}

function openRosterAction(name: string | RegExp) {
  openStudentRoster();
  fireEvent.click(screen.getByRole("button", { name }));
  expect(screen.queryByRole("dialog", { name: "选择汇报学生" })).toBeNull();
}

describe("showcase teacher selection and handoff", () => {
  it.each([false, true])("keeps export and rubric assessment reachable with immersive=%s", async (immersive) => {
    const assessedCourse: Course = {
      ...course,
      content: {
        ...course.content,
        stagePlan: {
          schemaVersion: 1, source: "resource-package", totalMinutes: 90, lessonCount: 2, minutesPerLesson: 45,
          stages: [], evaluationCriteria: "", reflectionQuestions: [],
          evaluationRubric: {
            id: "rubric-1", version: 1,
            dimensions: [{ id: "evidence", name: "证据质量", weight: 100, description: "结论有证据支持" }],
            sourceWeights: { teacher: 100, ai: 0 },
          },
        },
      },
    };
    render(<NewShowcaseTeacherView course={assessedCourse} immersive={immersive} />);
    await browseRecommendedStudent();
    openRosterAction("更多");
    const dialog = screen.getByRole("dialog", { name: "更多操作" });
    expect(within(dialog).getByRole("link", { name: "下载全班成果" })).toHaveAttribute("href", "/api/courses/course-1/showcase/artifacts/export");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "选择评分学生" }), { target: { value: "s1" } });
    expect(within(dialog).getByRole("region", { name: "课程量规评分" })).toBeTruthy();
    expect(within(dialog).getByRole("spinbutton", { name: "证据质量教师评分" })).toBeEnabled();
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(mocks.upsertRubricScore).not.toHaveBeenCalled();
  });

  it("does not mistake an unsaved legacy class-wide queue for a teacher-selected roster", async () => {
    mocks.state = baseState({ queueConfig: undefined, queue: [first, second] });
    render(<NewShowcaseTeacherView course={course} />);
    await browseRecommendedStudent();
    openRosterAction(/^汇报安排/);
    expect(screen.getByText("已选 0 人")).toBeTruthy();
    expect(screen.getByRole("button", { name: "请先添加汇报学生" })).toBeDisabled();
    expect(mocks.runAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "采用推荐名单" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: "save-queue", selectedStudentIds: ["s2"], orderedStudentIds: ["s2"] })));
  });
  it("starts the selected next student in one action, independent of the locally browsed recommendation", async () => {
    render(<NewShowcaseTeacherView course={course} />);
    await browseRecommendedStudent();
    expect(screen.getByTestId("artifact-viewer").dataset.versionId).toBe("pdf-1");
    fireEvent.click(screen.getByRole("button", { name: "开始小林汇报并投屏" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledExactlyOnceWith({ action: "start", studentId: "s1", artifactKind: "document", artifactVersionId: "a1", displayMode: "continuous" }));
  });

  it("shows evidence and browses all students without changing the presenter", async () => {
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.queryByRole("region", { name: "汇报学生列表" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "全部学生" })).toBeNull();
    expect(screen.queryByText("结论与实验数据对应清晰", { selector: "summary" })).toBeNull();
    await browseRecommendedStudent();
    openRosterAction("推荐依据");
    const evidence = screen.getByText("结论与实验数据对应清晰", { selector: "summary" });
    fireEvent.click(evidence);
    expect(screen.getByText("第 2 页：每天节水 20 升")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭推荐依据" }));
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: "全部学生" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索学生姓名" }), { target: { value: "小林" } });
    expect(screen.queryByRole("button", { name: "浏览小周作品" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "浏览小林作品" }));
    expect(screen.getByTestId("artifact-viewer").dataset.versionId).toBe("a1");
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("defaults a selected PDF to slides and starts the exact selected version", async () => {
    render(<NewShowcaseTeacherView course={course} />);
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: "全部学生" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览小林作品" }));
    fireEvent.click(screen.getByRole("button", { name: "选择学生汇报材料" }));
    fireEvent.click(screen.getByRole("option", { name: /校园节水汇报\.pdf/ }));
    expect(screen.getByTestId("artifact-viewer").dataset.displayMode).toBe("slides");
    fireEvent.click(screen.getByRole("button", { name: "开始小林汇报并投屏" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith({ action: "start", studentId: "s1", artifactKind: "pdf", artifactVersionId: "pdf-1", displayMode: "slides" }));
  });

  it("adds the inspected student and preserves a failed selection for retry", async () => {
    mocks.runAction.mockRejectedValueOnce(new Error("网络中断"));
    render(<NewShowcaseTeacherView course={course} />);
    await browseRecommendedStudent();
    openStudentRoster();
    fireEvent.click(screen.getByRole("button", { name: "加入小周汇报名单" }));
    await screen.findByText("网络中断");
    expect(screen.getByRole("button", { name: "移除小周汇报名单" })).toHaveTextContent("移出名单");
    expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: "save-queue", selectedStudentIds: ["s1", "s2"], orderedStudentIds: ["s1", "s2"] }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledTimes(2));
    expect(mocks.runAction.mock.calls[1][0]).toEqual(mocks.runAction.mock.calls[0][0]);
    expect(screen.queryByText("网络中断")).toBeNull();
  });

  it("removes a waiting student using the action on their roster row", async () => {
    mocks.state = baseState({ queue: [first, second] });
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.queryByRole("button", { name: "移除小周汇报名单" })).toBeNull();
    openStudentRoster();
    const remove = screen.getByRole("button", { name: "移除小周汇报名单" });
    expect(remove).toHaveTextContent("移出名单");
    fireEvent.click(remove);
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: "save-queue", selectedStudentIds: ["s1"], orderedStudentIds: ["s1"] })));
  });

  it("saves a changed reporting order using the roster row controls", async () => {
    mocks.state = baseState({ queue: [first, second] });
    render(<NewShowcaseTeacherView course={course} />);
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: /汇报名单/ }));
    fireEvent.click(screen.getByRole("button", { name: "小周上移" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: "save-queue", selectedStudentIds: ["s2", "s1"], orderedStudentIds: ["s2", "s1"] })));
  });

  it("adopts recommendations by filling the target without replacing the teacher's order", async () => {
    render(<NewShowcaseTeacherView course={course} />);
    await browseRecommendedStudent();
    openRosterAction(/^汇报安排/);
    fireEvent.click(screen.getByRole("button", { name: "补充推荐学生" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: "save-queue", selectedStudentIds: ["s1", "s2"], orderedStudentIds: ["s1", "s2"] })));
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining("/recommendations"), expect.objectContaining({ cache: "no-store" }));
  });

  it("arranges a selected student next from the reporting roster and saves immediately", async () => {
    mocks.state = baseState({ queue: [first, second] });
    render(<NewShowcaseTeacherView course={course} />);
    await browseRecommendedStudent();
    expect(screen.queryByRole("button", { name: "安排小周下一位" })).toBeNull();
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: /汇报名单/ }));
    fireEvent.click(screen.getByRole("button", { name: "安排小周下一位" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ selectedStudentIds: ["s2", "s1"], orderedStudentIds: ["s2", "s1"] })));
  });

  it("uses the new roster order even when an earlier student was already called", async () => {
    mocks.state = baseState({ queue: [second, { ...first, status: "called" }], currentQueueItem: { ...first, status: "called" } });
    render(<NewShowcaseTeacherView course={course} />);
    fireEvent.click(screen.getByRole("button", { name: "开始小周汇报并投屏" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: "start", studentId: "s2", displayMode: "slides" })));
  });

  it("preserves completed slots when a teacher makes another student next", async () => {
    const third = { ...first, studentId: "s3", studentName: "小张", position: 3 };
    const state = baseState({ queue: [first, { ...second, status: "completed" }, third] });
    state.data.students.push({ studentId: "s3", name: "小张", groupId: "g3", isAssigned: false, artifacts: [artifact] });
    mocks.state = state;
    render(<NewShowcaseTeacherView course={course} />);
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: "全部学生" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览小张作品" }));
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: /汇报名单/ }));
    fireEvent.click(screen.getByRole("button", { name: "安排小张下一位" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ orderedStudentIds: ["s3", "s2", "s1"] })));
  });

  it("requires reviewing recommendations when the recommended version is no longer current", async () => {
    mocks.fetch.mockImplementation(async (url: string) => Response.json(url.endsWith("/presentation") ? { ...baseState().data, students: [{ studentId: "s2", name: "小周", artifacts: [{ ...pdfArtifact, versionId: "pdf-2" }] }] } : recommendations()));
    render(<NewShowcaseTeacherView course={course} />);
    await browseRecommendedStudent();
    openRosterAction(/^汇报安排/);
    fireEvent.click(screen.getByRole("button", { name: "补充推荐学生" }));
    await screen.findByText(/作品已更新，已刷新推荐，请核对后采用/);
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(mocks.reload).toHaveBeenCalledOnce();
  });

  it("shows completion in the student roster after the last report", () => {
    mocks.state = baseState({ queue: [{ ...first, status: "completed" }], nextQueueItem: null });
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.getByRole("button", { name: "本轮汇报完成" })).toBeDisabled();
    openStudentRoster();
    expect(within(screen.getByRole("region", { name: "汇报学生列表" })).queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "进入下一阶段" })).toBeNull();
  });

  it("treats historical evaluating as finished and offers the next student without evaluation", async () => {
    mocks.state = baseState({ queue: [{ ...first, status: "evaluating" }, second], currentQueueItem: { ...first, status: "evaluating" }, nextQueueItem: second });
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.queryByText("教师点评中")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /点评/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始小周汇报并投屏" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: "start", studentId: "s2", displayMode: "slides" })));
  });

  it.each(["completed", "presenting"] as const)("protects a %s student from removal and reordering", (status) => {
    mocks.state = baseState({ queue: [{ ...first, status }, second], ...(status === "presenting" ? { activePresentation: active, presentations: [active] } : {}) });
    render(<NewShowcaseTeacherView course={course} />);
    if (status === "presenting") fireEvent.click(screen.getByRole("button", { name: "返回作品浏览" }));
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: /汇报名单/ }));
    expect(screen.getByRole("button", { name: "移除小林汇报名单" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "安排小林下一位" })).toBeNull();
    expect(screen.queryByRole("button", { name: "小林下移" })).toBeNull();
    expect(screen.getByRole("button", { name: "小周上移" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^汇报安排/ })).toHaveTextContent(`已汇报 ${status === "completed" ? 1 : 0} 人`);
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("keeps manual browsing available if AI recommendation loading fails", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ message: "分析暂不可用" }, { status: 503 }));
    render(<NewShowcaseTeacherView course={course} />);
    openRosterAction(/^汇报安排/);
    await screen.findByText(/分析暂不可用/);
    fireEvent.click(screen.getByRole("button", { name: "关闭汇报安排" }));
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: "全部学生" }));
    expect(screen.getByRole("button", { name: "浏览小周作品" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始小林汇报并投屏" })).toBeEnabled();
  });
});

describe("optional recommendation failures", () => {
  it.each(['error', 'empty', 'timeout'] as const)('keeps the full manual reporting flow available with recommendation %s', async failure => {
    if (failure === 'timeout') vi.useFakeTimers();
    mocks.state = baseState({ queue: [], queueConfig: undefined });
    mocks.fetch.mockImplementation(async () => failure === 'timeout' ? new Promise(() => {})
      : failure === 'error' ? Response.json({ message: '分析暂不可用' }, { status: 503 })
      : Response.json(recommendations({ recommendedStudentIds: [], candidates: [] })));
    mocks.runAction.mockImplementation(async action => {
      const data = mocks.state!.data;
      if (action.action === 'save-queue') {
        data.queue = action.orderedStudentIds.map((id: string) => ({ ...(id === 's1' ? first : second), status: 'waiting' }));
        data.queueConfig = { ...action, schemaVersion: 1, updatedAt: now };
      } else if (action.action === 'start') data.activePresentation = { ...active, studentId: action.studentId };
      else if (action.action === 'end') {
        data.activePresentation = null;
        data.queue = data.queue.map(row => ({ ...row, status: 'completed' }));
      }
      return data;
    });
    const view = render(<NewShowcaseTeacherView course={course} />);
    if (failure === 'timeout') {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
      vi.useRealTimers();
    } else await act(async () => {});
    openRosterAction(/^汇报安排/);
    expect(screen.getByRole('button', { name: '采用推荐名单' })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭汇报安排" }));
    openStudentRoster();
    expect(screen.getByRole('tab', { name: '全部学生' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '浏览小林作品' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '浏览小周作品' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '加入小林汇报名单' }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'save-queue', selectedStudentIds: ['s1'] })));
    view.rerender(<NewShowcaseTeacherView course={course} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭选择汇报学生' }));
    fireEvent.click(screen.getByRole('button', { name: '开始小林汇报并投屏' }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', studentId: 's1' })));
    view.rerender(<NewShowcaseTeacherView course={course} />);
    fireEvent.click(screen.getByRole('button', { name: '结束小林汇报' }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith({ action: 'end', presentationId: active.id }));
    view.rerender(<NewShowcaseTeacherView course={course} />);
    expect(screen.getByRole('button', { name: '本轮汇报完成' })).toBeDisabled();
    openStudentRoster();
    expect(within(screen.getByRole('region', { name: '汇报学生列表' })).queryByRole('status')).toBeNull();
  });
});

describe("showcase fullscreen projection", () => {
  it("opens a document locally without a reporting roster and restores the reading position on exit", async () => {
    mocks.state = baseState({ queue: [], queueConfig: undefined });
    render(<NewShowcaseTeacherView course={course} />);
    await browseRecommendedStudent();
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: "全部学生" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览小林作品" }));
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    const fullscreen = screen.getByRole("dialog", { name: `作品全屏展示：${artifact.title}` });
    expect(within(fullscreen).getByText("仅本机展示")).toBeTruthy();
    expect(within(fullscreen).getByTestId("artifact-viewer")).toHaveAttribute("data-mode", "self");
    expect(within(fullscreen).getByTestId("artifact-viewer")).toHaveAttribute("data-presentation-layout", "true");
    expect(within(fullscreen).queryByRole("button", { name: /结束.*汇报/ })).toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(within(fullscreen).getByRole("button", { name: "模拟翻页" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-initial-page", "2");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(mocks.updateViewState).not.toHaveBeenCalled();
  });

  it("keeps PDF mode and page changes local while another student's work is projected", async () => {
    mocks.state = baseState({ activePresentation: active, presentations: [active] });
    render(<NewShowcaseTeacherView course={course} />);
    const projection = screen.getByRole("region", { name: `作品全屏展示：${artifact.title}` });
    const publicViewer = within(projection).getByTestId("artifact-viewer");
    fireEvent.click(screen.getByRole("button", { name: "浏览学生作品" }));
    const browser = screen.getByRole("dialog", { name: "浏览学生作品" });
    await browseRecommendedStudent();
    fireEvent.click(within(browser).getByRole("button", { name: "本机全屏展示" }));
    const fullscreen = screen.getByRole("dialog", { name: `作品全屏展示：${pdfArtifact.title}` });
    fireEvent.click(within(fullscreen).getByRole("button", { name: "切换本机阅读方式" }));
    expect(within(fullscreen).getByTestId("artifact-viewer")).toHaveAttribute("data-display-mode", "continuous");
    fireEvent.click(within(fullscreen).getByRole("button", { name: "模拟翻页" }));
    fireEvent.click(within(fullscreen).getByRole("button", { name: "返回作品浏览" }));
    const restoredBrowser = screen.getByRole("dialog", { name: "浏览学生作品" });
    expect(within(restoredBrowser).getByTestId("artifact-viewer")).toHaveAttribute("data-initial-page", "2");
    expect(within(restoredBrowser).getByTestId("artifact-viewer")).toHaveAttribute("data-display-mode", "continuous");
    expect(within(projection).getByTestId("artifact-viewer")).toBe(publicViewer);
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(mocks.updateViewState).not.toHaveBeenCalled();
  });

  it("uses the whole viewport and keeps browsing local while the active controller stays mounted", async () => {
    mocks.state = baseState({ activePresentation: active, presentations: [active], queue: [{ ...first, status: "presenting" }, second] });
    render(<NewShowcaseTeacherView course={course} presentation="teaching" immersive />);
    const projection = screen.getByRole("region", { name: `作品全屏展示：${artifact.title}` });
    const viewer = within(projection).getByTestId("artifact-viewer");
    expect(viewer.dataset.presentationLayout).toBe("true");
    expect(screen.queryByTestId("teacher-showcase-management")).toBeNull();
    fireEvent.click(within(projection).getByRole("button", { name: "模拟翻页" }));
    expect(mocks.updateViewState).toHaveBeenCalledWith({ page: 2 });
    mocks.updateViewState.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "浏览学生作品" }));
    const browser = screen.getByRole("dialog", { name: "浏览学生作品" });
    await browseRecommendedStudent();
    fireEvent.click(within(browser).getByRole("button", { name: "模拟翻页" }));
    expect(mocks.updateViewState).not.toHaveBeenCalled();
    fireEvent.click(within(browser).getByRole("button", { name: "返回当前汇报" }));
    expect(within(projection).getByTestId("artifact-viewer")).toBe(viewer);
  });

  it("returns to browsing without ending the public presentation", async () => {
    mocks.state = baseState({ activePresentation: active, presentations: [active] });
    render(<NewShowcaseTeacherView course={course} />);
    fireEvent.click(screen.getByRole("button", { name: "返回作品浏览" }));
    expect(screen.queryByRole("region", { name: `作品全屏展示：${artifact.title}` })).toBeNull();
    expect(screen.getByRole("button", { name: "返回当前汇报" })).toBeTruthy();
    expect(mocks.runAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回当前汇报" }));
    fireEvent.click(screen.getByRole("button", { name: "结束小林汇报" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledExactlyOnceWith({ action: "end", presentationId: "p1" }));
  });

  it("provides explicit takeover when another window owns the projection", () => {
    mocks.state = { ...baseState({ activePresentation: active, presentations: [active] }), needsTakeover: true };
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.getByTestId("artifact-viewer").dataset.mode).toBe("teacher");
    fireEvent.click(screen.getByRole("button", { name: "接管投屏" }));
    expect(mocks.takeControl).toHaveBeenCalledOnce();
  });

  it("preserves the footer action on analytics and prevents duplicate starts", async () => {
    const footer = document.createElement("footer"); footer.dataset.testid = "showcase-footer"; document.body.append(footer);
    let finish: (value: ShowcaseData) => void = () => undefined;
    mocks.runAction.mockImplementationOnce(() => new Promise<ShowcaseData>((resolve) => { finish = resolve; }));
    render(<TeacherPresentationActionsProvider target={footer}><NewShowcaseTeacherView course={course} presentation="analytics" immersive /></TeacherPresentationActionsProvider>);
    const button = within(footer).getByRole("button", { name: "开始小林汇报并投屏" });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(mocks.runAction).toHaveBeenCalledOnce();
    finish(baseState().data);
    await waitFor(() => expect(button).toBeEnabled());
  });
});


describe("showcase reading and roster clarity", () => {
  it("keeps the current document open when recommendations arrive", async () => {
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-version-id", "a1");
    await act(async () => {});
    expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-version-id", "a1");
    openStudentRoster();
    expect(screen.getByRole("button", { name: "浏览小林作品" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("tab", { name: "推荐人选" }));
    fireEvent.click(await screen.findByRole("button", { name: "浏览小周作品" }));
    expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-version-id", "pdf-1");
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("separates browsing, membership, searching and reporting order", async () => {
    render(<NewShowcaseTeacherView course={course} />);
    openStudentRoster();
    expect(screen.queryByRole("button", { name: "小林上移" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索学生姓名" }), { target: { value: "找不到" } });
    expect(screen.getByRole("heading", { name: "没有找到“找不到”" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("button", { name: "浏览小林作品" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "汇报名单 1" }));
    expect(screen.getByLabelText("汇报顺序 1")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "小林上移" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除小林汇报名单" })).toHaveAttribute("aria-pressed", "true");
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it.each(["empty", "error", "pending"] as const)("provides an actionable recommendation %s state", async (state) => {
    mocks.fetch.mockResolvedValue(state === "error" ? Response.json({ message: "供应商繁忙" }, { status: 503 })
      : Response.json(recommendations({ recommendedStudentIds: [], candidates: [], pendingCount: state === "pending" ? 2 : 0 })));
    render(<NewShowcaseTeacherView course={course} />);
    await act(async () => {});
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: "推荐人选" }));
    expect(screen.getByRole("heading", { name: state === "error" ? "推荐暂时不可用" : state === "pending" ? "推荐名单准备中" : "本轮暂无推荐人选" })).toBeTruthy();
    expect(screen.queryByText(/暂无符合条件/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "浏览全部学生" }));
    expect(screen.getByRole("tab", { name: "全部学生" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "浏览小林作品" })).toBeEnabled();
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("marks an updated work without repeating an outdated quality recommendation", async () => {
    const candidate = recommendations().candidates[0];
    mocks.fetch.mockResolvedValue(Response.json(recommendations({ candidates: [{ ...candidate, analysisFreshness: "outdated" }] })));
    render(<NewShowcaseTeacherView course={course} />);
    await act(async () => {});
    openStudentRoster();
    fireEvent.click(screen.getByRole("tab", { name: "推荐人选" }));
    const roster = screen.getByRole("region", { name: "汇报学生列表" });
    expect(within(roster).queryByText("作品推荐")).toBeNull();
    expect(within(roster).getByText("作品已更新")).toBeTruthy();
    expect(within(roster).queryByText(candidate.reasons[0].text)).toBeNull();
  });

  it("zooms locally, respects limits and shares the setting with local fullscreen", () => {
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.queryByRole("button", { name: "缩小作品" })).toBeNull();
    fireEvent.pointerMove(screen.getByTestId("artifact-viewer"));
    fireEvent.click(screen.getByRole("button", { name: "调整作品缩放" }));
    for (let step = 0; step < 5; step++) fireEvent.click(screen.getByRole("button", { name: "缩小作品" }));
    expect(screen.getByLabelText("文档缩放比例")).toHaveTextContent("50%");
    expect(screen.getByRole("button", { name: "缩小作品" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "恢复100%" }));
    fireEvent.click(screen.getByRole("button", { name: "缩小作品" }));
    fireEvent.click(screen.getByRole("button", { name: "缩小作品" }));
    expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-scale", "0.8");
    fireEvent.click(screen.getByRole("button", { name: "本机全屏展示" }));
    expect(screen.getByLabelText("文档缩放比例")).toHaveTextContent("80%");
    fireEvent.pointerMove(screen.getByTestId("artifact-viewer"));
    fireEvent.click(screen.getByRole("button", { name: "调整作品缩放" }));
    fireEvent.click(screen.getByRole("button", { name: "放大作品" }));
    fireEvent.click(screen.getByRole("button", { name: "返回作品浏览" }));
    expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-scale", "0.9");
    fireEvent.pointerMove(screen.getByTestId("artifact-viewer"));
    fireEvent.click(screen.getByRole("button", { name: "调整作品缩放" }));
    for (let step = 0; step < 11; step++) fireEvent.click(screen.getByRole("button", { name: "放大作品" }));
    expect(screen.getByLabelText("文档缩放比例")).toHaveTextContent("200%");
    expect(screen.getByRole("button", { name: "放大作品" })).toBeDisabled();
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(mocks.updateViewState).not.toHaveBeenCalled();
  });
});
