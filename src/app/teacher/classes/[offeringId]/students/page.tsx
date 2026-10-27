"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine, ChevronLeft, ChevronRight, Clock3, Database,
  FileCheck2, KeyRound, Search, Settings2, Trash2, UserRoundCheck, RefreshCw, SlidersHorizontal, CheckCheck,
  UsersRound, X,
} from "lucide-react";
import { PlatformError, PlatformLoading } from "@/components/platform/platform-feedback";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger,
  Dialog, DialogContent, DialogDescription, DialogTitle, Drawer, DrawerContent,
} from "@/components/ui";
import { teacherLibraryThemeClassName } from "@/components/teacher/library-heading";
import { defaultStudentNavigation, filterStudentRecords, readStudentNavigation, resolveStudentSelection, studentNavigationQuery, STUDENT_PAGE_SIZE, type DetailTab, type StudentRecordNavigation } from "@/lib/platform/student-record-navigation";
import styles from "./records.module.css";
import { Checkbox } from "@/components/ui/checkbox";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { activityTypeLabel, progressStatusLabel } from "@/lib/platform/labels";
import type {
  getOfferingStudentDetail, getStudentActivitySubmissions, OfferingStudentSummary,
  OfferingStudentsSummary, StudentAttentionReason,
} from "@/lib/platform/student-records";

type StudentDetailData = Awaited<ReturnType<typeof getOfferingStudentDetail>>;
type SubmissionData = Awaited<ReturnType<typeof getStudentActivitySubmissions>>;
type ExportSection = "summary" | "activity_progress" | "activity_submissions" | "classrooms" | "artifacts" | "reflections" | "evaluations" | "summary_csv";

const attentionLabels: Record<StudentAttentionReason, string> = {
  not_participated: "尚未参与",
  incomplete_open_activity: "有开放活动未完成",
  pending_teacher_evaluation: "待教师评价",
};
const tabLabels: Record<Exclude<DetailTab, "account">, string> = { progress: "学习概览", submissions: "提交记录", classrooms: "课堂与评价" };
const fieldClass = "min-h-11 rounded-[10px] border border-[var(--pbl-border)] bg-white px-3 text-sm outline-none";
const secondaryButton = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-[var(--pbl-border)] bg-white px-4 text-sm font-medium hover:border-[var(--pbl-teacher)] disabled:opacity-50";
const defaultExportSections: ExportSection[] = ["summary", "activity_progress", "activity_submissions", "classrooms", "artifacts", "reflections", "evaluations"];
const exportOptions: Array<{ value: ExportSection; label: string; description: string }> = [
  { value: "summary", label: "学生与学习摘要", description: "身份、完成比例、课堂参与、最近学习时间和关注原因" },
  { value: "activity_progress", label: "活动进度", description: "每项活动的状态、访问与完成时间，以及最新进度数据" },
  { value: "activity_submissions", label: "活动提交与问卷作答", description: "完整提交历史、提交时题目快照和答案" },
  { value: "classrooms", label: "课堂参与与阶段提交", description: "课堂场次、进入时间、阶段进度和已提交内容" },
  { value: "artifacts", label: "课堂成果与版本", description: "成果信息和全部已提交版本" },
  { value: "reflections", label: "学习反思", description: "课堂反思正文与时间" },
  { value: "evaluations", label: "评价记录", description: "教师评价、学生自评、分数和量规数据" },
  { value: "summary_csv", label: "附带摘要 CSV", description: "便于电子表格打开，作为 JSON 之外的兼容格式" },
];

function formatTime(value: string | null | undefined, fallback = "暂无记录") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function completionText(student: OfferingStudentSummary) {
  return student.openActivityCount ? `${student.completedOpenActivities}/${student.openActivityCount}` : "暂无开放活动";
}
function useWideLayout() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 1280px)");
    if (!media) return;
    const update = () => setWide(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

export default function TeacherStudentsPage() {
  return <Suspense fallback={<PageLoading/>}><TeacherStudentsContent/></Suspense>;
}
function PageLoading() {
  return <TeacherPlatformPage><TeacherPlatformHeader compact active="classes"/><div className="pbl-workspace-content"><PlatformLoading label="正在汇总学生学习记录…"/></div></TeacherPlatformPage>;
}

function TeacherStudentsContent() {
  const { offeringId } = useParams<{ offeringId: string }>();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [navigation, setNavigation] = useState(() => readStudentNavigation(searchParams));
  const lastSearch = useRef(search);
  const [summary, setSummary] = useState<OfferingStudentsSummary | null>(null);
  const [detail, setDetail] = useState<StudentDetailData | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [moreFilters, setMoreFilters] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportFormat, setExportFormat] = useState<"csv" | "zip">("csv");
  const [exportSections, setExportSections] = useState<ExportSection[]>(defaultExportSections);
  const wide = useWideLayout();
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const studentListViewport = useRef<HTMLDivElement>(null);
  const drawerViewport = useRef<HTMLDivElement>(null);
  const scrollRestored = useRef(false);
  const initialScrollKey = useRef(`teacher-student-records:scroll:${offeringId}:${search}`);
  const studentButtons = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef<string | null>(null);
  const exportTrigger = useRef<HTMLButtonElement>(null);
  const latestNavigation = useRef(navigation);
  useEffect(() => { latestNavigation.current = navigation; }, [navigation]);

  const navigate = useCallback((next: StudentRecordNavigation, replace = false) => {
    const params = studentNavigationQuery(next);
    setNavigation(next);
    if (window.location.search.slice(1) === params) return;
    lastSearch.current = params;
    window.history[replace ? "replaceState" : "pushState"](null, "", `${window.location.pathname}${params ? `?${params}` : ""}`);
  }, []);
  useEffect(() => {
    if (lastSearch.current === search) return;
    lastSearch.current = search;
    setNavigation(readStudentNavigation(new URLSearchParams(search)));
  }, [search]);
  useEffect(() => {
    const restore = () => {
      lastSearch.current = window.location.search.slice(1);
      setNavigation(readStudentNavigation(new URLSearchParams(window.location.search)));
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const load = useCallback(async () => {
    const requestId = ++listRequest.current;
    const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students?view=summary`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "无法加载学生");
    if (requestId === listRequest.current) setSummary(data);
  }, [offeringId]);
  useEffect(() => {
    let active = true;
    const counter = listRequest;
    setLoading(true); setError("");
    void load().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; counter.current++; };
  }, [load]);

  const filtered = useMemo(() => filterStudentRecords(summary?.students ?? [], navigation), [navigation, summary]);
  const { page, pageCount, visible, selected, index } = resolveStudentSelection(filtered, navigation);
  const selectedId = selected?.enrollmentId ?? null;
  // Canonicalize invalid links, changed membership and pages without resetting valid deep links.
  useEffect(() => {
    if (!summary) return;
    const next = { ...navigation, page, student: selectedId, view: selectedId ? navigation.view : "list" as const };
    if (studentNavigationQuery(next) !== studentNavigationQuery(navigation)) navigate(next, true);
  }, [navigate, navigation, page, selectedId, summary]);
  useEffect(() => {
    const viewport = studentListViewport.current;
    const item = studentButtons.current.get(selectedId ?? "");
    if (!viewport || !item || !wide) return;
    const viewportRect = viewport.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < viewportRect.top) viewport.scrollTop -= viewportRect.top - itemRect.top;
    else if (itemRect.bottom > viewportRect.bottom) viewport.scrollTop += itemRect.bottom - viewportRect.bottom;
  }, [page, selectedId, wide]);

  const loadDetail = useCallback(async (enrollmentId: string) => {
    const requestId = ++detailRequest.current;
    setDetailLoading(true); setDetailError(""); setDetail(null);
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/${enrollmentId}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法加载学生档案");
      if (requestId === detailRequest.current) setDetail(data);
    } catch (reason) {
      if (requestId === detailRequest.current) setDetailError(reason instanceof Error ? reason.message : "无法加载学生档案");
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }, [offeringId]);
  const detailVisible = wide || navigation.view === "detail";
  useEffect(() => {
    if (scrollRestored.current || !summary || (!detail && selectedId && detailVisible && navigation.tab !== "account" && !detailError)) return;
    let saved: { windowY?: number; listY?: number; drawerY?: number } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(initialScrollKey.current) ?? "null"); } catch { /* Reading position is optional when browser storage is unavailable. */ }
    scrollRestored.current = true;
    if (!saved) return;
    const positions = saved;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, Number(positions.windowY) || 0), behavior: "instant" });
      if (studentListViewport.current) studentListViewport.current.scrollTop = Math.max(0, Number(positions.listY) || 0);
      if (drawerViewport.current) drawerViewport.current.scrollTop = Math.max(0, Number(positions.drawerY) || 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [summary, detail, selectedId, detailVisible, navigation.tab, detailError]);
  useEffect(() => {
    const save = () => {
      if (!scrollRestored.current) return;
      const key = `teacher-student-records:scroll:${offeringId}:${studentNavigationQuery(latestNavigation.current)}`;
      try { sessionStorage.setItem(key, JSON.stringify({ windowY: window.scrollY, listY: studentListViewport.current?.scrollTop ?? 0, drawerY: drawerViewport.current?.scrollTop ?? 0 })); } catch { /* Browsing remains usable without saved reading positions. */ }
    };
    document.addEventListener("scroll", save, true);
    window.addEventListener("pagehide", save);
    return () => { document.removeEventListener("scroll", save, true); window.removeEventListener("pagehide", save); };
  }, [offeringId]);
  useEffect(() => {
    const counter = detailRequest;
    if (selectedId && detailVisible && navigation.tab !== "account") void loadDetail(selectedId);
    else { setDetail(null); setDetailError(""); setDetailLoading(false); }
    return () => { counter.current++; };
  }, [detailVisible, loadDetail, selectedId, navigation.tab, detailRevision]);

  function filter(patch: Partial<StudentRecordNavigation>, replace = false) {
    navigate({ ...navigation, ...patch, page: 1, student: null, view: "list" }, replace);
  }
  function selectStudent(enrollmentId: string) {
    navigate({ ...navigation, student: enrollmentId, view: "detail" });
  }
  function moveStudent(direction: -1 | 1) {
    const next = filtered[index + direction];
    if (next) navigate({ ...navigation, student: next.enrollmentId, page: Math.floor((index + direction) / STUDENT_PAGE_SIZE) + 1 });
  }
  function movePage(nextPage: number) {
    navigate({ ...navigation, page: nextPage, student: filtered[(nextPage - 1) * STUDENT_PAGE_SIZE]?.enrollmentId ?? null });
    if (studentListViewport.current) studentListViewport.current.scrollTop = 0;
  }
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true); setError("");
    try {
      await load();
      setDetailRevision(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法刷新学生名单"); }
    finally { setRefreshing(false); setLoading(false); }
  }
  async function exportRecords() {
    if (!filtered.length || exportBusy || (exportFormat === "zip" && !exportSections.length)) return;
    setExportBusy(true); setExportError("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/export`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentIds: filtered.map(student => student.enrollmentId), sections: exportFormat === "csv" ? ["summary_csv"] : exportSections, format: exportFormat }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message ?? "无法生成导出文件");
      }
      const blob = await response.blob();
      const encodedName = (response.headers.get("Content-Disposition") ?? "").match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fileName = encodedName ? decodeURIComponent(encodedName) : `${summary?.offering.name ?? "教学班"}-学生学习记录.${exportFormat}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
    } catch (reason) { setExportError(reason instanceof Error ? reason.message : "无法导出，请重试"); }
    finally { setExportBusy(false); }
  }
  function studentRemoved(enrollmentId: string) {
    const next = filtered[index + 1] ?? filtered[index - 1] ?? null;
    setSummary(current => {
      if (!current) return current;
      const students = current.students.filter(student => student.enrollmentId !== enrollmentId);
      return { ...current, students, totals: {
        members: students.length, participated: students.filter(student => student.participated).length,
        incomplete: students.filter(student => student.attentionReasons.includes("incomplete_open_activity")).length,
        pendingEvaluation: students.filter(student => student.attentionReasons.includes("pending_teacher_evaluation")).length,
      } };
    });
    if (latestNavigation.current.student === enrollmentId) navigate({ ...latestNavigation.current, student: next?.enrollmentId ?? null, view: "list" }, true);
    void load().catch(reason => setError(reason instanceof Error ? reason.message : "名单刷新失败，请重试"));
  }
  const detailProps = {
    summary: selected, data: detail?.student.enrollmentId === selectedId ? detail : null,
    loading: detailLoading, error: detailError, tab: navigation.tab,
    setTab: (tab: DetailTab) => navigate({ ...navigation, tab }), index, total: filtered.length,
    onMove: moveStudent, onRetry: () => { if (selectedId) void loadDetail(selectedId); }, onStudentRemoved: studentRemoved, offeringId,
  };
  const activeFilters = [
    navigation.query ? { label: `搜索：${navigation.query}`, patch: { query: "" } } : null,
    navigation.activityId !== "all" ? { label: summary?.activities.find(activity => activity.id === navigation.activityId)?.title ?? "所选活动", patch: { activityId: "all" } } : null,
    navigation.status !== "all" ? { label: ({ not_started: "未开始", in_progress: "进行中", completed: "已完成" })[navigation.status], patch: { status: "all" as const } } : null,
    navigation.attention !== "all" ? { label: navigation.attention === "participated" ? "已参与学习" : attentionLabels[navigation.attention], patch: { attention: "all" as const } } : null,
  ].filter(item => item !== null);
  const stats = summary ? [
    { label: "课程成员", value: summary.totals.members, filter: "all" as const, hint: "当前教学班学生", icon: UsersRound },
    { label: "已参与学习", value: summary.totals.participated, filter: "participated" as const, hint: "含真实访问或提交记录", icon: UserRoundCheck },
    { label: "存在未完成活动", value: summary.totals.incomplete, filter: "incomplete_open_activity" as const, hint: "按已开放活动统计", icon: Clock3 },
    { label: "待教师评价", value: summary.totals.pendingEvaluation, filter: "pending_teacher_evaluation" as const, hint: "已有提交，待教师定评", icon: FileCheck2 },
  ] : [];
  function closeDrawer() {
    restoreFocus.current = selectedId;
    navigate({ ...navigation, view: "list" });
  }
  return <TeacherPlatformPage className={teacherLibraryThemeClassName}>
    <TeacherPlatformHeader compact active="classes" themeClassName={teacherLibraryThemeClassName} backHref={`/teacher/classes/${offeringId}`} backLabel="返回教学班"/>
    <div className={`pbl-workspace-content ${styles.page}`}>
      <header className={styles.heading}>
        <div><p className={styles.eyebrow}>{summary?.offering.name ?? "教学班"}{summary?.offering.term ? ` · ${summary.offering.term}` : ""}</p><h1>学生与学习记录</h1><p>了解学习进展，查看学生作品与评价。</p></div>
        <div className={styles.actions}><button className={styles.button} disabled={loading || refreshing} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? "motion-safe:animate-spin" : ""}/>{refreshing ? "刷新中…" : "刷新记录"}</button><button ref={exportTrigger} className={styles.primary} disabled={!filtered.length || loading} onClick={() => { setExportError(""); setExportOpen(true); }}><ArrowDownToLine size={16}/>导出当前结果</button></div>
      </header>
      {error ? <div className="mt-5"><PlatformError message={error} onRetry={() => void refresh()}/></div> : null}
      {loading ? <PlatformLoading label="正在汇总学生学习记录…"/> : summary ? <>
        <section aria-label="班级学习概览" className={styles.stats}>{stats.map(({ label, value, filter: attention, hint, icon: Icon }) => <button key={label} className={styles.stat} onClick={() => filter({ attention })} aria-pressed={navigation.attention === attention}>
          <span className={styles.statIcon}><Icon size={18}/></span><span><span className={styles.statLabel}>{label}</span><strong>{value}</strong><small>{hint}</small></span>
        </button>)}</section>
        <section aria-label="筛选学生" className={styles.filters}>
          <div className={styles.filterRow}>
            <label className={styles.search}><Search size={18}/><input aria-label="搜索学生" placeholder="搜索姓名或账号" value={navigation.query} onChange={event => filter({ query: event.target.value }, true)}/>{navigation.query ? <button aria-label="清除搜索" onClick={() => filter({ query: "" }, true)} type="button"><X size={16}/></button> : null}</label>
            <label className={styles.field}>活动<select aria-label="筛选活动" value={navigation.activityId} onChange={event => filter({ activityId: event.target.value })}><option value="all">全部活动</option>{summary.activities.filter(item => !item.archived).map(item => <option key={item.id} value={item.id}>{item.chapterTitle} · {item.title}</option>)}</select></label>
            <label className={styles.field}>学习状态<select aria-label="学习状态" value={navigation.status} onChange={event => filter({ status: event.target.value as StudentRecordNavigation["status"] })}><option value="all">全部学习状态</option><option value="not_started">未开始</option><option value="in_progress">进行中</option><option value="completed">已完成</option></select></label>
            <button className={styles.button} aria-expanded={moreFilters} aria-controls="student-more-filters" onClick={() => setMoreFilters(!moreFilters)}><SlidersHorizontal size={16}/>{moreFilters ? "收起筛选" : "更多筛选"}</button>
          </div>
          {moreFilters ? <div id="student-more-filters" className={styles.more}>
            <label className={styles.field}>关注状态<select aria-label="关注筛选" value={navigation.attention} onChange={event => filter({ attention: event.target.value as StudentRecordNavigation["attention"] })}><option value="all">全部关注状态</option><option value="not_participated">尚未参与</option><option value="incomplete_open_activity">有开放活动未完成</option><option value="pending_teacher_evaluation">待教师评价</option><option value="participated">已参与学习</option></select></label>
            <label className={styles.field}>排序<select aria-label="排序方式" value={navigation.sort} onChange={event => filter({ sort: event.target.value as StudentRecordNavigation["sort"] })}><option value="recent">最近学习优先</option><option value="name">按姓名排序</option><option value="completion">按完成比例排序</option></select></label>
          </div> : null}
          {activeFilters.length ? <div className={styles.filterTags}><span>当前筛选</span>{activeFilters.map(item => <button key={item.label} onClick={() => filter(item.patch)} aria-label={`清除${item.label}`}>{item.label}<X size={13}/></button>)}<button className={styles.clear} onClick={() => filter({ ...defaultStudentNavigation, tab: navigation.tab })}>清除全部</button></div> : null}
        </section>
        <div className={styles.workspace}>
          <section aria-label="学生名单" className={styles.list}>
            <div className={styles.listHeader}><h2>学生名单</h2><span aria-live="polite">{filtered.length} / {summary.students.length} 位学生</span></div>
            <div ref={studentListViewport} className={`${styles.listBody} pbl-student-pane-scroll`}>
              {visible.map(student => <button ref={node => { if (node) studentButtons.current.set(student.enrollmentId, node); else studentButtons.current.delete(student.enrollmentId); }} data-enrollment-id={student.enrollmentId} key={student.enrollmentId} aria-current={selectedId === student.enrollmentId ? "true" : undefined} className={styles.student} onClick={() => selectStudent(student.enrollmentId)}>
                <span className={styles.avatar} aria-hidden>{Array.from(student.displayName)[0] || "学"}</span>
                <span className={styles.studentText}><span className={styles.studentName}><strong>{student.displayName}</strong>{student.openActivityCount ? <small>活动 {completionText(student)}</small> : null}</span><span className={styles.studentMeta}>{student.username} · 课堂 {student.classroomParticipationCount} 次</span><span className={styles.recent}><Clock3 size={12}/>{formatTime(student.lastLearningAt, "尚未参与学习")}</span><span className={styles.badges}>{student.attentionReasons.map(reason => <span key={reason} className={`${styles.badge} ${reason === "pending_teacher_evaluation" ? styles.warning : ""}`}>{attentionLabels[reason]}</span>)}</span></span>
              </button>)}
              {!visible.length ? <div className={styles.empty}><UsersRound size={28}/><p>{activeFilters.length ? "没有符合条件的学生" : "等待学生加入"}</p><p className={styles.note}>{activeFilters.length ? "调整筛选条件，或清除全部后重新查看。" : "学生使用教学班邀请码加入后，会显示在这里。"}</p>{activeFilters.length ? <button className={`${styles.button} mt-4`} onClick={() => filter(defaultStudentNavigation)}>清除全部筛选</button> : <Link className={`${styles.button} mt-4`} href={`/teacher/classes/${offeringId}`}>返回教学班查看邀请码</Link>}</div> : null}
            </div>
            {filtered.length > STUDENT_PAGE_SIZE ? <nav aria-label="学生名单分页" className={styles.pagination}><button className={styles.button} disabled={page === 1} onClick={() => movePage(page - 1)}><ChevronLeft size={15}/>上一页</button><span>{page} / {pageCount} 页</span><button className={styles.button} disabled={page === pageCount} onClick={() => movePage(page + 1)}>下一页<ChevronRight size={15}/></button></nav> : null}
            <p className={`${styles.note} mt-3`}>{summary.updatedAt ? `更新于 ${formatTime(summary.updatedAt)}` : ""}</p>
          </section>
          {wide ? <aside className={styles.detail} aria-label="学生学习档案"><StudentDetail {...detailProps}/></aside> : null}
        </div>
      </> : null}
    </div>
    {!wide ? <Drawer open={navigation.view === "detail" && Boolean(selected)} onOpenChange={open => { if (!open) closeDrawer(); }}><DrawerContent ref={drawerViewport} className={`pbl-platform-theme ${teacherLibraryThemeClassName} ${styles.drawer}`} onCloseAutoFocus={event => { event.preventDefault(); studentButtons.current.get(restoreFocus.current ?? selectedId ?? "")?.focus(); }}>
      <DialogTitle className="sr-only">学生学习档案</DialogTitle><DialogDescription className="sr-only">查看所选学生的学习进度、提交记录和课堂评价</DialogDescription>
      <div className={styles.drawerTop}><button className={styles.button} onClick={closeDrawer}><ChevronLeft size={16}/>返回学生名单</button></div><StudentDetail {...detailProps}/>
    </DrawerContent></Drawer> : null}
    <ExportDialog onAfterClose={() => exportTrigger.current?.focus()} open={exportOpen} onOpenChange={setExportOpen} count={filtered.length} format={exportFormat} onFormat={setExportFormat} sections={exportSections} onToggle={section => setExportSections(current => current.includes(section) ? current.filter(item => item !== section) : [...current, section])} busy={exportBusy} error={exportError} onExport={() => void exportRecords()}/>
  </TeacherPlatformPage>;
}

function ExportDialog({ open, onOpenChange, onAfterClose, count, format, onFormat, sections, onToggle, busy, error, onExport }: {
  open: boolean; onOpenChange: (open: boolean) => void; onAfterClose: () => void; count: number; format: "csv" | "zip"; onFormat: (value: "csv" | "zip") => void;
  sections: ExportSection[]; onToggle: (section: ExportSection) => void; busy: boolean; error: string; onExport: () => void;
}) {
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); onAfterClose(); }} className={`pbl-platform-theme ${teacherLibraryThemeClassName} ${styles.exportDialog}`} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
    <div className={styles.exportHeader}><DialogTitle>导出学生学习记录</DialogTitle><DialogDescription>导出当前筛选的全部 {count} 位学生，包含其他分页的结果。</DialogDescription></div>
    <div className={styles.exportBody}><fieldset disabled={busy}>
      <legend className="sr-only">导出格式</legend><div className={styles.formatOptions}>
        <label><input type="radio" name="export-format" aria-label="摘要表格（CSV）" checked={format === "csv"} onChange={() => onFormat("csv")}/><span><strong>摘要表格（CSV）</strong><small>用 Excel 等表格软件打开，快速查看学生与学习概况。</small></span></label>
        <label><input type="radio" name="export-format" aria-label="完整数据包（ZIP）" checked={format === "zip"} onChange={() => onFormat("zip")}/><span><strong>完整数据包（ZIP）</strong><small>保留提交、作品版本和评价，用于归档与研究。</small></span></label>
      </div>
      {format === "csv" ? <div className="rounded-lg bg-[var(--pbl-bg)] p-4"><p className="text-sm font-medium">每位学生一行，便于筛选与统计</p><p className={`${styles.note} mt-2`}>包含姓名、账号、活动完成情况、课堂参与次数、最近学习时间和关注原因。活动完成数量按已开放活动统计，课堂参与单独列出。</p></div> : <div className="grid gap-2 sm:grid-cols-2">{exportOptions.map(option => <label key={option.value} htmlFor={`export-${option.value}`} className={`flex min-h-16 cursor-pointer gap-3 rounded-[10px] border p-3 ${sections.includes(option.value) ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)]" : "border-[var(--pbl-border)] bg-white"}`}><Checkbox id={`export-${option.value}`} checked={sections.includes(option.value)} onCheckedChange={() => onToggle(option.value)} className="mt-1"/><span><strong className="block text-sm font-medium">{option.label}</strong><small className={`mt-1 block ${styles.note}`}>{option.description}</small></span></label>)}</div>}
    </fieldset>{format === "zip" ? <p className={`${styles.note} mt-4 flex gap-2`}><Database size={16} className="mt-1 shrink-0"/>包含数据文件与中文说明，可按学生、活动和课堂场次关联分析。</p> : null}{error ? <p role="alert" className="mt-4 text-sm text-[var(--pbl-danger)]">{error}</p> : null}</div>
    <footer className={styles.exportFooter}><span className={styles.note}>{format === "zip" ? `已选择 ${sections.length} 类数据` : `${count} 位学生的学习摘要`}</span><div className={styles.actions}><button className={styles.button} disabled={busy} onClick={() => onOpenChange(false)}>取消</button><button className={styles.primary} disabled={!count || (format === "zip" && !sections.length) || busy} onClick={onExport}><ArrowDownToLine size={16}/>{busy ? "正在整理数据…" : format === "csv" ? "下载摘要 CSV" : "生成并下载 ZIP"}</button></div></footer>
  </DialogContent></Dialog>;
}

function StudentDetail({ summary, data, loading, error, tab, setTab, index, total, onMove, onRetry, onStudentRemoved, offeringId }: {
  summary: OfferingStudentSummary | null; data: StudentDetailData | null; loading: boolean; error: string; tab: DetailTab; setTab: (tab: DetailTab) => void;
  index: number; total: number; onMove: (direction: -1 | 1) => void; onRetry: () => void; onStudentRemoved: (enrollmentId: string) => void; offeringId: string;
}) {
  if (!summary) return <div className={styles.empty}><UsersRound size={28}/><p>从名单中选择学生查看学习档案</p></div>;
  const tabs: Array<{ key: DetailTab; label: string }> = [...Object.entries(tabLabels).map(([key, label]) => ({ key: key as DetailTab, label })), { key: "account", label: "账号管理" }];
  return <>
    <header className={styles.detailHeader}>
      <div className="min-w-0"><p>学生学习档案</p><h2>{summary.displayName}</h2><p>{summary.username} · {summary.status === "completed" ? "学习已结束" : "教学班成员"}</p></div>
      <div className={styles.stepper}><button className={styles.button} aria-label="上一位学生" disabled={index <= 0} onClick={() => onMove(-1)}><ChevronLeft size={17}/></button><span>{index + 1} / {total}</span><button className={styles.button} aria-label="下一位学生" disabled={index < 0 || index >= total - 1} onClick={() => onMove(1)}><ChevronRight size={17}/></button></div>
    </header>
    <nav aria-label="学生档案内容" className={styles.tabs}><div role="tablist" aria-label="学生档案内容">{tabs.map(({ key, label }, position) => <button key={key} role="tab" id={`student-tab-${key}`} aria-controls="student-detail-panel" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (position + 1) % tabs.length : event.key === "ArrowLeft" ? (position + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); setTab(tabs[next].key); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
    }}>{label}</button>)}</div></nav>
    <div id="student-detail-panel" role="tabpanel" aria-labelledby={`student-tab-${tab}`} className={styles.detailBody}>
      {tab === "account" ? <AccountTab key={summary.enrollmentId} summary={summary} offeringId={offeringId} onStudentRemoved={onStudentRemoved}/>
        : loading ? <PlatformLoading label="正在加载学习档案…"/>
        : error ? <PlatformError message={error} onRetry={onRetry}/>
        : data ? tab === "progress" ? <ProgressTab data={data} summary={summary}/> : tab === "submissions" ? <SubmissionTab key={summary.enrollmentId} data={data} offeringId={offeringId}/> : <ClassroomTab data={data}/>
        : null}
    </div>
  </>;
}

function AccountTab({ summary, offeringId, onStudentRemoved }: { summary: OfferingStudentSummary; offeringId: string; onStudentRemoved: (enrollmentId: string) => void }) {
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  async function removeStudent() {
    if (removeBusy) return;
    setRemoveBusy(true); setRemoveError("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/${summary.enrollmentId}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "无法移出学生");
      onStudentRemoved(summary.enrollmentId);
    } catch (reason) { setRemoveError(reason instanceof Error ? reason.message : "无法移出学生，请重试"); setRemoveBusy(false); }
  }
  return <div className="space-y-7">
    <section><div className="flex items-start gap-3 rounded-[12px] bg-white/70 p-4"><span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><Settings2 size={18}/></span><dl className="grid min-w-0 flex-1 gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs text-[var(--pbl-text-muted)]">学生</dt><dd className="mt-1 font-medium">{summary.displayName}</dd></div><div><dt className="text-xs text-[var(--pbl-text-muted)]">登录账号</dt><dd className="mt-1 break-all font-medium">{summary.username}</dd></div><div><dt className="text-xs text-[var(--pbl-text-muted)]">加入时间</dt><dd className="mt-1">{formatTime(summary.joinedAt)}</dd></div><div><dt className="text-xs text-[var(--pbl-text-muted)]">成员状态</dt><dd className="mt-1">{summary.status === "active" ? "正常学习中" : summary.status === "completed" ? "学习已结束" : summary.status === "withdrawn" ? "已移出" : "待确认"}</dd></div></dl></div></section>
    <StudentPasswordResetApproval key={summary.enrollmentId} enrollmentId={summary.enrollmentId} offeringId={offeringId}/>
    <section className="border-t border-[var(--pbl-danger-border)] pt-5"><h3 className="text-sm font-semibold text-[var(--pbl-danger)]">成员管理</h3><p className="mt-2 text-xs leading-5 text-[var(--pbl-text-muted)]">移出后学生无法继续访问本课程，已有学习记录会完整保留，学生账号不会被删除。</p><AlertDialog><AlertDialogTrigger asChild><button className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] px-4 text-sm font-medium text-[var(--pbl-danger)] disabled:opacity-50" disabled={removeBusy}><Trash2 size={16}/>{removeBusy ? "正在移出…" : "移出教学班"}</button></AlertDialogTrigger><AlertDialogContent className={`pbl-platform-theme ${teacherLibraryThemeClassName}`}><AlertDialogTitle>将“{summary.displayName}”移出教学班？</AlertDialogTitle><AlertDialogDescription>该学生将无法继续访问本课程。已有活动提交、课堂成果、反思和评价会继续保留，学生账号也不会被删除。</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void removeStudent()}>确认移出</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>{removeError ? <p role="alert" className="mt-2 text-sm text-[var(--pbl-danger)]">{removeError}</p> : null}</section>

  </div>;
}

type StudentResetRequest = {
  id: string; username: string; displayName: string;
  state: "pending" | "approved" | "expired" | "used" | "cancelled";
  createdAt: string; expiresAt: string; approvedAt: string | null;
};

function StudentPasswordResetApproval({ enrollmentId, offeringId }: { enrollmentId: string; offeringId: string }) {
  const [request, setRequest] = useState<StudentResetRequest | null>(null);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const reader = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const url = `/api/platform/offerings/${offeringId}/reset-password`;
  const refresh = useCallback(async () => {
    if (reader.current || mutation.current) return;
    const controller = new AbortController(); reader.current = controller; setLoading(true);
    try {
      const response = await teacherPlatformFetch(`${url}?enrollmentId=${encodeURIComponent(enrollmentId)}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法加载重置申请");
      if (!controller.signal.aborted) { setRequest(data.request); setChecked(true); setReadError(""); }
    } catch (reason) { if (!controller.signal.aborted) setReadError(reason instanceof Error ? reason.message : "无法加载重置申请，请重试"); }
    finally { if (reader.current === controller) { reader.current = null; setLoading(false); } }
  }, [enrollmentId, url]);
  useEffect(() => {
    void refresh();
    const checkVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(checkVisible, 10000);
    document.addEventListener("visibilitychange", checkVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", checkVisible); reader.current?.abort(); reader.current = null; mutation.current?.abort(); mutation.current = null; };
  }, [refresh]);
  async function decide(action: "approve" | "cancel") {
    if (!request || mutation.current) return;
    const controller = new AbortController(); mutation.current = controller;
    reader.current?.abort(); reader.current = null; setLoading(false); setBusy(true); setError("");
    try {
      const response = await teacherPlatformFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentId, requestId: request.id, action }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "申请状态已变化，请刷新后重试");
      if (!controller.signal.aborted) setRequest(data.request);
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "操作失败，请重试"); }
    finally { if (mutation.current === controller) { mutation.current = null; setBusy(false); void refresh(); } }
  }
  const stateLabels = { pending: "等待教师允许", approved: "已允许重置", expired: "申请已过期", used: "学生已完成重置", cancelled: "重置已取消" };
  return <section aria-label="密码重置申请" className="border-t border-[var(--pbl-border)] pt-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">密码协助</h3><button type="button" className={secondaryButton} disabled={busy || loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" size={16}/>{loading ? "检查中…" : "刷新申请"}</button></div>
    {!checked && !readError ? <p role="status" className="mt-3 text-sm text-[var(--pbl-text-muted)]">正在检查学生申请…</p> : null}
    {checked && !request ? <p className="mt-3 text-sm leading-6 text-[var(--pbl-text-muted)]">暂无重置申请。请让学生先在登录页点击“忘记密码”，填写学号和姓名提交申请。</p> : null}
    {request ? <div className="mt-3 grid gap-2 text-sm leading-6">
      <p role="status" className="font-medium">{stateLabels[request.state]}</p>
      <p className="text-[var(--pbl-text-muted)]">申请编号：{request.id.slice(0, 8)} · 提交于 {formatTime(request.createdAt)}</p>
      {(request.state === "pending" || request.state === "approved") ? <p className="text-[var(--pbl-text-muted)]">有效至 {formatTime(request.expiresAt)}</p> : null}
      {request.state === "pending" ? <><p className="text-[var(--pbl-text-muted)]">请核实申请者确为该学生本人，并与学生核对当前申请编号。允许后，学生在提交申请的浏览器设置新密码。</p><div className="flex flex-wrap gap-3"><button type="button" className={secondaryButton} disabled={busy || loading} onClick={() => void decide("approve")}><KeyRound aria-hidden="true" size={16}/>{busy ? "处理中…" : "允许重置密码"}</button><button type="button" className={secondaryButton} disabled={busy || loading} onClick={() => void decide("cancel")}>取消申请</button></div></> : null}
      {request.state === "approved" ? <><p className="text-[var(--pbl-text-muted)]">允许后 10 分钟内有效。请学生回到原浏览器完成重置，无需发送链接。</p><button type="button" className={`${secondaryButton} justify-self-start`} disabled={busy || loading} onClick={() => void decide("cancel")}>{busy ? "处理中…" : "取消重置"}</button></> : null}
      {(request.state === "expired" || request.state === "cancelled") ? <p className="text-[var(--pbl-text-muted)]">如仍需重置，请学生在原浏览器重新提交申请。</p> : null}
    </div> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-[var(--pbl-danger)]">{error}</p> : null}
    {readError ? <p role="alert" className="mt-3 text-sm text-[var(--pbl-danger)]">{readError}</p> : null}
  </section>;
}

function ProgressTab({ data, summary }: { data: StudentDetailData; summary: OfferingStudentSummary }) {
  const chapters = Array.from(new Map(data.activities.map(activity => [activity.chapterId, activity.chapterTitle])));
  return <div>
    <dl className={styles.summary}>
      <div><dt>已完成开放活动</dt><dd>{summary.openActivityCount ? completionText(summary) : "—"}</dd></div>
      <div><dt>课堂参与</dt><dd>{summary.classroomParticipationCount} <small>次</small></dd></div>
      <div><dt>最近学习</dt><dd><small>{formatTime(summary.lastLearningAt, "尚无记录")}</small></dd></div>
    </dl>
    <p className={styles.note}>活动完成数量按当前已开放的非课堂活动统计，课堂参与另计。完成进度不代表知识掌握程度。</p>
    {!chapters.length ? <EmptyLine icon={<FileCheck2 size={20}/>} text="该教学班尚未安排学习活动"/> : chapters.map(([chapterId, chapterTitle]) => <section className={styles.chapter} key={chapterId}><h3>{chapterTitle}</h3><ol>{data.activities.filter(activity => activity.chapterId === chapterId).map(activity => {
      const label = activity.archived ? "已归档" : !activity.isOpen && activity.progress.status === "not_started" ? "未开放" : progressStatusLabel(activity.progress.status);
      return <li key={activity.id} className={styles.activity}><div><p>{activity.title}</p><small>{activityTypeLabel(activity.type)}{activity.progress.lastAccessedAt ? ` · ${formatTime(activity.progress.lastAccessedAt)}` : ""}</small></div><span className={`${styles.badge} ${label === "已完成" ? "bg-emerald-50 text-emerald-800" : label === "进行中" || label === "已提交" ? "bg-blue-50 text-blue-800" : ""}`}>{label === "已完成" ? <CheckCheck size={13} className="mr-1"/> : null}{label}</span></li>;
    })}</ol></section>)}
  </div>;
}

function SubmissionTab({ data, offeringId }: { data: StudentDetailData; offeringId: string }) {
  const activities = useMemo(() => data.activities.filter((activity) => activity.type.toUpperCase() !== "CLASSROOM"), [data.activities]);
  const [activityId, setActivityId] = useState(activities[0]?.id ?? "");
  const [result, setResult] = useState<SubmissionData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const request = useRef(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => { setActivityId(activities[0]?.id ?? ""); setPage(1); }, [activities, data.student.enrollmentId]);
  useEffect(() => {
    if (!activityId) { setResult(null); setLoading(false); return; }
    const controller = new AbortController();
    const counter = request;
    const requestId = ++request.current; setLoading(true); setError(""); setResult(null);
    void teacherPlatformFetch(`/api/platform/offerings/${offeringId}/students/${data.student.enrollmentId}/submissions?activityId=${encodeURIComponent(activityId)}&page=${page}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const value = await response.json(); if (!response.ok) throw new Error(value.message ?? "无法加载提交记录"); if (requestId === request.current) setResult(value);
    }).catch((reason) => { if (requestId === request.current) setError(reason instanceof Error ? reason.message : "无法加载提交记录"); }).finally(() => { if (requestId === request.current) setLoading(false); });
    return () => { counter.current++; controller.abort(); };
  }, [activityId, data.student.enrollmentId, offeringId, page, revision]);
  if (!activities.length) return <EmptyLine icon={<FileCheck2 size={20}/>} text="该教学班暂无可提交的非课堂活动"/>;
  return <div><label className="text-xs font-medium text-[var(--pbl-text-muted)]">选择活动<select className={`${fieldClass} mt-2 w-full`} value={activityId} onChange={(event) => { setActivityId(event.target.value); setPage(1); }}>{activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.chapterTitle} · {activity.title}</option>)}</select></label>
    {loading ? <p role="status" className="py-8 text-sm text-[var(--pbl-text-muted)]">正在加载提交历史…</p> : error ? <div className="py-5"><PlatformError message={error} onRetry={() => setRevision(value => value + 1)}/></div> : result?.submissions.length ? <div className="mt-4 space-y-3">{result.submissions.map((submission, index) => <SubmissionRecord key={submission.id} submission={submission} currentConfig={data.activities.find((activity) => activity.id === activityId)?.config} defaultOpen={index === 0}/>)}</div> : <EmptyLine icon={<FileCheck2 size={20}/>} text="该活动暂无提交记录"/>}
    {result && result.submissions.length ? <div className="mt-4 flex items-center justify-between"><button className={secondaryButton} disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span className="text-xs text-[var(--pbl-text-muted)]">第 {page} 页 · 共 {result.pagination.total} 条</span><button className={secondaryButton} disabled={!result.pagination.hasMore} onClick={() => setPage((value) => value + 1)}>下一页</button></div> : null}
  </div>;
}

function SubmissionRecord({ submission, currentConfig, defaultOpen }: { submission: SubmissionData["submissions"][number]; currentConfig: unknown; defaultOpen: boolean }) {
  const payload = asObject(submission.payload);
  const snapshot = asObject(submission.activitySnapshot);
  const config = submission.snapshotSource === "legacy" ? asObject(currentConfig) : asObject(snapshot.config);
  const answers = asObject(payload.answers);
  const questions = Array.isArray(config.questions) ? config.questions.map(asObject) : [];
  return <details open={defaultOpen} className="border-b border-[var(--pbl-border)] pb-4"><summary className="flex min-h-11 items-center justify-between gap-3 text-sm font-medium"><span>{formatTime(submission.submittedAt)}</span><span className="text-xs text-[var(--pbl-text-muted)]">版本 {submission.activityVersion}</span></summary>{submission.snapshotSource === "legacy" ? <p className="mb-3 text-xs text-amber-700">旧记录未保存题目快照，以下题目来自当前活动配置。</p> : null}{typeof payload.answer === "string" && payload.answer ? <p className="whitespace-pre-wrap text-sm leading-7">{payload.answer}</p> : null}{Object.keys(answers).length ? <dl className="space-y-3">{Object.entries(answers).map(([questionId, answer]) => {
    const question = questions.find((item) => item.id === questionId);
    const options = Array.isArray(question?.options) ? question.options.map(asObject) : [];
    const labels = (Array.isArray(answer) ? answer : [answer]).map((value) => options.find((option) => option.id === value)?.label ?? (question?.type === "true-false" ? value === "true" ? "正确" : value === "false" ? "错误" : String(value) : String(value)));
    return <div key={questionId}><dt className="text-xs text-[var(--pbl-text-muted)]">{String(question?.title ?? question?.prompt ?? (questionId === "__skipReason" ? "跳题原因" : questionId))}</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{labels.join("、")}</dd></div>;
  })}</dl> : null}</details>;
}

function ClassroomTab({ data }: { data: StudentDetailData }) {
  if (!data.classrooms.length) return <EmptyLine icon={<UserRoundCheck size={20}/>} text="该学生尚未进入课堂"/>;
  const returnTo = typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;
  return <div><p className={`${styles.note} mb-4`}>按课堂场次查看学习过程、保存的作品与评价。</p>{data.classrooms.map(classroom => {
    const evaluation = classroom.evaluationSummary;
    const evaluationLabel = evaluation?.teacherStatus === "submitted" ? "已正式定评" : evaluation?.teacherStatus === "draft" ? "评价草稿" : classroom.pendingTeacherEvaluation ? "待教师评价" : "暂无教师定评";
    return <article key={classroom.id} className={styles.classroom}>
      <div className={styles.classroomHeader}><div><h3>{classroom.instance.activity.title}</h3><p>第 {classroom.instance.runNo} 场 · {classroom.instance.status === "finished" ? "已结束" : classroom.instance.status === "teaching" ? "授课中" : "待授课"}</p></div><div className="flex flex-wrap justify-end gap-2"><span className={`${styles.badge} ${classroom.pendingTeacherEvaluation ? styles.warning : ""}`}>{evaluationLabel}</span>{evaluation?.published ? <span className={`${styles.badge} bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]`}>{evaluation.publishedTeacher ? "有已发布定评" : "已发布过程报告"}</span> : null}</div></div>
      <p>首次参与 {formatTime(classroom.firstEnteredAt)}<br/>最近参与 {formatTime(classroom.lastEnteredAt)}</p>
      <div className={styles.actions}><Link className={styles.primary} href={`/teacher/participations/${classroom.id}?returnTo=${encodeURIComponent(returnTo)}`}>进入成果与评价<ChevronRight size={16}/></Link><Link className={styles.button} href={`/teacher/classrooms/${classroom.instance.id}?returnTo=${encodeURIComponent(returnTo)}`}>查看本场全班记录</Link></div>
    </article>;
  })}</div>;
}

function EmptyLine({ icon, text }: { icon: ReactNode; text: string }) { return <div className="mt-5 flex min-h-28 flex-col items-center justify-center gap-2 border-y border-dashed border-[var(--pbl-border)] text-sm text-[var(--pbl-text-muted)]">{icon}<p>{text}</p></div>; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
