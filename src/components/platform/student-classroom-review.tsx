"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, FileText, History, LockKeyhole, Play, RefreshCw } from "lucide-react";
import { ResilientImage } from "@/components/resilient-image";
import { StudentCourseAnswerReview } from "@/components/classroom/student-course-answer-review";
import { firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";
import type { Course } from "@/lib/session/types";
import { StudentProjectReview, hasStudentProjectRecords } from "./student-project-review";
import { ExperimentQuestionList, type ExperimentDisplayAnswer, type ExperimentDisplayQuestion } from "./experiment-question-card";
import styles from "./student-classroom-review.module.css";

export type ClassroomReviewRecord = {
  participation: { id: string; completedAt: string | null };
  student: { id: string; displayName: string };
  instance: { id: string; title: string; activityId: string; offeringName: string; offeringId: string; runNo: number; coverImageUrl?: string | null };
};
type ReviewData = { course: Course; studentId: string };
type Assessment = { questions: ExperimentDisplayQuestion[]; submission: { answers: Record<string, ExperimentDisplayAnswer>; submittedAt: string } | null };

function dateLabel(value?: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date) : null;
}

/** One read-only home for the actual records retained by this classroom run. */
export function StudentClassroomReview({ record }: { record: ClassroomReviewRecord }) {
  const [tab, setTab] = useState<"lesson" | "answers" | "project">("lesson");
  const [data, setData] = useState<ReviewData>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/courses?courseId=${encodeURIComponent(record.instance.id)}`, { cache: "no-store", signal: controller.signal, headers: { "X-OpenPBL-Role": "student" } })
      .then(async response => {
        const payload = await response.json();
        const course = (payload.courses as Course[] | undefined)?.find(item => item.id === record.instance.id);
        if (!response.ok || !course || typeof payload.studentId !== "string" || !payload.studentId || payload.studentId !== record.student.id || course.status !== "finished") throw new Error(payload.message || "暂时无法读取本次课堂的回顾内容，请重试。");
        if (!controller.signal.aborted) { setData({ course, studentId: payload.studentId }); setError(undefined); }
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "课堂回顾加载失败"); });
    return () => controller.abort();
  }, [record.instance.id, record.student.id, retry]);

  const course = data?.course;
  const classroomId = course?.aiLearningClassroomId || course?.content._openmaicClassroomId;
  const progress = data && course?.aiLearningProgress?.[data.studentId];
  const attempts = firstKnowledgeLectureAttempts(classroomId && progress?.classroomId === classroomId ? progress : undefined);
  const sections = course?.content.knowledgeLectureSections ?? [];
  const hasProject = data ? hasStudentProjectRecords(data.course, data.studentId) : false;
  const ownGroups = new Set((course?.groups ?? []).filter(group => group.members.some(member => member.studentId === data?.studentId)).map(group => group.id));
  const feedback = (course?.feedback ?? []).filter(item => (item.sourceRole ?? "teacher") === "teacher" && item.content.trim()
    && (item.targetType === "course" || item.targetId === data?.studentId || (item.targetType === "group" && ownGroups.has(item.targetId))));
  const playbackHref = `/student/classroom/${encodeURIComponent(record.instance.id)}?returnParticipationId=${encodeURIComponent(record.participation.id)}`;
  const endedAt = dateLabel(record.participation.completedAt);
  const resources = (course?.resources ?? []).filter(resource => resource.stageKey === "ai-learning" && resource.url && /^(?:https?:\/\/|\/api\/uploads\/)/i.test(resource.url));

  return <div className={styles.page}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <div className={styles.context}><span>{record.instance.offeringName}</span><span aria-hidden="true">/</span><span>课堂回顾</span></div>
        <div className={styles.eyebrow}><span>第 {record.instance.runNo} 次课堂</span><span className={styles.readOnly}><LockKeyhole size={12} aria-hidden="true" />已结束 · 只读复习</span></div>
        <h1>{record.instance.title}</h1>
        <p>重新理解课堂知识，对照自己当时的思考。</p>
      </div>
      {record.instance.coverImageUrl ? <div className={styles.cover}><ResilientImage src={record.instance.coverImageUrl} alt={`${record.instance.title}课堂封面`} fill unoptimized className={styles.coverImage} /></div> : null}
    </header>

    {error ? <div className={styles.error} role="alert"><p>{error}</p><button className={styles.secondary} type="button" onClick={() => { setError(undefined); setRetry(value => value + 1); }}><RefreshCw size={15} />重新加载</button></div> : null}
    {!data && !error ? <div className={styles.loading} role="status"><div /><div /><p>正在整理本次课堂记录…</p></div> : null}
    {data && course ? <>
      <nav className={styles.tabs} aria-label="课堂回顾导航">
        {([{ key: "lesson", label: "课程复习", icon: BookOpen }, { key: "answers", label: "我的作答", icon: History }, ...(hasProject ? [{ key: "project", label: "项目回顾", icon: FileText } as const] : [])] as const).map(({ key, label, icon: Icon }) => <button type="button" aria-pressed={tab === key} key={key} onClick={() => setTab(key)}><Icon size={17} aria-hidden="true" />{label}</button>)}
      </nav>

      <div className={`${styles.layout} ${tab !== "lesson" ? styles.fullWidth : ""}`}>
        <div className={styles.main}>
          {tab === "lesson" ? <section aria-label="课程复习">
            <div className={styles.lecture}>
              <div className={styles.lectureIcon}><BookOpen size={27} strokeWidth={1.5} aria-hidden="true" /></div>
              <div className={styles.lectureCopy}><p className={styles.sectionLabel}>第二阶段 · 课堂知识</p><h2>知识讲授</h2><p>{classroomId ? "回到课堂中的讲授页面，自由翻阅课件、播放讲解，也可以随时打开题目解析。" : "本次课堂未保存可回看的 AI 课件，已有作答与项目记录仍可在这里查看。"}</p></div>
              {classroomId ? <Link className={styles.primary} href={playbackHref}><Play size={16} aria-hidden="true" />进入课程回看<ArrowRight size={16} aria-hidden="true" /></Link> : null}
            </div>
            {sections.length ? <div className={styles.sections}>
              <div className={styles.sectionHeading}><h3>本课小节</h3><span>{sections.length} 个小节</span></div>
              <ol className={styles.sectionList}>{sections.map((section, index) => {
                const attempt = attempts.find(item => item.sectionId === section.id || item.quizOutlineId === section.quizOutlineId);
                const points = section.knowledgePointIds.map(id => course.content.knowledgePoints.find(point => point.id === id)?.name).filter(Boolean);
                return <li key={section.id}><span className={styles.sectionNumber}>{String(index + 1).padStart(2, "0")}</span><div><h4>{section.title}</h4>{points.length ? <p>{points.join(" · ")}</p> : null}</div><span className={styles.sectionState}>{attempt ? "已保存作答" : "可回看"}</span></li>;
              })}</ol>
            </div> : null}
            {course.learningObjectives?.length ? <details className={styles.objectives}><summary>回顾本课学习目标</summary><ul>{course.learningObjectives.map((objective, index) => <li key={index}>{objective}</li>)}</ul></details> : null}
            <div className={styles.answerEntry}><div><h3>对照自己的作答</h3><p>{attempts.length ? "按小节查看当时的答案、原题解析与 AI 讲题。" : "已保存的小测答案会在这里呈现；未作答的题目也能在课程回看中浏览。"}</p></div><button className={styles.textAction} type="button" onClick={() => setTab("answers")}>查看我的作答<ArrowRight size={16} aria-hidden="true" /></button></div>
            {feedback.length ? <section className={styles.feedback} aria-label="教师反馈"><div className={styles.sectionHeading}><h3>教师反馈</h3></div>{feedback.map(item => <article key={item.id}><p>{item.content}</p><span>{item.sourceName || "授课教师"}{dateLabel(item.createdAt) ? ` · ${dateLabel(item.createdAt)}` : ""}</span></article>)}</section> : null}
          </section> : tab === "answers" ? <section aria-label="我的作答"><div className={styles.paneHeading}><h2>我的作答</h2><p>保留课堂中当时的答案，结合解析与讲题再次理解。</p></div><StudentCourseAnswerReview course={course} studentId={data.studentId} />{course.experimentPosttestSummary?.enabled ? <SavedAssessments instanceId={course.id} /> : null}</section>
            : hasProject ? <section aria-label="项目回顾"><div className={styles.paneHeading}><h2>项目回顾</h2><p>查看课堂中保存的文档与提交版本。</p></div><StudentProjectReview course={course} studentId={data.studentId} /></section> : null}
        </div>
        {tab === "lesson" ? <aside className={styles.aside} aria-label="课堂回顾信息"><section><h3>本次课堂</h3><dl><div><dt>学习者</dt><dd>{record.student.displayName}</dd></div><div><dt>授课场次</dt><dd>第 {record.instance.runNo} 次</dd></div>{endedAt ? <div><dt>结束日期</dt><dd>{endedAt}</dd></div> : null}</dl></section>{resources.length ? <section><h3>学习资料</h3><ul className={styles.resources}>{resources.map(resource => <li key={resource.id}><a href={resource.url} target="_blank" rel="noreferrer"><FileText size={16} aria-hidden="true" /><span>{resource.title}</span><ArrowRight size={14} aria-hidden="true" /></a></li>)}</ul></section> : null}<p className={styles.note}><LockKeyhole size={15} aria-hidden="true" /><span>播放、翻页和查看讲解均为只读操作，不会覆盖当时的答案或学习进度。</span></p></aside> : null}
      </div>
    </> : null}
  </div>;
}

function SavedAssessments({ instanceId }: { instanceId: string }) {
  const [records, setRecords] = useState<Array<{ phase: "pretest" | "posttest"; assessment: Assessment }>>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all((["pretest", "posttest"] as const).map(async phase => {
      const response = await fetch(`/api/platform/classroom-instances/${encodeURIComponent(instanceId)}/experiment?phase=${phase}`, { cache: "no-store", signal: controller.signal, headers: { "X-OpenPBL-Role": "student" } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "测评记录暂时无法读取");
      return { phase, assessment: payload as Assessment };
    })).then(items => { if (!controller.signal.aborted) { setRecords(items.filter(item => item.assessment.submission)); setError(undefined); } }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "测评记录暂时无法读取"); });
    return () => controller.abort();
  }, [instanceId, retry]);
  if (!records && !error) return <p className={styles.note} role="status">正在读取前后测记录…</p>;
  if (error) return <div className={styles.error} role="alert"><p>{error}</p><button className={styles.secondary} type="button" onClick={() => { setError(undefined); setRetry(value => value + 1); }}>重试读取测评记录</button></div>;
  if (!records?.length) return null;
  return <section className={styles.assessments} aria-label="前后测作答记录"><h3>课前与课后测评</h3>{records.map(({ phase, assessment }) => <details key={phase}><summary>{phase === "pretest" ? "课前前测" : "课后后测"}<span>查看当时的答案</span></summary><ExperimentQuestionList questions={assessment.questions} answers={assessment.submission!.answers} readOnly onAnswerChange={() => undefined} inputNamePrefix={`review-${phase}`} questionIdPrefix={`review-${phase}`} /></details>)}</section>;
}
