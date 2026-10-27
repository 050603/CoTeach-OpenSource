import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { QuizQuestion, Scene } from "@openmaic/lib/types/stage";
import type { Course, KnowledgeLectureQuestionReview } from "@/lib/session/types";
import { authoredQuestionFingerprint, knowledgeTutorEvidence } from "@/lib/courses/knowledge-tutor-evidence";
import { aggregateQuestionAnalytics } from "./knowledge-question-analytics";
import { buildTeacherQuestionCatalog, buildTeacherQuestionReview, reviewAnswerDistribution, reviewAnswerText, teacherQuestionSourceInput, verifyTeacherQuestionSource } from "./teacher-question-review";

const question: KnowledgeLectureQuestionReview = {
  questionId: "q1", prompt: "观察证据说明了什么？", questionType: "single", options: [{ value: "A", label: "变化" }, { value: "B", label: "不变" }],
  rawAnswer: "A", answer: "A", correct: false, points: 10, earned: 0, gradingStatus: "graded", feedback: "核对观察证据", knowledgePointIds: ["kp"],
};
function makeCourse(): Course {
  return {
    id: "course", aiLearningClassroomId: "classroom", students: [{ id: "s1", name: "学生一" }, { id: "s2", name: "学生二" }],
    content: { knowledgePoints: [{ id: "kp", name: "观察证据", evidenceItemIds: ["evidence"] }],
      knowledgeLectureSections: [{ id: "section", title: "第一节", order: 0, quizOutlineId: "quiz", knowledgePointIds: ["kp"], maxScore: 10 }],
      courseEvidence: { version: 1, fingerprint: "source-v1", items: [{ id: "evidence", content: "原始材料", source: { textbookTitle: "教材" } }] } },
    aiLearningProgress: Object.fromEntries(["s1", "s2"].map((studentId) => [studentId, {
      classroomId: "classroom", knowledgeLectureAttempts: [{ id: `attempt-${studentId}`, sectionId: "section", quizOutlineId: "quiz", runtimeSceneId: "scene",
        submittedAt: "2026-10-23T00:00:00Z", gradingSource: "server", knowledgePointIds: ["kp"],
        questions: [{ ...structuredClone(question), ...(studentId === "s2" ? { rawAnswer: "B", answer: "B", correct: true, earned: 10 } : {}) }] }],
    }])) } as unknown as Course;
}
const source: QuizQuestion = { id: "q1", question: question.prompt, type: "single", options: question.options, answer: ["B"], analysis: "原始解析：依据记录判断。", knowledgePointIds: ["kp"], points: 10 };
const scenes = [{ id: "scene", outlineId: "quiz", type: "quiz", content: { type: "quiz", questions: [source] } }] as Scene[];
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

describe("teacher question review evidence", () => {
  it("counts current students' first submissions and excludes unrelated classrooms, removed students and retries", () => {
    const course = makeCourse();
    const attempts = course.aiLearningProgress!.s1.knowledgeLectureAttempts!;
    attempts.unshift({ ...structuredClone(attempts[0]), id: "later", submittedAt: "2026-10-23T01:00:00Z", questions: [{ ...question, earned: 10, correct: true }] });
    course.aiLearningProgress!.removed = structuredClone(course.aiLearningProgress!.s1);
    course.aiLearningProgress!.s2.classroomId = "old-classroom";
    const data = buildTeacherQuestionReview(course);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ submittedCount: 1, gradedCount: 1, incorrectCount: 1, correctCount: 0, accuracy: 0 });
    expect(data.sections[0]).toMatchObject({ submittedCount: 1, averageScore: 0 });
    expect(data.mastery[0].answeredStudents).toBe(1);
  });

  it("keeps pending, failed and legacy records visible without counting them as wrong or scored", () => {
    const course = makeCourse();
    const attempts = course.aiLearningProgress!.s1.knowledgeLectureAttempts!;
    attempts[0].questions = ["graded", "pending", "failed"].map((status, index) => ({ ...question, questionId: `q${index}`, gradingStatus: status as "graded" | "pending" | "failed" }));
    course.aiLearningProgress!.s2.knowledgeLectureAttempts![0].gradingSource = "legacy-unverified";
    course.aiLearningProgress!.s2.knowledgeLectureAttempts![0].questions = structuredClone(attempts[0].questions);
    const rows = buildTeacherQuestionReview(course).rows;
    expect(rows.map((row) => [row.gradedCount, row.incorrectCount, row.pendingCount, row.failedCount, row.unverifiedCount])).toEqual([
      [1, 1, 0, 0, 1], [0, 0, 1, 0, 1], [0, 0, 0, 1, 1],
    ]);
    expect(rows[1].accuracy).toBeUndefined();
    expect(rows[1].scoreRate).toBeUndefined();
  });

  it("uses objective correctness and the existing 80% threshold for subjective answers", () => {
    const course = makeCourse();
    for (const [index, entry] of Object.values(course.aiLearningProgress!).entries()) {
      entry.knowledgeLectureAttempts![0].questions = [{ ...question, questionType: "short_answer", options: undefined, correct: null, earned: index ? 8 : 7.9 }];
    }
    const row = buildTeacherQuestionReview(course).rows[0];
    expect(row).toMatchObject({ objective: false, gradedCount: 2, incorrectCount: 1, scoreRate: 80 });
    expect(row.accuracy).toBeUndefined();
  });

  it("does not infer correctness from scores when the explicit question type contradicts the saved grade", () => {
    const course = makeCourse();
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions = [
      { ...question, questionId: "single", questionType: "single", correct: null },
      { ...question, questionId: "multiple", questionType: "multiple", correct: null },
      { ...question, questionId: "matching", questionType: "matching", correct: null },
      { ...question, questionId: "text", questionType: "short_answer", correct: false },
      { ...question, questionId: "blank", questionType: "short_answer", questionFormat: "fill_blank", correct: null, earned: 7 },
    ];
    course.aiLearningProgress!.s2.knowledgeLectureAttempts = [];
    const rows = buildTeacherQuestionReview(course).rows;
    expect(rows.slice(0, 4).map((row) => [row.gradedCount, row.incorrectCount, row.unverifiedCount])).toEqual([
      [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1],
    ]);
    expect(rows[4]).toMatchObject({ objective: false, gradedCount: 1, incorrectCount: 1 });
  });

  it("keeps different question versions separate and guards malformed grades", () => {
    const course = makeCourse();
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].authoredQuestionFingerprint = "old";
    course.aiLearningProgress!.s2.knowledgeLectureAttempts![0].questions[0].authoredQuestionFingerprint = "new";
    expect(buildTeacherQuestionReview(course).rows).toHaveLength(2);
    const first = course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0];
    delete first.authoredQuestionFingerprint;
    const second = course.aiLearningProgress!.s2.knowledgeLectureAttempts![0].questions[0];
    delete second.authoredQuestionFingerprint;
    second.prompt = "修改后的题目";
    expect(buildTeacherQuestionReview(course).rows).toHaveLength(2);
    first.earned = Number.NaN;
    expect(buildTeacherQuestionReview(course).rows.find((row) => row.snapshot.prompt === question.prompt)).toMatchObject({ gradedCount: 0, incorrectCount: 0, unverifiedCount: 1 });
  });

  it("shares strict grade validation and duplicate boundaries with knowledge-point evidence", () => {
    const course = makeCourse();
    const invalid: Partial<KnowledgeLectureQuestionReview>[] = [
      { earned: Number.NaN }, { earned: Number.POSITIVE_INFINITY }, { earned: -1 }, { earned: 11 },
      { points: 0 }, { points: Number.POSITIVE_INFINITY }, { correct: null }, { questionType: "short_answer", correct: false },
    ];
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions = [
      structuredClone(question), { ...question, earned: 10, correct: true },
      ...invalid.map((overrides, index) => ({ ...question, questionId: `invalid-${index}`, ...overrides })),
      { ...question, questionId: "pending", gradingStatus: "pending" }, { ...question, questionId: "failed", gradingStatus: "failed" },
    ];
    course.aiLearningProgress!.s2.knowledgeLectureAttempts = [];
    const review = buildTeacherQuestionReview(course);
    expect(review.rows[0]).toMatchObject({ submittedCount: 1, gradedCount: 1, incorrectCount: 1 });
    expect(review.rows.filter((row) => row.snapshot.questionId.startsWith("invalid-"))).toHaveLength(invalid.length);
    expect(review.rows.filter((row) => row.snapshot.questionId.startsWith("invalid-")).every((row) => row.unverifiedCount === 1 && row.gradedCount === 0)).toBe(true);
    expect(review.mastery[0]).toMatchObject({ answeredStudents: 1, responseCount: 1, incorrectStudents: 1, earned: 0, maxScore: 10 });
    expect(review.sections[0].averageScore).toBeUndefined();
    expect(aggregateQuestionAnalytics(course, course.aiLearningProgress!)).toEqual([
      expect.objectContaining({ answeredStudents: 1, correctStudents: 0, scoreRate: 0 }),
    ]);
  });

  it("keeps multi-point student counts independent rather than adding them together", () => {
    const course = makeCourse();
    course.content.knowledgePoints.push({ id: "kp2", name: "判断依据", description: "" });
    for (const entry of Object.values(course.aiLearningProgress!)) {
      entry.knowledgeLectureAttempts![0].questions[0].knowledgePointIds = ["kp", "kp2", "kp"];
      entry.knowledgeLectureAttempts![0].questions.push(structuredClone(entry.knowledgeLectureAttempts![0].questions[0]));
    }
    const review = buildTeacherQuestionReview(course);
    expect(review.rows[0]).toMatchObject({ submittedCount: 2, knowledgePointIds: ["kp", "kp2"] });
    expect(review.mastery).toHaveLength(2);
    expect(review.mastery.every((point) => point.answeredStudents === 2 && point.responseCount === 2 && point.incorrectStudents === 1)).toBe(true);
  });

  it("preserves the legacy aggregate export and score denominators", () => {
    const course = makeCourse();
    expect(aggregateQuestionAnalytics(course, course.aiLearningProgress!)).toEqual([{
      id: "quiz:q1", sectionId: "section", sectionTitle: "第一节", questionNumber: 1, prompt: question.prompt,
      knowledgePointNames: ["观察证据"], answeredStudents: 2, correctStudents: 1, accuracy: 50, scoreRate: 50, commonFeedback: "核对观察证据",
    }]);
  });

  it("matches the existing server fingerprint byte for byte and rejects changes in sources or correct answers", async () => {
    const course = makeCourse();
    const evidence = knowledgeTutorEvidence(course.content, ["kp"]);
    const original = JSON.stringify({ question: source, evidence });
    const fingerprint = authoredQuestionFingerprint(source, evidence);
    expect(fingerprint).toBe(createHash("sha256").update(original).digest("hex"));
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].authoredQuestionFingerprint = fingerprint;
    const row = buildTeacherQuestionReview(course).rows.find((item) => item.snapshot.authoredQuestionFingerprint)!;
    const input = teacherQuestionSourceInput(row, course.content, scenes);
    expect(input).toBe(original);
    expect(await verifyTeacherQuestionSource(input, fingerprint, subtle)).toEqual({ status: "verified", question: source });
    expect(await verifyTeacherQuestionSource(input, "wrong-version", subtle)).toEqual({ status: "mismatch" });
    const changed = structuredClone(scenes);
    if (changed[0].content.type === "quiz") changed[0].content.questions[0].answer = ["A"];
    expect(await verifyTeacherQuestionSource(teacherQuestionSourceInput(row, course.content, changed), fingerprint, subtle)).toEqual({ status: "mismatch" });
    course.content.courseEvidence!.version = 2;
    expect(await verifyTeacherQuestionSource(teacherQuestionSourceInput(row, course.content, scenes), fingerprint, subtle)).toEqual({ status: "mismatch" });
  });

  it("does not borrow a current answer when fingerprint or exact scene identity is absent", async () => {
    const course = makeCourse();
    const row = buildTeacherQuestionReview(course).rows[0];
    expect(await verifyTeacherQuestionSource(teacherQuestionSourceInput(row, course.content, scenes), undefined, subtle)).toEqual({ status: "missing-fingerprint" });
    expect(teacherQuestionSourceInput({ ...row, runtimeSceneId: "other" }, course.content, scenes)).toBeUndefined();
    expect(teacherQuestionSourceInput({ ...row, quizOutlineId: "other" }, course.content, scenes)).toBeUndefined();
    expect(await verifyTeacherQuestionSource(undefined, "version", subtle)).toEqual({ status: "missing-source" });
    const failing = { digest: () => Promise.reject(new Error("unsupported")) } as unknown as SubtleCrypto;
    expect(await verifyTeacherQuestionSource("{}", "version", failing)).toEqual({ status: "unavailable" });
  });

  it("renders exact multi-select and matching values without inventing missing mappings", () => {
    expect(reviewAnswerText({ ...question, questionType: "multiple", rawAnswer: ["A", "B"] })).toBe("A. 变化；B. 不变");
    const matching: QuizQuestion = { id: "matching", type: "matching", question: "匹配", answer: ["L1:R1"], matchingPairs: [{ leftId: "L1", left: "输入", rightId: "R1", right: "接收数据" }] };
    const answer = { ...question, questionType: "matching" as const, options: undefined, rawAnswer: ["L1:R1"] };
    expect(reviewAnswerText(answer, matching)).toBe("输入 → 接收数据");
    expect(reviewAnswerText(answer)).toBe("L1:R1");
    const row = buildTeacherQuestionReview(makeCourse()).rows[0];
    expect(reviewAnswerDistribution(row)).toEqual([{ label: "A. 变化", count: 1 }, { label: "B. 不变", count: 1 }]);
  });
});

describe("teacher full question catalog", () => {
  function adoptFingerprint(course: Course, original = source) {
    const fingerprint = authoredQuestionFingerprint(original, knowledgeTutorEvidence(course.content, ["kp"]));
    for (const entry of Object.values(course.aiLearningProgress!)) entry.knowledgeLectureAttempts![0].questions[0].authoredQuestionFingerprint = fingerprint;
    return fingerprint;
  }

  it("joins exact source versions and adds all unanswered originals without changing learning evidence", async () => {
    const course = makeCourse();
    adoptFingerprint(course);
    const current = structuredClone(scenes);
    const second: QuizQuestion = { ...source, id: "q2", question: "尚未提交的原题", answer: ["A"] };
    if (current[0].content.type === "quiz") current[0].content.questions.push(second);
    const before = JSON.stringify(course);
    const review = buildTeacherQuestionReview(course);
    const catalog = await buildTeacherQuestionCatalog(course, current, subtle);
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows[0]).toMatchObject({ id: review.rows[0].id, sourceStatus: "verified", authoredSource: source, submittedCount: 2, incorrectCount: 1 });
    expect(catalog.rows[1]).toMatchObject({ sectionId: "section", questionNumber: 2, sourceStatus: "current", authoredSource: second,
      submittedCount: 0, answers: [], gradedCount: 0, incorrectCount: 0 });
    expect(catalog.rows[1].snapshot.gradingStatus).toBeUndefined();
    expect(catalog.mastery).toEqual(review.mastery);
    expect(catalog.sections).toEqual(review.sections);
    expect(JSON.stringify(course)).toBe(before);
    course.aiLearningProgress = {};
    const unsubmitted = await buildTeacherQuestionCatalog(course, current, subtle);
    expect(unsubmitted.rows.map((row) => row.id)).toEqual(catalog.rows.map((row) => row.id));
    expect(unsubmitted.rows.every((row) => row.submittedCount === 0 && row.answers.length === 0)).toBe(true);
  });

  it("keeps changed versions, missing fingerprints and foreign runtime identities separate", async () => {
    const course = makeCourse();
    adoptFingerprint(course);
    const first = course.aiLearningProgress!.s1.knowledgeLectureAttempts![0];
    first.questions[0].authoredQuestionFingerprint = "old-version";
    let catalog = await buildTeacherQuestionCatalog(course, scenes, subtle);
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.find((row) => row.sourceStatus === "mismatch")).toMatchObject({ submittedCount: 1 });
    expect(catalog.rows.find((row) => row.sourceStatus === "mismatch")?.authoredSource).toBeUndefined();
    expect(catalog.rows.find((row) => row.sourceStatus === "verified")).toMatchObject({ submittedCount: 1, authoredSource: source });
    delete first.questions[0].authoredQuestionFingerprint;
    catalog = await buildTeacherQuestionCatalog(course, scenes, subtle);
    expect(catalog.rows.find((row) => row.sourceStatus === "missing-fingerprint")).toMatchObject({ submittedCount: 1 });
    expect(catalog.rows.find((row) => row.sourceStatus === "missing-fingerprint")?.authoredSource).toBeUndefined();
    adoptFingerprint(course);
    first.runtimeSceneId = "previous-runtime-scene";
    catalog = await buildTeacherQuestionCatalog(course, scenes, subtle);
    expect(catalog.rows.find((row) => row.sourceStatus === "missing-source")).toMatchObject({ submittedCount: 1 });
    expect(catalog.rows.find((row) => row.sourceStatus === "missing-source")?.authoredSource).toBeUndefined();
    expect(catalog.rows.find((row) => row.sourceStatus === "verified")).toMatchObject({ submittedCount: 1 });
  });

  it("uses current authored order while keeping stable saved question identities", async () => {
    const course = makeCourse();
    adoptFingerprint(course);
    const savedId = buildTeacherQuestionReview(course).rows[0].id;
    const current = structuredClone(scenes);
    if (current[0].content.type === "quiz") current[0].content.questions.unshift({ ...source, id: "new-first", question: "第一题" });
    const catalog = await buildTeacherQuestionCatalog(course, current, subtle);
    expect(catalog.rows.map((row) => [row.snapshot.questionId, row.questionNumber])).toEqual([["new-first", 1], ["q1", 2]]);
    expect(catalog.rows[1].id).toBe(savedId);
  });

  it("does not merge a matching question body when the saved chapter conflicts with the source scene", async () => {
    const course = makeCourse();
    adoptFingerprint(course);
    const current = structuredClone(scenes);
    current[0].lectureSectionId = "different-section";
    const catalog = await buildTeacherQuestionCatalog(course, current, subtle);
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.find((row) => row.sourceStatus === "missing-source")).toMatchObject({ sectionId: "section", submittedCount: 2 });
    expect(catalog.rows.find((row) => row.sourceStatus === "current")).toMatchObject({ sectionId: "", sectionTitle: "未归属章节", submittedCount: 0 });
  });

  it("keeps unknown current quizzes unassigned and excludes other routed stages and teacher material", async () => {
    const course = makeCourse();
    course.aiLearningProgress = {};
    const current = structuredClone(scenes);
    current[0] = { ...current[0], stageKey: "ai-learning", audience: "student", generationPurpose: "knowledge-teaching", outlineId: "unbound-quiz", title: "第一节" };
    current.push({ ...current[0], id: "teacher-quiz", audience: "teacher" }, { ...current[0], id: "other-stage", stageKey: "launch" });
    const catalog = await buildTeacherQuestionCatalog(course, current, subtle);
    expect(catalog.rows).toHaveLength(1);
    expect(catalog.rows[0]).toMatchObject({ sectionId: "", sourceStatus: "current", sectionTitle: "未归属章节", answers: [] });
  });

  it("retains saved snapshots and readable originals when browser hashing is unavailable", async () => {
    const course = makeCourse();
    adoptFingerprint(course);
    const failing = { digest: () => Promise.reject(new Error("unsupported")) } as unknown as SubtleCrypto;
    const catalog = await buildTeacherQuestionCatalog(course, scenes, failing);
    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.find((row) => row.sourceStatus === "unavailable")).toMatchObject({ submittedCount: 2 });
    expect(catalog.rows.find((row) => row.sourceStatus === "unavailable")?.authoredSource).toBeUndefined();
    expect(catalog.rows.find((row) => row.sourceStatus === "current")).toMatchObject({ submittedCount: 0, authoredSource: source });
  });
});
