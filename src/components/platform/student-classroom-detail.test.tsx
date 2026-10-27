import classroomStyles from "@/components/platform/student-classroom-detail.module.css";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentClassroomDetail } from "./student-classroom-detail";
import type { StudentClassroomActivity } from "./student-classroom-detail.types";

const base: StudentClassroomActivity = { id: "activity", title: "用数据认识校园", description: "记录与比较校园中的观察结果。", isOpen: true,
  offering: { id: "course", name: "科学探索", status: "open" }, chapter: { title: "第一章" },
  instance: { id: "run-2", runNo: 2, status: "teaching", canWrite: true, startedAt: "2026-10-19T01:00:00Z" },
  instances: [{ id: "run-1", runNo: 1, status: "finished", startedAt: "2026-10-12T01:00:00Z", experiment: null }] };
const experiment = { enabled: true, pretest: [{ id: "q1", type: "short-answer" as const, prompt: "你的想法" }], posttest: [{ id: "q2", type: "short-answer" as const, prompt: "你的收获" }] };
let fetcher: ReturnType<typeof vi.fn>;
async function refreshWith(activity: StudentClassroomActivity) {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity })));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("classroom detail guidance", () => {
  it.each([
    [{ ...base, isOpen: false }, "课堂尚未开放"],
    [{ ...base, instance: null }, "等待教师安排课堂"],
    [{ ...base, instance: { ...base.instance!, status: "scheduled", canWrite: false } }, "等待教师开始"],
  ])("explains why a classroom cannot be entered", (activity, heading) => {
    render(<StudentClassroomDetail initialActivity={activity} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });

  it("updates from waiting to teaching without automatically entering and keeps history expanded", async () => {
    render(<StudentClassroomDetail initialActivity={{ ...base, instance: { ...base.instance!, status: "scheduled", canWrite: false } }} />);
    fireEvent.click(screen.getByRole("button", { name: /历史课堂/ }));
    await refreshWith(base);
    expect(screen.getByRole("button", { name: "进入课堂" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /历史课堂/ })).toHaveAttribute("aria-expanded", "true");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("prioritizes a required pretest and accepts its completed state on return", async () => {
    const activity = { ...base, instance: { ...base.instance!, pretestSubmitted: false, experiment } };
    render(<StudentClassroomDetail initialActivity={activity} />);
    expect(screen.getByRole("link", { name: "开始前测" })).toHaveAttribute("href", "/student/activities/activity/assessments/run-2/pretest");
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
    await refreshWith({ ...activity, instance: { ...activity.instance, pretestSubmitted: true } });
    expect(screen.getByRole("button", { name: "进入课堂" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看前测答案" })).toBeInTheDocument();
  });

  it("keeps classroom entry primary while teaching even if a stale flag allows the posttest", () => {
    render(<StudentClassroomDetail initialActivity={{ ...base, instance: { ...base.instance!, pretestSubmitted: true, posttestAvailable: true, experiment } }} />);
    expect(screen.queryByRole("link", { name: "开始后测" })).toBeNull();
    expect(screen.getByRole("button", { name: "进入课堂" })).toHaveClass(classroomStyles.primary);
    expect(screen.getByRole("heading", { name: "课堂已开始，准备加入" })).toBeInTheDocument();
    expect(screen.getByText("尚未开放")).toBeInTheDocument();
    expect(screen.queryByText(/课堂已结束/)).toBeNull();
  });
  it.each([undefined, 2] as const)("shows an authorized posttest after class for contract %s while keeping classroom review read-only", (evaluationContractVersion) => {
    render(<StudentClassroomDetail initialActivity={{ ...base, instance: { ...base.instance!, status: "finished", canWrite: false, evaluationContractVersion, pretestSubmitted: true, posttestAvailable: true, experiment } }} />);
    expect(screen.getByRole("link", { name: "开始后测" })).toHaveAttribute("href", "/student/activities/activity/assessments/run-2/posttest");
    expect(screen.getByRole("button", { name: "查看课堂记录" })).toBeInTheDocument();
    expect(screen.getByText("1 题 · 待完成")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });

  it("switches the primary entry to posttest only after both classroom end and student eligibility refresh", async () => {
    const instance = { ...base.instance!, pretestSubmitted: true, posttestAvailable: false, experiment };
    render(<StudentClassroomDetail initialActivity={{ ...base, instance }} />);
    expect(screen.getByRole("button", { name: "进入课堂" })).toHaveClass(classroomStyles.primary);
    await refreshWith({ ...base, instance: { ...instance, status: "finished", canWrite: false } });
    expect(screen.queryByRole("link", { name: "开始后测" })).toBeNull();
    expect(screen.getByRole("button", { name: "查看课堂记录" })).toHaveClass(classroomStyles.primary);
    await refreshWith({ ...base, instance: { ...instance, status: "finished", canWrite: false, posttestAvailable: true } });
    expect(screen.getByRole("link", { name: "开始后测" })).toHaveClass(classroomStyles.primary);
    expect(screen.getByRole("button", { name: "查看课堂记录" })).toHaveClass(classroomStyles.secondary);
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });

  it("shows the finished current run once and preserves review access even if its pretest was not submitted", () => {
    const current = { ...base.instance!, status: "finished", pretestSubmitted: false, experiment };
    render(<StudentClassroomDetail initialActivity={{ ...base, offering: { ...base.offering, status: "finished" }, instance: current, instances: [current] }} />);
    expect(screen.getByRole("button", { name: "查看课堂记录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /历史课堂/ })).toBeNull();
  });

  it("collapses older runs and shows their own dates and assessment links when expanded", () => {
    render(<StudentClassroomDetail initialActivity={{ ...base, instances: [{ ...base.instances![0], pretestSubmitted: true, posttestSubmitted: true, experiment }] }} />);
    expect(screen.queryByRole("link", { name: "开始后测" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /历史课堂/ }));
    const history = within(screen.getByRole("region", { name: "历史课堂" }));
    expect(history.getByRole("heading", { name: "第 1 次课堂" })).toBeInTheDocument();
    expect(history.getByText(/2026年10月12日/)).toBeInTheDocument();
    expect(history.getByRole("link", { name: "查看后测答案" })).toHaveAttribute("href", "/student/activities/activity/assessments/run-1/posttest");
    expect(history.queryByRole("link", { name: "开始后测" })).toBeNull();
  });

  it.each([undefined, false])("hides unsubmitted posttest actions in finished current and historical classrooms without student eligibility %s", (posttestAvailable) => {
    render(<StudentClassroomDetail initialActivity={{ ...base,
      instance: { ...base.instance!, status: "finished", pretestSubmitted: true, posttestAvailable, experiment },
      instances: [{ ...base.instances![0], pretestSubmitted: true, posttestAvailable, experiment }],
    }} />);
    expect(screen.getByRole("button", { name: "查看课堂记录" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "开始后测" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /历史课堂/ }));
    expect(screen.queryByRole("link", { name: "开始后测" })).toBeNull();
    expect(screen.getAllByText("已关闭").length).toBeGreaterThan(0);
  });

  it("keeps an abstract cover when the stored image fails", () => {
    render(<StudentClassroomDetail initialActivity={{ ...base, instance: { ...base.instance!, coverImageUrl: "/missing-cover.png" } }} />);
    fireEvent.error(screen.getByRole("img", { name: "用数据认识校园课堂封面" }));
    expect(screen.getByRole("img", { name: /图片暂不可用/ }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "进入课堂" })).toBeInTheDocument();
  });

  it("prevents duplicate entry, reports a failure and permits another attempt", async () => {
    let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    render(<StudentClassroomDetail initialActivity={base} />);
    fireEvent.click(screen.getByRole("button", { name: "进入课堂" }));
    expect(screen.getByRole("button", { name: "正在打开课堂…" })).toBeDisabled();
    window.dispatchEvent(new Event("focus"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { finish(new Response(JSON.stringify({ message: "课堂暂时不可用" }), { status: 503 })); });
    expect(screen.getByRole("alert")).toHaveTextContent("课堂暂时不可用");
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "请稍后重试" }), { status: 503 }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "进入课堂" })); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("请稍后重试");
  });

  it("removes all entry and assessment actions when refresh discovers lost access", async () => {
    render(<StudentClassroomDetail initialActivity={{ ...base, instance: { ...base.instance!, experiment, pretestSubmitted: true, posttestAvailable: true } }} />);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "登录已失效" }), { status: 401 }));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByRole("heading", { name: "暂时无法访问课堂" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
    expect(screen.queryByRole("link", { name: "开始后测" })).toBeNull();
    expect(screen.getByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/student/courses/course");
    fireEvent.click(screen.getByRole("button", { name: /历史课堂/ }));
    expect(screen.getByRole("button", { name: "查看课堂记录" })).toBeDisabled();
  });
});
