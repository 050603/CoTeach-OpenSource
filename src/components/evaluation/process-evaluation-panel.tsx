"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import type { Course } from "@/lib/session/types";
import type { ProcessEvaluationSnapshot } from "@/lib/evaluation/process-contract";
import { TeacherOperationDrawer } from "@/components/classroom/teacher-operation-details";
import { ProcessReport } from "./evaluation-record";
import { ProcessEvidenceTimeline } from "./process-evidence-timeline";
import { useEvaluation } from "./use-evaluation";
import styles from "./evaluation.module.css";

type ProcessJob = ProcessEvaluationSnapshot["jobs"][number];
const pending = (job: ProcessJob) => ["pending", "queued", "running", "processing"].includes(job.status.toLowerCase());

export function ProcessEvaluationPanel({ course, studentId }: { course: Course; studentId?: string }) {
  const { snapshot, error: loadError, refresh } = useEvaluation(course.id);
  const [selectedId, setSelectedId] = useState("");
  const [jobs, setJobs] = useState<ProcessJob[]>([]);
  const [reports, setReports] = useState<ProcessEvaluationSnapshot["reports"]>([]);
  const readRevision = useRef({ value: 0 });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = snapshot?.participants.find(item => item.participationId === selectedId)
    ?? snapshot?.participants.find(item => item.studentId === studentId) ?? snapshot?.participants[0];
  const endpoint = `/api/platform/classroom-instances/${encodeURIComponent(course.id)}/process-evaluation`;
  const readJobs = useCallback(async () => {
    const revision = ++readRevision.current.value;
    try {
      const response = await boundedFetch(endpoint, { cache: "no-store", headers: { "x-auth-role": "teacher" } }, 15_000);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? "过程报告状态读取失败。");
      if (revision !== readRevision.current.value) return;
      setJobs(Array.isArray(body.jobs) ? body.jobs : []);
      setReports(Array.isArray(body.reports) ? body.reports : []);
      setError("");
      await refresh();
    } catch (reason) { if (revision === readRevision.current.value) setError(reason instanceof Error ? reason.message : "过程报告状态读取失败。"); }
  }, [endpoint, refresh]);
  useEffect(() => {
    const revision = readRevision.current;
    const initial = window.setTimeout(() => void readJobs(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void readJobs(); }, 8_000);
    return () => { ++revision.value; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [readJobs]);
  const generate = async (all: boolean) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await boundedFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-auth-role": "teacher" }, body: JSON.stringify(all ? {} : { participationId: selected?.participationId }) }, 20_000);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? "过程报告生成任务未能启动。");
      setNotice(body.queued ? `已安排 ${body.queued} 份报告，生成完成后自动显示。` : "当前证据已有报告，或相同任务正在处理。");
      await readJobs();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "生成失败，请重试。"); }
    finally { setBusy(false); }
  };
  const currentJobs = jobs.filter(job => job.participationId === selected?.participationId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const job = currentJobs[0];
  const failed = job?.status.toLowerCase() === "failed";
  const rawReport = reports.find(report => report.participationId === selected?.participationId && report.id === selected?.processReport?.id);
  const reported = snapshot?.participants.filter(item => item.processReport).length ?? 0;
  const classFocus = snapshot?.participants.flatMap(item => {
    const report = item.processReport;
    if (!report) return [];
    const points = [...new Set([
      ...(report.evidenceGaps ?? []),
      ...report.dimensions.flatMap(dimension => [dimension.suggestion ? `${dimension.name}：${dimension.suggestion}` : "", ...dimension.gaps].filter(Boolean)),
      ...(report.confidence === "low" ? ["现有证据支持有限，可结合现场观察补充核对。"] : []),
    ])];
    return points.length ? [{ participationId: item.participationId, name: item.name, points }] : [];
  }) ?? [];
  return <div className={styles.root}>
    <p className={styles.muted}>结合知识学习、作品修改与 AI 协作的真实记录生成报告。报告在教师发布前仅教师可见。</p>
    {error || loadError ? <p className={styles.error} role="alert">{error || loadError}</p> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {snapshot ? <>
      <section className={styles.section} aria-label="班级关注点"><h3>班级关注点</h3>
        <p className={styles.muted}>已有报告 {reported}/{snapshot.participants.length} 人。以下按学生名单显示需要核对的证据与改进建议。</p>
        <p className={styles.muted}>尚无报告或未使用 AI 均不代表能力不足，也不作为低分依据。</p>
        {classFocus.length ? <ul className={styles.list}>{classFocus.slice(0, 6).map(item => <li key={item.participationId}><button className={`${styles.button} w-full flex-col items-start text-left`} type="button" aria-label={`查看 ${item.name} 的过程报告`} onClick={() => setSelectedId(item.participationId)}><strong>{item.name}</strong><span className={styles.result}>{item.points.slice(0, 2).join("；")}</span></button></li>)}</ul> : <p className={styles.muted}>{reported ? "现有报告尚无需要补充核对的建议，请结合个人档案判断。" : "生成报告后，可在这里查看班级关注点。"}</p>}
        {classFocus.length > 6 ? <p className={styles.muted}>先显示前 6 位学生，可从下方名单查看其余个人报告。</p> : null}
      </section>
      <label className={styles.field}><span>查看学生</span><select value={selected?.participationId ?? ""} onChange={event => setSelectedId(event.target.value)}>{snapshot.participants.map(item => <option value={item.participationId} key={item.participationId}>{item.name}</option>)}</select></label>
      <div className={styles.actions}><button className={styles.primary} disabled={busy || !selected || currentJobs.some(pending)} type="button" onClick={() => void generate(false)}>{failed ? "重试此人报告" : "生成或更新此人报告"}</button><button className={styles.button} disabled={busy || !snapshot.participants.length} type="button" onClick={() => void generate(true)}>更新全班报告</button><button className={styles.button} type="button" onClick={() => void readJobs()}>刷新状态</button></div>
      {job && pending(job) ? <p className={styles.notice} role="status">{job.status.toLowerCase() === "running" ? "正在分析真实过程证据…" : "已排队，等待生成过程报告…"}</p> : failed ? <p className={styles.error} role="alert">报告生成失败：{job.error || "服务暂不可用，请重试。"} 已有报告仍保留，可重试此人报告。</p> : null}
      <ProcessReport report={selected?.processReport ?? null} />
      {rawReport ? <ProcessEvidenceTimeline report={rawReport} /> : null}
    </> : <p className={styles.empty}>正在加载学生过程档案…</p>}
  </div>;
}

export function ProcessEvaluationEntry({ course, studentId }: { course: Course; studentId?: string }) {
  const [open, setOpen] = useState(false);
  if (course.evaluationContractVersion !== 2) return null;
  return <><button className={styles.button} type="button" onClick={() => setOpen(true)}><Sparkles size={16} />AI 过程评价</button><TeacherOperationDrawer open={open} onOpenChange={setOpen} title="AI 学习过程评价" description="按学生查看全程证据与改进建议，报告发布前仅教师可见。">{open ? <ProcessEvaluationPanel course={course} studentId={studentId} /> : null}</TeacherOperationDrawer></>;
}
