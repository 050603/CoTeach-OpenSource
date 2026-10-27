import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { TeacherClassroomReview, type TeacherClassroomReviewRecord } from "./teacher-classroom-review";

const evaluation = vi.hoisted(() => vi.fn());
vi.mock("@/components/classroom/student-course-answer-review", () => ({ StudentCourseAnswerReview: ({ role, studentId }: { role: string; studentId: string }) => <div>作答视图：{role} · {studentId}</div> }));
vi.mock("./student-project-review", () => ({ StudentProjectReview: ({ course, role, studentId }: { course: Course; role: string; studentId: string }) => <div>{role}：{course.submissions?.filter(item => item.studentId === studentId).map(item => item.content).join("、")}</div> }));
vi.mock("@/components/evaluation/teacher-evaluation", () => ({ TeacherEvaluationWorkspace: (props: { participationId: string }) => { evaluation(props); return <div>项目评价档案：{props.participationId}</div>; } }));

const record: TeacherClassroomReviewRecord = { participation: { id: "participation", completedAt: "2026-10-25T10:00:00Z", firstEnteredAt: "2026-10-25T09:00:00Z" }, student: { id: "student", displayName: "小林" }, instance: { id: "course", title: "河流调查", status: "finished", offeringName: "科学探索", runNo: 2 } };
const course = { id: "course", status: "finished", evaluationContractVersion: 2,
  students: [{ id: "student", stageProgress: { launch: 100, "ai-learning": 55 } }],
  stages: [{ key: "launch", label: "项目启动" }, { key: "ai-learning", label: "知识讲授" }, { key: "make", label: "项目实践" }],
  content: { knowledgeLectureSections: [] },
  submissions: [{ id: "draft", studentId: "student", content: "真实课堂草稿", status: "draft" }, { id: "other", studentId: "other", content: "其他学生作品" }],
} as unknown as Course;
let fetcher: ReturnType<typeof vi.fn>;
function respond(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
beforeEach(() => { evaluation.mockClear(); fetcher = vi.fn().mockImplementation(async () => respond({ courses: [course] })); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("teacher classroom learning record", () => {
  it("reads the real projection with teacher scope and separates absent progress from recorded completion", async () => {
    render(<TeacherClassroomReview record={record} />);
    expect(await screen.findByRole("progressbar", { name: "知识讲授" })).toHaveAttribute("aria-valuenow", "55");
    expect(screen.getByText("暂无进度记录")).toBeVisible();
    expect(screen.getByText("已完成")).toBeVisible();
    expect(fetcher.mock.calls[0][0]).toBe("/api/courses?courseId=course");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-OpenPBL-Role")).toBe("teacher");
    fireEvent.click(screen.getByRole("button", { name: "项目成果" }));
    expect(screen.getByText("teacher：真实课堂草稿")).toBeVisible();
    expect(screen.queryByText(/其他学生作品/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "课堂作答" }));
    expect(screen.getByText("作答视图：teacher · student")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "评价反馈" }));
    expect(screen.getByText("项目评价档案：participation")).toBeVisible();
    expect(evaluation.mock.lastCall?.[0]).toMatchObject({ participationId: "participation", course });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows a failed read with retry instead of empty records and recovers", async () => {
    fetcher.mockResolvedValueOnce(respond({ message: "读取暂时中断" }, 503));
    render(<TeacherClassroomReview record={record} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取暂时中断");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无进度记录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("navigation")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("loads project collaboration only when opened and does not confuse reports with support requests", async () => {
    fetcher.mockImplementation(async (url: string) => url.endsWith("/ai") ? respond({ conversations: [{ id: "conversation", title: "项目讨论一", messages: [{ id: "m", role: "user", content: "已保存的项目讨论" }] }], supportRecords: [{ id: "support", summary: "请检查采样方法", status: "OPEN" }, { id: "report", type: "PBL_PROCESS_REPORT", summary: "过程报告不应重复作为求助", status: "READY" }] }) : respond({ courses: [course] }));
    render(<TeacherClassroomReview record={record} />);
    await screen.findByRole("navigation");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("项目协作记录"));
    expect(await screen.findByText("已保存的项目讨论")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /教师求助/ }));
    expect(screen.getByText("请检查采样方法")).toBeVisible();
    expect(screen.queryByText("过程报告不应重复作为求助")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/ai"))).toHaveLength(1);
    expect(fetcher.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
  });

  it("preserves legacy post-class evaluation writes and a zero score", async () => {
    const results = { evaluations: [{ id: "old", evaluatorType: "TEACHER", content: "上次评价", score: 80 }] };
    fetcher.mockImplementation(async (url: string, options: RequestInit) => options.method === "POST" ? respond({ outcome: { id: "saved" } }) : url.endsWith("/outcomes") ? respond(results) : respond({ courses: [{ ...course, evaluationContractVersion: undefined }] }));
    render(<TeacherClassroomReview record={record} />);
    fireEvent.click(await screen.findByRole("button", { name: "评价反馈" }));
    expect(await screen.findByText("上次评价")).toBeVisible();
    fireEvent.change(screen.getByLabelText("评价内容"), { target: { value: "补充证据" } });
    fireEvent.change(screen.getByLabelText("评分（可选，0–100）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评价" }));
    expect(await screen.findByText("评价已保存")).toBeVisible();
    const saved = fetcher.mock.calls.find(([, options]) => options.method === "POST");
    expect(saved?.[0]).toBe("/api/platform/participations/participation/outcomes");
    expect(JSON.parse(saved![1].body)).toMatchObject({ action: "evaluate", content: "补充证据", score: 0, idempotencyKey: expect.any(String) });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/courses"))).toHaveLength(2));
  });
  it("retains an unacknowledged legacy evaluation and reuses its retry key", async () => {
    let writes = 0;
    fetcher.mockImplementation(async (url: string, options: RequestInit) => {
      if (options.method === "POST") {
        if (++writes === 1) throw new TypeError("网络中断");
        return respond({ outcome: { id: "saved" } });
      }
      return url.endsWith("/outcomes") ? respond({ evaluations: [] }) : respond({ courses: [{ ...course, evaluationContractVersion: undefined }] });
    });
    render(<TeacherClassroomReview record={record} />);
    fireEvent.click(await screen.findByRole("button", { name: "评价反馈" }));
    fireEvent.change(await screen.findByLabelText("评价内容"), { target: { value: "保留这份评价" } });
    fireEvent.click(screen.getByRole("button", { name: "保存评价" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络中断");
    expect(screen.getByLabelText("评价内容")).toHaveValue("保留这份评价");
    fireEvent.click(screen.getByRole("button", { name: "保存评价" }));
    expect(await screen.findByText("评价已保存")).toBeVisible();
    const writesSent = fetcher.mock.calls.filter(([, options]) => options.method === "POST");
    expect(JSON.parse(writesSent[0][1].body).idempotencyKey).toBe(JSON.parse(writesSent[1][1].body).idempotencyKey);
  });
});
