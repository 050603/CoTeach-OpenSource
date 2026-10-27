"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, PencilLine, RefreshCw } from "lucide-react";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { teacherActivityEditHref } from "@/lib/platform/activity";
import { readableDesignAnswer } from "@/lib/platform/experiment-design-answer";
import type { ActivityResults } from "@/lib/platform/teacher-activity-results";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 text-sm font-semibold disabled:opacity-50";
const statusLabels = { "not-started": "未开始", "in-progress": "作答中", submitted: "已提交" };

function answerText(value: string | string[] | undefined, type?: string): string {
  if (Array.isArray(value)) return value.join("、");
  if (type === "true-false") return value === "true" ? "正确" : value === "false" ? "错误" : "未作答";
  return value ? readableDesignAnswer(value) : "未作答";
}

function SubmissionAnswers({ submission }: { submission: NonNullable<ActivityResults["students"][number]["submission"]> }) {
  return <div className="space-y-5 border-t border-[var(--pbl-border)] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--pbl-text-muted)]"><span>提交版本 {submission.activityVersion}</span>{submission.objectiveTotal ? <span>客观题 {submission.objectiveScore}/{submission.objectiveTotal}</span> : null}</div>
    {submission.snapshotSource === "legacy" ? <p className="text-xs text-[var(--pbl-warning)]">旧记录未保存题目快照，以下题目来自当前活动配置。</p> : null}
    {submission.answer ? <p className="whitespace-pre-wrap break-words text-sm leading-7">{submission.answer}</p> : null}
    {submission.questions.map((question, index, questions) => <div key={question.id} className="min-w-0 text-sm leading-7">
      {question.group && question.group.id !== questions[index - 1]?.group?.id ? <div className="mb-3 border-l-2 border-[var(--pbl-teacher)] bg-[var(--pbl-bg)] px-3 py-2"><h3 className="font-semibold">{question.group.title}</h3>{question.group.instruction ? <p className="whitespace-pre-wrap text-[var(--pbl-text-muted)]">{question.group.instruction}</p> : null}{question.group.referenceNote ? <p className="mt-2 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{question.group.referenceNote}</p> : null}</div> : null}
      <p className="whitespace-pre-wrap break-words font-medium">{index + 1}. {question.prompt}</p>
      <p className="mt-1 whitespace-pre-wrap break-words">学生作答：{answerText(submission.answers[question.id], question.type)}</p>
      {question.correctAnswer ? <p className="mt-1 whitespace-pre-wrap break-words text-[var(--pbl-text-muted)]">参考答案：{answerText(question.correctAnswer, question.type)}</p> : null}
    </div>)}
    {submission.answers.__skipReason ? <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--pbl-bg)] p-3 text-sm">跳题原因：{answerText(submission.answers.__skipReason)}</p> : null}
  </div>;
}

export default function TeacherActivityResultsPage() {
  const { activityId } = useParams<{ activityId: string }>();
  return <ActivityResultsContent activityId={activityId} key={activityId} />;
}

function ActivityResultsContent({ activityId }: { activityId: string }) {
  const [result, setResult] = useState<ActivityResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ActivityResults["students"][number]["status"]>("all");
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    try {
      const response = await teacherPlatformFetch(`/api/platform/activities/${encodeURIComponent(activityId)}/results`, { cache: "no-store", signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法读取作答结果");
      if (!data.activity || !data.summary || !Array.isArray(data.students)) throw new Error("作答结果格式无效");
      if (!request.signal.aborted) { setResult(data); setError(""); }
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取作答结果");
    } finally { if (!request.signal.aborted) setBusy(false); }
  }, [activityId]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(onVisible, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); controller.current?.abort(); };
  }, [load]);
  const label = result?.activity.type === "Quiz" ? "测验" : "后测";
  const filteredStudents = result?.students.filter((row) => statusFilter === "all" || row.status === statusFilter) ?? [];
  return <TeacherPlatformPage>
    <TeacherPlatformHeader active="classes" backHref={result ? `/teacher/classes/${result.activity.offering.id}` : "/teacher/classes"} backLabel="返回课程" />
    <div className="pbl-workspace-content">
      <section aria-label="学习内容作答结果" className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--pbl-border)] pb-5">
          <div className="min-w-0 flex-1 basis-full sm:basis-0"><p className="text-sm font-semibold text-[var(--pbl-teacher)]">{result ? `${label}结果` : "学习结果"}</p><h1 className="mt-2 break-words text-2xl font-semibold md:text-3xl">{result?.activity.title ?? "作答结果"}</h1>{result ? <p className="mt-2 break-words text-sm text-[var(--pbl-text-muted)]">{result.activity.offering.name} · {result.activity.chapter.title} · {result.activity.questionCount} 题</p> : null}</div>
          <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void load()} type="button"><RefreshCw size={16} />{busy ? "刷新中…" : "刷新结果"}</button>{result ? <Link className={button} href={teacherActivityEditHref(result.activity.offering.id, result.activity.id)}><PencilLine size={16} />编辑内容</Link> : null}</div>
        </header>
        {error ? <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--pbl-danger)]" role="alert"><p>{error}</p><button className={button} onClick={() => void load()} type="button">重新加载</button></div> : null}
        {!result && !error ? <p className="py-12 text-center text-sm text-[var(--pbl-text-muted)]" role="status">正在读取作答结果…</p> : null}
        {result ? <>
          <p className="text-sm text-[var(--pbl-text-muted)]">教学班有效学生 {result.summary.totalStudents} 人 · {result.activity.isOpen ? "当前开放作答" : "当前未开放作答"}。草稿不计入提交人数。</p>
          <dl aria-label="作答人数统计" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {([ ["未开始", result.summary.notStartedCount], ["作答中", result.summary.inProgressCount], ["已提交", result.summary.submittedCount] ] as const).map(([name, count]) => <div className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-5" key={name}><dt className="text-sm text-[var(--pbl-text-muted)]">{name}</dt><dd className="mt-2 text-3xl font-semibold tabular-nums">{count}</dd></div>)}
          </dl>
          <div className="space-y-3">
            <div><h2 className="text-lg font-semibold">学生作答</h2><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">展开已提交学生，查看提交时的题目与正式答案。</p></div>
            <div aria-label="按学生作答状态筛选" className="flex flex-wrap gap-2" role="group">
              {([
                ["all", "全部", result.summary.totalStudents],
                ["not-started", statusLabels["not-started"], result.summary.notStartedCount],
                ["in-progress", statusLabels["in-progress"], result.summary.inProgressCount],
                ["submitted", statusLabels.submitted, result.summary.submittedCount],
              ] as const).map(([status, name, count]) => <button aria-label={`${name}（${count} 人）`} aria-pressed={statusFilter === status} className={`${button} transition-colors aria-pressed:border-[var(--pbl-teacher-border)] aria-pressed:bg-[var(--pbl-teacher-soft)] aria-pressed:text-[var(--pbl-teacher)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-teacher)]`} key={status} onClick={() => setStatusFilter(status)} type="button">{name}<span className="tabular-nums">{count}</span></button>)}
            </div>
            <p className="text-sm text-[var(--pbl-text-muted)]" role="status">显示 {filteredStudents.length} / {result.summary.totalStudents} 名学生</p>
          </div>
          {filteredStudents.length ? <div className="divide-y divide-[var(--pbl-border)] overflow-hidden rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)]">{filteredStudents.map((row) => <div key={row.student.id}>
            {row.submission ? <details><summary className="flex min-h-14 cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3"><span className="min-w-0 break-words font-medium">{row.student.displayName}<small className="ml-2 text-xs text-[var(--pbl-text-muted)]">{row.student.username}</small></span><span className="inline-flex flex-wrap items-center gap-2 text-sm text-[var(--pbl-student)]"><ClipboardCheck size={16} />已提交 · {new Date(row.submission.submittedAt).toLocaleString("zh-CN")}</span></summary><SubmissionAnswers submission={row.submission} /></details> : <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3"><span className="min-w-0 break-words font-medium">{row.student.displayName}</span><span className="text-sm text-[var(--pbl-text-muted)]">{statusLabels[row.status]}</span></div>}
          </div>)}</div> : <p className="py-10 text-center text-sm text-[var(--pbl-text-muted)]">{result.students.length && statusFilter !== "all" ? `暂无“${statusLabels[statusFilter]}”的学生。` : "暂无学生记录。学生加入教学班后将在这里显示。"}</p>}
        </> : null}
      </section>
    </div>
  </TeacherPlatformPage>;
}
