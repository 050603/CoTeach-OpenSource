import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizQuestion, Scene } from "@openmaic/lib/types/stage";
import type { Course, KnowledgeLectureQuestionReview } from "@/lib/session/types";
import { authoredQuestionFingerprint, knowledgeTutorEvidence } from "@/lib/courses/knowledge-tutor-evidence";
import { useKnowledgeReviewResources } from "@/hooks/use-knowledge-review-resources";
import { buildTeacherQuestionReview, type TeacherQuestionReviewRow } from "@/lib/classroom/teacher-question-review";
import { TeacherQuestionReview, TeacherQuestionReviewContent } from "./teacher-question-review";

let resources: { ready: boolean; scenes: Scene[]; error?: string; retry: ReturnType<typeof vi.fn<() => void>> };
vi.mock("@/hooks/use-knowledge-review-resources", () => ({ useKnowledgeReviewResources: vi.fn(() => resources) }));
const choice: QuizQuestion = {
  id: "q1", type: "single", format: "single_choice", question: "依据观察记录选择解释", options: [{ value: "A", label: "保持不变" }, { value: "B", label: "发生变化" }],
  answer: ["B"], analysis: "标准解析：记录表明发生变化。", points: 10, knowledgePointIds: ["kp"],
};

function makeCourse(questions: QuizQuestion[] = [choice, { ...choice, id: "q2", question: "依据第二份记录选择解释" }]): Course {
  const content = { knowledgePoints: [{ id: "kp", name: "证据判断" }],
    knowledgeLectureSections: [{ id: "section", title: "第一节 · 观察证据", order: 0, quizOutlineId: "quiz", knowledgePointIds: ["kp"], maxScore: 20 }] } as unknown as Course["content"];
  resources.scenes = [{ id: "scene", outlineId: "quiz", type: "quiz", content: { type: "quiz", questions } }] as Scene[];
  return {
    id: "course", aiLearningClassroomId: "classroom", students: [{ id: "s1", name: "学生姓名" }], content,
    aiLearningProgress: { s1: { classroomId: "classroom", knowledgeLectureAttempts: [{ id: "attempt", quizOutlineId: "quiz", runtimeSceneId: "scene",
      sectionId: "section", submittedAt: "2026-10-23T00:00:00Z", gradingSource: "server", knowledgePointIds: ["kp"],
      questions: questions.map((question): KnowledgeLectureQuestionReview => ({
        questionId: question.id, prompt: question.question, questionType: question.type, questionFormat: question.format,
        options: question.options, matchingOptions: question.matchingPairs ? { left: question.matchingPairs.map((pair) => pair.left), right: question.matchingPairs.map((pair) => pair.right) } : undefined,
        answer: "A", rawAnswer: "A", correct: question.type === "short_answer" ? null : false, points: 10, earned: 0,
        gradingStatus: "graded", feedback: "评分反馈说明", authoredAnalysis: "保存的旧解析", referenceAnswer: "保存的参考说明", knowledgePointIds: ["kp"],
        authoredQuestionFingerprint: authoredQuestionFingerprint(question, knowledgeTutorEvidence(content, ["kp"])),
      })) }] } },
  } as unknown as Course;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  resources = { ready: true, scenes: [], retry: vi.fn() };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TeacherQuestionReview", () => {
  it("reports the active stable question ID without repeating for disclosure, callback identity or live grades", async () => {
    const course = makeCourse();
    const rows = buildTeacherQuestionReview(course).rows;
    const onQuestionChange = vi.fn();
    const view = render(<TeacherQuestionReviewContent active={false} simplified course={course} resources={resources} rows={rows} onQuestionChange={onQuestionChange} />);
    expect(onQuestionChange).not.toHaveBeenCalled();
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={rows} onQuestionChange={onQuestionChange} />);
    expect(onQuestionChange.mock.calls).toEqual([[rows[0].id]]);
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={rows.map((row) => ({ ...row, gradedCount: 2 }))} onQuestionChange={(id) => onQuestionChange(id)} />);
    expect(onQuestionChange.mock.calls).toEqual([[rows[0].id]]);
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(onQuestionChange.mock.calls).toEqual([[rows[0].id], [rows[1].id]]);
    view.rerender(<TeacherQuestionReviewContent active={false} simplified course={course} resources={resources} rows={rows} onQuestionChange={onQuestionChange} />);
    expect(onQuestionChange).toHaveBeenCalledTimes(2);
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={rows} onQuestionChange={onQuestionChange} />);
    expect(onQuestionChange.mock.calls).toEqual([[rows[0].id], [rows[1].id], [rows[1].id]]);
    await act(async () => {});
  });

  it("shows an unsubmitted authored question and reveals its real answer without inventing a submission", async () => {
    const course = makeCourse([choice]);
    const template = buildTeacherQuestionReview(course).rows[0];
    const authored: TeacherQuestionReviewRow = { ...template, id: "current-original", authoredSource: choice, sourceStatus: "current", answers: [],
      submittedCount: 0, gradedCount: 0, incorrectCount: 0, correctCount: 0, pendingCount: 0, failedCount: 0, unverifiedCount: 0, accuracy: undefined, scoreRate: undefined };
    delete course.aiLearningProgress;
    render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={[authored]} scope={{ sectionId: "section" }} />);
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("未作答");
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("已提交 0 人");
    expect(screen.getAllByText("0 人 · 0%")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "查看原始作答" })).not.toBeInTheDocument();
    expect(screen.queryByText("保存的参考说明")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    expect(screen.getByText("B. 发生变化")).toBeInTheDocument();
    expect(screen.getByText(choice.analysis!)).toBeInTheDocument();
    expect(screen.queryByText(/无法核验标准答案/)).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("restores question selection and disclosure state separately for each chapter", async () => {
    const course = makeCourse();
    const rows = buildTeacherQuestionReview(course).rows;
    const other = { ...rows[0], id: "other-chapter", sectionId: "other", sectionTitle: "第二章", snapshot: { ...rows[0].snapshot, prompt: "另一章原题" } };
    const catalog = [...rows, other];
    const onKnowledgePoint = vi.fn();
    const view = render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={catalog} scope={{ sectionId: "section" }} onKnowledgePoint={onKnowledgePoint} />);
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    fireEvent.click(screen.getByRole("button", { name: "查看原始作答" }));
    await screen.findByText(choice.analysis!);
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={catalog} scope={{ sectionId: "other" }} onKnowledgePoint={onKnowledgePoint} />);
    expect(screen.getByRole("heading", { name: "另一章原题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示答案与解析" })).toHaveAttribute("aria-expanded", "false");
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={catalog} scope={{ sectionId: "section" }} onKnowledgePoint={onKnowledgePoint} />);
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "收起原始作答" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "补讲知识点：证据判断" }));
    expect(onKnowledgePoint).toHaveBeenCalledWith("kp");
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    expect(screen.getByRole("button", { name: "显示答案与解析" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "查看原始作答" })).toHaveAttribute("aria-expanded", "false");
    await act(async () => {});
  });

  it("focuses a stable historical row version once and keeps later live updates on the chosen question", async () => {
    const course = makeCourse([choice]);
    const template = buildTeacherQuestionReview(course).rows[0];
    const current: TeacherQuestionReviewRow = { ...template, id: "current-version", sourceStatus: "verified", authoredSource: choice };
    const historical: TeacherQuestionReviewRow = { ...template, id: "historical-version", sourceStatus: "mismatch" };
    const rows = [current, historical];
    const focus = { sequence: 1, questionId: historical.id };
    const view = render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={rows} scope={{ sectionId: "section" }} focus={focus} />);
    expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toHaveValue(historical.id);
    expect(screen.getByRole("option", { name: /历史版本/ })).toHaveValue(historical.id);
    expect(screen.getByText(/原题或采用的资料已更新/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    expect(screen.getByText("保存的参考说明")).toBeInTheDocument();
    expect(screen.queryByText(choice.analysis!)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toHaveValue(current.id);
    expect(screen.getByRole("button", { name: "显示答案与解析" })).toHaveAttribute("aria-expanded", "false");
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={[{ ...current, gradedCount: 2 }, historical]} scope={{ sectionId: "section" }} focus={focus} />);
    expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toHaveValue(current.id);
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} rows={rows} scope={{ sectionId: "section" }} focus={{ ...focus, sequence: 2 }} />);
    expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toHaveValue(historical.id);
    await act(async () => {});
  });

  it("keeps the only related-courseware action above a long single question without adding a selector", async () => {
    const prompt = "阅读以下完整观察记录并说明各项证据的含义。".repeat(80);
    const course = makeCourse([{ ...choice, question: prompt }]);
    const onCourseware = vi.fn();
    render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} scope={{ sectionId: "section" }} onCourseware={onCourseware} />);
    const action = screen.getByRole("button", { name: "查看相关课件" });
    const heading = screen.getByRole("heading", { name: prompt });
    expect(action.closest("header")).not.toBeNull();
    expect(action.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "查看相关课件" })).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: "选择讲解题目" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("第 1 题 · 单选题");
    expect(screen.queryByText("第一节 · 观察证据 · 第 1 题")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "答案与解析" })).queryByRole("button", { name: "查看相关课件" })).not.toBeInTheDocument();
    fireEvent.click(action);
    expect(onCourseware).toHaveBeenCalledWith(["kp"]);
    await act(async () => {});
  });

  it.each([["kp", "kp2"], []])("offers one related-courseware action with the selected question's exact point IDs %j", async (...pointIds) => {
    const course = makeCourse([choice]);
    course.content.knowledgePoints.push({ id: "kp2", name: "第二知识点" } as Course["content"]["knowledgePoints"][number]);
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].knowledgePointIds = pointIds;
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].knowledgePointIds = [];
    const onCourseware = vi.fn();
    const onKnowledgePoint = vi.fn();
    render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} scope={{ sectionId: "section" }} onCourseware={onCourseware} onKnowledgePoint={onKnowledgePoint} />);
    expect(screen.queryByRole("button", { name: /查看知识点课件/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "查看相关课件" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "查看相关课件" }));
    expect(onCourseware).toHaveBeenCalledWith(pointIds);
    expect(onKnowledgePoint).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("simplifies the controls and pages through every submitted question without skipping correct answers", async () => {
    const course = makeCourse([choice, { ...choice, id: "q2", question: "第二题已答对" }, { ...choice, id: "q3", question: "第三题需讲解" }]);
    const answer = course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[1];
    answer.correct = true; answer.earned = 10;
    render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} scope={{ sectionId: "section" }} />);
    const root = screen.getByRole("region", { name: "题目讲解" });
    const scrollIntoView = vi.fn();
    Object.defineProperty(root, "scrollIntoView", { configurable: true, value: scrollIntoView });
    expect(screen.queryByRole("group", { name: "讲解题目范围" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: /第二题已答对/ })).not.toHaveTextContent("第一节 · 观察证据");
    expect(screen.getByRole("option", { name: /第二题已答对/ })).toHaveTextContent(/^第 2 题 · 第二题已答对$/);
    expect(screen.getByRole("option", { name: /第三题需讲解/ })).toHaveTextContent(/^第 3 题 · 第三题需讲解$/);
    expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(screen.getByRole("heading", { name: "第二题已答对" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "第 2 题，共 3 题" })).toHaveTextContent("2 / 3");
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByRole("heading", { name: "第三题需讲解" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "第 3 题，共 3 题" })).toHaveTextContent("3 / 3");
    fireEvent.change(screen.getByRole("combobox", { name: "选择讲解题目" }), { target: { value: (screen.getByRole("option", { name: /第二题已答对/ }) as HTMLOptionElement).value } });
    expect(screen.getByRole("heading", { name: "第二题已答对" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    await act(async () => {});
  });

  it("chooses the current first wrong question when a previously hidden simplified view is first opened", async () => {
    const course = makeCourse();
    const { rerender } = render(<TeacherQuestionReviewContent active={false} simplified course={course} resources={resources} scope={{ sectionId: "section" }} />);
    const updated = structuredClone(course);
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].correct = true;
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].earned = 10;
    rerender(<TeacherQuestionReviewContent active simplified course={updated} resources={resources} scope={{ sectionId: "section" }} />);
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一题" })).toBeEnabled();
    await act(async () => {});
  });

  it("does not pin a question during hidden scope changes before the first opening", async () => {
    const course = makeCourse();
    const { rerender } = render(<TeacherQuestionReviewContent active={false} simplified course={course} resources={resources} scope={{ sectionId: "missing" }} />);
    rerender(<TeacherQuestionReviewContent active={false} simplified course={course} resources={resources} scope={{ sectionId: "section" }} />);
    const updated = structuredClone(course);
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].correct = true;
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].earned = 10;
    rerender(<TeacherQuestionReviewContent active={false} simplified course={updated} resources={resources} scope={{ sectionId: "section" }} />);
    rerender(<TeacherQuestionReviewContent active simplified course={updated} resources={resources} scope={{ sectionId: "section" }} />);
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示答案与解析" })).toHaveAttribute("aria-expanded", "false");
    await act(async () => {});
  });

  it("keeps a simplified selected question and revealed answer when live grading removes it from the wrong questions", async () => {
    const course = makeCourse();
    const { rerender } = render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} scope={{ sectionId: "section" }} />);
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText("标准解析：记录表明发生变化。");
    const updated = structuredClone(course);
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].correct = true;
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].earned = 10;
    rerender(<TeacherQuestionReviewContent active={false} simplified course={updated} resources={resources} scope={{ sectionId: "section" }} />);
    rerender(<TeacherQuestionReviewContent active simplified course={updated} resources={resources} scope={{ sectionId: "section" }} />);
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
  });

  it("shows compact valid-grade statistics and keeps raw feedback behind the answer reveal", async () => {
    const course = makeCourse([choice]);
    for (const id of ["s2", "s3", "s4", "s5"]) {
      course.students.push({ id, name: id, joinedAt: "", stageProgress: {} });
      course.aiLearningProgress![id] = structuredClone(course.aiLearningProgress!.s1);
    }
    const correct = course.aiLearningProgress!.s2.knowledgeLectureAttempts![0].questions[0];
    correct.correct = true; correct.earned = 10;
    course.aiLearningProgress!.s3.knowledgeLectureAttempts![0].questions[0].gradingStatus = "pending";
    course.aiLearningProgress!.s4.knowledgeLectureAttempts![0].questions[0].gradingStatus = "failed";
    delete course.aiLearningProgress!.s5.knowledgeLectureAttempts![0].gradingSource;
    render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} scope={{ sectionId: "section" }} />);
    expect(screen.queryByRole("combobox", { name: "选择讲解题目" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "本题作答情况" })).not.toBeInTheDocument();
    const summary = screen.getByLabelText("本题作答情况");
    expect(summary).toHaveTextContent("答错 1/2 人");
    expect(summary).toHaveTextContent("正确率 50%");
    expect(summary).toHaveTextContent("待评 1 人");
    expect(summary).toHaveTextContent("评分失败 1 人");
    expect(summary).toHaveTextContent("待核验 1 人");
    expect(screen.queryByRole("heading", { name: "本题作答情况" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看原始作答" }));
    expect(screen.queryByText("评分反馈说明")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText("标准解析：记录表明发生变化。");
    expect(screen.getAllByText("评分反馈说明")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "收起原始作答" })).toHaveAttribute("aria-expanded", "true");
  });

  it("falls back to submitted questions when there are no wrong grades without implying pending answers are correct", async () => {
    const course = makeCourse([choice]);
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].gradingStatus = "pending";
    const view = render(<TeacherQuestionReviewContent active simplified course={course} resources={resources} scope={{ sectionId: "section" }} />);
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("暂无有效评分");
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("待评 1 人");
    expect(screen.getByLabelText("本题作答情况")).not.toHaveTextContent("答错");
    expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一题" })).toBeDisabled();
    view.rerender(<TeacherQuestionReviewContent active simplified course={course} resources={resources} scope={{ sectionId: "missing" }} />);
    expect(screen.getByRole("heading", { name: "当前章节暂无作答题目" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看全部作答题目" })).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("embeds the shared question content with an inline selector and no extra resource request", async () => {
    const course = makeCourse();
    vi.mocked(useKnowledgeReviewResources).mockClear();
    render(<TeacherQuestionReviewContent active course={course} resources={resources} scope={{ sectionId: "section" }} />);
    expect(useKnowledgeReviewResources).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "返回班级学情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择题目" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "题目讲解" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "选择讲解题目" }), { target: { value: (screen.getAllByRole("option")[1] as HTMLOptionElement).value } });
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText("标准解析：记录表明发生变化。");
  });

  it("keeps the selected question and reveal state when returning from its knowledge-point slides or receiving a corrected grade", async () => {
    const course = makeCourse();
    const onKnowledgePoint = vi.fn();
    const { rerender } = render(<TeacherQuestionReviewContent active course={course} resources={resources} scope={{ pointId: "kp" }} onKnowledgePoint={onKnowledgePoint} />);
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText("标准解析：记录表明发生变化。");
    fireEvent.click(screen.getByRole("button", { name: "查看知识点课件：证据判断" }));
    expect(onKnowledgePoint).toHaveBeenCalledWith("kp");
    rerender(<TeacherQuestionReviewContent active={false} course={course} resources={resources} scope={{ pointId: "kp" }} onKnowledgePoint={onKnowledgePoint} />);
    const updated = structuredClone(course);
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[1].correct = true;
    updated.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[1].earned = 10;
    rerender(<TeacherQuestionReviewContent active course={updated} resources={resources} scope={{ pointId: "kp" }} onKnowledgePoint={onKnowledgePoint} />);
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toHaveValue((screen.getAllByRole("option")[1] as HTMLOptionElement).value);
    expect(screen.getByText("本题已提交 1 人 · 已评分 1 人")).toBeInTheDocument();
  });

  it("resets to the first scoped question on directory changes and keeps all-question fallback inside that scope", async () => {
    const course = makeCourse();
    const { rerender } = render(<TeacherQuestionReviewContent active course={course} resources={resources} scope={{ pointId: "kp" }} />);
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    rerender(<TeacherQuestionReviewContent active course={course} resources={resources} scope={{ sectionId: "section" }} />);
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示答案与解析" })).toHaveAttribute("aria-expanded", "false");
    rerender(<TeacherQuestionReviewContent active course={course} resources={resources} scope={{ pointId: "missing" }} />);
    expect(screen.getByRole("heading", { name: "当前范围暂无错题" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "查看全部作答题目" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /全部题目/ }));
    expect(screen.getByRole("heading", { name: "当前范围暂无作答题目" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: choice.question })).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("keeps the question navigation bounded and announces the current question", async () => {
    const course = makeCourse();
    const onBack = vi.fn();
    const { rerender } = render(<TeacherQuestionReview active course={course} onBack={onBack} />);
    const navigation = screen.getByRole("navigation", { name: "讲解题目翻页" });
    expect(within(navigation).getByRole("button", { name: "上一题" })).toBeDisabled();
    expect(within(navigation).getByRole("status", { name: "第 1 题，共 2 题" })).toHaveTextContent("1 / 2");
    fireEvent.click(within(navigation).getByRole("button", { name: "下一题" }));
    expect(within(navigation).getByRole("button", { name: "下一题" })).toBeDisabled();
    expect(within(navigation).getByRole("status", { name: "第 2 题，共 2 题" })).toHaveTextContent("2 / 2");
    fireEvent.click(within(navigation).getByRole("button", { name: "上一题" }));
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    rerender(<TeacherQuestionReview active={false} course={course} onBack={onBack} />);
    expect(screen.queryByRole("navigation", { name: "讲解题目翻页" })).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("starts with one wrong question and reveals verified answers only on request, hiding them on the next question", async () => {
    const course = makeCourse();
    render(<TeacherQuestionReview active course={course} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    expect(screen.queryByText("标准解析：记录表明发生变化。")).not.toBeInTheDocument();
    expect(screen.queryByText("正确选项")).not.toBeInTheDocument();
    expect(screen.queryByText("学生姓名")).not.toBeInTheDocument();
    expect(screen.queryByText("评分反馈说明")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText("标准解析：记录表明发生变化。");
    expect(screen.getByText("正确选项")).toBeInTheDocument();
    expect(screen.getByText("B. 发生变化")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    expect(screen.queryByText("正确选项")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示答案与解析" })).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves the selected question and reveal state while hidden, resized by its parent, or receiving new statistics", async () => {
    const course = makeCourse();
    const onBack = vi.fn();
    const { rerender } = render(<TeacherQuestionReview active course={course} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText("标准解析：记录表明发生变化。");
    rerender(<TeacherQuestionReview active={false} course={course} onBack={onBack} />);
    expect(screen.queryByRole("region", { name: "题目讲解" })).not.toBeInTheDocument();
    const updated = structuredClone(course);
    updated.students.push({ id: "s2", name: "新学生", joinedAt: "", stageProgress: {} });
    updated.aiLearningProgress!.s2 = structuredClone(updated.aiLearningProgress!.s1);
    rerender(<TeacherQuestionReview active course={updated} onBack={onBack} />);
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("本题已提交 2 人 · 已评分 2 人")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回班级学情" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("scrolls user-selected questions into view without resetting reading position on parent or live-data updates", async () => {
    const course = makeCourse();
    const onBack = vi.fn();
    const { rerender } = render(<TeacherQuestionReview active course={course} onBack={onBack} />);
    const context = screen.getByText("第一节 · 观察证据 · 第 1 题").parentElement!;
    const scrollIntoView = vi.fn();
    Object.defineProperty(context, "scrollIntoView", { configurable: true, value: scrollIntoView });
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" }));
    expect(context).toHaveTextContent("第 2 题");
    scrollIntoView.mockClear();

    rerender(<TeacherQuestionReview active={false} course={course} onBack={onBack} />);
    rerender(<TeacherQuestionReview active course={course} onBack={onBack} />);
    const updated = structuredClone(course);
    updated.students.push({ id: "s2", name: "新学生", joinedAt: "", stageProgress: {} });
    updated.aiLearningProgress!.s2 = structuredClone(updated.aiLearningProgress!.s1);
    rerender(<TeacherQuestionReview active course={updated} onBack={onBack} />);
    await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "选择题目" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /依据观察记录选择解释/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" }));
    expect(context).toHaveTextContent("第 1 题");
  });

  it("uses the drawer for knowledge/section summaries and returns focus to its entry", async () => {
    render(<TeacherQuestionReview active course={makeCourse()} onBack={vi.fn()} />);
    const entry = screen.getByRole("button", { name: "选择题目" });
    fireEvent.click(entry);
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("各小节测验情况")).toBeInTheDocument();
    expect(within(drawer).getByText("知识点未达标率排名")).toBeInTheDocument();
    expect(within(drawer).getByText("已提交 1/1 人 · 完成率 100%")).toBeInTheDocument();
    expect(within(drawer).getByText("均分 0/20 分")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: /依据第二份记录选择解释/ }));
    expect(screen.getByRole("heading", { name: "依据第二份记录选择解释" })).toBeInTheDocument();
    await waitFor(() => expect(entry).toHaveFocus());
  });

  it("shows pending questions only in all questions and never marks them as wrong", async () => {
    const course = makeCourse([choice]);
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].gradingStatus = "pending";
    render(<TeacherQuestionReview active course={course} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "当前范围暂无错题" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /全部题目/ }));
    expect(screen.getByRole("heading", { name: choice.question })).toBeInTheDocument();
    expect(screen.getByText(/待评 1 人，不计入错误人数/)).toBeInTheDocument();
    expect(screen.getByText("本题暂无有效评分。")).toBeInTheDocument();
    await act(async () => {});
  });

  it.each(["missing", "changed", "failed", "no-classroom"])("retains the submitted snapshot when the source is %s", async (mode) => {
    const course = makeCourse([choice]);
    if (mode === "missing") delete course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].authoredQuestionFingerprint;
    if (mode === "changed" && resources.scenes[0].content.type === "quiz") resources.scenes[0].content.questions = [{ ...choice, answer: ["A"] }];
    if (mode === "failed") { resources.scenes = []; resources.error = "网络错误"; }
    if (mode === "no-classroom") { delete course.aiLearningClassroomId; resources.ready = false; resources.scenes = []; }
    render(<TeacherQuestionReview active course={course} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    expect(screen.getByText("保存的参考说明")).toBeInTheDocument();
    expect(screen.getByText("保存的旧解析")).toBeInTheDocument();
    if (mode === "changed") await screen.findByText(/原题或采用的资料已更新/);
    if (mode === "missing") await screen.findByText(/历史作答未保存原题版本/);
    if (mode === "no-classroom") await screen.findByText(/未找到这份作答对应的原题/);
    if (mode === "failed") { fireEvent.click(screen.getByRole("button", { name: "重试加载原题" })); expect(resources.retry).toHaveBeenCalledOnce(); }
    expect(screen.queryByText("正确选项")).not.toBeInTheDocument();
    expect(screen.queryByText("标准解析：记录表明发生变化。")).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("presents multiple-choice distributions without exposing the correct set until requested", async () => {
    const question = { ...choice, type: "multiple" as const, format: "multiple_choice" as const, answer: ["A", "B"] };
    const course = makeCourse([question]);
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].rawAnswer = ["A", "B"];
    render(<TeacherQuestionReview active course={course} onBack={vi.fn()} />);
    expect(screen.getAllByText("1 人 · 100%")).toHaveLength(2);
    expect(screen.getByText(/各项占比之和可能超过 100%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await waitFor(() => expect(screen.getAllByText("正确选项")).toHaveLength(2));
  });

  it("distinguishes legacy unmappable option text from actual blank answers", async () => {
    const course = makeCourse([choice]);
    const question = course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0];
    delete question.rawAnswer;
    question.answer = "A：保持不变";
    course.students.push({ id: "s2", name: "学生二", joinedAt: "", stageProgress: {} });
    course.aiLearningProgress!.s2 = structuredClone(course.aiLearningProgress!.s1);
    course.aiLearningProgress!.s2.knowledgeLectureAttempts![0].questions[0].answer = "";
    render(<TeacherQuestionReview active course={course} onBack={vi.fn()} />);
    expect(screen.getByText(/1 份已评分记录含无法匹配原选项的提交值/)).toBeInTheDocument();
    expect(screen.getByText("另有 1 份已评分的空白作答。")).toBeInTheDocument();
    expect(screen.getAllByText("0 人 · 0%")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "查看原始作答" }));
    expect(screen.getByText("A：保持不变")).toBeInTheDocument();
    expect(screen.getByText("未填写答案")).toBeInTheDocument();
    await act(async () => {});
  });

  it("renders matching candidates, real relationships and revealed canonical pairs", async () => {
    const question: QuizQuestion = { id: "matching", type: "matching", format: "matching", question: "为动作匹配含义", points: 10, knowledgePointIds: ["kp"],
      matchingPairs: [{ leftId: "L1", left: "输入", rightId: "R1", right: "接收数据" }, { leftId: "L2", left: "输出", rightId: "R2", right: "呈现结果" }],
      answer: ["L1:R1", "L2:R2"], analysis: "输入接收数据，输出呈现结果。" };
    const course = makeCourse([question]);
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].rawAnswer = ["L1:R2", "L2:R1"];
    render(<TeacherQuestionReview active course={course} onBack={vi.fn()} />);
    expect(screen.getByLabelText("原题匹配项")).toBeInTheDocument();
    await screen.findByText("输入 → 呈现结果；输出 → 接收数据");
    expect(screen.queryByRole("heading", { name: "正确答案" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    expect(screen.getByText(/输入 → 接收数据/)).toBeInTheDocument();
    expect(screen.getByText("输入接收数据，输出呈现结果。")).toBeInTheDocument();
  });

  it.each(["fill_blank", "short_answer", "scenario_task"] as const)("shows saved %s text, source reference and analysis with math", async (format) => {
    const question: QuizQuestion = { id: "text", type: "short_answer", format, question: "解释公式 $x^2$", referenceAnswer: "标准参考答案", analysis: "标准题目解析", points: 10, knowledgePointIds: ["kp"] };
    const course = makeCourse([question]);
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].answer = "我的原始回答";
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].rawAnswer = "我的原始回答";
    const { container } = render(<TeacherQuestionReview active course={course} onBack={vi.fn()} />);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(screen.getByText("未达标人数")).toBeInTheDocument();
    expect(screen.queryByText("标准参考答案")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText("标准参考答案");
    expect(screen.getByText("标准题目解析")).toBeInTheDocument();
  });
});
