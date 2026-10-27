import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { ContentMonitorEvent } from "@/lib/project-practice/content-monitor-contract";
import { TeacherContentMonitorPanel, useTeacherContentMonitor } from "./teacher-content-monitor";
import type { Course } from "@/lib/session/types";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser/bounded-fetch", () => ({ boundedFetch: fetch }));
vi.mock("@/components/teacher/document-content-monitor-setting", () => ({ DocumentContentMonitorSetting: () => <div>本场课堂设置</div> }));
vi.mock("@/components/classroom/teacher-operation-details", () => ({ teacherOperationStyles: { button: "monitor-button" } }));
const event: ContentMonitorEvent = {
  id: "event-1", studentId: "student-1", studentName: "小明", createdAt: "2026-10-25T02:00:00Z", pastedCharacters: 460,
  excerpt: "可核实的作品核心结论", requirementQuote: "结合实际数据分析", reason: "这段内容包含直接回答任务的完整结论", status: "pending",
  studentSource: "own-draft", studentExplanation: "这是我离线完成的草稿", contentState: "unknown", history: [],
};
const course = createPblTemplateCourse("instance");
const response = (events = [event], extra: Record<string, unknown> = {}) => Response.json({ events, pendingCount: events.filter(item => item.status === "pending").length, ...extra });

function MonitorLauncher({ course }: { course: Course }) {
  const [open, setOpen] = useState(false);
  const state = useTeacherContentMonitor(course);
  return <>
    <button type="button" onClick={() => { setOpen(true); void state.refresh(); }}>
      外部内容提醒{state.pendingCount ? `（${state.pendingCount} 待核实）` : ""}{state.error ? " · 同步失败" : ""}
    </button>
    {open ? <TeacherContentMonitorPanel course={course} state={state} /> : null}
  </>;
}

function EmbeddedMonitor({ current = course, active = true, studentId, onStudentChange }: {
  current?: Course; active?: boolean; studentId?: string; onStudentChange?: (id: string) => void;
}) {
  const state = useTeacherContentMonitor(current, active);
  return <TeacherContentMonitorPanel course={current} state={state} studentId={studentId} onStudentChange={onStudentChange} />;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

describe("teacher content monitoring", () => {
  beforeEach(() => { fetch.mockReset(); fetch.mockImplementation(async () => response()); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("reads historical reminders even when the classroom switch is off and exposes evidence only on demand", async () => {
    render(<MonitorLauncher course={course} />);
    await screen.findByRole("button", { name: "外部内容提醒（1 待核实）" });
    expect(screen.queryByText(event.excerpt)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "外部内容提醒（1 待核实）" }));
    expect(await screen.findByText(event.excerpt)).toBeTruthy();
    expect(screen.getByText(/这是我离线完成的草稿/)).toBeTruthy();
    expect(screen.getByText(/尚未核对保存稿/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/project-practice/content-monitor/events?courseId=instance", expect.objectContaining({ headers: { "X-OpenPBL-Role": "teacher" } }));
  });

  it("saves a teacher dismissal with its explanation and refreshes the durable record", async () => {
    let current = event;
    fetch.mockImplementation(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { current = { ...event, status: "dismissed" }; return Response.json({ event: current }); }
      return response([current]);
    });
    render(<MonitorLauncher course={course} />);
    fireEvent.click(await screen.findByRole("button", { name: "外部内容提醒（1 待核实）" }));
    fireEvent.change(screen.getByRole("textbox", { name: "核实备注（可选）" }), { target: { value: "已查看离线草稿，来源解释合理" } });
    fireEvent.click(screen.getByRole("button", { name: "排除这条提醒" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/project-practice/content-monitor/events/event-1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ courseId: "instance", action: "review", status: "dismissed", note: "已查看离线草稿，来源解释合理" }),
    })));
    await screen.findByText("当前筛选下暂无提醒记录。");
    fireEvent.change(screen.getByRole("combobox", { name: "核实状态" }), { target: { value: "all" } });
    expect(screen.getByRole("heading", { name: "小明 · 已排除" })).toBeTruthy();
  });

  it("keeps the review note when saving fails", async () => {
    fetch.mockImplementation(async (_url: string, options: RequestInit) => options.method === "PATCH" ? Response.json({ message: "保存失败" }, { status: 503 }) : response());
    render(<MonitorLauncher course={course} />);
    fireEvent.click(await screen.findByRole("button", { name: "外部内容提醒（1 待核实）" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "需要保留的核实备注" } });
    fireEvent.click(screen.getByRole("button", { name: "标记已核实" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("textbox")).toHaveValue("需要保留的核实备注");
  });

  it("does not present a failed read as zero reminders", async () => {
    fetch.mockImplementation(async () => Response.json({ message: "服务暂时不可用" }, { status: 503 }));
    render(<MonitorLauncher course={course} />);
    fireEvent.click(await screen.findByRole("button", { name: "外部内容提醒 · 同步失败" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.queryByText("当前筛选下暂无提醒记录。")).toBeNull();
  });

  it("loads later pages while preserving the first page", async () => {
    fetch.mockImplementation(async (url: string) => url.includes("cursor=")
      ? response([{ ...event, id: "event-2", studentName: "小红", studentId: "student-2" }])
      : response([event], { pendingCount: 2, nextCursor: "next-page" }));
    render(<MonitorLauncher course={course} />);
    fireEvent.click(await screen.findByRole("button", { name: "外部内容提醒（2 待核实）" }));
    fireEvent.click(await screen.findByRole("button", { name: "加载更多记录" }));
    expect(await screen.findByRole("heading", { name: "小红 · 待核实" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "小明 · 待核实" })).toBeTruthy();
  });

  it("embeds review controls without a nested drawer and includes students without reminders", async () => {
    const current = { ...course, students: [{ id: "student-3", name: "小刚", joinedAt: "2026-10-25T00:00:00Z", stageProgress: {} }] };
    render(<EmbeddedMonitor current={current} />);
    await screen.findByRole("heading", { name: "小明 · 待核实" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("本场课堂设置")).toBeTruthy();
    expect(screen.getByRole("option", { name: "小刚" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "学生" }), { target: { value: "student-3" } });
    expect(screen.getByText("当前筛选下暂无提醒记录。")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "学生" }), { target: { value: "" } });
    expect(screen.getByRole("heading", { name: "小明 · 待核实" })).toBeTruthy();
  });

  it("supports a shared controlled student selection", async () => {
    const onStudentChange = vi.fn();
    const view = render(<EmbeddedMonitor studentId="student-2" onStudentChange={onStudentChange} />);
    await screen.findByText("当前筛选下暂无提醒记录。");
    fireEvent.change(screen.getByRole("combobox", { name: "学生" }), { target: { value: "" } });
    expect(onStudentChange).toHaveBeenCalledWith("");
    view.rerender(<EmbeddedMonitor studentId="" onStudentChange={onStudentChange} />);
    expect(screen.getByRole("heading", { name: "小明 · 待核实" })).toBeTruthy();
  });

  it("keeps previously loaded evidence when refreshing fails and recovers on retry", async () => {
    render(<EmbeddedMonitor />);
    await screen.findByRole("heading", { name: "小明 · 待核实" });
    fetch.mockImplementation(async () => Response.json({ message: "稍后重试" }, { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("稍后重试 已保留上次读取的记录。");
    expect(screen.getByRole("heading", { name: "小明 · 待核实" })).toBeTruthy();
    fetch.mockImplementation(async () => response());
    fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("pauses inactive and hidden polling and refreshes on return", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const view = render(<EmbeddedMonitor active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_001); });
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(<EmbeddedMonitor active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    await act(async () => { fireEvent(document, new Event("visibilitychange")); });
    expect(fetch).toHaveBeenCalledTimes(2);
    view.rerender(<EmbeddedMonitor active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores a late classroom response even if the transport does not honor abort", async () => {
    const late = deferredResponse();
    const second = { ...course, id: "second-classroom" };
    fetch.mockImplementation(async (url: string) => url.includes("second-classroom")
      ? response([{ ...event, id: "second-event", studentName: "新课堂学生" }]) : late.promise);
    const view = render(<EmbeddedMonitor />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<EmbeddedMonitor current={second} />);
    await screen.findByRole("heading", { name: "新课堂学生 · 待核实" });
    expect(signal.aborted).toBe(true);
    await act(async () => { late.resolve(response()); });
    expect(screen.queryByRole("heading", { name: "小明 · 待核实" })).toBeNull();
    expect(screen.getByRole("heading", { name: "新课堂学生 · 待核实" })).toBeTruthy();
  });

  it("resets pagination and local filters when switching classrooms", async () => {
    const second = { ...course, id: "second-classroom" };
    fetch.mockImplementation(async (url: string) => url.includes("second-classroom") ? response([])
      : url.includes("cursor=") ? response([{ ...event, id: "later-event" }]) : response([event], { nextCursor: "later" }));
    const view = render(<EmbeddedMonitor />);
    fireEvent.click(await screen.findByRole("button", { name: "加载更多记录" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "小明 · 待核实" })).toHaveLength(2));
    fireEvent.change(screen.getByRole("combobox", { name: "学生" }), { target: { value: "student-1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "核实状态" }), { target: { value: "all" } });
    view.rerender(<EmbeddedMonitor current={second} />);
    await screen.findByText("当前筛选下暂无提醒记录。");
    expect(screen.getByRole("combobox", { name: "学生" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "核实状态" })).toHaveValue("pending");
    expect(fetch.mock.calls.filter(([url]) => url.includes("second-classroom"))).toHaveLength(1);
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/project-practice/content-monitor/events?courseId=second-classroom");
  });

  it("cancels old review UI and prevents its late receipt from refreshing either classroom", async () => {
    const review = deferredResponse();
    const second = { ...course, id: "second-classroom" };
    fetch.mockImplementation(async (url: string, options: RequestInit) => options.method === "PATCH" ? review.promise
      : response([{ ...event, studentName: url.includes("second-classroom") ? "新课堂学生" : "小明" }]));
    const view = render(<EmbeddedMonitor />);
    await screen.findByRole("heading", { name: "小明 · 待核实" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧课堂的备注" } });
    fireEvent.click(screen.getByRole("button", { name: "标记已核实" }));
    const reviewSignal = fetch.mock.calls.find(([, options]) => options.method === "PATCH")?.[1].signal as AbortSignal;
    view.rerender(<EmbeddedMonitor current={second} />);
    await screen.findByRole("heading", { name: "新课堂学生 · 待核实" });
    expect(reviewSignal.aborted).toBe(true);
    expect(screen.getByRole("textbox")).toHaveValue("");
    const requestCount = fetch.mock.calls.length;
    await act(async () => { review.resolve(Response.json({ event: { ...event, status: "reviewed" } })); });
    expect(fetch).toHaveBeenCalledTimes(requestCount);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByText("正在保存核实结果…")).toBeNull();
  });

  it("keeps complete per-student totals independent of loaded reminder pages", async () => {
    const counts = [
      { studentId: "student-1", pendingCount: 100, reviewedCount: 3, dismissedCount: 2 },
      { studentId: "outside-first-page", pendingCount: 2, reviewedCount: 0, dismissedCount: 1 },
    ];
    fetch.mockImplementation(async (url: string) => url.includes("cursor=")
      ? response([{ ...event, id: "later-event", studentId: "outside-first-page" }], { pendingCount: 102, studentCounts: counts })
      : response(Array.from({ length: 100 }, (_, index) => ({ ...event, id: `event-${index}` })), { pendingCount: 102, studentCounts: counts, nextCursor: "later" }));
    const { result } = renderHook(() => useTeacherContentMonitor(course));
    await waitFor(() => expect(result.current.studentCounts).toEqual(counts));
    expect(result.current.events).toHaveLength(100);
    expect(result.current.pendingCount).toBe(102);
    expect(result.current.events?.some(record => record.studentId === "outside-first-page")).toBe(false);
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.events).toHaveLength(101);
    expect(result.current.studentCounts).toEqual(counts);
  });

  it("does not fabricate complete student totals for an older response without aggregates", async () => {
    const { result } = renderHook(() => useTeacherContentMonitor(course));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.studentCounts).toBeUndefined();
    fetch.mockImplementation(async () => response([], { studentCounts: [] }));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.studentCounts).toEqual([]);
    fetch.mockImplementation(async () => response([]));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.studentCounts).toBeUndefined();
  });

  it("retains complete student totals on read or malformed-aggregate failures", async () => {
    const counts = [{ studentId: "student-1", pendingCount: 1, reviewedCount: 2, dismissedCount: 3 }];
    fetch.mockImplementation(async () => response([event], { studentCounts: counts }));
    const { result } = renderHook(() => useTeacherContentMonitor(course));
    await waitFor(() => expect(result.current.studentCounts).toEqual(counts));
    fetch.mockImplementation(async () => Response.json({ message: "读取失败" }, { status: 503 }));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBe("读取失败");
    expect(result.current.studentCounts).toEqual(counts);
    fetch.mockImplementation(async () => response([event], { studentCounts: [{ studentId: "student-1", pendingCount: -1 }] }));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toContain("学生提醒汇总响应不完整");
    expect(result.current.studentCounts).toEqual(counts);
  });

  it("refreshes complete student totals after teacher review readback", async () => {
    let reviewed = false;
    fetch.mockImplementation(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { reviewed = true; return Response.json({ event: { ...event, status: "reviewed" } }); }
      return response([{ ...event, status: reviewed ? "reviewed" : "pending" }], { studentCounts: [{ studentId: "student-1", pendingCount: reviewed ? 0 : 1, reviewedCount: reviewed ? 1 : 0, dismissedCount: 0 }] });
    });
    function ReviewPanel() {
      const state = useTeacherContentMonitor(course);
      return <>
        <output data-testid="counts">{JSON.stringify({ studentCounts: state.studentCounts, pendingCount: state.pendingCount })}</output>
        <TeacherContentMonitorPanel course={course} state={state} />
      </>;
    }
    render(<ReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "标记已核实" }));
    await waitFor(() => expect(screen.getByTestId("counts")).toHaveTextContent(JSON.stringify({
      studentCounts: [{ studentId: "student-1", pendingCount: 0, reviewedCount: 1, dismissedCount: 0 }], pendingCount: 0,
    })));
  });

  it("keeps student aggregates isolated across classrooms and pauses them while hidden", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const late = deferredResponse();
    const second = { ...course, id: "second-classroom" };
    const counts = [{ studentId: "new-student", pendingCount: 2, reviewedCount: 0, dismissedCount: 0 }];
    fetch.mockImplementation(async (url: string) => url.includes("second-classroom") ? response([], { studentCounts: counts }) : late.promise);
    const { result, rerender } = renderHook(({ current, active }) => useTeacherContentMonitor(current, active), { initialProps: { current: course, active: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    rerender({ current: second, active: true });
    expect(result.current.studentCounts).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.studentCounts).toEqual(counts);
    await act(async () => { late.resolve(response([], { studentCounts: [{ studentId: "old-student", pendingCount: 9, reviewedCount: 0, dismissedCount: 0 }] })); });
    expect(result.current.studentCounts).toEqual(counts);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    const previousRequests = fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(fetch).toHaveBeenCalledTimes(previousRequests);
    expect(result.current.studentCounts).toEqual(counts);
    hidden.mockReturnValue(false);
    await act(async () => { fireEvent(document, new Event("visibilitychange")); });
    expect(fetch).toHaveBeenCalledTimes(previousRequests + 1);
  });

  it("recovers new reminders through its polling fallback", async () => {
    vi.useFakeTimers();
    fetch.mockImplementation(async () => response([]));
    render(<MonitorLauncher course={course} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    fetch.mockImplementation(async () => response());
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(screen.getByRole("button", { name: "外部内容提醒（1 待核实）" })).toBeTruthy();
  });
});
