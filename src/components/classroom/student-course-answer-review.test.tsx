import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course, KnowledgeLectureAttempt } from "@/lib/session/types";
import { StudentCourseAnswerReview } from "./student-course-answer-review";

const board = vi.hoisted(() => ({ props: undefined as undefined | Record<string, unknown> }));
vi.mock("@/components/views/student/knowledge-lecture-board", () => ({
  KnowledgeLectureBoard: (props: Record<string, unknown>) => {
    board.props = props;
    return <div role="dialog" aria-label="AI 讲题"><button onClick={props.onClose as () => void} type="button">关闭讲题</button></div>;
  },
}));

const attempt: KnowledgeLectureAttempt = {
  id: "first", sectionId: "section-one", quizOutlineId: "quiz-one", runtimeSceneId: "scene-one", submittedAt: "2026-10-01T08:00:00Z",
  score: 0, maxScore: 10, knowledgePointIds: ["point"],
  questions: [{ questionId: "question-one", prompt: "如何控制实验条件？", answer: "只改变一个变量", points: 10, earned: 0,
    correct: null, gradingStatus: "pending", feedback: "保留其他条件一致", authoredAnalysis: "用控制变量法进行公平比较。", referenceAnswer: "比较前确保其他条件相同。", knowledgePointIds: ["point"] }],
};
const course = {
  id: "course", name: "观察课堂", status: "finished", aiLearningClassroomId: "lesson",
  content: { knowledgePoints: [{ id: "point", name: "控制变量" }], knowledgeLectureSections: [
    { id: "section-one", title: "第一节 · 公平实验" }, { id: "section-two", title: "第二节 · 数据证据" },
  ] },
  aiLearningProgress: { student: { classroomId: "lesson", knowledgeLectureAttempts: [attempt] },
    other: { classroomId: "lesson", knowledgeLectureAttempts: [{ ...attempt, id: "other", questions: [{ ...attempt.questions[0], answer: "其他同学的答案" }] }] } },
} as unknown as Course;

afterEach(() => { cleanup(); board.props = undefined; });

describe("saved student course answers", () => {
  it("lets a teacher inspect original answers without opening student AI endpoints", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<StudentCourseAnswerReview course={course} studentId="student" role="teacher" />);
    expect(screen.getByRole("region", { name: "学生作答记录" })).toHaveTextContent("只改变一个变量");
    expect(screen.getByText("保留其他条件一致")).toBeVisible();
    expect(screen.queryByRole("button", { name: /AI 讲题/ })).not.toBeInTheDocument();
    expect(board.props).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("shows only the student's original first answers with authored analysis and feedback", () => {
    const repeated = { ...attempt, id: "repeat", submittedAt: "2026-10-02T08:00:00Z", questions: [{ ...attempt.questions[0], answer: "后来的答案" }] };
    render(<StudentCourseAnswerReview course={{ ...course, aiLearningProgress: { ...course.aiLearningProgress,
      student: { ...course.aiLearningProgress!.student, knowledgeLectureAttempts: [repeated, attempt] } } }} studentId="student" />);
    expect(screen.getByText("只改变一个变量")).toBeVisible();
    expect(screen.getByText("保留其他条件一致")).toBeVisible();
    expect(screen.getByText(/用控制变量法进行公平比较/)).toBeVisible();
    expect(screen.queryByText("其他同学的答案")).toBeNull();
    expect(screen.queryByText("后来的答案")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/得分|正确率|待完成批阅|0\s*\/\s*10/)).toBeNull();
  });

  it("orders and selects sections instead of expanding the full course into a long answer page", () => {
    const second = { ...attempt, id: "second", sectionId: "section-two", quizOutlineId: "quiz-two", questions: [
      { ...attempt.questions[0], questionId: "second-one", prompt: "记录哪些证据？", answer: "观察结果" },
      { ...attempt.questions[0], questionId: "second-two", prompt: "如何检查证据？", answer: "重复实验" },
    ] };
    render(<StudentCourseAnswerReview course={{ ...course, aiLearningProgress: { student: { ...course.aiLearningProgress!.student,
      knowledgeLectureAttempts: [second, attempt] } } }} studentId="student" />);
    expect(screen.getByRole("heading", { name: "第一节 · 公平实验" })).toBeVisible();
    expect(screen.queryByText("观察结果")).toBeNull();
    fireEvent.click(within(screen.getByRole("navigation", { name: "作答小节" })).getByRole("button", { name: /第二节 · 数据证据/ }));
    expect(screen.getByRole("heading", { name: "第二节 · 数据证据" })).toBeVisible();
    expect(screen.getByText("观察结果")).toBeVisible();
    expect(screen.getByText("重复实验")).not.toBeVisible();
    fireEvent.click(screen.getAllByText("如何检查证据？")[0].closest("summary")!);
    expect(screen.getByText("重复实验")).toBeVisible();
    expect(screen.queryByText("只改变一个变量")).toBeNull();
  });

  it("preserves original option labels and matching columns and opens the matching read-only explanation", () => {
    const questions: KnowledgeLectureAttempt["questions"] = [
      { ...attempt.questions[0], answer: "B", rawAnswer: "B", options: [{ value: "A", label: "改变所有条件" }, { value: "B", label: "只改变一个条件" }] },
      { ...attempt.questions[0], questionId: "matching", prompt: "将变量与作用配对。", answer: "L1:R2、L2:R1", rawAnswer: ["L1:R2", "L2:R1"],
        matchingOptions: { left: ["自变量", "因变量"], right: ["观察结果", "主动改变"] } },
    ];
    render(<StudentCourseAnswerReview course={{ ...course, aiLearningProgress: { student: { ...course.aiLearningProgress!.student,
      knowledgeLectureAttempts: [{ ...attempt, questions }] } } }} studentId="student" />);
    expect(screen.getByText("B. 只改变一个条件")).toBeVisible();
    expect(screen.getByText("当时选择")).toBeVisible();
    fireEvent.click(screen.getAllByText("将变量与作用配对。")[0].closest("summary")!);
    expect(screen.getByText("自变量")).toBeVisible();
    expect(screen.getByText("主动改变")).toBeVisible();
    expect(screen.getByText("L1:R2、L2:R1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "AI 讲题 · 第 2 题" }));
    expect(screen.getByRole("dialog", { name: "AI 讲题" })).toBeVisible();
    expect(board.props).toMatchObject({ courseId: "course", studentId: "student", readOnly: true, initialQuestionId: "matching", attempt: { id: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭讲题" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["different-version", "missing-student", "missing-classroom"])("does not show answers outside the owned lesson context: %s", condition => {
    render(<StudentCourseAnswerReview course={{ ...course, ...(condition === "different-version" ? { aiLearningClassroomId: "new-lesson" }
      : condition === "missing-classroom" ? { aiLearningClassroomId: undefined } : {}) }} studentId={condition === "missing-student" ? "unrecorded-student" : "student"} />);
    expect(screen.getByRole("heading", { name: "还没有保存的作答记录" })).toBeVisible();
    expect(screen.queryByText("只改变一个变量")).toBeNull();
    expect(screen.queryByRole("button", { name: /AI 讲题/ })).toBeNull();
  });

  it("keeps an unanswered saved question explicit and clears the old student's open explanation on identity changes", () => {
    const unanswered = { ...attempt, questions: [{ ...attempt.questions[0], answer: "", rawAnswer: "" }] };
    const view = render(<StudentCourseAnswerReview course={{ ...course, aiLearningProgress: { student: { ...course.aiLearningProgress!.student,
      knowledgeLectureAttempts: [unanswered] } } }} studentId="student" />);
    expect(screen.getAllByText("当时未作答").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "AI 讲题 · 第 1 题" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(<StudentCourseAnswerReview course={course} studentId="other" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("其他同学的答案")).toBeVisible();
  });
});
