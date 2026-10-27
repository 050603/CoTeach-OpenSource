"use client";

import { ArrowLeft, BookOpen, History } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AiLearningView } from "@/components/views/student/ai-learning";
import { StudentCourseAnswerReview } from "@/components/classroom/student-course-answer-review";
import { useSession } from "@/lib/session/store";
import type { Course } from "@/lib/session/types";
import { StudentPblEvaluation } from "@/components/evaluation/student-evaluation";

export function StudentClassroomFinishedState({ course }: { course: Course }) {
  const { studentId } = useSession();
  const [tab, setTab] = useState<"lesson" | "answers" | "evaluation">("lesson");
  const [returnParticipationId, setReturnParticipationId] = useState<string>();
  useEffect(() => {
    let disposed = false;
    // Read the optional return context after hydration; no search-param suspense
    // boundary is needed around the real lesson player.
    queueMicrotask(() => {
      const value = new URLSearchParams(window.location.search).get("returnParticipationId");
      if (!disposed) setReturnParticipationId(value && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value) ? value : undefined);
    });
    return () => { disposed = true; };
  }, [course.id]);

  return <div className="flex min-h-0 flex-col gap-4">
    <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] px-4 py-3">
      <div>
        <h1 className="text-lg font-bold text-stone-900">课堂已结束</h1>
        <p className="mt-1 text-sm leading-6 text-stone-600">回看《{course.name}》的 AI 课程、题目、当时的答案与讲解。仅供浏览，不会改变原始学习记录。</p>
      </div>
      {returnParticipationId ? <Link className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--pbl-student-border)] bg-white px-4 text-sm font-semibold text-[var(--pbl-student)]" href={`/student/participations/${encodeURIComponent(returnParticipationId)}`}><ArrowLeft aria-hidden="true" size={16} />返回课堂回顾</Link>
        : course.platformContext?.activityId ? <Link className="inline-flex min-h-11 items-center rounded-lg border border-[var(--pbl-student-border)] bg-white px-4 text-sm font-semibold text-[var(--pbl-student)]" href={`/student/activities/${encodeURIComponent(course.platformContext.activityId)}`}>返回课堂活动</Link> : null}
    </header>
    <nav aria-label="课堂回看" className="flex flex-wrap gap-2">
      {([{ key: "lesson", title: "回看 AI 课程", icon: BookOpen }, { key: "answers", title: "我的作答", icon: History }] as const).map(({ key, title, icon: Icon }) => <button
        aria-pressed={tab === key}
        className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm font-semibold ${tab === key ? "border-[var(--pbl-student)] bg-[var(--pbl-student)] text-white" : "border-stone-200 bg-white text-stone-600"}`}
        key={key} onClick={() => setTab(key)} type="button"
      ><Icon size={17} />{title}</button>)}
      {course.evaluationContractVersion === 2 ? <button aria-pressed={tab === "evaluation"} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm font-semibold ${tab === "evaluation" ? "border-[var(--pbl-student)] bg-[var(--pbl-student)] text-white" : "border-stone-200 bg-white text-stone-600"}`} onClick={() => setTab("evaluation")} type="button">项目评价</button> : null}
    </nav>
    {tab === "evaluation" ? <StudentPblEvaluation course={course} initialTab="results" /> : tab === "lesson" ? <section aria-label="AI 课程回看" className="h-[calc(100dvh-18rem)] min-h-80 overflow-hidden rounded-xl border border-stone-200 bg-white">
      <AiLearningView course={course} />
    </section> : studentId ? <StudentCourseAnswerReview course={course} studentId={studentId} /> : <p className="py-8 text-sm text-stone-600">正在加载本人的作答记录…</p>}
  </div>;
}
