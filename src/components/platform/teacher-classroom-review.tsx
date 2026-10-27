"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Award, BookOpen, FileText, History, MessagesSquare, RefreshCw } from "lucide-react";
import { StudentCourseAnswerReview } from "@/components/classroom/student-course-answer-review";
import { TeacherEvaluationWorkspace } from "@/components/evaluation/teacher-evaluation";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import { browserRandomUUID } from "@/lib/browser/random-uuid";
import { firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";
import type { Course } from "@/lib/session/types";
import { StudentProjectReview } from "./student-project-review";
import { TeacherProjectCollaboration } from "./teacher-project-collaboration";
import type { CollaborationRecord } from "@/lib/platform/teacher-collaboration-records";
import styles from "./teacher-classroom-review.module.css";

export type TeacherClassroomReviewRecord = {
  participation: { id: string; completedAt: string | null; firstEnteredAt?: string | null; lastEnteredAt?: string | null };
  student: { id: string; displayName: string };
  instance: { id: string; status: string; title: string; offeringName: string; runNo: number };
};

async function teacherRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await boundedFetch(url, { ...options, cache: "no-store", headers: { "X-OpenPBL-Role": "teacher", ...options.headers } }, 20_000);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.message ?? data?.error?.message ?? "记录暂时无法读取，请重试。");
  return data as T;
}

function useTeacherRecord<T>(url: string, read: (url: string, signal: AbortSignal) => Promise<T>) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ url: string; data?: T; error?: string }>();
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const data = await read(url, controller.signal);
        if (!controller.signal.aborted) setState({ url, data });
      } catch (reason) {
        if (!controller.signal.aborted) setState(previous => ({ url, data: previous?.url === url ? previous.data : undefined, error: reason instanceof Error ? reason.message : "记录读取失败，请重试。" }));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    });
    return () => controller.abort();
  }, [url, read, revision]);
  return { data: state?.url === url ? state.data : undefined, error: state?.url === url ? state.error : undefined, loading, refresh };
}

async function readCourse(url: string, signal: AbortSignal) {
  const response = await teacherRequest<{ courses?: Course[] }>(url, { signal });
  const instanceId = new URL(url, "https://coteach.local").searchParams.get("courseId");
  const course = response.courses?.find(item => item.id === instanceId);
  if (!course || !Array.isArray(course.students) || !Array.isArray(course.stages) || !course.content) throw new Error("本场课堂记录暂不可用，请重新加载。");
  return course;
}

function dateLabel(value?: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date) : "暂无记录";
}

function ReadError({ message, retry }: { message: string; retry: () => void }) {
  return <div className={styles.error} role="alert"><p>{message}</p><button type="button" className={styles.button} onClick={retry}><RefreshCw size={15} aria-hidden />重新加载</button></div>;
}

export function TeacherClassroomReview({ record }: { record: TeacherClassroomReviewRecord }) {
  const { data: course, error, loading, refresh } = useTeacherRecord(`/api/courses?courseId=${encodeURIComponent(record.instance.id)}`, readCourse);
  const [tab, setTab] = useState<"process" | "answers" | "project" | "evaluation">("process");
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const student = course?.students.find(item => item.id === record.student.id);
  const classroomId = course?.aiLearningClassroomId || course?.content._openmaicClassroomId;
  const progress = course?.aiLearningProgress?.[record.student.id];
  const attempts = firstKnowledgeLectureAttempts(classroomId && progress?.classroomId === classroomId ? progress : undefined);
  const reflections = course?.reflections?.filter(item => item.studentId === record.student.id) ?? [];
  const groups = new Set(course?.groups?.filter(group => group.members.some(member => member.studentId === record.student.id)).map(group => group.id));
  const feedback = course?.feedback?.filter(item => (item.sourceRole ?? "teacher") === "teacher" && item.content.trim()
    && (item.targetType === "course" || item.targetType === "student" && item.targetId === record.student.id || item.targetType === "group" && groups.has(item.targetId))) ?? [];

  return <div className={styles.page}>
    <header className={styles.header}>
      <div className={styles.heading}><p className={styles.context}>{record.instance.offeringName} · 第 {record.instance.runNo} 次课堂</p><h1>{record.student.displayName}的课堂档案</h1><p>{record.instance.title}</p></div>
      <div className={styles.headerActions}><span className={styles.status}>{record.instance.status === "teaching" ? "授课中" : record.instance.status === "finished" ? "课堂已结束" : "尚未开课"}</span><button className={styles.button} type="button" disabled={loading} onClick={refresh}><RefreshCw size={15} aria-hidden />{loading ? "读取中…" : "刷新记录"}</button></div>
    </header>
    {error ? <ReadError message={error} retry={refresh} /> : null}
    {!course && !error ? <p className={styles.empty} role="status">正在整理本场课堂的学习记录…</p> : null}
    {course ? <>
      <nav className={styles.tabs} aria-label="学生课堂档案导航">{([
        ["process", "学习过程", BookOpen], ["answers", "课堂作答", History], ["project", "项目成果", FileText], ["evaluation", "评价反馈", Award],
      ] as const).map(([key, label, Icon]) => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}><Icon size={17} aria-hidden />{label}</button>)}</nav>
      {tab === "process" ? <div className={styles.processLayout}>
        <div className={styles.main}>
          <section aria-label="阶段学习进度"><div className={styles.sectionHeading}><div><h2>阶段学习进度</h2><p>完成情况来自本场课堂的学习记录。</p></div></div>
            <ol className={styles.stages}>{course.stages.map((stage, index) => {
              const value = student?.stageProgress?.[stage.key];
              const saved = typeof value === "number" && Number.isFinite(value);
              const percent = saved ? Math.max(0, Math.min(100, value)) : 0;
              return <li key={stage.key}><span className={styles.number}>{String(index + 1).padStart(2, "0")}</span><div><h3>{stage.label}</h3><div className={styles.track} role={saved ? "progressbar" : undefined} aria-label={saved ? stage.label : undefined} aria-valuenow={saved ? percent : undefined} aria-valuemin={saved ? 0 : undefined} aria-valuemax={saved ? 100 : undefined}><span style={{ width: `${percent}%` }} /></div></div><span className={styles.progressLabel}>{saved ? percent >= 100 ? "已完成" : `${Math.round(percent)}%` : "暂无进度记录"}</span></li>;
            })}</ol><p className={styles.note}>阶段进度表示完成情况，不能代替知识掌握程度或评价分数。</p>
          </section>
          <section className={styles.section} aria-label="课堂知识学习"><div className={styles.sectionHeading}><div><h2>课堂知识学习</h2><p>已保存 {attempts.length} 个小节的首次作答。</p></div><button className={styles.button} type="button" onClick={() => setTab("answers")}>查看课堂作答</button></div>
            {course.content.knowledgeLectureSections?.length ? <ul className={styles.sectionList}>{course.content.knowledgeLectureSections.map(section => <li key={section.id}><span>{section.title}</span><span>{attempts.some(item => item.sectionId === section.id || item.quizOutlineId === section.quizOutlineId) ? "已保存作答" : "暂无作答记录"}</span></li>)}</ul> : <p className={styles.note}>本场未保存知识讲授小节目录。</p>}
          </section>
          <details className={styles.section} onToggle={event => setCollaborationOpen(event.currentTarget.open)}><summary className={styles.summary}><MessagesSquare size={18} aria-hidden />项目协作记录<span>查看讨论与求助</span></summary>{collaborationOpen ? <ProjectCollaboration key={record.participation.id} participationId={record.participation.id} stages={Object.fromEntries(course.stages.map(stage => [stage.key, stage.label]))} /> : null}</details>
        </div>
        <aside className={styles.aside} aria-label="本场参与信息"><h2>本场参与</h2><dl><div><dt>首次进入</dt><dd>{dateLabel(record.participation.firstEnteredAt)}</dd></div><div><dt>最近进入</dt><dd>{dateLabel(record.participation.lastEnteredAt)}</dd></div>{record.participation.completedAt ? <div><dt>课堂结束</dt><dd>{dateLabel(record.participation.completedAt)}</dd></div> : null}</dl><p className={styles.note}>浏览档案不会修改学生的作答、作品或学习进度。</p></aside>
      </div> : tab === "answers" ? <section className={styles.pane} aria-label="课堂作答"><StudentCourseAnswerReview course={course} studentId={record.student.id} role="teacher" /></section>
        : tab === "project" ? <section className={styles.pane} aria-label="项目成果"><StudentProjectReview course={course} studentId={record.student.id} role="teacher" /></section>
          : <section className={styles.pane} aria-label="评价反馈">
            {course.evaluationContractVersion === 2 ? <TeacherEvaluationWorkspace course={course} participationId={record.participation.id} onEvaluationChange={refresh} /> : <LegacyTeacherEvaluation participationId={record.participation.id} classroomStatus={record.instance.status} onChange={refresh} />}
            {feedback.length ? <section className={styles.section} aria-label="课堂教师反馈"><h2>课堂教师反馈</h2>{feedback.map(item => <article className={styles.record} key={item.id}><p>{item.content}</p><small>{item.sourceName || "授课教师"} · {dateLabel(item.createdAt)}</small></article>)}</section> : null}
            {reflections.length ? <section className={styles.section} aria-label="学习反思"><h2>学习反思</h2>{reflections.map(item => <article className={styles.record} key={item.id}><p>{item.content}</p>{item.improvementPlan ? <p>改进计划：{item.improvementPlan}</p> : null}<small>{dateLabel(item.createdAt)}</small></article>)}</section> : null}
          </section>}
    </> : null}
  </div>;
}

async function readCollaboration(url: string, signal: AbortSignal) {
  const result = await teacherRequest<CollaborationRecord>(url, { signal });
  if (!Array.isArray(result.conversations) || !Array.isArray(result.supportRecords)) throw new Error("项目协作记录不完整，请重试。");
  return result;
}
function ProjectCollaboration({ participationId, stages }: { participationId: string; stages: Record<string, string> }) {
  const { data, error, loading, refresh } = useTeacherRecord(`/api/platform/participations/${encodeURIComponent(participationId)}/ai`, readCollaboration);
  return <div className={styles.collaboration}>
    {error ? <ReadError message={error} retry={refresh} /> : null}
    {!data && loading && !error ? <p role="status">正在读取项目协作记录…</p> : null}
    {data ? <TeacherProjectCollaboration data={data} stages={stages} loading={loading} refresh={refresh} /> : null}
  </div>;
}

type LegacyEvaluation = { id: string; evaluatorType: string; type?: string; content: string; score: number | string | null; createdAt?: string };
async function readLegacyEvaluation(url: string, signal: AbortSignal) {
  const result = await teacherRequest<{ evaluations: LegacyEvaluation[] }>(url, { signal });
  if (!Array.isArray(result.evaluations)) throw new Error("评价记录不完整，请重试。");
  return result.evaluations.filter(item => !item.type?.startsWith("PBL_"));
}
function LegacyTeacherEvaluation({ participationId, classroomStatus, onChange }: { participationId: string; classroomStatus: string; onChange: () => void }) {
  const endpoint = `/api/platform/participations/${encodeURIComponent(participationId)}/outcomes`;
  const { data, error, refresh } = useTeacherRecord(endpoint, readLegacyEvaluation);
  const [content, setContent] = useState("");
  const [score, setScore] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<{ signature: string; id: string } | null>(null);
  const save = async () => {
    if (saving) return;
    setSaving(true); setSaveError(""); setNotice("");
    const body = { action: "evaluate", content: content.trim(), ...(score !== "" ? { score: Number(score) } : {}) };
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, id: browserRandomUUID() };
    try {
      await teacherRequest(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idempotencyKey: pending.current.id }) });
      pending.current = null; setContent(""); setScore(""); setNotice("评价已保存"); refresh(); onChange();
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : "评价未保存，请重试。"); }
    finally { setSaving(false); }
  };
  return <section aria-label="教师评价"><div className={styles.sectionHeading}><h2>教师评价</h2><button className={styles.button} type="button" onClick={refresh}>刷新评价</button></div>
    {error ? <ReadError message={error} retry={refresh} /> : null}{!data && !error ? <p role="status">正在读取评价记录…</p> : null}
    {data ? <>{data.length ? data.map(item => <article className={styles.record} key={item.id}><h3>{item.evaluatorType === "TEACHER" ? "教师评价" : "学生评价"}{item.score !== null ? ` · ${item.score} 分` : ""}</h3><p>{item.content}</p><small>{dateLabel(item.createdAt)}</small></article>) : <p className={styles.note}>教师暂未提交评价。</p>}
      {["teaching", "finished"].includes(classroomStatus) ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}><label className={styles.field}>评价内容<textarea required maxLength={30000} value={content} onChange={event => setContent(event.target.value)} /></label><label className={styles.field}>评分（可选，0–100）<input type="number" min={0} max={100} step="0.01" value={score} onChange={event => setScore(event.target.value)} /></label>{saveError ? <p className={styles.error} role="alert">{saveError}</p> : null}{notice ? <p role="status">{notice}</p> : null}<button className={styles.primary} type="submit" disabled={saving || !content.trim()}>{saving ? "保存中…" : "保存评价"}</button></form> : <p className={styles.note}>课堂开始后可填写评价。</p>}
    </> : null}
  </section>;
}
