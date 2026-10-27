import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { knowledgeRecommendations, knowledgeReviewCommonIssues } from "@/lib/classroom/knowledge-review";
import { TeacherKnowledgeAnalytics, TeacherPresentationAnalytics } from "./teacher-presentation-analytics";
import { knowledgeMountainCurve } from "./knowledge-learning-mountain";
import { deriveTeacherClassroomPulse } from "./teacher-classroom-pulse";

function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: "course-1", name: "测试课堂", subject: "综合实践", grade: "七年级", hours: 2,
    summary: "", drivingQuestion: "", status: "teaching", stages: [], currentStageIndex: 0,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: {} },
    students: [{ id: "s1", name: "隐藏姓名小明" }, { id: "s2", name: "隐藏姓名小华" }],
    resources: [{ id: "r1", title: "项目说明", type: "PDF", size: "1 MB", stageKey: "launch", downloadedBy: ["s1"] }],
    ...overrides,
  } as Course;
}

describe("TeacherPresentationAnalytics", () => {
  it.each([
    ["launch", "资料阅读覆盖", "已完成0、阅读中1、未打开1"],
    ["make", "AI 协作汇总", "已提交0、编制中0、待形成2"],
    ["showcase", "汇报安排", "已汇报0、进行中0、等待中0、未就绪2"],
  ])("shows aggregate-only %s data and lets the teacher explicitly open details", (stageKey, title, distribution) => {
    const onDetails = vi.fn();
    const { container } = render(<TeacherPresentationAnalytics course={makeCourse()} stageKey={stageKey} onDetails={onDetails} />);
    expect(screen.getByRole("region", { name: title })).toBeTruthy();
    expect(screen.getByRole("img", { name: distribution })).toBeTruthy();
    expect(container.textContent).not.toContain("隐藏姓名");
    expect(onDetails).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));
    expect(onDetails).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole("button")[1]!);
    expect(onDetails).toHaveBeenCalledTimes(2);
  });

  it("uses three compact charts for knowledge-learning progress, quiz completion, and average score", () => {
    const students = [
      { id: "s1", name: "小明", joinedAt: "2026-09-16T08:00:00.000Z", stageProgress: {} },
      { id: "s2", name: "小华", joinedAt: "2026-09-16T08:00:00.000Z", stageProgress: {} },
    ];
    const attempt = (sectionId: string, score: number) => ({
      id: `attempt-${sectionId}`, sectionId, quizOutlineId: `quiz-${sectionId}`, runtimeSceneId: `runtime-${sectionId}`,
      submittedAt: "2026-09-16T09:00:00.000Z", score, maxScore: 10, gradingSource: "server" as const, gradingStatus: "graded" as const, knowledgePointIds: [],
      questions: [{ questionId: `q-${sectionId}`, prompt: "问题", answer: "回答", points: 10, earned: score, gradingStatus: "graded" as const, correct: score === 10, feedback: "", knowledgePointIds: [] }],
    });
    const course = makeCourse({
      students,
      content: {
        pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
        knowledgeLectureSections: [
          { id: "section-1", title: "第一节 · 基础概念", order: 0, knowledgePointIds: [], sceneOutlineIds: [], quizOutlineId: "quiz-1", estimatedMinutes: 5 },
          { id: "section-2", title: "第二节 · 综合应用", order: 1, knowledgePointIds: [], sceneOutlineIds: [], quizOutlineId: "quiz-2", estimatedMinutes: 5 },
        ],
      },
      aiLearningProgress: {
        s1: { classroomId: "classroom-1", studentId: "s1", currentSceneIndex: 2, totalScenes: 4, completedScenes: ["scene-1", "scene-2"], completionModelVersion: 2, masteryLevel: "in-progress", lastActiveAt: "2026-09-16T09:00:00.000Z", knowledgeLectureAttempts: [attempt("section-1", 8), attempt("section-2", 6)] },
        s2: { classroomId: "classroom-1", studentId: "s2", currentSceneIndex: 1, totalScenes: 4, completedScenes: ["scene-1"], completionModelVersion: 2, masteryLevel: "in-progress", lastActiveAt: "2026-09-16T09:00:00.000Z", knowledgeLectureAttempts: [attempt("section-1", 10)] },
      },
    });

    const { container } = render(<TeacherPresentationAnalytics course={course} stageKey="ai-learning" onDetails={vi.fn()} />);

    expect(screen.getByRole("img", { name: "班级整体学习进度38%" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "章节测验完成率75%" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "小测累计班级均分12分" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /学习进度分布：.*20–29% 1人.*50–59% 1人/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看全部明细" })).toBeTruthy();
    expect(container.textContent).toContain("小明");
    expect(container.textContent).not.toContain("小华");
    fireEvent.click(screen.getByRole("button", { name: "20–29%，1人，查看名单" }));
    expect(screen.getByRole("region", { name: "20–29%学生名单" }).textContent).toContain("小华");
    expect(screen.queryByText("知识掌握汇总")).toBeNull();
  });

  it.each([1, 30, 40, 80])("keeps %i same-progress students visible or explicitly counted", (count) => {
    const students = Array.from({ length: count }, (_, index) => ({ id: `s${index}`, name: `学生${index}` }));
    const aiLearningProgress = Object.fromEntries(students.map((student) => [student.id, {
      classroomId: "classroom-1", studentId: student.id, currentSceneIndex: 3, totalScenes: 10,
      completedScenes: ["scene-1", "scene-2", "scene-3", "scene-4", "scene-5"], completionModelVersion: 2,
      masteryLevel: "in-progress", lastActiveAt: "2026-09-16T09:00:00.000Z",
    }]));
    const onStudentDetails = vi.fn();
    const { container } = render(<TeacherPresentationAnalytics course={makeCourse({ students, aiLearningProgress } as Partial<Course>)} stageKey="ai-learning" onDetails={vi.fn()} onStudentDetails={onStudentDetails} />);
    const bin = screen.getByRole("button", { name: `50–59%，${count}人，查看名单` });
    expect(bin.textContent).toContain(`${count} 人`);
    expect(screen.getByText(new RegExp(`有效 ${count}/${count} 人`))).toBeTruthy();
    fireEvent.click(bin);
    const list = screen.getByRole("region", { name: "50–59%学生名单" });
    expect(list.querySelectorAll("li")).toHaveLength(count);
    fireEvent.click(within(list).getAllByRole("button", { name: "查看明细" })[0]!);
    expect(onStudentDetails).toHaveBeenCalledWith("s0");
    expect(container.textContent).toContain("学生0");
  });

  it("draws a smooth curve through real counts without exceeding adjacent heights", () => {
    const { curve, area } = knowledgeMountainCurve([0, 0, 40, 0, 0, 0, 0, 0, 0, 0]);
    expect(curve).toContain("M 36 134");
    expect(curve).toContain("180 22");
    expect(curve).toContain("252 134");
    expect(area.endsWith("L 720 134 L 0 134 Z")).toBe(true);
    expect(curve).not.toMatch(/-[0-9]/);
  });

  it("shows every tied leader and full names when the whole class finishes", () => {
    const students = Array.from({ length: 4 }, (_, index) => ({ id: `s${index}`, name: `名字很长的学生${index}同学`, joinedAt: "2026-09-16T08:00:00.000Z", stageProgress: {} }));
    const aiLearningProgress = Object.fromEntries(students.map((student) => [student.id, {
      classroomId: "classroom-1", studentId: student.id, currentSceneIndex: 3, totalScenes: 3,
      completedScenes: ["a", "b", "c"], completionModelVersion: 2,
      masteryLevel: "completed", lastActiveAt: "2026-09-16T09:00:00.000Z",
    }]));
    render(<TeacherPresentationAnalytics course={makeCourse({ students, aiLearningProgress } as Partial<Course>)} stageKey="ai-learning" onDetails={vi.fn()} />);
    const mountain = screen.getByRole("region", { name: "班级学习山形图" });
    expect(mountain.textContent).toContain("4 人并列");
    expect(mountain.textContent).toContain("已完成");
    fireEvent.click(screen.getByRole("button", { name: "90–100%，4人，查看名单" }));
    const list = screen.getByRole("region", { name: "90–100%学生名单" });
    expect(list.querySelectorAll("li")).toHaveLength(4);
    for (const student of students) expect(list.textContent).toContain(student.name);
  });

  it("updates the distribution and leader when a student finishes another scene", () => {
    const students = [{ id: "s1", name: "小明", joinedAt: "2026-09-16T08:00:00.000Z", stageProgress: {} }, { id: "s2", name: "小华", joinedAt: "2026-09-16T08:00:00.000Z", stageProgress: {} }];
    const first = { classroomId: "classroom-1", studentId: "s1", currentSceneIndex: 1, totalScenes: 4,
      completedScenes: ["a"], completionModelVersion: 2, masteryLevel: "in-progress" as const, lastActiveAt: "2026-09-16T09:00:00.000Z" };
    const course = makeCourse({ students, aiLearningProgress: { s1: first, s2: { ...first, studentId: "s2" } } });
    const { rerender } = render(<TeacherPresentationAnalytics course={course} stageKey="ai-learning" onDetails={vi.fn()} />);
    expect(screen.getByRole("img", { name: /20–29% 2人/ })).toBeTruthy();
    rerender(<TeacherPresentationAnalytics course={{ ...course, aiLearningProgress: { s1: { ...first, completedScenes: ["a", "b"] }, s2: { ...first, studentId: "s2" } } } as Course} stageKey="ai-learning" onDetails={vi.fn()} />);
    expect(screen.getByRole("img", { name: /20–29% 1人.*50–59% 1人/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "班级学习山形图" }).textContent).toContain("小明");
  });

  it("separates unreliable progress and uses a true zero for a student who has only entered", () => {
    const course = makeCourse({ aiLearningProgress: {
      s1: { classroomId: "classroom-1", studentId: "s1", currentSceneIndex: 2, totalScenes: 4, completedScenes: ["scene-1"], masteryLevel: "in-progress", lastActiveAt: "2026-09-16T09:00:00.000Z" },
    } });
    render(<TeacherPresentationAnalytics course={course} stageKey="ai-learning" onDetails={vi.fn()} />);
    expect(screen.getByRole("img", { name: /0–9% 1人.*待核验1人/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "待核验 1 人" })).toBeTruthy();
  });

  it("shows an explicit empty state for legacy stages instead of reflection statistics", () => {
    render(<TeacherPresentationAnalytics course={makeCourse()} stageKey="legacy-inquiry" onDetails={vi.fn()} />);
    expect(screen.getByText("当前阶段暂无可用统计")).toBeTruthy();
    expect(screen.queryByText("反思提交状态")).toBeNull();
    expect(deriveTeacherClassroomPulse(makeCourse(), "legacy-inquiry").metrics).toEqual([]);
  });

  it.each(["launch", "ai-learning", "make", "showcase", "reflection"])("represents an empty %s classroom without inventing percentages", (stageKey) => {
    const { container } = render(<TeacherPresentationAnalytics course={makeCourse({ students: [], resources: [] })} stageKey={stageKey} onDetails={vi.fn()} />);
    expect(screen.getByText("暂无学生加入课堂")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|Infinity|0\/0/);
  });

  it("preserves observed values while marking a delayed snapshot", () => {
    render(<TeacherPresentationAnalytics course={makeCourse()} stageKey="launch" degraded onDetails={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("数据同步延迟");
    expect(screen.getByRole("button", { name: /资料阅读覆盖率/ }).textContent).toContain("50%");
    expect(screen.getByRole("button", { name: /全部资料浏览完成/ }).textContent).toContain("0/2");
  });

  it("shows missing reading records as missing, not a measured zero", () => {
    const course = makeCourse();
    course.resources![0]!.downloadedBy = [];
    render(<TeacherPresentationAnalytics course={course} stageKey="launch" onDetails={vi.fn()} />);
    expect(screen.getByRole("button", { name: /资料阅读覆盖率/ }).textContent).toContain("—");
  });

  it("uses only the latest valid reflection for each current student and hides individual text", () => {
    const record = (id: string, studentId: string, updatedAt: string, score: number) => ({
      id, studentId, updatedAt, content: "个人问题不可投影", survey: {
        schemaVersion: 1, learningReflection: "个人反思不可投影", systemReflection: "个人意见不可投影",
        aiHelpfulness: score, systemUsability: score, reuseIntention: score,
      },
    });
    const course = makeCourse({ reflections: [
      record("old", "s1", "2026-01-01", 1), record("new", "s1", "2026-01-02", 5),
      record("removed", "former-student", "2026-01-02", 2),
    ] as Course["reflections"] });
    const { container } = render(<TeacherPresentationAnalytics course={course} stageKey="reflection" onDetails={vi.fn()} />);
    const distribution = screen.getByRole("region", { name: "反思评价分布" });
    expect(within(distribution).getAllByText("1 分：0 2 分：0 3 分：0 4 分：0 5 分：1")).toHaveLength(3);
    expect(container.textContent).not.toContain("不可投影");
    expect(container.textContent).not.toContain("隐藏姓名");
  });
});


describe("TeacherKnowledgeAnalytics", () => {
  it("navigates analytics tabs with arrows, Home and End while retaining student sorting", () => {
    render(<TeacherKnowledgeAnalytics course={makeCourse()} />);
    const overview = screen.getByRole("tab", { name: "概览" });
    const students = screen.getByRole("tab", { name: "学生明细" });
    expect(overview.tabIndex).toBe(0);
    expect(students.tabIndex).toBe(-1);
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(document.activeElement).toBe(students);
    expect(students.getAttribute("aria-selected")).toBe("true");
    expect(students.tabIndex).toBe(0);
    expect(overview.tabIndex).toBe(-1);
    fireEvent.change(screen.getByLabelText("学生排序指标"), { target: { value: "accuracy" } });
    fireEvent.keyDown(students, { key: "ArrowRight" });
    expect(document.activeElement).toBe(overview);
    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(students);
    fireEvent.keyDown(students, { key: "Home" });
    expect(document.activeElement).toBe(overview);
    fireEvent.keyDown(overview, { key: "End" });
    expect(document.activeElement).toBe(students);
    expect(screen.getByDisplayValue("按答题准确率")).toBeTruthy();
    expect(screen.getByRole("tabpanel", { name: "学生明细" })).toBeTruthy();
  });

  it("defaults to overview and preserves student navigation and sorting across hidden views", () => {
    const course = makeCourse({ evaluationContractVersion: 2 });
    const onQuestionReview = vi.fn();
    const view = render(<TeacherKnowledgeAnalytics course={course} onQuestionReview={onQuestionReview} />);
    expect(screen.getByRole("tab", { name: "概览" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("list", { name: "学生状态总览" })).toBeNull();
    expect(screen.getByRole("button", { name: "AI 过程评价" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "课堂讲解" }));
    expect(onQuestionReview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));
    expect(screen.getByText("学生明细").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: "学生学习情况" })).toBeNull();
    expect(screen.queryByText("预览学生 AI 课程")).toBeNull();
    expect(screen.queryByText("补讲与课堂干预")).toBeNull();
    expect(screen.queryByLabelText("自主选择知识讲授PPT页面")).toBeNull();
    fireEvent.change(screen.getByLabelText("学生排序指标"), { target: { value: "accuracy" } });
    fireEvent.click(screen.getByRole("button", { name: "当前倒序，点击改为正序" }));
    fireEvent.click(screen.getByRole("button", { name: "查看隐藏姓名小明的答题详情" }));
    expect(screen.getByRole("tab", { name: "答题详情" }).getAttribute("aria-selected")).toBe("true");

    view.rerender(<TeacherKnowledgeAnalytics active={false} course={course} onQuestionReview={onQuestionReview} />);
    expect(screen.queryByRole("tab", { name: "答题详情" })).toBeNull();
    view.rerender(<TeacherKnowledgeAnalytics course={{ ...course }} onQuestionReview={onQuestionReview} />);
    expect(screen.getByRole("tab", { name: "答题详情" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("学生明细").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByDisplayValue("按答题准确率")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
    expect(screen.getByRole("button", { name: "当前正序，点击改为倒序" })).toBeTruthy();
  });

  it("opens a chart-selected student directly in the trajectory without leaving analytics", () => {
    const course = makeCourse();
    course.aiLearningProgress = Object.fromEntries(course.students.map((student) => [student.id, {
      classroomId: "classroom-1", studentId: student.id, currentSceneIndex: 1, totalScenes: 2,
      completedScenes: ["scene-1"], completionModelVersion: 2, masteryLevel: "in-progress", lastActiveAt: "2026-09-16T09:00:00.000Z",
    }]));
    render(<TeacherKnowledgeAnalytics course={course} />);
    fireEvent.click(screen.getByRole("button", { name: "50–59%，2人，查看名单" }));
    const students = screen.getByRole("region", { name: "50–59%学生名单" });
    fireEvent.click(within(students).getAllByRole("button", { name: "查看明细" })[1]!);
    expect(screen.getByText("学生明细").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "学习轨迹" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("dialog").textContent).toContain("隐藏姓名小华");
  });

  it("retains common signals already mapped to a recommended knowledge point in the analytics fold", () => {
    const course = makeCourse();
    course.content.knowledgePoints = [{ id: "kp-1", name: "变量关系", description: "" }];
    course.aiLearningProgress = Object.fromEntries(course.students.map((student) => [student.id, {
      classroomId: "classroom-1", studentId: student.id, currentSceneIndex: 0, totalScenes: 1, completedScenes: [],
      masteryLevel: "in-progress", lastActiveAt: "2026-09-16T09:00:00.000Z",
      knowledgeLectureAttempts: [{ id: `attempt-${student.id}`, sectionId: "section", quizOutlineId: "quiz", runtimeSceneId: "quiz-scene",
        submittedAt: "2026-09-16T09:00:00.000Z", gradingSource: "server", score: 0, maxScore: 10, knowledgePointIds: ["kp-1"],
        questions: [{ questionId: "q", prompt: "说明变量关系", answer: "回答", points: 10, earned: 0, gradingStatus: "graded", correct: false,
          feedback: "需澄清变量关系", knowledgePointIds: ["kp-1"] }] }],
    }]));
    course.learningSignals = course.students.map((student) => ({
      id: `signal-${student.id}`, courseId: course.id, studentId: student.id, stageKey: "ai-learning", sceneId: "scene-1",
      kind: "goal-stalled", severity: "warning", status: "open", title: "学习停滞", summary: "需要协助",
      content: { knowledgePointIds: ["kp-1"] }, normalizedIssueKey: "help", evidenceEventIds: [], aiInterventionAttempts: 0,
      firstDetectedAt: "2026-09-16T09:00:00.000Z", lastDetectedAt: "2026-09-16T09:00:00.000Z",
    }));
    const issues = knowledgeReviewCommonIssues(course);
    expect(knowledgeRecommendations(course, issues)[0].issues).toEqual(issues);
    render(<TeacherKnowledgeAnalytics course={course} />);
    const summary = screen.getByText("其他共性学习信号 · 1 条");
    expect(summary.closest("details")?.open).toBe(false);
    fireEvent.click(summary);
    expect(within(summary.closest("details")!).getByText("多名学生未能继续推进学习任务")).toBeTruthy();
    expect(within(summary.closest("details")!).getByText(/影响 2 人/)).toBeTruthy();
  });

  it("folds common learning signals and routes explicit knowledge links to classroom review", () => {
    const course = makeCourse();
    course.content.knowledgePoints = [{ id: "kp-1", name: "变量关系", description: "" }];
    course.learningSignals = course.students.map((student) => ({
      id: `signal-${student.id}`, courseId: course.id, studentId: student.id, stageKey: "ai-learning", sceneId: "scene-1",
      kind: "goal-stalled", severity: "warning", status: "open", title: "学习停滞", summary: "需要协助",
      content: { knowledgePointIds: ["kp-1"] }, normalizedIssueKey: "help", evidenceEventIds: [], aiInterventionAttempts: 0,
      firstDetectedAt: "2026-09-16T09:00:00.000Z", lastDetectedAt: "2026-09-16T09:00:00.000Z",
    }));
    const onKnowledgeReview = vi.fn();
    render(<TeacherKnowledgeAnalytics course={course} onKnowledgeReview={onKnowledgeReview} degraded />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("其他共性学习信号 · 1 条").closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByText("其他共性学习信号 · 1 条"));
    fireEvent.click(screen.getByRole("button", { name: "讲解变量关系" }));
    expect(onKnowledgeReview).toHaveBeenCalledWith("kp-1");
  });
});
