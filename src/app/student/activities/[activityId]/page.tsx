"use client";

import { StudentShell } from "@/components/platform/student-shell";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { activityTypeLabel, progressStatusLabel } from "@/lib/platform/labels";

import { StudentClassroomDetail, StudentClassroomDetailSkeleton } from "@/components/platform/student-classroom-detail";
import type { StudentClassroomActivity } from "@/components/platform/student-classroom-detail.types";
import { SurveyQuestionFields } from "@/components/platform/survey-question-fields";
import { surveyTextAnswer, type SurveyAnswer, type SurveyQuestion } from "@/lib/platform/survey";
import { StudentExperimentAssessment } from "@/components/platform/student-experiment-assessment";
import { StudentSurveyExperience } from "@/components/platform/student-survey-experience";
import { StudentPdfResourceViewer } from "@/components/classroom/simple-stage-resources";
type Activity = StudentClassroomActivity & { type: string; description: string | null; config?: { content?: string; url?: string; resourceKind?: "link" | "file"; fileName?: string; questions?: SurveyQuestion[] }; progress: { status: string; progressData?: { answer?: string; answers?: Record<string, SurveyAnswer> } } };

async function fetchActivity(activityId: string, signal: AbortSignal): Promise<Activity> {
  const response = await fetch(`/api/platform/activities/${activityId}`, { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "无法加载活动");
  return data.activity as Activity;
}

export default function StudentActivityPage() {
  const params = useParams<{ activityId: string }>();
  return <StudentActivityContent key={params.activityId} activityId={params.activityId} />;
}

function StudentActivityContent({ activityId }: { activityId: string }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answers, setAnswers] = useState<Record<string, SurveyAnswer>>({});
  const [saved, setSaved] = useState(false);
  const recordingResource = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchActivity(activityId, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setActivity(data);
      setAnswer(data.progress?.progressData?.answer ?? "");
      setAnswers(data.progress?.progressData?.answers ?? {});
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "加载失败");
    });
    return () => controller.abort();
  }, [activityId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !activity?.isOpen) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const response = await fetch(`/api/platform/activities/${activity.id}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer, answers }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "提交失败");
      setActivity({ ...activity, progress: { status: "completed", progressData: data.progress.progressData } }); setSaved(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "提交失败，请重试"); }
    finally { setBusy(false); }
  }

  async function recordResourceOpen(resource: Activity) {
    if (recordingResource.current === resource.id || resource.progress.status === "completed" || !resource.isOpen || resource.offering.status !== "open") return;
    recordingResource.current = resource.id;
    setError(null);
    try {
      const response = await fetch(`/api/platform/activities/${resource.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "学习记录保存失败");
      setActivity((current) => current?.id === resource.id
        ? { ...current, progress: { status: "completed", progressData: data.progress.progressData } }
        : current);
    } catch (reason) {
      recordingResource.current = null;
      setError(reason instanceof Error ? reason.message : "学习记录保存失败，请重试");
    }
  }

  useEffect(() => {
    if (activity?.type !== "Resource" || activity.config?.url || !activity.config?.content?.trim()) return;
    const frame = window.requestAnimationFrame(() => void recordResourceOpen(activity));
    return () => window.cancelAnimationFrame(frame);
  }, [activity]);

  if (error && !activity) return <StudentShell backHref="/student?all=1" backLabel="返回我的课程"><section className="mx-auto max-w-2xl py-20"><h1 className="text-xl font-semibold">暂时无法打开活动</h1><p role="alert" className="mt-3 text-sm text-[var(--pbl-danger)]">{error}</p><button type="button" className="mt-6 min-h-11 rounded-xl bg-[var(--pbl-student)] px-6 text-sm font-semibold text-white" onClick={() => window.location.reload()}>重新加载</button></section></StudentShell>;
  if (!activity || activity.id !== activityId) return <StudentShell backHref="/student?all=1" backLabel="返回我的课程"><StudentClassroomDetailSkeleton /></StudentShell>;
  const classroom = activity.type.toUpperCase() === "CLASSROOM";
  if (activity.type === "PostTest") return <StudentShell focus>
    <div className="min-h-screen w-full pb-5 [--assessment-gutter:1rem] sm:[--assessment-gutter:1.5rem] lg:[--assessment-gutter:2rem] xl:[--assessment-gutter:2.5rem]">
      <header className="bg-white pb-4 pt-5">
        <nav aria-label="测验导航" className="mx-[var(--assessment-gutter)] flex min-h-11 items-center justify-between gap-4 border-b border-[var(--pbl-border)] pb-4"><Link className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-[var(--pbl-student)] hover:bg-[var(--pbl-student-soft)]" href={`/student/courses/${activity.offering.id}`}>← 返回课程</Link><span className="text-sm font-semibold text-[var(--pbl-text-muted)]">后测</span></nav>
        <div className="mx-auto max-w-[1120px] px-[var(--assessment-gutter)] pt-4"><h1 className="text-2xl font-bold md:text-3xl">{activity.title}</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p></div>
      </header>
      <StudentExperimentAssessment activityId={activity.id} layout="full" phase="posttest" />
    </div>
  </StudentShell>;
  if (activity.type === "Form") return <StudentSurveyExperience activity={activity} answers={answers} busy={busy} error={error} saved={saved} onAnswersChange={(next) => { setAnswers(next); setSaved(false); }} onSubmit={submit} />;
  if (activity.type === "Resource") {
    const resourceUrl = activity.config?.url;
    const uploadedPdf = Boolean(resourceUrl && /^\/api\/uploads\/[0-9a-f-]+$/i.test(resourceUrl));
    const externalLink = resourceUrl && /^https?:\/\//i.test(resourceUrl);
    if (uploadedPdf && resourceUrl) return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程" contentClassName="pbl-student-resource-layout">
      <section className="pbl-student-resource-page">
        <header className="pbl-student-resource-header">
          <div className="pbl-student-resource-heading">
            <div className="min-w-0">
              <h1>{activity.title}</h1>
              <p className="pbl-student-resource-context"><span>{activity.offering.name} · {activity.chapter.title}</span><span>{activity.progress.status === "completed" ? "已学习" : progressStatusLabel(activity.progress.status)}</span></p>
            </div>
            {activity.isOpen ? <a className="pbl-student-resource-download" download={activity.config?.fileName || true} href={`${resourceUrl}?download=1`}><Download aria-hidden="true" size={16} />下载文件</a> : null}
          </div>
          {activity.description ? <p className="pbl-student-resource-description">{activity.description}</p> : null}
          {!activity.isOpen ? <p className="mt-3 text-sm" role="status">此任务尚未解锁，请等待教师开放。</p> : <>
            {activity.config?.content ? <div className="pbl-student-resource-description">{activity.config.content}</div> : null}
            {error ? <div className="mt-2" role="alert"><p className="text-sm text-[var(--pbl-danger)]">{error}</p><button className="min-h-11 text-sm font-semibold text-[var(--pbl-student)] underline" onClick={() => void recordResourceOpen(activity)} type="button">重试保存学习记录</button></div> : null}
            {activity.offering.status !== "open" ? <p className="mt-2 text-xs text-[var(--pbl-text-muted)]">课程已结束，可查看学习资料。</p> : null}
          </>}
        </header>
        {activity.isOpen ? <div aria-label="PDF 阅读区域" className="pbl-student-resource-viewer" role="region">
          <StudentPdfResourceViewer key={activity.id} onReady={() => void recordResourceOpen(activity)} progressKey={`activity:${activity.id}`} title={activity.config?.fileName || activity.title} url={resourceUrl} />
        </div> : null}
      </section>
    </StudentShell>;
    return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程">
      <div className="mx-auto max-w-3xl">
        <section className="pbl-content-card p-5 md:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="rounded-full bg-[var(--pbl-bg)] px-3 py-1 text-xs font-bold text-[var(--pbl-student)]">{activityTypeLabel(activity.type)}</span>
            <span className="text-xs font-semibold text-[var(--pbl-text-muted)]">{activity.progress.status === "completed" ? "已学习" : progressStatusLabel(activity.progress.status)}</span>
          </div>
          <h1 className="mt-4 text-2xl font-bold md:text-3xl">{activity.title}</h1>
          <p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p>
          {activity.description ? <p className="mt-5 whitespace-pre-wrap text-sm leading-7">{activity.description}</p> : null}
          {!activity.isOpen ? <p className="mt-6" role="status">此任务尚未解锁，请等待教师开放。</p> : <>
            {activity.config?.content ? <div className="mt-6 whitespace-pre-wrap text-sm leading-8">{activity.config.content}</div> : null}
            {externalLink ? <a className="mt-6 inline-flex min-h-11 items-center text-[var(--pbl-student)] underline underline-offset-4" href={resourceUrl} onClick={() => void recordResourceOpen(activity)} rel="noopener noreferrer" target="_blank">打开参考资料 ↗</a> : null}
            {error ? <div className="mt-4" role="alert"><p className="text-sm text-[var(--pbl-danger)]">{error}</p><button className="mt-2 text-sm font-semibold text-[var(--pbl-student)] underline" onClick={() => void recordResourceOpen(activity)} type="button">重试保存学习记录</button></div> : null}
            {activity.offering.status !== "open" ? <p className="mt-4 text-sm text-[var(--pbl-text-muted)]">课程已结束，可查看学习资料。</p> : null}
          </>}
        </section>
      </div>
    </StudentShell>;
  }
  if (classroom) return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程"><StudentClassroomDetail key={activity.id} initialActivity={activity} /></StudentShell>;
  return <StudentShell backHref={`/student/courses/${activity.offering.id}`} backLabel="返回课程"><div className="mx-auto max-w-3xl"><section className="pbl-content-card p-6 md:p-10"><div className="flex items-center justify-between gap-3"><span className="rounded-full bg-[var(--pbl-bg)] px-3 py-1 text-xs font-bold text-[var(--pbl-student)]">{activityTypeLabel(activity.type)}</span><span className="text-xs font-semibold text-[var(--pbl-text-muted)]">{progressStatusLabel(activity.progress.status)}</span></div><h1 className="mt-5 text-3xl font-bold">{activity.title}</h1><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{activity.offering.name} · {activity.chapter.title}</p>{activity.description && !(activity.type === "Form" && activity.description === activity.config?.content) ? <p className="mt-6 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text)]">{activity.description}</p> : null}<form className="mt-8 space-y-6 border-t border-[var(--pbl-border)] pt-6" onSubmit={submit}>
          {!activity.isOpen ? <p role="status">此任务尚未解锁，请等待教师开放。</p> : <>
            {activity.config?.content && <div className="whitespace-pre-wrap text-sm leading-8">{activity.config.content}</div>}
            {activity.config?.url && (/^https?:\/\//i.test(activity.config.url) || /^\/api\/uploads\/[0-9a-f-]+$/i.test(activity.config.url)) && <a href={activity.config.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[var(--pbl-student)] underline underline-offset-4">{activity.config.resourceKind === "file" ? `打开 ${activity.config.fileName || "PDF 参考资料"}` : "打开参考资料"} ↗</a>}
            {activity.type !== "Resource" && (activity.config?.questions?.length ? activity.type === "Form" ? <SurveyQuestionFields answers={answers} onChange={(next) => { setAnswers(next); setSaved(false); }} questions={activity.config.questions.map((question) => ({ ...question, type: question.type ?? "short-text", chartType: question.chartType ?? "donut", options: question.options ?? [] }))} /> : activity.config.questions.map((question, index) => <label key={question.id} className="block text-sm font-medium">{index + 1}. {question.title}{question.required !== false ? "（必答）" : "（选答）"}<textarea required={question.required !== false} maxLength={10000} className="mt-3 min-h-28 w-full rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3" value={surveyTextAnswer(answers[question.id])} onChange={(event) => { setAnswers({ ...answers, [question.id]: event.target.value }); setSaved(false); }} /></label>) : <label className="block text-sm font-medium">{activity.type === "Assignment" ? "作业内容" : "你的回答"}<textarea required maxLength={30000} className="mt-3 min-h-48 w-full rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3" value={answer} onChange={(event) => { setAnswer(event.target.value); setSaved(false); }} /></label>)}
            {error && <p role="alert" className="text-sm text-[var(--pbl-danger)]">{error}</p>}
            {saved && <p role="status" className="text-sm text-[var(--pbl-student)]">已保存，课程学习进度已更新。</p>}
            <button disabled={busy || activity.offering.status !== "open"} className="min-h-11 rounded-[6px] bg-[var(--pbl-student)] px-6 text-sm font-semibold text-white disabled:opacity-50" type="submit">{busy ? "保存中…" : activity.type === "Resource" ? "标记为已学习" : activity.progress.status === "completed" ? "更新提交" : "提交"}</button>
            {activity.offering.status !== "open" && <p className="text-sm text-[var(--pbl-text-muted)]">课程已结束，可查看已提交的内容。</p>}
          </>}
        </form></section></div></StudentShell>;
}
