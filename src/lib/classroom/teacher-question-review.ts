import type { QuizQuestion, Scene } from "@openmaic/lib/types/stage";
import type { Course, CourseContent, KnowledgeLectureQuestionReview } from "@/lib/session/types";
import { aggregateKnowledgePointMastery, firstKnowledgeLectureQuestions, isValidKnowledgeLectureQuestionGrade, verifiedKnowledgeLectureScorePoints } from "@/lib/knowledge-lecture";
import { authoredQuestionFingerprintInput, knowledgeTutorEvidence } from "@/lib/courses/knowledge-tutor-evidence-shared";
import { selectStudentLearningScenes } from "@openmaic/lib/pbl/scene-routing";
import { currentKnowledgeQuestionAttempts } from "./knowledge-question-analytics";

export type QuestionReviewAnswer = {
  studentId: string;
  studentName: string;
  question: KnowledgeLectureQuestionReview;
  status: "graded" | "pending" | "failed" | "unverified";
};

export type TeacherQuestionReviewRow = {
  id: string;
  sectionId: string;
  sectionTitle: string;
  quizOutlineId: string;
  runtimeSceneId: string;
  questionNumber: number;
  snapshot: KnowledgeLectureQuestionReview;
  /** Present only for an original current question or a fingerprint-verified snapshot. */
  authoredSource?: QuizQuestion;
  sourceStatus?: "current" | QuestionSourceResolution["status"];
  knowledgePointIds: string[];
  knowledgePointNames: string[];
  answers: QuestionReviewAnswer[];
  submittedCount: number;
  gradedCount: number;
  incorrectCount: number;
  correctCount: number;
  pendingCount: number;
  failedCount: number;
  unverifiedCount: number;
  objective: boolean;
  accuracy?: number;
  scoreRate?: number;
};

/** A missing fingerprint never permits merging different historical question bodies. */
function snapshotVersion(question: KnowledgeLectureQuestionReview): string {
  return question.authoredQuestionFingerprint || JSON.stringify([
    question.prompt, question.options, question.matchingOptions, question.questionType,
    question.questionFormat, question.referenceAnswer, question.authoredAnalysis, question.points,
  ]);
}

export function questionAnswerNeedsReview(question: KnowledgeLectureQuestionReview): boolean {
  const subjective = question.questionType === "short_answer" || (!question.questionType && question.correct === null);
  return subjective ? question.correct === null && question.points > 0 && question.earned / question.points < 0.8 : question.correct === false;
}

export function buildTeacherQuestionReview(course: Course) {
  const students = new Map(course.students.map((student) => [student.id, student]));
  const sections = new Map((course.content.knowledgeLectureSections ?? []).map((section) => [section.id, section]));
  const names = new Map(course.content.knowledgePoints.map((point) => [point.id, point.name]));
  const attempts = currentKnowledgeQuestionAttempts(course);
  const grouped = new Map<string, TeacherQuestionReviewRow>();
  for (const { studentId, attempt } of attempts) {
    firstKnowledgeLectureQuestions(attempt).forEach((question, index) => {
      const id = JSON.stringify([attempt.sectionId, attempt.quizOutlineId, attempt.runtimeSceneId, question.questionId, snapshotVersion(question)]);
      const pointIds = question.knowledgePointIds.length ? question.knowledgePointIds : attempt.knowledgePointIds;
      const row = grouped.get(id) ?? {
        id, sectionId: attempt.sectionId, sectionTitle: sections.get(attempt.sectionId)?.title ?? "知识讲授小测",
        quizOutlineId: attempt.quizOutlineId, runtimeSceneId: attempt.runtimeSceneId, questionNumber: index + 1,
        snapshot: question, knowledgePointIds: [...new Set(pointIds)], knowledgePointNames: [], answers: [],
        submittedCount: 0, gradedCount: 0, incorrectCount: 0, correctCount: 0, pendingCount: 0, failedCount: 0, unverifiedCount: 0,
        objective: question.questionType ? question.questionType !== "short_answer" : question.correct !== null,
      };
      if (row.answers.some((answer) => answer.studentId === studentId)) return;
      const status = attempt.gradingSource !== "server" ? "unverified" : isValidKnowledgeLectureQuestionGrade(question) ? "graded"
        : question.gradingStatus === "failed" ? "failed" : question.gradingStatus === "graded" ? "unverified" : "pending";
      row.answers.push({ studentId, studentName: students.get(studentId)?.name ?? "学生", question, status });
      row.knowledgePointIds = [...new Set([...row.knowledgePointIds, ...pointIds])];
      grouped.set(id, row);
    });
  }
  const rows: TeacherQuestionReviewRow[] = [...grouped.values()].map((row) => {
    const graded = row.answers.filter((answer) => answer.status === "graded");
    const objective = graded.filter(({ question }) => question.correct !== null);
    const totalPoints = graded.reduce((sum, { question }) => sum + question.points, 0);
    return {
      ...row, knowledgePointNames: row.knowledgePointIds.map((id) => names.get(id) ?? id),
      submittedCount: row.answers.length, gradedCount: graded.length,
      incorrectCount: graded.filter(({ question }) => questionAnswerNeedsReview(question)).length,
      correctCount: objective.filter(({ question }) => question.correct === true).length,
      pendingCount: row.answers.filter((answer) => answer.status === "pending").length,
      failedCount: row.answers.filter((answer) => answer.status === "failed").length,
      unverifiedCount: row.answers.filter((answer) => answer.status === "unverified").length,
      accuracy: objective.length ? Math.round(objective.filter(({ question }) => question.correct === true).length / objective.length * 100) : undefined,
      scoreRate: totalPoints ? Math.round(graded.reduce((sum, { question }) => sum + question.earned, 0) / totalPoints * 100) : undefined,
    };
  }).sort((a, b) => (sections.get(a.sectionId)?.order ?? Number.MAX_SAFE_INTEGER) - (sections.get(b.sectionId)?.order ?? Number.MAX_SAFE_INTEGER)
    || a.questionNumber - b.questionNumber || a.id.localeCompare(b.id));
  const sectionRows = [...sections.values()].sort((a, b) => a.order - b.order).map((section) => {
    const submitted = attempts.filter(({ attempt }) => attempt.sectionId === section.id);
    const scores = submitted.flatMap(({ attempt }) => {
      const score = verifiedKnowledgeLectureScorePoints(attempt);
      return score === undefined ? [] : [score];
    });
    return { id: section.id, title: section.title, submittedCount: new Set(submitted.map(({ studentId }) => studentId)).size,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 100) / 100 : undefined,
      maxScore: section.maxScore, gradedCount: scores.length };
  });
  return { rows, sections: sectionRows, mastery: aggregateKnowledgePointMastery(course), studentCount: students.size };
}

export type QuestionSourceResolution =
  | { status: "verified"; question: QuizQuestion }
  | { status: "missing-fingerprint" | "missing-source" | "mismatch" | "unavailable" };

export function findTeacherReviewSource(row: TeacherQuestionReviewRow, scenes: readonly Scene[]): QuizQuestion | undefined {
  const scene = scenes.find((item) => item.id === row.runtimeSceneId && (item.outlineId || item.id) === row.quizOutlineId
    && (!item.lectureSectionId || item.lectureSectionId === row.sectionId));
  return scene?.content.type === "quiz" ? scene.content.questions.find((question) => question.id === row.snapshot.questionId) : undefined;
}

/** These bytes must remain identical to the server's immutable submission fingerprint. */
export function teacherQuestionSourceInput(row: TeacherQuestionReviewRow, content: CourseContent, scenes: readonly Scene[]): string | undefined {
  const source = findTeacherReviewSource(row, scenes);
  return source ? authoredQuestionFingerprintInput(source,
    knowledgeTutorEvidence(content, row.snapshot.knowledgePointIds, row.snapshot.teachingUnitIds)) : undefined;
}

export async function verifyTeacherQuestionSource(input: string | undefined, fingerprint: string | undefined,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<QuestionSourceResolution> {
  if (!fingerprint) return { status: "missing-fingerprint" };
  if (!input) return { status: "missing-source" };
  if (!subtle) return { status: "unavailable" };
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return actual === fingerprint ? { status: "verified", question: (JSON.parse(input) as { question: QuizQuestion }).question } : { status: "mismatch" };
  } catch {
    return { status: "unavailable" };
  }
}

async function digestQuestionInput(input: string, subtle: SubtleCrypto | undefined): Promise<string | undefined> {
  if (!subtle) return undefined;
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

/**
 * Add every current original without inventing submissions or grades. Historical
 * snapshots only join the original when scene, question and source version agree.
 * The caller retains buildTeacherQuestionReview's readable snapshots on load failure.
 */
export async function buildTeacherQuestionCatalog(course: Course, scenes: readonly Scene[],
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<ReturnType<typeof buildTeacherQuestionReview>> {
  const review = buildTeacherQuestionReview(course);
  const rows = await Promise.all(review.rows.map(async (row): Promise<TeacherQuestionReviewRow> => {
    const resolution = await verifyTeacherQuestionSource(teacherQuestionSourceInput(row, course.content, scenes), row.snapshot.authoredQuestionFingerprint, subtle);
    return { ...row, sourceStatus: resolution.status, ...(resolution.status === "verified" ? { authoredSource: resolution.question } : {}) };
  }));
  const sections = course.content.knowledgeLectureSections ?? [];
  const pointNames = new Map(course.content.knowledgePoints.map((point) => [point.id, point.name]));
  const outlines = new Map((course.content._openmaicSceneOutlines ?? []).map((outline) => [outline.id, outline]));
  const questionOrder = new Map<string, number>();
  const originals = selectStudentLearningScenes([...scenes]).filter((scene) => scene.content.type === "quiz")
    .sort((left, right) => (outlines.get(left.outlineId || left.id)?.order ?? left.order ?? 0)
      - (outlines.get(right.outlineId || right.id)?.order ?? right.order ?? 0));
  for (const scene of originals) {
    if (scene.content.type !== "quiz") continue;
    const quizOutlineId = scene.outlineId || scene.id;
    const candidates = sections.filter((section) => section.quizOutlineId === quizOutlineId
      && (!scene.lectureSectionId || section.id === scene.lectureSectionId));
    const section = candidates.length === 1 ? candidates[0] : undefined;
    const sectionId = section?.id ?? "";
    const sectionUnits = course.content.teachingBlueprint?.sections.find((item) => item.id === sectionId)?.units.map((unit) => unit.id) ?? [];
    const seen = new Set<string>();
    for (const [index, question] of scene.content.questions.entries()) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      questionOrder.set(JSON.stringify([scene.id, question.id]), index + 1);
      const adoptedPoints = question.knowledgePointIds?.filter((id) => !section || section.knowledgePointIds.includes(id)) ?? [];
      const knowledgePointIds = [...new Set(adoptedPoints.length ? adoptedPoints : section?.knowledgePointIds ?? scene.knowledgePointIds ?? [])];
      const adoptedUnits = question.teachingUnitIds?.filter((id) => !section || sectionUnits.includes(id)) ?? [];
      const teachingUnitIds = [...new Set(adoptedUnits.length ? adoptedUnits : section ? sectionUnits : scene.teachingUnitIds ?? [])];
      const input = authoredQuestionFingerprintInput(question, knowledgeTutorEvidence(course.content, knowledgePointIds, teachingUnitIds));
      const fingerprint = await digestQuestionInput(input, subtle);
      const id = JSON.stringify([sectionId, quizOutlineId, scene.id, question.id, fingerprint ?? input]);
      const saved = rows.find((row) => row.id === id && row.sourceStatus === "verified");
      if (saved) {
        saved.questionNumber = index + 1;
        continue;
      }
      // This snapshot supplies the existing question reader's authored display
      // fields only. The empty answers array is the submission boundary.
      const snapshot: KnowledgeLectureQuestionReview = {
        questionId: question.id, prompt: question.question, questionType: question.type, questionFormat: question.format,
        options: question.options, matchingOptions: question.matchingPairs ? {
          left: question.matchingPairs.map((pair) => pair.left), right: question.matchingPairs.map((pair) => pair.right),
        } : undefined,
        authoredAnalysis: question.analysis, referenceAnswer: question.referenceAnswer || question.analysis,
        authoredQuestionFingerprint: fingerprint, gradingRubric: question.commentPrompt, scoringRubric: question.scoringRubric,
        points: question.points ?? 1, knowledgePointIds, teachingUnitIds, answer: "", earned: 0, correct: null, feedback: "",
      };
      rows.push({ id, sectionId, sectionTitle: section?.title ?? "未归属章节", quizOutlineId, runtimeSceneId: scene.id,
        questionNumber: index + 1, snapshot, authoredSource: question, sourceStatus: "current", knowledgePointIds,
        knowledgePointNames: knowledgePointIds.map((pointId) => pointNames.get(pointId) ?? pointId), answers: [],
        submittedCount: 0, gradedCount: 0, incorrectCount: 0, correctCount: 0, pendingCount: 0, failedCount: 0, unverifiedCount: 0,
        objective: question.type !== "short_answer" });
    }
  }
  const sectionOrder = new Map(sections.map((section) => [section.id, section.order]));
  const sceneOrder = new Map(originals.map((scene, index) => [scene.id, index]));
  rows.sort((left, right) => (sectionOrder.get(left.sectionId) ?? Number.MAX_SAFE_INTEGER) - (sectionOrder.get(right.sectionId) ?? Number.MAX_SAFE_INTEGER)
    || (sceneOrder.get(left.runtimeSceneId) ?? Number.MAX_SAFE_INTEGER) - (sceneOrder.get(right.runtimeSceneId) ?? Number.MAX_SAFE_INTEGER)
    || (questionOrder.get(JSON.stringify([left.runtimeSceneId, left.snapshot.questionId])) ?? left.questionNumber)
      - (questionOrder.get(JSON.stringify([right.runtimeSceneId, right.snapshot.questionId])) ?? right.questionNumber)
    || Number(right.sourceStatus === "current" || right.sourceStatus === "verified") - Number(left.sourceStatus === "current" || left.sourceStatus === "verified")
    || left.id.localeCompare(right.id));
  return { ...review, rows };
}

export function reviewAnswerValues(question: KnowledgeLectureQuestionReview): string[] {
  const raw = question.rawAnswer ?? question.answer;
  if (!question.rawAnswer && question.questionType === "multiple" && typeof raw === "string") {
    const values = raw.split("、").map((value) => value.trim());
    if (values.length > 1 && values.every((value) => question.options?.some((option) => option.value === value))) return values;
  }
  return (Array.isArray(raw) ? raw : [raw]).filter((value) => value.trim());
}

export function reviewAnswerText(question: KnowledgeLectureQuestionReview, source?: QuizQuestion): string {
  const values = reviewAnswerValues(question);
  return values.map((value) => {
    const option = question.options?.find((item) => item.value === value);
    if (option) return `${value}. ${option.label}`;
    if (source?.type === "matching") {
      const separator = value.indexOf(":");
      const left = source.matchingPairs?.find((pair) => pair.leftId === value.slice(0, separator));
      const right = source.matchingPairs?.find((pair) => pair.rightId === value.slice(separator + 1));
      if (separator > 0 && left && right) return `${left.left} → ${right.right}`;
    }
    return value;
  }).join("；") || "未填写答案";
}

/** Only exact persisted responses are grouped; no inferred semantic misconceptions. */
export function reviewAnswerDistribution(row: TeacherQuestionReviewRow, source?: QuizQuestion) {
  const groups = new Map<string, { label: string; count: number }>();
  for (const { question, status } of row.answers) {
    if (status !== "graded") continue;
    const label = reviewAnswerText(question, source);
    const current = groups.get(label) ?? { label, count: 0 };
    current.count += 1;
    groups.set(label, current);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
