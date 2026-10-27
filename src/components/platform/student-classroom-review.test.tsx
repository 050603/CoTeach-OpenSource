import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { StudentClassroomReview, type ClassroomReviewRecord } from "./student-classroom-review";

vi.mock("@/components/classroom/student-course-answer-review", () => ({ StudentCourseAnswerReview: ({ studentId }: { studentId: string }) => <div>本人小测记录：{studentId}</div> }));
vi.mock("./student-project-review", () => ({ hasStudentProjectRecords: (course: Course, studentId: string) => (course.submissions ?? []).some(item => item.studentId === studentId && item.content.trim()), StudentProjectReview: () => <div>课堂项目记录</div> }));
const record: ClassroomReviewRecord = {
  participation: { id: "participation", completedAt: "2026-10-20T08:00:00Z" }, student: { id: "student", displayName: "小林" },
  instance: { id: "classroom", activityId: "activity", offeringId: "offering", offeringName: "科学探索", title: "河流调查", runNo: 2 },
};
const course = {
  id: "classroom", name: "河流调查", status: "finished", aiLearningClassroomId: "lesson", groups: [], submissions: [], feedback: [], resources: [],
  content: { knowledgePoints: [{ id: "point", name: "控制变量" }], knowledgeLectureSections: [{ id: "section", title: "观察方法", knowledgePointIds: ["point"], quizOutlineId: "quiz" }] },
  aiLearningProgress: {},
} as unknown as Course;
let current: Course;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  current = structuredClone(course);
  fetcher = vi.fn(async (url: string) => url.includes("/experiment") ? Response.json({ questions: [], submission: null, available: true }) : Response.json({ courses: [current], studentId: "student" }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("student classroom review home", () => {
  it("organizes course playback and answers in one review page without empty legacy functions", async () => {
    render(<StudentClassroomReview record={record} />);
    const navigation = await screen.findByRole("navigation", { name: "课堂回顾导航" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(navigation).toHaveTextContent("课程复习我的作答");
    expect(screen.getByRole("link", { name: "进入课程回看" })).toHaveAttribute("href", "/student/classroom/classroom?returnParticipationId=participation");
    expect(screen.getByText("观察方法")).toBeVisible();
    expect(screen.queryByRole("button", { name: "项目回顾" })).toBeNull();
    expect(screen.queryByRole("region", { name: "教师反馈" })).toBeNull();
    for (const label of ["项目成果", "学习反思", "成长评价", "成果与评价", "项目工作区"]) expect(screen.queryByText(label)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "我的作答" }));
    expect(screen.getByRole("region", { name: "我的作答" })).toHaveTextContent("本人小测记录：student");
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("only adds project records and teacher feedback when the scoped content exists", async () => {
    current.submissions = [{ id: "saved", studentId: "student", content: "已保存文档" }] as Course["submissions"];
    current.feedback = [{ id: "teacher", targetType: "student", targetId: "student", sourceRole: "teacher", content: "请补充观察条件", createdAt: "2026-10-20T00:00:00Z" }, { id: "ai", targetType: "student", targetId: "student", sourceRole: "ai", content: "AI反馈不是教师反馈" }, { id: "other", targetType: "student", targetId: "other", sourceRole: "teacher", content: "其他学生的反馈" }] as Course["feedback"];
    render(<StudentClassroomReview record={record} />);
    expect(await screen.findByRole("region", { name: "教师反馈" })).toHaveTextContent("请补充观察条件");
    expect(screen.queryByText("AI反馈不是教师反馈")).toBeNull();
    expect(screen.queryByText("其他学生的反馈")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "项目回顾" }));
    expect(screen.getByRole("region", { name: "项目回顾" })).toHaveTextContent("课堂项目记录");
  });

  it("shows only submitted pre/posttest answers and never opens an available unfinished assessment", async () => {
    current.experimentPosttestSummary = { enabled: true } as Course["experimentPosttestSummary"];
    fetcher.mockImplementation(async (url: string) => url.includes("phase=pretest") ? Response.json({ questions: [{ id: "pre", type: "short-answer", prompt: "课前如何观察？" }], submission: { answers: { pre: "当时记录的想法" }, submittedAt: "2026-10-20T00:00:00Z" } }) : url.includes("phase=posttest") ? Response.json({ questions: [{ id: "post", type: "short-answer", prompt: "不该出现的未答后测" }], submission: null, available: true }) : Response.json({ courses: [current], studentId: "student" }));
    render(<StudentClassroomReview record={record} />);
    fireEvent.click(await screen.findByRole("button", { name: "我的作答" }));
    const region = await screen.findByRole("region", { name: "前后测作答记录" });
    fireEvent.click(screen.getByText("课前前测"));
    expect(region).toHaveTextContent("当时记录的想法");
    expect(screen.queryByText("不该出现的未答后测")).toBeNull();
    expect(screen.queryByRole("button", { name: /提交|开始答题/ })).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("reports failed reads with retry instead of displaying invented empty records", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ message: "读取暂时失败" }, { status: 503 }));
    render(<StudentClassroomReview record={record} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取暂时失败");
    expect(screen.queryByRole("navigation", { name: "课堂回顾导航" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("link", { name: "进入课程回看" })).toBeVisible();
  });

  it.each(["different classroom", "missing identity", "changed identity"])("rejects %s instead of showing unbound records", async failure => {
    fetcher.mockResolvedValue(Response.json({ courses: [{ ...current, id: failure === "different classroom" ? "different" : current.id }], studentId: failure === "missing identity" ? null : failure === "changed identity" ? "other-student" : "student" }));
    render(<StudentClassroomReview record={record} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.queryByRole("link", { name: "进入课程回看" })).toBeNull();
  });
});
