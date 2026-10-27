"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { BookOpenText, ChevronDown, MessageCircleQuestion } from "lucide-react";
import { KnowledgeLectureBoard } from "@/components/views/student/knowledge-lecture-board";
import { firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";
import { renderQuizMathText } from "@/lib/openmaic/quiz/math-text";
import type { Course, KnowledgeLectureQuestionReview } from "@/lib/session/types";

function ReviewText({ text }: { text: string }) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{segments.map((segment, index) => segment.type === "text"
    ? <span key={index}>{segment.value}</span>
    : <span className={segment.displayMode ? "block overflow-x-auto [&_.katex-display]:!my-2" : "inline-block align-baseline"}
      dangerouslySetInnerHTML={{ __html: segment.html }} key={index} />)}</span>;
}

function answerText(question: KnowledgeLectureQuestionReview): string {
  const raw = question.rawAnswer ?? question.answer;
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter(value => value.trim()).map(value => {
    const option = question.options?.find(item => item.value === value);
    return option ? `${value}. ${option.label}` : value;
  }).join("、");
}

export function StudentCourseAnswerReview({ course, studentId, role = "student" }: { course: Course; studentId: string; role?: "student" | "teacher" }) {
  const teacher = role === "teacher";
  const reviewStyle = teacher ? { "--pbl-student": "var(--pbl-teacher)", "--pbl-student-soft": "var(--pbl-teacher-soft)", "--pbl-student-border": "var(--pbl-border)" } as CSSProperties : undefined;
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const saved = course.aiLearningProgress?.[studentId];
  const progress = classroomId && saved?.classroomId === classroomId ? saved : undefined;
  const attempts = useMemo(() => {
    const sectionOrder = new Map((course.content.knowledgeLectureSections ?? []).map((section, index) => [section.id, index]));
    return firstKnowledgeLectureAttempts(progress).sort((left, right) =>
      (sectionOrder.get(left.sectionId) ?? Number.MAX_SAFE_INTEGER) - (sectionOrder.get(right.sectionId) ?? Number.MAX_SAFE_INTEGER));
  }, [course.content.knowledgeLectureSections, progress]);
  const scope = JSON.stringify([course.id, classroomId, studentId]);
  const [selection, setSelection] = useState<{ scope: string; attemptId: string }>();
  const [review, setReview] = useState<{ scope: string; attemptId: string; questionId: string }>();
  const active = attempts.find(attempt => selection?.scope === scope && attempt.id === selection.attemptId) ?? attempts[0];
  const reviewedAttempt = review?.scope === scope ? attempts.find(attempt => attempt.id === review.attemptId) : undefined;
  const names = useMemo(() => new Map((course.content.knowledgePoints ?? []).map(point => [point.id, point.name])), [course.content.knowledgePoints]);
  const sectionTitle = (sectionId: string) => course.content.knowledgeLectureSections?.find(section => section.id === sectionId)?.title || "课堂小测";

  if (!attempts.length) return <section aria-label={teacher ? "学生作答记录" : "我的作答记录"} style={reviewStyle} className="border-t border-[var(--pbl-border)] py-12 text-center">
    <BookOpenText aria-hidden="true" className="mx-auto text-[var(--pbl-text-muted)]" size={28} />
    <h2 className="mt-4 text-lg font-semibold">还没有保存的作答记录</h2>
    <p className="mx-auto mt-2 max-w-lg text-sm leading-7 text-[var(--pbl-text-muted)]">{teacher ? "本次课堂没有保存该学生的小测作答记录。" : "本次课堂没有保存小测作答记录。仍可在课程复习中浏览题目、解析与讲解。"}</p>
  </section>;

  return <section aria-label={teacher ? "学生作答记录" : "我的作答记录"} style={reviewStyle} className="grid min-w-0 gap-6 lg:grid-cols-[minmax(12rem,15rem)_minmax(0,1fr)] lg:gap-10">
    <aside className="min-w-0">
      <p className="text-xs font-semibold tracking-wide text-[var(--pbl-text-muted)]">按小节回顾</p>
      <nav aria-label="作答小节" className="mt-3 flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
        {attempts.map((attempt, index) => <button aria-current={active.id === attempt.id ? "true" : undefined}
          className={`flex min-h-14 shrink-0 items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors lg:w-full ${active.id === attempt.id ? "border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]" : "border-transparent text-[var(--pbl-text-muted)] hover:bg-[var(--pbl-bg)]"}`}
          key={attempt.id} onClick={() => setSelection({ scope, attemptId: attempt.id })} type="button">
          <span aria-hidden="true" className="pt-0.5 text-xs tabular-nums">{String(index + 1).padStart(2, "0")}</span>
          <span className="min-w-0"><span className="block max-w-56 whitespace-normal text-sm font-semibold leading-6">{sectionTitle(attempt.sectionId)}</span><span className="mt-1 block text-xs opacity-75">{attempt.questions.length} 道题</span></span>
        </button>)}
      </nav>
    </aside>
    <div className="min-w-0">
      <header className="border-b border-[var(--pbl-border)] pb-5">
        <h2 className="text-xl font-semibold text-[var(--pbl-text)]">{sectionTitle(active.sectionId)}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">已保存的首次作答 · {active.questions.length} 道题。展开原题查看答案与解析。</p>
      </header>
      <ol className="divide-y divide-[var(--pbl-border)]" key={`${scope}:${active.id}`}>
        {active.questions.map((question, index) => {
          const answer = answerText(question);
          const raw = question.rawAnswer ?? question.answer;
          const selectedValues = Array.isArray(raw) ? raw : [raw];
          const analysis = [question.authoredAnalysis, question.referenceAnswer !== question.authoredAnalysis ? question.referenceAnswer : undefined].filter(Boolean).join("\n\n");
          return <li key={question.questionId}>
            <details className="group" open={index === 0}>
              <summary className="flex min-h-16 cursor-pointer list-none items-start gap-3 py-5 [&::-webkit-details-marker]:hidden">
                <span className="pt-0.5 text-xs font-medium tabular-nums text-[var(--pbl-text-muted)]">{String(index + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1"><span className="line-clamp-2 text-sm font-semibold leading-7"><ReviewText text={question.prompt} /></span><span className="mt-1 block text-xs text-[var(--pbl-text-muted)]">{answer ? "查看当时的答案" : "当时未作答"}</span></span>
                <ChevronDown aria-hidden="true" className="mt-1 shrink-0 text-[var(--pbl-text-muted)] transition-transform group-open:rotate-180" size={17} />
              </summary>
              <div className="space-y-5 pb-6 pl-6 sm:pl-7">
                <div className="text-sm leading-7"><ReviewText text={question.prompt} /></div>
                {question.options?.length ? <ul aria-label="原题选项" className="grid gap-2 sm:grid-cols-2">{question.options.map(option => <li
                  className={`rounded-lg border px-3 py-2 text-sm leading-6 ${selectedValues.includes(option.value) ? "border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)]" : "border-[var(--pbl-border)]"}`} key={option.value}>
                  <span className="mr-2 font-semibold">{option.value}.</span><ReviewText text={option.label} />
                  {selectedValues.includes(option.value) ? <span className="ml-2 text-xs font-semibold text-[var(--pbl-student)]">当时选择</span> : null}
                </li>)}</ul> : null}
                {question.matchingOptions ? <div aria-label="原题匹配项" className="grid grid-cols-2 gap-4 text-sm leading-7">
                  {([{ label: "左侧项目", values: question.matchingOptions.left }, { label: "右侧候选", values: question.matchingOptions.right }] as const).map(column => <div key={column.label}><p className="mb-2 text-xs font-semibold text-[var(--pbl-text-muted)]">{column.label}</p><ul className="space-y-2">{column.values.map((value, itemIndex) => <li className="rounded-lg bg-[var(--pbl-bg)] px-3 py-2" key={itemIndex}><ReviewText text={value} /></li>)}</ul></div>)}
                </div> : null}
                <div className="border-l-2 border-[var(--pbl-student)] bg-[var(--pbl-student-soft)] px-4 py-3">
                  <p className="text-xs font-semibold text-[var(--pbl-student)]">当时的答案</p>
                  <p className="mt-2 text-sm leading-7"><ReviewText text={answer || "当时未作答"} /></p>
                </div>
                {question.feedback || analysis ? <dl className="grid gap-5 text-sm leading-7 xl:grid-cols-2">
                  {question.feedback ? <div><dt className="mb-2 text-xs font-semibold text-[var(--pbl-text-muted)]">批阅反馈</dt><dd><ReviewText text={question.feedback} /></dd></div> : null}
                  {analysis ? <div><dt className="mb-2 text-xs font-semibold text-[var(--pbl-text-muted)]">题目解析</dt><dd><ReviewText text={analysis} /></dd></div> : null}
                </dl> : null}
                {!teacher ? <button className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--pbl-student-border)] px-4 text-sm font-semibold text-[var(--pbl-student)] transition-colors hover:bg-[var(--pbl-student-soft)]"
                  onClick={() => setReview({ scope, attemptId: active.id, questionId: question.questionId })} type="button"><MessageCircleQuestion aria-hidden="true" size={17} />AI 讲题 · 第 {index + 1} 题</button> : null}
              </div>
            </details>
          </li>;
        })}
      </ol>
    </div>
    {!teacher && reviewedAttempt && review ? <KnowledgeLectureBoard attempt={reviewedAttempt} courseId={course.id} studentId={studentId}
      initialQuestionId={review.questionId} initialThreads={progress?.knowledgeLectureTutorThreads ?? []}
      knowledgePointNames={names} key={`${scope}:${reviewedAttempt.id}:${review.questionId}`} readOnly onClose={() => setReview(undefined)} /> : null}
  </section>;
}
