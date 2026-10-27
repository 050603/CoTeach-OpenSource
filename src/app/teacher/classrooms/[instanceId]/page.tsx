"use client";

import Link from "next/link";
import { ResilientImage } from "@/components/resilient-image";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ClipboardCheck, RefreshCw, Search, Users, X } from "lucide-react";
import { teacherClassroomEntry } from "@/lib/platform/classroom-entry";
import type { TeacherEvaluationSummary } from "@/lib/platform/classroom-record-summary";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { teacherLibraryThemeClassName } from "@/components/teacher/library-heading";
import { TeacherExperimentResults } from "@/components/platform/teacher-experiment-results";

type Participant = {
  id: string; displayName: string; username: string; lastEnteredAt: string | null; completedAt: string | null;
  hasLearningEvidence: boolean; hasFinalOutput: boolean; submittedArtifactVersionCount: number;
  evaluationSummary: TeacherEvaluationSummary;
  _count: { artifacts: number; reflections: number; evaluations: number };
};
type Classroom = {
  instance: { id: string; title: string; offeringId: string; status: string; snapshot: unknown; coverImageUrl?: string | null };
  participants: Participant[];
};
const evaluationFilters = [
  ["all", "全部评价状态"], ["pending", "待教师评价"], ["draft", "评价草稿"],
  ["submitted", "已正式定评"], ["published", "已发布结果"], ["none", "尚无教师评价"],
] as const;
type EvaluationFilter = typeof evaluationFilters[number][0];
type Filters = { q: string; evaluation: EvaluationFilter; returnTo: string | null };
const emptyFilters: Filters = { q: "", evaluation: "all", returnTo: null };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 text-sm font-medium disabled:opacity-50";

function readFilters(): Filters {
  const params = new URLSearchParams(window.location.search);
  const evaluation = params.get("evaluation");
  const returnTo = params.get("returnTo");
  return {
    q: params.get("q") ?? "",
    evaluation: evaluationFilters.some(([value]) => value === evaluation) ? evaluation as EvaluationFilter : "all",
    returnTo: returnTo?.startsWith("/teacher/classes/") && !returnTo.includes("\\") ? returnTo : null,
  };
}
function filterQuery(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.evaluation !== "all") params.set("evaluation", filters.evaluation);
  if (filters.returnTo) params.set("returnTo", filters.returnTo);
  return params.size ? `?${params}` : "";
}
function matchesEvaluation(participant: Participant, filter: EvaluationFilter) {
  if (filter === "all") return true;
  if (filter === "pending") return participant.evaluationSummary.pending;
  if (filter === "published") return participant.evaluationSummary.published;
  return participant.evaluationSummary.teacherStatus === filter;
}
function EvaluationStatus({ summary }: { summary: TeacherEvaluationSummary }) {
  return <div className="flex flex-wrap gap-1.5">
    <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${summary.teacherStatus === "submitted" ? "bg-emerald-50 text-emerald-800" : summary.teacherStatus === "draft" ? "bg-amber-50 text-amber-800" : "bg-[var(--pbl-bg)] text-[var(--pbl-text-muted)]"}`}>
      {summary.teacherStatus === "submitted" ? "已正式定评" : summary.teacherStatus === "draft" ? "评价草稿" : summary.pending ? "待教师评价" : "尚无教师评价"}
    </span>
    {summary.published && <span className="rounded-md bg-[var(--pbl-teacher-soft)] px-2 py-1 text-xs text-[var(--pbl-teacher)]">{summary.publishedTeacher ? "已发布定评" : "已发布过程报告"}</span>}
  </div>;
}

export default function ClassroomMonitor() {
  const { instanceId } = useParams<{ instanceId: string }>();
  const [data, setData] = useState<Classroom | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/platform/classroom-instances/${instanceId}/participants`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "无法读取课堂");
      if (current === requestId.current) setData(result);
    } catch (reason) {
      if (current === requestId.current) setError(reason instanceof Error ? reason.message : "无法读取课堂");
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [instanceId]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) { setData(null); void load(); } });
    return () => { active = false; requestId.current += 1; };
  }, [load]);
  useEffect(() => {
    const restore = () => setFilters(readFilters());
    queueMicrotask(restore);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [instanceId]);
  function updateFilters(patch: Partial<Filters>, replace = false) {
    const next = { ...filters, ...patch };
    setFilters(next);
    const href = `/teacher/classrooms/${instanceId}${filterQuery(next)}`;
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  }
  const snapshot = data?.instance.snapshot;
  const kind = snapshot && typeof snapshot === "object" && "kind" in snapshot && typeof snapshot.kind === "string" ? snapshot.kind : undefined;
  const entry = data ? teacherClassroomEntry(data.instance, kind) : null;
  const status = data?.instance.status.toLowerCase();
  const back = filters.returnTo ?? (data ? `/teacher/classes/${data.instance.offeringId}` : "/teacher/classes");
  const term = filters.q.trim().toLocaleLowerCase();
  const participants = data?.participants.filter((participant) => (!term || `${participant.displayName} ${participant.username}`.toLocaleLowerCase().includes(term)) && matchesEvaluation(participant, filters.evaluation)) ?? [];
  const returnTo = `/teacher/classrooms/${instanceId}${filterQuery(filters)}`;
  const filtered = Boolean(filters.q || filters.evaluation !== "all");
  const versions = data?.participants.reduce((sum, participant) => sum + participant.submittedArtifactVersionCount, 0) ?? 0;
  const metrics = [
    { label: "参与学生", value: data?.participants.filter((participant) => participant.hasLearningEvidence).length, detail: "按学生计，依据实际学习记录", filter: "all" },
    { label: "已提交作品", value: data?.participants.filter((participant) => participant.submittedArtifactVersionCount > 0).length, detail: data ? `${versions} 个正式版本，按提交学生计` : "按提交学生计，草稿不计入", filter: "all" },
    { label: "待教师评价", value: data?.participants.filter((participant) => participant.evaluationSummary.pending).length, detail: "已交成果，尚未正式定评", filter: "pending" },
    { label: "已正式定评", value: data?.participants.filter((participant) => participant.evaluationSummary.teacherStatus === "submitted").length, detail: "按学生计，草稿与发布分别展示", filter: "submitted" },
  ] as const;
  return <TeacherPlatformPage className={teacherLibraryThemeClassName}>
    <TeacherPlatformHeader active="classes" themeClassName={teacherLibraryThemeClassName} backHref={back} backLabel={filters.returnTo ? "返回学生档案" : "返回教学班"} />
    <div className="pbl-workspace-content">
      <header className="pbl-page-heading">
        <div className="min-w-0"><p className="text-xs font-semibold tracking-widest text-[var(--pbl-teacher)]">课堂学习记录</p><h1 className="mt-3 break-words text-3xl font-semibold">{data?.instance.title ?? "课堂学习记录"}</h1>
          <div className="mt-4 flex flex-wrap items-center gap-3">{data && <span className="rounded-md bg-[var(--pbl-teacher-soft)] px-3 py-1.5 text-sm text-[var(--pbl-teacher)]">{status === "teaching" ? "授课中" : status === "finished" ? "已结束 · 记录留存" : "待授课"}</span>}<p className="text-sm text-[var(--pbl-text-muted)]">查看学习过程、正式成果与教师评价</p></div>
        </div>
        {data?.instance.coverImageUrl ? <div className="relative hidden aspect-video w-52 shrink-0 overflow-hidden rounded-xl border border-[var(--pbl-border)] xl:block"><ResilientImage src={data.instance.coverImageUrl} alt={`${data.instance.title}课堂封面`} fill unoptimized className="object-cover" /></div> : null}
        <div className="flex w-full flex-wrap gap-2">
          <button className={button} disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? "motion-safe:animate-spin" : ""}/>{loading ? "正在刷新" : "刷新记录"}</button>
          {entry && <Link className={`${button} text-[var(--pbl-teacher)]`} href={status === "finished" ? `/teacher/teach/${instanceId}/setup` : entry.href}>{status === "finished" ? "返回教学工作台" : entry.label}<ArrowUpRight size={16}/></Link>}
        </div>
      </header>
      {error && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-[var(--pbl-danger)]"><span>{error}{data ? "。以下保留上次成功读取的记录。" : "，课堂统计尚未读取。"}</span><button className="min-h-11 px-3 font-medium underline" onClick={() => void load()}>重新加载</button></div>}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="课堂概况">{metrics.map(({ label, value, detail, filter }) => {
        const content = <><p className="text-sm text-[var(--pbl-text-muted)]">{label}</p><strong className="mt-2 block text-3xl font-semibold tabular-nums">{value ?? "—"}<span className="ml-1 text-sm font-normal text-[var(--pbl-text-muted)]">{data ? "人" : ""}</span></strong><p className="mt-2 text-xs leading-5 text-[var(--pbl-text-muted)]">{detail}</p></>;
        return filter === "all" ? <div key={label} className="rounded-xl border border-[var(--pbl-border)] bg-white p-4 sm:p-5">{content}</div> : <button key={label} className={`rounded-xl border bg-white p-4 text-left sm:p-5 ${filters.evaluation === filter ? "border-[var(--pbl-teacher)] ring-1 ring-[var(--pbl-teacher)]" : "border-[var(--pbl-border)]"}`} aria-pressed={filters.evaluation === filter} disabled={!data} onClick={() => updateFilters({ evaluation: filters.evaluation === filter ? "all" : filter })}>{content}</button>;
      })}</div>
      <section className="mt-6 overflow-hidden rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] shadow-sm">
        <div className="border-b border-[var(--pbl-border)] p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Users size={20} className="text-[var(--pbl-teacher)]"/>学生学习档案</h2>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-[var(--pbl-border)] px-3 focus-within:border-[var(--pbl-teacher)]"><Search size={17} className="shrink-0 text-[var(--pbl-text-muted)]"/><input aria-label="搜索学生姓名或账号" placeholder="搜索学生姓名或账号" className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none" value={filters.q} onChange={(event) => updateFilters({ q: event.target.value }, true)}/></label>
            <select aria-label="评价状态" value={filters.evaluation} onChange={(event) => updateFilters({ evaluation: event.target.value as EvaluationFilter })} className="min-h-11 rounded-lg border border-[var(--pbl-border)] bg-white px-3 text-sm sm:w-48">{evaluationFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </div>
          <div className="mt-3 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--pbl-text-muted)]"><span role="status">{data ? `显示 ${participants.length} / ${data.participants.length} 位学生` : "等待加载学生记录"}</span>
            {filters.q && <span className="rounded-md bg-[var(--pbl-bg)] px-2 py-1">搜索：{filters.q}</span>}
            {filters.evaluation !== "all" && <span className="rounded-md bg-[var(--pbl-teacher-soft)] px-2 py-1 text-[var(--pbl-teacher)]">{evaluationFilters.find(([value]) => value === filters.evaluation)?.[1]}</span>}
            {filtered && <button className="inline-flex min-h-11 items-center gap-1 text-[var(--pbl-teacher)]" onClick={() => updateFilters({ q: "", evaluation: "all" })}><X size={14}/>清除筛选</button>}
          </div>
        </div>
        {!data && loading ? <div role="status" className="space-y-4 p-6"><p className="text-sm text-[var(--pbl-text-muted)]">正在加载学习记录…</p>{[0, 1, 2].map(item => <div key={item} className="h-14 rounded-xl bg-[var(--pbl-bg)] motion-safe:animate-pulse"/>)}</div> : data && data.participants.length === 0 ? <div className="px-6 py-12 text-center"><ClipboardCheck size={36} strokeWidth={1.4} className="mx-auto text-[var(--pbl-teacher)]"/><h3 className="mt-4 font-semibold">等待第一份学习记录</h3><p className="mt-2 text-sm leading-7 text-[var(--pbl-text-muted)]">学生进入课堂后，参与情况与提交的成果将在这里汇集。</p></div> : data && !participants.length ? <div className="px-6 py-12 text-center"><h3 className="font-semibold">没有符合条件的学生</h3><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">调整姓名、账号或评价状态后重试。</p><button className={`${button} mt-4 text-[var(--pbl-teacher)]`} onClick={() => updateFilters({ q: "", evaluation: "all" })}>显示全部学生</button></div> : data && <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">学生参与、正式成果版本、反思和教师评价记录</caption><thead className="bg-[var(--pbl-bg)] text-xs text-[var(--pbl-text-muted)]"><tr>{["学生", "最近参与", "正式成果", "反思", "教师评价", "操作"].map(label => <th scope="col" key={label} className="px-5 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{participants.map(participant => <tr className="border-t border-[var(--pbl-border)] transition-colors hover:bg-[var(--pbl-bg)]" key={participant.id}>
          <th scope="row" className="max-w-60 break-words px-5 py-4 font-medium"><span className="block">{participant.displayName}</span><span className="mt-1 block text-xs font-normal text-[var(--pbl-text-muted)]">{participant.username}</span></th>
          <td className="px-5 py-4 text-xs text-[var(--pbl-text-muted)]">{participant.lastEnteredAt ? new Date(participant.lastEnteredAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "尚未进入"}</td>
          <td className="px-5 py-4 text-xs tabular-nums">{participant.submittedArtifactVersionCount ? `${participant.submittedArtifactVersionCount} 个版本` : "尚无正式作品"}</td><td className="px-5 py-4 text-xs tabular-nums">{participant._count.reflections} 条</td>
          <td className="max-w-64 px-5 py-4"><EvaluationStatus summary={participant.evaluationSummary}/></td>
          <td className="px-5 py-4"><Link className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap font-medium text-[var(--pbl-teacher)]" href={`/teacher/participations/${participant.id}?${new URLSearchParams({ returnTo })}`} aria-label={`查看与评价 ${participant.displayName}`}>查看与评价<ArrowUpRight size={14}/></Link></td>
        </tr>)}</tbody></table></div>}
      </section>
      {data ? <TeacherExperimentResults instanceId={instanceId} offeringId={data.instance.offeringId} /> : null}
    </div>
  </TeacherPlatformPage>;
}
