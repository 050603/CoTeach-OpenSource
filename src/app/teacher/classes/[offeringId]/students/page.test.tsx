import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ offeringId: "course-1" }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/components/platform/teacher-shell", () => ({
  TeacherPlatformPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  TeacherPlatformHeader: () => <nav>教师课程</nav>,
}));

const summary = {
  offering: { id: "course-1", name: "设计思维", term: "秋季" },
  activities: [
    { id: "form", chapterId: "chapter", chapterTitle: "第一章", chapterPosition: 1, position: 1, title: "学习调查", type: "FORM", isOpen: true, archived: false },
  ],
  totals: { members: 2, participated: 1, incomplete: 1, pendingEvaluation: 1 },
  updatedAt: "2026-09-10T08:00:00.000Z",
  students: [
    { id: "student-1", enrollmentId: "enrollment-1", username: "=formula", displayName: "小林", status: "active", joinedAt: "2026-09-01T08:00:00.000Z", participated: true, completedOpenActivities: 1, openActivityCount: 1, classroomParticipationCount: 1, lastLearningAt: "2026-09-10T08:00:00.000Z", activityStatuses: { form: "completed" }, attentionReasons: ["pending_teacher_evaluation"] },
    { id: "student-2", enrollmentId: "enrollment-2", username: "wang", displayName: "小王", status: "active", joinedAt: "2026-09-01T08:00:00.000Z", participated: false, completedOpenActivities: 0, openActivityCount: 1, classroomParticipationCount: 0, lastLearningAt: null, activityStatuses: { form: "not_started" }, attentionReasons: ["not_participated", "incomplete_open_activity"] },
  ],
};
const detail = {
  student: { id: "student-1", enrollmentId: "enrollment-1", username: "=formula", displayName: "小林", status: "active", joinedAt: "2026-09-01T08:00:00.000Z" },
  activities: [{ ...summary.activities[0], config: { questions: [{ id: "q1", title: "你选择什么？", options: [{ id: "a", label: "校园环境" }] }] }, progress: { status: "completed", startedAt: null, completedAt: "2026-09-10T08:00:00.000Z", lastAccessedAt: "2026-09-10T08:00:00.000Z" } }],
  classrooms: [],
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  window.history.replaceState(null, "", "/teacher/classes/course-1/students");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const resetRequest = { id: "request-123456789", username: "=formula", displayName: "小林", state: "pending", createdAt: "2026-10-26T07:00:00Z", expiresAt: "2026-10-26T07:30:00Z", approvedAt: null };
function mockFetch(records = summary) {
  let currentReset = { ...resetRequest };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/students?view=summary")) return Response.json(records);
    const selected = records.students.find(student => url.endsWith(`/students/${student.enrollmentId}`));
    if (selected && init?.method !== "DELETE") return Response.json({ ...detail, student: selected });
    if (url.includes("/submissions?")) return Response.json({
      activity: { id: "form", title: "学习调查", type: "FORM" },
      submissions: [{ id: "s1", activityVersion: 1, activitySnapshot: { config: detail.activities[0].config }, payload: { answers: { q1: "a" } }, submittedAt: "2026-09-10T08:00:00.000Z", snapshotSource: "submission" }],
      pagination: { page: 1, pageSize: 20, total: 1, hasMore: false },
    });
    if (url.endsWith("/students/export") && init?.method === "POST") {
      const csv = JSON.parse(String(init.body)).format === "csv";
      return new Response(csv ? '\uFEFF"姓名","账号"\r\n"小林","=formula"' : "zip-bytes", {
        headers: { "Content-Type": csv ? "text/csv; charset=utf-8" : "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`设计思维-学生学习记录.${csv ? "csv" : "zip"}`)}` },
      });
    }
    if (url.endsWith("/students/enrollment-1") && init?.method === "DELETE") return Response.json({ enrollmentId: "enrollment-1", status: "withdrawn" });
    if (url.includes("/reset-password?")) return Response.json({ request: url.includes("enrollment-1") ? currentReset : null });
    if (url.endsWith("/reset-password") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      currentReset = { ...currentReset, state: body.action === "approve" ? "approved" : "cancelled" };
      return Response.json({ request: currentReset });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function manyStudents() {
  const students = Array.from({ length: 25 }, (_, index) => ({
    ...summary.students[0], id: `student-${index + 1}`, enrollmentId: `enrollment-${index + 1}`,
    username: `student${String(index + 1).padStart(2, "0")}`, displayName: `学生${String(index + 1).padStart(2, "0")}`,
    lastLearningAt: new Date(Date.parse(summary.updatedAt) - index * 60_000).toISOString(),
  }));
  return { ...summary, students, totals: { members: 25, participated: 25, incomplete: 0, pendingEvaluation: 25 } };
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("教师学生学习记录页面", () => {
  it("shows real summary data and filters the list by attention and activity status", async () => {
    mockFetch();
    render(<Page/>);
    expect(await screen.findByRole("heading", { name: "学生与学习记录" })).toBeInTheDocument();
    expect(await screen.findByText("设计思维 · 秋季")).toBeInTheDocument();
    expect(screen.getByText("含真实访问或提交记录")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多筛选" }));
    fireEvent.change(screen.getByLabelText("关注筛选"), { target: { value: "not_participated" } });
    expect(screen.getByRole("button", { name: /小王/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /小林/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("筛选活动"), { target: { value: "form" } });
    fireEvent.change(screen.getByLabelText("学习状态"), { target: { value: "completed" } });
    expect(await screen.findByText("没有符合条件的学生")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "小王" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "学习概览" })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("student")).toBeNull();
    expect(screen.getByRole("button", { name: "导出当前结果" })).toBeDisabled();
  });

  it("restores question and option labels from the submission snapshot", async () => {
    mockFetch();
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "提交记录" }));
    expect(await screen.findByText("你选择什么？")).toBeInTheDocument();
    expect(screen.getByText("校园环境")).toBeInTheDocument();
  });

  it("shows standalone posttest prompts and judgment answers from the saved snapshot", async () => {
    const fetcher = mockFetch();
    const fallback = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => String(input).includes("/submissions?") ? Response.json({
      activity: { id: "form", title: "独立后测", type: "POSTTEST" },
      submissions: [{ id: "s1", activityVersion: 1, activitySnapshot: { config: { questions: [{ id: "judge", type: "true-false", prompt: "项目学习需要持续探究。" }, { id: "rating", type: "scale", prompt: "学习体验" }] } }, payload: { answers: { judge: "true", rating: "4", __skipReason: "未参与讨论" } }, submittedAt: "2026-09-10T08:00:00.000Z", snapshotSource: "submission" }],
      pagination: { page: 1, pageSize: 20, total: 1, hasMore: false },
    }) : fallback(input, init));
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "提交记录" }));
    expect(await screen.findByText("项目学习需要持续探究。")).toBeInTheDocument();
    expect(screen.getByText("正确")).toBeInTheDocument();
    expect(screen.getByText("学习体验")).toBeInTheDocument();
    expect(screen.getByText("跳题原因")).toBeInTheDocument();
  });

  it("keeps the latest selected student when an earlier detail request finishes later", async () => {
    let releaseFirst!: (response: Response) => void;
    const firstDetail = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/students?view=summary")) return Response.json(summary);
      if (url.endsWith("/students/enrollment-1")) return firstDetail;
      if (url.endsWith("/students/enrollment-2")) return Response.json({ ...detail, student: { ...detail.student, enrollmentId: "enrollment-2", displayName: "小王", username: "wang" }, activities: [{ ...detail.activities[0], title: "小王的活动记录" }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<Page/>);
    fireEvent.click(await screen.findByRole("button", { name: /小王/ }));
    expect(await screen.findByRole("heading", { name: "小王" })).toBeInTheDocument();
    expect(await screen.findByText("小王的活动记录")).toBeInTheDocument();
    await act(async () => { releaseFirst(Response.json(detail)); });
    expect(screen.getByRole("heading", { name: "小王" })).toBeInTheDocument();
    expect(screen.getByText("小王的活动记录")).toBeInTheDocument();
  });

  it("lets the teacher choose data types and downloads the current filtered results as a ZIP", async () => {
    const fetcher = mockFetch();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:zip");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("button", { name: "导出当前结果" }));
    expect(screen.getByRole("dialog", { name: "导出学生学习记录" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "摘要表格（CSV）" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "完整数据包（ZIP）" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /评价记录/ }));
    fireEvent.click(screen.getByRole("button", { name: "生成并下载 ZIP" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/students/export", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ enrollmentIds: ["enrollment-1", "enrollment-2"], sections: ["summary", "activity_progress", "activity_submissions", "classrooms", "artifacts", "reflections"], format: "zip" }),
    })));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const archive = createObjectURL.mock.calls[0]![0] as Blob;
    expect(archive.size).toBe(9);
    expect(archive.type).toBe("application/zip");
    expect(Array.from(await readBlobBytes(archive))).toEqual(Array.from(new TextEncoder().encode("zip-bytes")));
  });

  it("approves only the current student's reset request and can cancel approval", async () => {
    const fetcher = mockFetch();
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "账号管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "允许重置密码" }));
    expect(await screen.findByText("已允许重置")).toBeInTheDocument();
    expect(screen.getByText(/请学生回到原浏览器/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/reset-password", expect.objectContaining({ body: JSON.stringify({ enrollmentId: "enrollment-1", requestId: resetRequest.id, action: "approve" }) }));
    await waitFor(() => expect(screen.getByRole("button", { name: "取消重置" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "取消重置" }));
    expect(await screen.findByText("重置已取消")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/reset-password", expect.objectContaining({ body: JSON.stringify({ enrollmentId: "enrollment-1", requestId: resetRequest.id, action: "cancel" }) }));
    expect(screen.queryByRole("button", { name: "复制链接" })).toBeNull();
  });

  it("cancels a pending request without approving it first", async () => {
    const fetcher = mockFetch();
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "账号管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消申请" }));
    expect(await screen.findByText("重置已取消")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/reset-password", expect.objectContaining({ body: JSON.stringify({ enrollmentId: "enrollment-1", requestId: resetRequest.id, action: "cancel" }) }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "允许重置密码" })).toBeNull();
  });

  it("does not apply an earlier student's late reset request to the newly selected student", async () => {
    const fetcher = mockFetch();
    const fallback = fetcher.getMockImplementation()!;
    let finish!: (response: Response) => void;
    const late = new Promise<Response>(resolve => { finish = resolve; });
    fetcher.mockImplementation(async (input, init) => String(input).includes("/reset-password?enrollmentId=enrollment-1") ? late : fallback(input, init));
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "账号管理" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("reset-password?enrollmentId=enrollment-1"), expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: /小王/ }));
    expect(await screen.findByText(/暂无重置申请/)).toBeInTheDocument();
    await act(async () => { finish(Response.json({ request: resetRequest })); });
    expect(screen.queryByRole("button", { name: "允许重置密码" })).toBeNull();
    expect(screen.getByText(/暂无重置申请/)).toBeInTheDocument();
  });

  it("keeps member removal in account settings and uses the scoped enrollment endpoint", async () => {
    const fetcher = mockFetch();
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "账号管理" }));
    fireEvent.click(screen.getByRole("button", { name: "移出教学班" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/students/enrollment-1", { method: "DELETE" }));
  });

  it("selects students on the new page, and previous/next student navigation crosses pages", async () => {
    mockFetch(manyStudents());
    const { container } = render(<Page/>);
    await screen.findByRole("heading", { name: "学生01" });
    expect(container.querySelectorAll("[data-enrollment-id]")).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("heading", { name: "学生21" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-enrollment-id]")).toHaveLength(5);
    expect(container.querySelector('[data-enrollment-id="enrollment-21"]')).toHaveAttribute("aria-current", "true");
    expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "上一位学生" }));
    expect(await screen.findByRole("heading", { name: "学生20" })).toBeInTheDocument();
    expect(container.querySelector('[data-enrollment-id="enrollment-20"]')).toHaveAttribute("aria-current", "true");
    expect(new URLSearchParams(window.location.search).get("page")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一位学生" }));
    expect(await screen.findByRole("heading", { name: "学生21" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByRole("heading", { name: "学生01" })).toBeInTheDocument();
  });

  it("restores a deep-linked second page and actual popstate navigation without mocking history", async () => {
    window.history.replaceState(null, "", "/teacher/classes/course-1/students?q=student&activity=form&status=completed&page=2&student=enrollment-23&tab=classrooms");
    mockFetch(manyStudents());
    const { container } = render(<Page/>);
    expect(await screen.findByRole("heading", { name: "学生23" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索学生")).toHaveValue("student");
    expect(screen.getByLabelText("筛选活动")).toHaveValue("form");
    expect(screen.getByLabelText("学习状态")).toHaveValue("completed");
    expect(screen.getByRole("tab", { name: "课堂与评价" })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelectorAll("[data-enrollment-id]")).toHaveLength(5);
    expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
    act(() => {
      window.history.pushState(null, "", "/teacher/classes/course-1/students?student=enrollment-2&tab=account");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("heading", { name: "学生02" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "账号管理" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("搜索学生")).toHaveValue("");
    expect(container.querySelectorAll("[data-enrollment-id]")).toHaveLength(20);
  });

  it("clears a selected profile when search is empty and restores the list after clearing filters", async () => {
    mockFetch();
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.change(screen.getByLabelText("搜索学生"), { target: { value: "没有这个学生" } });
    expect(await screen.findByText("没有符合条件的学生")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "小林" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("student")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除全部" }));
    expect(await screen.findByRole("heading", { name: "小林" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("q")).toBeNull();
  });

  it("retries submission history locally without treating a failed request as no records", async () => {
    const fetcher = mockFetch();
    const fallback = fetcher.getMockImplementation()!;
    let attempts = 0;
    let available = false;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes("/submissions?")) {
        attempts++;
        if (!available) return Response.json({ message: "提交历史暂时不可用" }, { status: 503 });
      }
      return fallback(input, init);
    });
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "提交记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("提交历史暂时不可用");
    expect(screen.queryByText("该活动暂无提交记录")).not.toBeInTheDocument();
    const failedAttempts = attempts;
    available = true;
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("校园环境")).toBeInTheDocument();
    expect(attempts).toBe(failedAttempts + 1);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/students?view=summary"))).toHaveLength(1);
  });

  it("waits until a narrow-screen profile is opened before loading details and history", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const fetcher = mockFetch();
    render(<Page/>);
    const student = await screen.findByRole("button", { name: /小林/ });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual(["/api/platform/offerings/course-1/students?view=summary"]);
    expect(screen.queryByRole("heading", { name: "小林" })).not.toBeInTheDocument();
    fireEvent.click(student);
    const drawer = await screen.findByRole("dialog", { name: "学生学习档案" });
    expect(within(drawer).getByRole("heading", { name: "小林" })).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/students/enrollment-1", expect.anything()));
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/submissions?"))).toBe(false);
    fireEvent.click(within(drawer).getByRole("button", { name: "返回学生名单" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "学生学习档案" })).not.toBeInTheDocument());
    expect(new URLSearchParams(window.location.search).get("view")).toBe("list");
  });

  it("opens a narrow-screen student deep link directly with the requested tab", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    window.history.replaceState(null, "", "/teacher/classes/course-1/students?student=enrollment-2&tab=submissions");
    const fetcher = mockFetch();
    render(<Page/>);
    const drawer = await screen.findByRole("dialog", { name: "学生学习档案" });
    expect(within(drawer).getByRole("heading", { name: "小王" })).toBeInTheDocument();
    expect(within(drawer).getByRole("tab", { name: "提交记录" })).toHaveAttribute("aria-selected", "true");
    expect(await within(drawer).findByText("校园环境")).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("enrollment-1"))).toBe(false);
  });

  it("does not display an old student's reset result after switching accounts", async () => {
    const fetcher = mockFetch();
    const fallback = fetcher.getMockImplementation()!;
    let releaseReset!: (response: Response) => void;
    const pendingReset = new Promise<Response>(resolve => { releaseReset = resolve; });
    let secondRequest = { ...resetRequest, id: "second-request", username: "wang", displayName: "小王" };
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/reset-password") && String(init?.body).includes("enrollment-1")) return pendingReset;
      if (url.includes("reset-password?enrollmentId=enrollment-2")) return Response.json({ request: secondRequest });
      if (url.endsWith("/reset-password") && String(init?.body).includes("enrollment-2")) {
        secondRequest = { ...secondRequest, state: "approved" };
        return Response.json({ request: secondRequest });
      }
      return fallback(input, init);
    });
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "账号管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "允许重置密码" }));
    fireEvent.click(screen.getByRole("button", { name: "下一位学生" }));
    expect(await screen.findByRole("heading", { name: "小王" })).toBeInTheDocument();
    await screen.findByText(/second-r/);
    await act(async () => { releaseReset(Response.json({ request: { ...resetRequest, state: "approved" } })); });
    expect(screen.queryByText("已允许重置")).not.toBeInTheDocument();
    expect(screen.queryByText(/request-/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "允许重置密码" }));
    expect(await screen.findByText("已允许重置")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/reset-password", expect.objectContaining({ body: JSON.stringify({ enrollmentId: "enrollment-2", requestId: "second-request", action: "approve" }) }));
  });

  it("downloads CSV by default using every filtered student and preserves the BOM bytes", async () => {
    const fetcher = mockFetch(manyStudents());
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:csv");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Page/>);
    await screen.findByRole("heading", { name: "学生01" });
    fireEvent.click(screen.getByRole("button", { name: "导出当前结果" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("全部 25 位学生");
    fireEvent.click(screen.getByRole("button", { name: "下载摘要 CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const request = fetcher.mock.calls.find(([input]) => String(input).endsWith("/students/export"))!;
    expect(JSON.parse(String(request[1]?.body))).toEqual({ format: "csv", enrollmentIds: manyStudents().students.map(student => student.enrollmentId), sections: ["summary_csv"] });
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    const bytes = await readBlobBytes(blob);
    expect(blob.type.replace(/\s/g, "")).toBe("text/csv;charset=utf-8");
    expect(blob.size).toBe(bytes.length);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode('\uFEFF"姓名","账号"\r\n"小林","=formula"')));
  });

  it("keeps the current filters, selection and loaded records when refresh fails", async () => {
    const fetcher = mockFetch();
    const fallback = fetcher.getMockImplementation()!;
    let summaryLoads = 0;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/students?view=summary") && ++summaryLoads > 1) return Response.json({ message: "无法刷新名单" }, { status: 503 });
      return fallback(input, init);
    });
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.change(screen.getByLabelText("搜索学生"), { target: { value: "wang" } });
    await screen.findByRole("heading", { name: "小王" });
    const before = window.location.search;
    fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法刷新名单");
    expect(screen.getByRole("heading", { name: "小王" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索学生")).toHaveValue("wang");
    expect(screen.getByRole("button", { name: /小王/ })).toBeInTheDocument();
    expect(window.location.search).toBe(before);
  });

  it("keeps the newly selected student's detail when an earlier refresh finishes later", async () => {
    const fetcher = mockFetch();
    const fallback = fetcher.getMockImplementation()!;
    let loads = 0;
    let releaseRefresh!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/students?view=summary") && ++loads > 1) return pending;
      const student = summary.students.find(item => url.endsWith(`/students/${item.enrollmentId}`));
      if (student) return Response.json({ ...detail, student, activities: [{ ...detail.activities[0], title: `${student.displayName}的独有活动` }] });
      return fallback(input, init);
    });
    render(<Page/>);
    await screen.findByText("小林的独有活动");
    fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    fireEvent.click(screen.getByRole("button", { name: /小王/ }));
    await screen.findByText("小王的独有活动");
    await act(async () => { releaseRefresh(Response.json(summary)); });
    expect(screen.getByRole("heading", { name: "小王" })).toBeInTheDocument();
    expect(await screen.findByText("小王的独有活动")).toBeInTheDocument();
    expect(screen.queryByText("小林的独有活动")).not.toBeInTheDocument();
  });
});

it("restores keyboard focus to the export entry after closing its controlled dialog", async () => {
  mockFetch();
  render(<Page/>);
  await screen.findByRole("heading", { name: "小林" });
  const trigger = screen.getByRole("button", { name: "导出当前结果" });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "导出学生学习记录" });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "导出学生学习记录" })).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});
