import { describe, expect, it } from "vitest";
import type { Course, KnowledgeLectureAttempt, KnowledgeLectureQuestionReview, KnowledgeLectureSection } from "@/lib/session/types";
import { buildTeacherQuestionReview } from "./teacher-question-review";
import { classroomReviewChapters, initialClassroomReviewChapter } from "./classroom-review";

function section(id: string, order: number, pageIds: string[] = []): KnowledgeLectureSection {
  return { id, title: `章节 ${id}`, order, knowledgePointIds: ["point"], sceneOutlineIds: pageIds,
    quizOutlineId: `quiz-${id}`, estimatedMinutes: 5 };
}

function question(id: string, overrides: Partial<KnowledgeLectureQuestionReview> = {}): KnowledgeLectureQuestionReview {
  return { questionId: id, prompt: `题目 ${id}`, questionType: "single", answer: "A", points: 10, earned: 0,
    gradingStatus: "graded", correct: false, feedback: "", knowledgePointIds: ["point"], ...overrides };
}

function attempt(sectionId: string, questions: KnowledgeLectureQuestionReview[], gradingSource: KnowledgeLectureAttempt["gradingSource"] = "server"): KnowledgeLectureAttempt {
  return { id: `attempt-${sectionId}`, sectionId, quizOutlineId: `quiz-${sectionId}`, runtimeSceneId: `runtime-${sectionId}`,
    submittedAt: "2026-10-26T00:00:00.000Z", gradingSource, score: 0, maxScore: questions.length * 10,
    knowledgePointIds: ["point"], questions };
}

function course(sections: KnowledgeLectureSection[] = [], attempts: KnowledgeLectureAttempt[] = []): Course {
  return {
    id: "course", name: "课堂", subject: "科学", grade: "七年级", hours: 1, summary: "", drivingQuestion: "",
    status: "teaching", stages: [], currentStageIndex: 0, aiLearningClassroomId: "classroom",
    content: { pblOutline: "", lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
      knowledgePoints: [{ id: "point", name: "知识点", description: "" }], knowledgeLectureSections: sections },
    students: [{ id: "student", name: "学生", joinedAt: "2026-10-26T00:00:00.000Z", stageProgress: {} }],
    aiLearningProgress: { student: { classroomId: "classroom", studentId: "student", currentSceneIndex: 0, totalScenes: 1,
      completedScenes: [], masteryLevel: "in-progress", lastActiveAt: "2026-10-26T00:00:00.000Z", knowledgeLectureAttempts: attempts } },
    createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
  };
}

function chaptersFor(input: Course) {
  return classroomReviewChapters(input, buildTeacherQuestionReview(input));
}

describe("classroom review chapter navigation", () => {
  it("uses the saved teaching order without changing stored sections", () => {
    const input = course([section("third", 30), section("first", 10), section("second", 20)]);
    expect(chaptersFor(input).map((chapter) => chapter.sectionId)).toEqual(["first", "second", "third"]);
    expect(input.content.knowledgeLectureSections!.map((chapter) => chapter.id)).toEqual(["third", "first", "second"]);
  });

  it("initially prefers valid wrong questions, then submitted questions, then the first chapter", () => {
    const sections = [section("empty", 0), section("pending", 1), section("wrong", 2), section("later-wrong", 3)];
    const wrong = chaptersFor(course(sections, [
      attempt("pending", [question("pending", { gradingStatus: "pending" })]),
      attempt("wrong", [question("wrong")]), attempt("later-wrong", [question("later")]),
    ]));
    expect(initialClassroomReviewChapter(wrong).sectionId).toBe("wrong");
    const submitted = chaptersFor(course(sections, [attempt("pending", [question("pending", { gradingStatus: "pending" })])]));
    expect(initialClassroomReviewChapter(submitted).sectionId).toBe("pending");
    expect(initialClassroomReviewChapter(chaptersFor(course(sections))).sectionId).toBe("empty");
  });

  it.each([
    ["pending", "server"], ["failed", "server"], ["graded", "legacy-unverified"],
  ] as const)("does not label %s / %s submissions as wrong", (gradingStatus, gradingSource) => {
    const [chapter] = chaptersFor(course([section("one", 0)], [attempt("one", [question("q", { gradingStatus })], gradingSource)]));
    expect(chapter.questions[0]).toMatchObject({ incorrectCount: 0, gradedCount: 0 });
  });

  it("counts independent wrong questions and distinguishes correct answers from missing answers", () => {
    const [wrong] = chaptersFor(course([section("one", 0)], [attempt("one", [
      question("objective"), question("subjective", { questionType: "short_answer", correct: null, earned: 7 }),
      question("correct", { correct: true, earned: 10 }),
    ])]));
    expect(wrong.questions.filter((row) => row.incorrectCount > 0)).toHaveLength(2);
    const [correct] = chaptersFor(course([section("one", 0)], [attempt("one", [question("correct", { correct: true, earned: 10 })])]));
    expect(correct.questions[0]).toMatchObject({ incorrectCount: 0, gradedCount: 1 });
    expect(chaptersFor(course([section("one", 0)]))[0].questions).toEqual([]);
  });

  it("keeps unknown section identities separate with honest generic labels after configured chapters", () => {
    const input = course([section("known", 0)], [attempt("unknown-b", [question("b")]), attempt("unknown-a", [question("a")])]);
    const review = buildTeacherQuestionReview(input);
    review.rows.forEach((row) => { row.sectionTitle = "无法证实的旧章节名称"; });
    const chapters = classroomReviewChapters(input, review);
    expect(chapters.map((chapter) => chapter.sectionId)).toEqual(["known", "unknown-a", "unknown-b"]);
    expect(chapters.slice(1).map((chapter) => chapter.title)).toEqual(["其他作答 1", "其他作答 2"]);
    expect(chapters.slice(1).map((chapter) => chapter.questions.map((row) => row.snapshot.questionId))).toEqual([["a"], ["b"]]);
    expect(chapters.slice(1).flatMap((chapter) => chapter.pageIds)).toEqual([]);
  });

  it.each([false, true])("uses one virtual all-content group when no sections are configured (saved answers: %s)", (hasAnswers) => {
    const input = course([], hasAnswers ? [attempt("unknown-a", [question("a")]), attempt("unknown-b", [question("b")])] : []);
    const chapters = chaptersFor(input);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ id: "all", title: "课堂内容" });
    expect(chapters[0].sectionId).toBeUndefined();
    expect(chapters[0].questions.map((row) => row.snapshot.questionId).sort()).toEqual(hasAnswers ? ["a", "b"] : []);
  });

  it("lists only actual student teaching pages in teaching order for the virtual group", () => {
    const input = course();
    input.content._openmaicSceneOutlines = [
      { id: "later", title: "后页", type: "slide", order: 2, stageKey: "ai-learning", audience: "student" },
      { id: "quiz", title: "小测", type: "quiz", order: 1, stageKey: "ai-learning", audience: "student" },
      { id: "first", title: "前页", type: "slide", order: 0, stageKey: "ai-learning", audience: "student" },
      { id: "teacher", title: "教师页面", type: "slide", order: 0, stageKey: "ai-learning", audience: "teacher" },
      { id: "other-stage", title: "其他阶段", type: "slide", order: 0, stageKey: "launch", audience: "student" },
    ];
    expect(chaptersFor(input)[0].pageIds).toEqual(["first", "later"]);
  });

  it("keeps exact saved chapter page IDs and does not infer pages from shared points or titles", () => {
    const input = course([section("bound", 0, ["saved-page", "missing-page"]), section("unbound", 1)]);
    input.content._openmaicSceneOutlines = [{ id: "similar-page", title: "章节 unbound", type: "slide", order: 0,
      stageKey: "ai-learning", audience: "student", knowledgePointIds: ["point"] }];
    const chapters = chaptersFor(input);
    expect(chapters[0].pageIds).toEqual(["saved-page", "missing-page"]);
    expect(chapters[1].pageIds).toEqual([]);
  });
});
