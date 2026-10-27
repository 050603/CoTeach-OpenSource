import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course, KnowledgeLectureAttempt } from "@/lib/session/types";
import { StudentClassroomFinishedState } from "./student-classroom-finished-state";

vi.mock("@/lib/session/store", () => ({ useSession: () => ({ studentId: "student" }) }));
vi.mock("@/components/views/student/ai-learning", () => ({ AiLearningView: ({ course }: { course: Course }) => <div>复习课件：{course.aiLearningClassroomId}</div> }));
vi.mock("@/components/evaluation/student-evaluation", () => ({ StudentPblEvaluation: ({ initialTab }: { initialTab?: string }) => <section aria-label="课后项目评价">{initialTab === "results" ? "已发布的评价反馈" : "评价填写"}</section> }));
vi.mock("@/components/views/student/knowledge-lecture-board", () => ({ KnowledgeLectureBoard: ({ readOnly, attempt }: { readOnly?: boolean; attempt: KnowledgeLectureAttempt }) => <div role="dialog" aria-label="AI 讲题" data-readonly={readOnly}>{attempt.questions[0].answer}</div> }));

const attempt: KnowledgeLectureAttempt = {
  id: "attempt", quizOutlineId: "quiz", sectionId: "section", runtimeSceneId: "scene", submittedAt: "2026-10-01T00:00:00Z",
  score: 1, maxScore: 1, knowledgePointIds: [],
  questions: [{ questionId: "q", prompt: "如何控制实验条件？", answer: "只改变一个变量", feedback: "保留其他条件一致", authoredAnalysis: "控制变量法", points: 1, earned: 1, correct: true, knowledgePointIds: [] }],
};
const course = {
  id: "course", name: "观察课堂", status: "finished", aiLearningClassroomId: "lesson",
  content: { knowledgePoints: [] }, platformContext: { activityId: "activity-1" },
  aiLearningProgress: { student: { classroomId: "lesson", knowledgeLectureAttempts: [attempt] }, other: { classroomId: "lesson", knowledgeLectureAttempts: [{ ...attempt, id: "other", questions: [{ ...attempt.questions[0], answer: "其他同学答案" }] }] } },
} as unknown as Course;

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

describe("student classroom finished state", () => {
  it("opens the ended lesson for review and links back to its activity", () => {
    render(<StudentClassroomFinishedState course={course} />);
    expect(screen.getByRole("heading", { name: "课堂已结束" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回课堂活动" })).toHaveAttribute("href", "/student/activities/activity-1");
    expect(screen.getByRole("region", { name: "AI 课程回看" })).toHaveTextContent("复习课件：lesson");
    expect(screen.queryByRole("button", { name: "项目评价" })).toBeNull();
  });

  it("makes published PBL feedback reachable after a V2 classroom has finished", () => {
    render(<StudentClassroomFinishedState course={{ ...course, evaluationContractVersion: 2 }} />);
    fireEvent.click(screen.getByRole("button", { name: "项目评价" }));
    expect(screen.getByRole("region", { name: "课后项目评价" })).toHaveTextContent("已发布的评价反馈");
  });

  it("keeps a standalone classroom's finished state without a platform activity link", () => {
    render(<StudentClassroomFinishedState course={{ ...course, platformContext: undefined }} />);
    expect(screen.getByRole("heading", { name: "课堂已结束" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "返回课堂活动" })).toBeNull();
  });

  it("shows only the student's saved first answers and opens read-only AI explanations", () => {
    const repeated = { ...attempt, id: "repeat", submittedAt: "2026-10-02T00:00:00Z", questions: [{ ...attempt.questions[0], answer: "重做的答案" }] };
    render(<StudentClassroomFinishedState course={{ ...course, aiLearningProgress: { ...course.aiLearningProgress, student: { ...course.aiLearningProgress!.student, knowledgeLectureAttempts: [repeated, attempt] } } }} />);
    fireEvent.click(screen.getByRole("button", { name: "我的作答" }));
    expect(screen.getByRole("region", { name: "我的作答记录" })).toHaveTextContent("只改变一个变量");
    expect(screen.queryByText("其他同学答案")).toBeNull();
    expect(screen.queryByText("重做的答案")).toBeNull();
    expect(screen.getByText("控制变量法")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "AI 讲题 · 第 1 题" }));
    expect(screen.getByRole("dialog", { name: "AI 讲题" })).toHaveAttribute("data-readonly", "true");
  });

  it("ignores attempts saved for a different lesson version", () => {
    render(<StudentClassroomFinishedState course={{ ...course, aiLearningClassroomId: "different-lesson" }} />);
    fireEvent.click(screen.getByRole("button", { name: "我的作答" }));
    expect(screen.getByText(/本次课堂没有保存小测作答记录/)).toBeVisible();
    expect(screen.queryByText("只改变一个变量")).toBeNull();
  });

  it("returns to the platform course review through a validated participation id", async () => {
    window.history.replaceState(null, "", "/student/classroom/course?returnParticipationId=participation-one&returnTo=https://example.org");
    render(<StudentClassroomFinishedState course={course} />);
    expect(await screen.findByRole("link", { name: "返回课堂回顾" })).toHaveAttribute("href", "/student/participations/participation-one");
    expect(screen.getByRole("region", { name: "AI 课程回看" })).toHaveTextContent("复习课件：lesson");
  });

  it.each(["https://example.org", "../other", "a".repeat(161), ""])("does not turn invalid return context into navigation: %s", async value => {
    window.history.replaceState(null, "", `/student/classroom/course?returnParticipationId=${encodeURIComponent(value)}`);
    const view = render(<StudentClassroomFinishedState course={course} />);
    await screen.findByRole("link", { name: "返回课堂活动" });
    expect(screen.queryByRole("link", { name: "返回课堂回顾" })).toBeNull();
    view.unmount();
  });
});
