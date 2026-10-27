import { firstKnowledgeLectureAttempts, firstKnowledgeLectureQuestions, isCurrentAiLearningEntry, isValidKnowledgeLectureQuestionGrade } from "@/lib/knowledge-lecture";
import type { Course, StudentAiProgress } from "@/lib/session/types";

/** Shared provenance and first-submission boundary for teacher question views. */
export function currentKnowledgeQuestionAttempts(course: Course, progress = course.aiLearningProgress ?? {}) {
  const studentIds = new Set(course.students.map((student) => student.id));
  return Object.entries(progress).flatMap(([studentId, entry]) =>
    studentIds.has(studentId) && isCurrentAiLearningEntry(course, entry)
      ? firstKnowledgeLectureAttempts(entry).map((attempt) => ({ studentId, attempt }))
      : []);
}

export type QuestionAnalyticsRow = {
  id: string;
  sectionId: string;
  sectionTitle: string;
  questionNumber: number;
  prompt: string;
  knowledgePointNames: string[];
  answeredStudents: number;
  correctStudents: number;
  accuracy?: number;
  scoreRate?: number;
  commonFeedback?: string;
};

export function aggregateQuestionAnalytics(
  course: Course,
  progress: Record<string, StudentAiProgress>,
): QuestionAnalyticsRow[] {
  const sections = new Map((course.content.knowledgeLectureSections ?? []).map((section) => [section.id, section]));
  const pointNames = new Map(course.content.knowledgePoints.map((point) => [point.id, point.name]));
  const accumulators = new Map<string, {
    sectionId: string;
    quizOutlineId: string;
    questionId: string;
    questionNumber: number;
    prompt: string;
    knowledgePointIds: Set<string>;
    answeredStudents: Set<string>;
    correctStudents: Set<string>;
    objectiveCount: number;
    earned: number;
    maxScore: number;
    feedback: string[];
  }>();

  currentKnowledgeQuestionAttempts(course, progress).forEach(({ studentId, attempt }) => {
      if (attempt.gradingSource !== "server") return;
      firstKnowledgeLectureQuestions(attempt).forEach((question, questionIndex) => {
        if (!isValidKnowledgeLectureQuestionGrade(question)) return;
        const id = `${attempt.quizOutlineId}:${question.questionId}`;
        const current = accumulators.get(id) ?? {
          sectionId: attempt.sectionId,
          quizOutlineId: attempt.quizOutlineId,
          questionId: question.questionId,
          questionNumber: questionIndex + 1,
          prompt: question.prompt,
          knowledgePointIds: new Set<string>(),
          answeredStudents: new Set<string>(),
          correctStudents: new Set<string>(),
          objectiveCount: 0,
          earned: 0,
          maxScore: 0,
          feedback: [],
        };
        (question.knowledgePointIds.length ? question.knowledgePointIds : attempt.knowledgePointIds)
          .forEach((knowledgePointId) => current.knowledgePointIds.add(knowledgePointId));
        current.answeredStudents.add(studentId);
        current.earned += question.earned;
        current.maxScore += question.points;
        if (question.correct !== null) current.objectiveCount += 1;
        if (question.correct === true) {
          current.correctStudents.add(studentId);
        } else if (question.feedback.trim()) {
          current.feedback.push(question.feedback.trim());
        }
        accumulators.set(id, current);
      });
  });

  return [...accumulators.entries()].map(([id, item]) => ({
    id,
    sectionId: item.sectionId,
    sectionTitle: sections.get(item.sectionId)?.title ?? "知识讲授小测",
    questionNumber: item.questionNumber,
    prompt: item.prompt,
    knowledgePointNames: [...item.knowledgePointIds].map((knowledgePointId) => pointNames.get(knowledgePointId) ?? knowledgePointId),
    answeredStudents: item.answeredStudents.size,
    correctStudents: item.correctStudents.size,
    accuracy: item.objectiveCount > 0 ? Math.round(item.correctStudents.size / item.objectiveCount * 100) : undefined,
    scoreRate: item.maxScore > 0 ? Math.round(item.earned / item.maxScore * 100) : undefined,
    commonFeedback: item.feedback[0],
  })).sort((left, right) => {
    const leftOrder = sections.get(left.sectionId)?.order ?? 0;
    const rightOrder = sections.get(right.sectionId)?.order ?? 0;
    return leftOrder - rightOrder || left.questionNumber - right.questionNumber;
  });
}
