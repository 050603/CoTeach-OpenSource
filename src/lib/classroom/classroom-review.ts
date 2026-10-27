import type { Course } from "@/lib/session/types";
import type { buildTeacherQuestionReview, TeacherQuestionReviewRow } from "./teacher-question-review";
import { teachingOutlines } from "./knowledge-review";

export type ClassroomReviewChapter = {
  id: string;
  title: string;
  sectionId?: string;
  knowledgePointIds: string[];
  pageIds: string[];
  questions: TeacherQuestionReviewRow[];
};

/** Use saved chapter identities and page bindings; unknown submissions remain separate. */
export function classroomReviewChapters(course: Course, review: ReturnType<typeof buildTeacherQuestionReview>): ClassroomReviewChapter[] {
  if (!course.content.knowledgeLectureSections?.length) return [{ id: "all", title: "课堂内容", knowledgePointIds: [], pageIds: teachingOutlines(course).map((outline) => outline.id), questions: review.rows }];
  const chapters: ClassroomReviewChapter[] = [...(course.content.knowledgeLectureSections ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((section) => ({ id: `section:${section.id}`, sectionId: section.id, title: section.title,
      knowledgePointIds: section.knowledgePointIds ?? [], pageIds: section.sceneOutlineIds ?? [],
      questions: review.rows.filter((row) => row.sectionId === section.id) }));
  const known = new Set(chapters.map((chapter) => chapter.sectionId));
  const unknown = [...new Set(review.rows.map((row) => row.sectionId).filter((id) => !known.has(id)))].sort();
  unknown.forEach((sectionId, index) => chapters.push({ id: `section:${sectionId}`, sectionId,
    title: !sectionId ? "未归属章节" : unknown.length === 1 ? "其他作答" : `其他作答 ${index + 1}`, knowledgePointIds: [], pageIds: [],
    questions: review.rows.filter((row) => row.sectionId === sectionId) }));
  return chapters;
}

export function initialClassroomReviewChapter(chapters: ClassroomReviewChapter[]): ClassroomReviewChapter {
  return chapters.find((chapter) => chapter.questions.some((row) => row.incorrectCount > 0))
    ?? chapters.find((chapter) => chapter.questions.length > 0) ?? chapters[0];
}
