import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

const fetcher = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useParams: () => ({ activityId: "assessment" }) }));
vi.mock("@/lib/platform/client", () => ({ teacherPlatformFetch: fetcher }));
vi.mock("@/components/platform/teacher-shell", () => ({ TeacherPlatformPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>, TeacherPlatformHeader: () => null }));

const result = {
  activity: { id: "assessment", title: "课后学习检查", type: "PostTest", questionCount: 2, isOpen: true, chapter: { id: "chapter", title: "第一章" }, offering: { id: "offering", name: "教学理论" } },
  summary: { totalStudents: 3, notStartedCount: 1, inProgressCount: 1, submittedCount: 1 },
  students: [
    { student: { id: "s1", displayName: "小林", username: "lin" }, status: "submitted", submission: {
      id: "submission", submittedAt: "2026-10-20T02:00:00.000Z", activityVersion: 2, snapshotSource: "submission", objectiveScore: 1, objectiveTotal: 1,
      questions: [{ id: "q1", type: "true-false", prompt: "提交时的判断题", correctAnswer: "true" }, { id: "q2", type: "short-answer", prompt: "提交时的解释题" }], answers: { q1: "true", q2: "学生的正式解释" },
    } },
    { student: { id: "s2", displayName: "小王", username: "wang" }, status: "in-progress", submission: null },
    { student: { id: "s3", displayName: "小陈", username: "chen" }, status: "not-started", submission: null },
  ],
};
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("teacher standalone assessment results", () => {
  it.each(["PostTest", "Quiz"])("shows %s results and saved answers without opening an editor", async (type) => {
    fetcher.mockResolvedValue(Response.json({ ...result, activity: { ...result.activity, type } }));
    render(<Page />);
    expect(await screen.findByRole("heading", { name: "课后学习检查" })).toBeInTheDocument();
    expect(screen.getByText(type === "Quiz" ? "测验结果" : "后测结果")).toBeVisible();
    expect(screen.getByLabelText("作答人数统计")).toHaveTextContent("未开始1作答中1已提交1");
    expect(screen.getByText("小王")).toBeVisible();
    expect(screen.getByRole("link", { name: "编辑内容" })).toHaveAttribute("href", "/teacher/classes/offering?editActivity=assessment");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("小林"));
    expect(screen.getByText("1. 提交时的判断题")).toBeVisible();
    expect(screen.getByText("学生作答：正确")).toBeVisible();
    expect(screen.getByText("参考答案：正确")).toBeVisible();
    expect(screen.getByText("学生作答：学生的正式解释")).toBeVisible();
    expect(screen.getByText("客观题 1/1")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/assessment/results", expect.objectContaining({ cache: "no-store" }));
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("shows read failures with a retry action and does not invent zero completion counts", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ message: "暂时无法读取结果" }, { status: 503 })).mockResolvedValue(Response.json(result));
    render(<Page />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取结果");
    expect(screen.queryByLabelText("作答人数统计")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("heading", { name: "课后学习检查" })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it.each(["PostTest", "Quiz"])("filters %s students by status and restores the full roster", async (type) => {
    fetcher.mockResolvedValue(Response.json({ ...result, activity: { ...result.activity, type } }));
    render(<Page />);
    expect(await screen.findByRole("button", { name: "全部（3 人）", pressed: true })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("显示 3 / 3 名学生");

    for (const [status, student] of [["未开始", "小陈"], ["作答中", "小王"], ["已提交", "小林"]]) {
      fireEvent.click(screen.getByRole("button", { name: `${status}（1 人）` }));
      expect(screen.getByRole("button", { name: `${status}（1 人）`, pressed: true })).toBeVisible();
      expect(screen.getByText(student)).toBeVisible();
      for (const other of ["小林", "小王", "小陈"].filter((name) => name !== student)) {
        expect(screen.queryByText(other)).not.toBeInTheDocument();
      }
      expect(screen.getByRole("status")).toHaveTextContent("显示 1 / 3 名学生");
      expect(screen.getByLabelText("作答人数统计")).toHaveTextContent("未开始1作答中1已提交1");
    }
    fireEvent.click(screen.getByText("小林"));
    expect(screen.getByText("学生作答：学生的正式解释")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "全部（3 人）" }));
    expect(screen.getByText("小王")).toBeVisible();
    expect(screen.getByText("小陈")).toBeVisible();
    expect(screen.getByText("小林")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("显示 3 / 3 名学生");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves the filter on refresh and shows an empty match when a student submits", async () => {
    fetcher.mockResolvedValueOnce(Response.json(result));
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "作答中（1 人）" }));
    expect(screen.getByText("小王")).toBeVisible();

    fetcher.mockResolvedValueOnce(Response.json({
      ...result,
      summary: { ...result.summary, inProgressCount: 0, submittedCount: 2 },
      students: result.students.map((row) => row.student.id === "s2" ? { ...row, status: "submitted", submission: { ...result.students[0].submission, id: "submission-2" } } : row),
    }));
    fireEvent.click(screen.getByRole("button", { name: "刷新结果" }));
    expect(await screen.findByRole("button", { name: "作答中（0 人）", pressed: true })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("显示 0 / 3 名学生");
    expect(screen.getByText("暂无“作答中”的学生。")).toBeVisible();
    expect(screen.queryByText(/暂无学生记录/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("作答人数统计")).toHaveTextContent("未开始1作答中0已提交2");

    fireEvent.click(screen.getByRole("button", { name: "已提交（2 人）" }));
    expect(screen.getByText("小林")).toBeVisible();
    expect(screen.getByText("小王")).toBeVisible();
    expect(screen.queryByText("小陈")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("显示 2 / 3 名学生");
  });

  it("shows an empty student roster using the actual zero counts", async () => {
    fetcher.mockResolvedValue(Response.json({ ...result, summary: { totalStudents: 0, notStartedCount: 0, inProgressCount: 0, submittedCount: 0 }, students: [] }));
    render(<Page />);
    expect(await screen.findByText(/暂无学生记录/)).toBeVisible();
    expect(screen.getByText(/教学班有效学生 0 人/)).toBeVisible();
  });
});
