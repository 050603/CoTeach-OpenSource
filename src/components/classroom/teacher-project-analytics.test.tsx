import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { Course } from "@/lib/session/types";
import { TeacherProjectAnalytics } from "./teacher-project-analytics";

const monitor = vi.hoisted(() => ({ active: vi.fn(), studentCounts: undefined as Array<{ studentId: string; pendingCount: number; reviewedCount: number; dismissedCount: number }> | undefined, nextCursor: undefined as string | undefined }));
vi.mock("@/components/views/teacher/teacher-content-monitor", () => ({
  useTeacherContentMonitor: (_course: Course, active: boolean) => { monitor.active(active); return { pendingCount: 2, error: "", events: [], studentCounts: monitor.studentCounts, nextCursor: monitor.nextCursor }; },
  TeacherContentMonitorPanel: ({ studentId, onStudentChange }: { studentId: string; onStudentChange: (id: string) => void }) => <div><label>提醒学生<select value={studentId} onChange={event => onStudentChange(event.target.value)}><option value="">全部学生</option><option value="s1">小明</option><option value="s2">小红</option></select></label><p>核实记录与本场开关</p></div>,
}));
function fixture(mode: "document" | "other" | "python" | "c" = "document"): Course {
  return {
    ...createPblTemplateCourse("practice"), currentStageIndex: 2, status: "teaching",
    pblConfig: { makeArtifactMode: mode },
    students: [{ id: "s1", name: "小明", joinedAt: "2026-10-01", stageProgress: {} }, { id: "s2", name: "小红", joinedAt: "2026-10-01", stageProgress: {} }],
    submissions: [{ id: "work", courseId: "practice", studentId: "s1", stageKey: "make", type: "document", status: "draft", title: "方案", content: "<p>不在学情中重复展示的作品正文</p>", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }],
    aiInteractionEvents: [{ id: "request", courseId: "practice", studentId: "s1", stageKey: "make", conversationId: "chat", requestId: "r1", source: "sidebar", eventType: "request", actorRole: "student", content: "无提交也能看到的学生提问", createdAt: "2026-10-01T00:01:00Z" }],
  } as Course;
}
describe("project practice analytics", () => {
  beforeEach(() => {
    monitor.active.mockClear(); monitor.nextCursor = undefined;
    monitor.studentCounts = [{ studentId: "s1", pendingCount: 2, reviewedCount: 0, dismissedCount: 0 }];
  });
  it("routes overview statistics to filtered lists and opens a single collaboration drawer", () => {
    const onStudentWork = vi.fn();
    render(<TeacherProjectAnalytics course={fixture()} onStudentWork={onStudentWork} />);
    expect(screen.getByRole("tab", { name: "概览", selected: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /已开始写作或上传，尚未提交/ }));
    expect(screen.getByRole("tab", { name: "学生进度", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "进度筛选" })).toHaveValue("in-progress");
    const row = screen.getByRole("button", { name: "查看小明的 AI 协作" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "查看成果" }));
    expect(onStudentWork).toHaveBeenCalledWith("s1");
    fireEvent.click(within(row).getByRole("button", { name: "查看小明的 AI 协作" }));
    const dialog = screen.getByRole("dialog", { name: "小明 · AI 协作" });
    expect(within(dialog).getByText("无提交也能看到的学生提问")).toBeInTheDocument();
    expect(screen.queryByText("不在学情中重复展示的作品正文")).toBeNull();
    expect(within(dialog).queryByRole("link", { name: /导出/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("tab", { name: "外部内容提醒" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByRole("combobox", { name: "提醒学生" })).toHaveValue("s1");
    fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
    expect(screen.getByRole("combobox", { name: "进度筛选" })).toHaveValue("in-progress");
  });
  it("opens all-class reminders in the same detail surface and lets teachers change student", () => {
    render(<TeacherProjectAnalytics course={fixture()} onStudentWork={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "AI 协作" }));
    fireEvent.click(screen.getByRole("button", { name: "外部内容提醒（2 待核实）" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const student = screen.getByRole("combobox", { name: "提醒学生" });
    expect(student).toHaveValue("");
    fireEvent.change(student, { target: { value: "s2" } });
    expect(screen.getByRole("dialog", { name: "小红 · AI 协作" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "协作对话" }));
    expect(screen.getByText("尚无学生与 AI 的协作对话。")).toBeInTheDocument();
  });
  it("keeps filters and scroll across local view switches and resets on classroom changes", () => {
    const course = fixture();
    const { rerender } = render(<TeacherProjectAnalytics course={course} onStudentWork={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "学生进度" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索进度学生" }), { target: { value: "小红" } });
    const panel = screen.getByRole("tabpanel", { name: "学生进度" });
    panel.scrollTop = 125;
    fireEvent.scroll(panel);
    fireEvent.click(screen.getByRole("tab", { name: "AI 协作" }));
    fireEvent.click(screen.getByRole("tab", { name: "学生进度" }));
    expect(panel.scrollTop).toBe(125);
    rerender(<TeacherProjectAnalytics course={course} active={false} onStudentWork={vi.fn()} />);
    expect(monitor.active).toHaveBeenLastCalledWith(false);
    rerender(<TeacherProjectAnalytics course={course} onStudentWork={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "搜索进度学生" })).toHaveValue("小红");
    expect(screen.getByRole("button", { name: "查看小红的 AI 协作" })).toBeInTheDocument();
    expect(panel.scrollTop).toBe(125);
    rerender(<TeacherProjectAnalytics course={{ ...course, id: "different" }} onStudentWork={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "概览", selected: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "学生进度" }));
    expect(screen.getByRole("textbox", { name: "搜索进度学生" })).toHaveValue("");
  });
  it.each(["python", "c", "other"] as const)("shows %s collaboration without document reminders", mode => {
    render(<TeacherProjectAnalytics course={fixture(mode)} onStudentWork={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "AI 协作" }));
    expect(screen.queryByRole("button", { name: /外部内容提醒/ })).toBeNull();
    expect(monitor.active).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "查看小红的 AI 协作" }));
    expect(screen.queryByRole("tab", { name: "外部内容提醒" })).toBeNull();
  });
  it("supports arrow navigation and an empty classroom", () => {
    render(<TeacherProjectAnalytics course={{ ...fixture(), students: [] }} onStudentWork={vi.fn()} />);
    const tabs = screen.getByRole("tablist", { name: "项目实践班级学情内容" });
    fireEvent.keyDown(within(tabs).getByRole("tab", { name: "概览" }), { key: "ArrowRight" });
    expect(within(tabs).getByRole("tab", { name: "学生进度", selected: true })).toHaveFocus();
    expect(within(screen.getByRole("tabpanel", { name: "学生进度" })).getByText("暂无学生进入本场课堂。")).toBeInTheDocument();
  });
});

it("shows disjoint progress states and persistent submission history without a final-draft distinction", () => {
  const course = fixture();
  course.projectDocumentVersions = [{ id: "v1", courseId: course.id, studentId: "s2", submissionId: "old", stageKey: "make", sequence: 1, sourceVersion: 1, title: "初步成果", sourceHtml: "<p>已提交一次后继续改</p>", status: "submitted", createdAt: "2026-10-01T00:00:00Z", submittedAt: "2026-10-01T00:00:00Z" }];
  render(<TeacherProjectAnalytics course={course} onStudentWork={vi.fn()} />);
  const overview = screen.getByRole("tabpanel", { name: "概览" });
  expect(within(overview).getByRole("img", { name: "未开始 0 人，任务进行中 1 人，提交过成果 1 人" })).toBeInTheDocument();
  expect(screen.queryByText("已形成成果草稿")).toBeNull();
  expect(screen.queryByText("已提交定稿")).toBeNull();
  fireEvent.click(within(overview).getByRole("button", { name: /提交过一次即计入/ }));
  expect(screen.getByRole("combobox", { name: "进度筛选" })).toHaveValue("submitted");
  const row = screen.getByRole("button", { name: "查看小红的 AI 协作" }).closest("li")!;
  expect(within(row).getByText("提交过")).toBeInTheDocument();
  expect(within(row).getByRole("button", { name: "提交 1 次" })).toBeInTheDocument();
});

it("separates AI boundary tags from pending external reminders and drills into the right detail", () => {
  const course = fixture();
  course.aiInteractionEvents!.push({ id: "policy", courseId: course.id, studentId: "s2", stageKey: "make", requestId: "boundary", source: "sidebar", eventType: "policy", actorRole: "system", payload: { protectedCapability: "核心推理" }, content: "请先提出自己的判断。", createdAt: "2026-10-01T00:02:00Z" });
  render(<TeacherProjectAnalytics course={course} onStudentWork={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "AI 协作" }));
  const list = screen.getByRole("list", { name: "学生协作列表" });
  const student1 = within(list).getByRole("button", { name: "查看小明的 AI 协作" }).closest("li")!;
  const student2 = within(list).getByRole("button", { name: "查看小红的 AI 协作" }).closest("li")!;
  expect(within(student1).getByRole("button", { name: "对话 1 轮" })).toBeInTheDocument();
  expect(within(student1).getByRole("button", { name: "采纳 0 次" })).toBeInTheDocument();
  expect(within(student1).getByRole("button", { name: "未采纳 0 次" })).toBeInTheDocument();
  expect(within(student1).getByRole("button", { name: "外部待核实 2" })).toBeInTheDocument();
  expect(within(student1).getByRole("button", { name: "AI 边界 0 次" })).toBeInTheDocument();
  expect(within(student2).getByRole("button", { name: "AI 边界 1 次" })).toBeInTheDocument();
  fireEvent.click(within(student1).getByRole("button", { name: "外部待核实 2" }));
  expect(screen.getByRole("tab", { name: "外部内容提醒", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "提醒学生" })).toHaveValue("s1");
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  fireEvent.click(screen.getByRole("tab", { name: "概览" }));
  fireEvent.click(within(screen.getByRole("region", { name: "需关注学生概览" })).getByRole("button", { name: "查看全部" }));
  expect(screen.getByRole("list", { name: "学生进度列表" }).children).toHaveLength(2);
});

it("keeps external counts unknown when the server omits full counts and a later page remains", () => {
  monitor.studentCounts = undefined; monitor.nextCursor = "more";
  render(<TeacherProjectAnalytics course={fixture()} onStudentWork={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "AI 协作" }));
  const row = screen.getByRole("button", { name: "查看小红的 AI 协作" }).closest("li")!;
  expect(within(row).getByRole("button", { name: "外部待核实 —" })).toBeInTheDocument();
  expect(within(row).queryByRole("button", { name: "外部待核实 0" })).toBeNull();
  expect(screen.getByRole("option", { name: "外部待核实（待同步）" })).toBeDisabled();
  fireEvent.click(screen.getByRole("tab", { name: "学生进度" }));
  fireEvent.change(screen.getByRole("combobox", { name: "进度筛选" }), { target: { value: "attention" } });
  expect(within(screen.getByRole("tabpanel", { name: "学生进度" })).getByText("正在同步完整关注名单…")).toBeInTheDocument();
  expect(screen.queryByText("没有匹配的学生，可调整搜索或筛选条件。")).toBeNull();
});

it("does not label an archived-only outcome as zero written characters", () => {
  const course = fixture();
  course.submissions = [];
  course.projectDocumentVersions = [{ id: "archive", courseId: course.id, studentId: "s2", submissionId: "missing", stageKey: "make", sequence: 1, sourceVersion: 1, title: "已提交成果", sourceHtml: "", status: "submitted", createdAt: "2026-10-01T00:00:00Z", submittedAt: "2026-10-01T00:00:00Z" }];
  render(<TeacherProjectAnalytics course={course} onStudentWork={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "学生进度" }));
  const row = screen.getByRole("button", { name: "查看小红的 AI 协作" }).closest("li")!;
  expect(within(row).getByText("正文待读取")).toBeInTheDocument();
  expect(within(row).queryByText("已写 0 字")).toBeNull();
});

it("shows cumulative student AI requests separately from participation and keeps attention below", () => {
  const course = fixture();
  const request = course.aiInteractionEvents![0];
  course.aiInteractionEvents!.push(
    { ...request, id: "request-duplicate", content: request.content },
    { ...request, id: "request-2", requestId: "r2", studentId: "s2", content: "第二位学生的请求" },
    { ...request, id: "response", eventType: "response", actorRole: "ai", content: "回复不重复计入交互" },
    { ...request, id: "foreign", courseId: "different", requestId: "foreign" },
  );
  const { rerender } = render(<TeacherProjectAnalytics course={course} onStudentWork={vi.fn()} />);
  const overview = screen.getByRole("tabpanel", { name: "概览" });
  const cumulative = within(overview).getByRole("button", { name: /累计 AI 交互/ });
  expect(cumulative).toHaveTextContent("2次");
  expect(cumulative).toHaveTextContent("学生每发起一轮对话，累计 1 次");
  expect(within(overview).queryByRole("button", { name: /^需关注学生/ })).toBeNull();
  expect(within(overview).getByRole("region", { name: "需关注学生概览" })).toBeInTheDocument();
  rerender(<TeacherProjectAnalytics course={{ ...course, aiInteractionEvents: [...course.aiInteractionEvents!, { ...request, id: "request-3", requestId: "r3", content: "继续追问" }] }} onStudentWork={vi.fn()} />);
  expect(cumulative).toHaveTextContent("3次");
  fireEvent.click(cumulative);
  expect(screen.getByRole("tab", { name: "AI 协作", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "协作筛选" })).toHaveValue("participating");
});
