import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassroomWorkspace } from "./classroom-workspace";

vi.mock("./student-shell", () => ({ StudentShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./teacher-shell", () => ({ TeacherPlatformPage: ({ children }: { children: React.ReactNode }) => children, TeacherPlatformHeader: ({ backHref, backLabel }: { backHref?: string; backLabel?: string }) => backHref ? <a href={backHref}>{backLabel}</a> : null }));
vi.mock("./student-classroom-review", () => ({ StudentClassroomReview: ({ record }: { record: { instance: { title: string } } }) => <section aria-label="课堂回顾"><h1>{record.instance.title}</h1></section> }));
vi.mock("./teacher-classroom-review", () => ({ TeacherClassroomReview: ({ record }: { record: { student: { displayName: string } } }) => <section aria-label="教师课堂档案">{record.student.displayName}</section> }));
const results = { submissions: [], artifacts: [{ id: "artifact", title: "水质调查成果", versions: [{ id: "v1", sequence: 1, sourceHtml: "我们的调查报告" }] }], reflections: [{ id: "reflection", content: "下次我们会扩大采样范围。" }], evaluations: [{ id: "evaluation", evaluatorType: "TEACHER", content: "论据充分，建议增加样本。", score: 90 }], showcases: [] };
let fetcher: ReturnType<typeof vi.fn>;
function mockClassroom(status = "finished", teacher = false, evaluations = results.evaluations, snapshotKind = "legacy") {
  const respond = async (url: string) => new Response(JSON.stringify(url.endsWith("/outcomes") ? { ...results, evaluations } : url.endsWith("/ai") ? { conversations: [], supportRecords: [] } : {
    participation: { id: "p", completedAt: "2026-09-09T00:00:00Z" }, student: { id: "student", displayName: "小林" },
    instance: { id: "i", status, activityId: "a", offeringId: "o", offeringName: "科学探索", title: "河流调查", runNo: 1, templateVersion: 2, snapshot: { kind: snapshotKind }, coverImageUrl: "/generated/river-cover.png" },
    workspace: { version: 4, projectState: { document: "保留的调查文档", code: "<p>历史作品</p>" } }, isTeacher: teacher, canWrite: status === "teaching" && !teacher,
  }));
  fetcher.mockImplementation(respond);
  return respond;
}
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("classroom learning records", () => {
  it.each([
    ["pbl-course", "/teacher/classrooms/i?query=one", "返回课堂学习记录"],
    ["pbl-course", "/teacher/classes/o/students?student=one", "返回学生与学习记录"],
    ["legacy", "/teacher/classrooms/i?query=one", "返回课堂学习记录"],
    ["legacy", "/teacher/classes/o/students?student=one", "返回学生与学习记录"],
  ])("preserves the contextual return through loading, failure and success: %s %s", async (kind, returnHref, label) => {
    mockClassroom("finished", true, results.evaluations, kind);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "课堂暂时无法读取" }), { status: 503 }));
    render(<ClassroomWorkspace participationId="p" role="teacher" returnHref={returnHref} />);
    expect(screen.getByText("正在加载课堂…")).toBeVisible();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", returnHref);
    expect(await screen.findByRole("alert")).toHaveTextContent("课堂暂时无法读取");
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", returnHref);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    if (kind === "pbl-course") await screen.findByRole("region", { name: "教师课堂档案" });
    else await screen.findByRole("button", { name: "保存评价" });
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", returnHref);
  });
  it("selects the student session when teacher and student sessions coexist", async () => {
    const teacherResponse = mockClassroom("finished", true);
    const studentResponse = mockClassroom("finished", false);
    fetcher.mockImplementation((url: string, options: RequestInit) => (
      new Headers(options.headers).get("X-OpenPBL-Role") === "student" ? studentResponse : teacherResponse
    )(url));
    render(<ClassroomWorkspace participationId="p" />);
    await screen.findByText("论据充分，建议增加样本。");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("河流调查");
    expect(screen.queryByLabelText("评价内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存评价" })).toBeNull();
  });

  it("never exposes the teacher editor on a student page even if response metadata reports a teacher", async () => {
    mockClassroom("finished", true);
    render(<ClassroomWorkspace participationId="p" />);
    await screen.findByText("论据充分，建议增加样本。");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("河流调查");
    expect(screen.queryByRole("button", { name: "保存评价" })).toBeNull();
  });

  it.each(["teaching", "scheduled", "finished"])("defaults student records to outcomes with read-only teacher feedback during %s", async (status) => {
    mockClassroom(status); render(<ClassroomWorkspace participationId="p" />);
    expect(await screen.findByText("论据充分，建议增加样本。")).toBeVisible();
    expect(screen.getByRole("button", { name: "成果与评价" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "教师评价" })).toHaveTextContent("90 分");
    expect(screen.queryByLabelText("评价内容")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存评价" })).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    expect(fetcher.mock.calls.every(([, options]) => new Headers(options.headers).get("X-OpenPBL-Role") === "student")).toBe(true);
  });

  it.each([false, true])("shows pending teacher feedback even when historical self-evaluation exists: %s", async (hasSelfEvaluation) => {
    mockClassroom("teaching", false, hasSelfEvaluation ? [{ id: "self", evaluatorType: "SELF", content: "我对这次合作很满意。", score: 95 }] : []);
    render(<ClassroomWorkspace participationId="p" />);
    expect(await screen.findByText("教师暂未提交评价")).toBeVisible();
    const teacherFeedback = screen.getByRole("region", { name: "教师评价" });
    expect(teacherFeedback).not.toHaveTextContent("95 分");
    expect(screen.queryByRole("button", { name: "保存评价" })).toBeNull();
    if (hasSelfEvaluation) expect(screen.getByText("我对这次合作很满意。")).toBeVisible();
  });

  it("saves student work on HTTP origins without crypto.randomUUID", async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    mockClassroom("teaching");
    render(<ClassroomWorkspace participationId="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "项目工作区" }));
    fireEvent.change(screen.getByLabelText("项目文档"), { target: { value: "新的调查记录" } });
    fireEvent.click(screen.getByRole("button", { name: "保存工作区" }));
    expect(await screen.findByText("已保存")).toBeVisible();
    const saved = fetcher.mock.calls.find(([, options]) => options.method === "PATCH");
    expect(saved).toBeDefined();
    expect(new Headers(saved![1].headers).get("X-OpenPBL-Role")).toBe("student");
    expect(JSON.parse(saved![1].body).idempotencyKey).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });

  it("opens finished PBL records in the integrated review without querying the legacy tools", async () => {
    mockClassroom("finished", false, results.evaluations, "pbl-course"); render(<ClassroomWorkspace participationId="p" />);
    expect(await screen.findByRole("region", { name: "课堂回顾" })).toHaveTextContent("河流调查");
    expect(screen.queryByRole("navigation", { name: "课堂工具" })).toBeNull();
    expect(screen.queryByRole("button", { name: "成果与评价" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交成果新版本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存评价" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/platform/participations/p");
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it.each(["scheduled", "teaching", "finished"])("opens teacher PBL records through the real course review during %s", async status => {
    mockClassroom(status, true, results.evaluations, "pbl-course");
    render(<ClassroomWorkspace participationId="p" role="teacher" />);
    expect(await screen.findByRole("region", { name: "教师课堂档案" })).toHaveTextContent("小林");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("navigation", { name: "课堂工具" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls[0][1].headers["X-OpenPBL-Role"]).toBe("teacher");
  });
  it("discards the previous student's slow response when the selected participation changes", async () => {
    const respond = mockClassroom("finished", true, results.evaluations, "pbl-course");
    let finishFirst: (value: Response) => void = () => undefined;
    const first = new Promise<Response>(resolve => { finishFirst = resolve; });
    fetcher.mockImplementation(async (url: string) => {
      if (url.endsWith("/p")) return first;
      const data = await (await respond(url)).json();
      return new Response(JSON.stringify({ ...data, participation: { ...data.participation, id: "next" }, student: { id: "next-student", displayName: "小陈" } }));
    });
    const view = render(<ClassroomWorkspace participationId="p" role="teacher" />);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    view.rerender(<ClassroomWorkspace participationId="next" role="teacher" />);
    expect(await screen.findByRole("region", { name: "教师课堂档案" })).toHaveTextContent("小陈");
    finishFirst(await respond("/api/platform/participations/p"));
    await vi.waitFor(() => expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true));
    expect(screen.getByRole("region", { name: "教师课堂档案" })).toHaveTextContent("小陈");
  });
  it("keeps a scheduled run read-only", async () => {
    mockClassroom("scheduled"); render(<ClassroomWorkspace participationId="p" />);
    await screen.findByText("河流调查");
    expect(screen.queryByRole("button", { name: "提交环节记录" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
    expect(screen.getByLabelText("项目文档")).toHaveAttribute("readonly");
  });
  it("clears a failed refresh message after a successful reload", async () => {
    mockClassroom(); render(<ClassroomWorkspace participationId="p" />);
    await screen.findByText("水质调查成果");
    fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "暂时无法读取" }), { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
    fireEvent.click(screen.getByRole("button", { name: /重新加载/ }));
    await screen.findByDisplayValue("保留的调查文档");
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "AI 协作" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新对话状态" }));
    await vi.waitFor(() => expect(fetcher.mock.calls.every(([, options]) => new Headers(options.headers).get("X-OpenPBL-Role") === "student")).toBe(true));
  });
  it("preserves teacher post-class evaluation and the outcomes default", async () => {
    mockClassroom("finished", true); render(<ClassroomWorkspace participationId="p" role="teacher" />);
    expect(await screen.findByRole("button", { name: "保存评价" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "成果与评价" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("评价内容"), { target: { value: "请补充采样记录。" } });
    fireEvent.change(screen.getByLabelText("评分（可选，0–100）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评价" }));
    expect(await screen.findByText("已保存")).toBeVisible();
    const saved = fetcher.mock.calls.find(([, options]) => options.method === "POST");
    expect(saved?.[0]).toBe("/api/platform/participations/p/outcomes");
    expect(JSON.parse(saved![1].body)).toMatchObject({ action: "evaluate", content: "请补充采样记录。", score: 0 });
    expect(fetcher.mock.calls.every(([, options]) => new Headers(options.headers).get("X-OpenPBL-Role") === "teacher")).toBe(true);
  });
});
