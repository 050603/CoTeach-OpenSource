"use client";

import { useEffect, useId, useRef, useState } from "react";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Download, FileText, List, LoaderCircle, Maximize, Minimize, MonitorUp, PanelLeftClose, Search, Sparkles, Square, Users } from "lucide-react";
import { ShowcaseSelectionPanel } from "@/components/showcase/showcase-selection-panel";
import { CourseRubricAssessment } from "@/components/showcase/course-rubric-assessment";
import { ShowcaseArtifactViewer, type ShowcaseViewStatePatch } from "@/components/showcase/showcase-artifact-viewer";
import { ShowcaseProjectionStatus } from "@/components/showcase/showcase-projection-status";
import { ShowcaseDrawer, ShowcaseMaterialToolbar, ShowcaseZoomControls, showcaseStyles as styles } from "@/components/showcase/showcase-workspace-controls";
import { Card } from "@/components/ui";
import { useShowcasePresentation, type ShowcasePresentationController } from "@/hooks/use-showcase-presentation";
import { useTeacherPresentation, type TeacherFullscreenController } from "@/hooks/use-teacher-presentation";
import { useBodyScrollLock } from "@/hooks/use-body-scroll-lock";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";
import type { Course, FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";
import type { ShowcaseAction, ShowcaseData, ShowcaseStudentSummary } from "@/lib/showcase/types";
import type { ShowcaseRecommendations, ShowcaseRecommendationReason } from "@/lib/showcase/recommendation-types";
import { showcaseSelectedStudentIds } from "@/lib/showcase/selection";
import { StageEmptyState } from "@/components/classroom/classroom-ui";
import { TeacherPresentationActions } from "@/components/classroom/teacher-presentation-actions";
import { teacherOperationStyles as operationStyles } from "@/components/classroom/teacher-operation-details";
import { EvaluationWorkspaceEntry } from "@/components/evaluation/teacher-evaluation";
import { CourseStageRequirements } from "@/components/classroom/course-stage-requirements";

const completedStatuses = ["completed", "evaluating"];
const recommendationLabels: Record<ShowcaseRecommendationReason["kind"], string> = {
  quality: "作品推荐", earliest: "较早提交", latest: "最近提交", "ai-interactions": "AI 互动较多",
};
function presentable(artifacts: FinalArtifactSummary[]) { return artifacts.find((item) => item.kind === "document" || item.kind === "pdf"); }
function artifactForPresentation(presentation: ShowcasePresentationSnapshot): FinalArtifactSummary {
  return { kind: presentation.artifactKind, versionId: presentation.artifactVersionId, title: presentation.artifactTitle, sequence: 0, submittedAt: presentation.requestedAt, displayModes: presentation.artifactKind === "pdf" ? ["continuous", "slides"] : ["continuous"] };
}

export function NewShowcaseTeacherView({ course, focus, controller, fullscreen, presentation = "teaching", immersive = false }: {
  course: Course; presentation?: TeacherPresentationMode; immersive?: boolean;
  focus?: Extract<TeacherStageFocus, { stageKey: "showcase" }>; controller?: ShowcasePresentationController;
  fullscreen?: TeacherFullscreenController;
}) {
  const localController = useShowcasePresentation(controller ? undefined : course.id);
  const localFullscreenControl = useTeacherPresentation(!fullscreen);
  const fullscreenControl = fullscreen ?? localFullscreenControl;
  const localFullscreenSession = useRef<{ wasFullscreen: boolean; entered: boolean } | undefined>(undefined);
  const control = controller ?? localController;
  const { data, loading, error, runAction, reload } = control;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const adoptingRef = useRef(false);
  const [localError, setLocalError] = useState<string>();
  const [saveMessage, setSaveMessage] = useState("");
  const retryRef = useRef<ShowcaseAction | undefined>(undefined);
  const [selectedDraft, setSelectedDraft] = useState<string[]>();
  const [selectedStudentId, setSelectedStudentId] = useState<string>();
  const [selectedArtifactVersionId, setSelectedArtifactVersionId] = useState<string>();
  const [previewScale, setPreviewScale] = useState(1);
  const [selectedDisplayMode, setSelectedDisplayMode] = useState<"continuous" | "slides">("slides");
  const [listTab, setListTab] = useState<"recommended" | "all" | "selected">("all");
  const [query, setQuery] = useState("");
  const [browsePresentationId, setBrowsePresentationId] = useState<string>();
  const [studentsOpen, setStudentsOpen] = useState(false);
  const [wideWorkspace, setWideWorkspace] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [minimizedId, setMinimizedId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [assessmentStudentId, setAssessmentStudentId] = useState("");
  const [readingPositions, setReadingPositions] = useState<Record<string, ShowcaseViewStatePatch>>({});
  const [localFullscreen, setLocalFullscreen] = useState<{ artifact: FinalArtifactSummary; studentName: string; displayMode: "continuous" | "slides" }>();
  const localFullscreenTrigger = useRef<HTMLButtonElement>(null);
  const localFullscreenTriggerId = useId();
  const [recommendations, setRecommendations] = useState<ShowcaseRecommendations>();
  const [recommendationError, setRecommendationError] = useState<string>();
  const [recommendationUpdated, setRecommendationUpdated] = useState(false);
  const [recommendationRetry, setRecommendationRetry] = useState(0);
  const recommendationRevision = useRef<string | undefined>(undefined);
  const recommendationsUrl = `/api/courses/${encodeURIComponent(course.id)}/showcase/recommendations`;

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async (method: "GET") => {
      try {
        const response = await boundedFetch(recommendationsUrl, { method, cache: "no-store", signal: abort.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message ?? "推荐读取失败");
        if (abort.signal.aborted) return;
        const next = result as ShowcaseRecommendations;
        if (recommendationRevision.current && recommendationRevision.current !== next.revision) setRecommendationUpdated(true);
        recommendationRevision.current = next.revision;
        setRecommendations(next);
        setRecommendationError(undefined);
      } catch (caught) {
        if (!abort.signal.aborted) setRecommendationError(caught instanceof Error ? caught.message : "推荐读取失败");
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => { void read("GET"); }, 10_000);
      }
    };
    void read("GET");
    return () => { abort.abort(); clearTimeout(timer); };
  }, [recommendationsUrl, recommendationRetry]);

  const queue = data?.queue ?? [];
  const students: ShowcaseStudentSummary[] = data?.students.length ? data.students : queue.map((item) => ({ studentId: item.studentId, name: item.studentName, groupId: item.groupId, isAssigned: false, artifacts: item.artifacts }));
  const active = data?.activePresentation ?? null;
  const browseOpen = Boolean(active && browsePresentationId === active.id);
  const setBrowseOpen = (open: boolean) => setBrowsePresentationId(open ? active?.id : undefined);
  const completed = queue.filter((item) => completedStatuses.includes(item.status));
  const protectedIds = [...new Set([...queue.filter((item) => completedStatuses.includes(item.status) || item.status === "presenting").map((item) => item.studentId), ...(active ? [active.studentId] : [])])];
  const savedSelection = showcaseSelectedStudentIds(data);
  const savedIds = [...queue.map((item) => item.studentId).filter((id) => savedSelection.includes(id)), ...savedSelection.filter((id) => !queue.some((item) => item.studentId === id))];
  const selectedIds = [...new Set([...(selectedDraft ?? savedIds), ...protectedIds])];
  const targetCount = data?.queueConfig?.presenterCount ?? recommendations?.targetCount ?? course.content.stagePlan?.showcasePlan?.presenterCount ?? 3;
  const targetSource = recommendations?.targetSource ?? (data?.queueConfig?.presenterCount ? "teacher" : course.content.stagePlan?.showcasePlan?.presenterCount ? "plan" : "default");
  const presentableCount = students.filter((student) => presentable(student.artifacts)).length;
  const recommendedIds = recommendations?.recommendedStudentIds ?? [];
  const next = queue.find((item) => selectedIds.includes(item.studentId) && !completedStatuses.includes(item.status) && item.status !== "presenting" && presentable(item.artifacts));
  const startTarget = active ? undefined : next;
  const selectedStudent = students.find((student) => student.studentId === (selectedStudentId ?? focus?.studentId))
    ?? students.find((student) => presentable(student.artifacts)) ?? students[0];
  const selectedArtifact = selectedStudent?.artifacts.find((artifact) => artifact.versionId === selectedArtifactVersionId) ?? (selectedStudent ? presentable(selectedStudent.artifacts) ?? selectedStudent.artifacts[0] : undefined);
  const selectedCandidate = recommendations?.candidates.find((candidate) => candidate.studentId === selectedStudent?.studentId);
  const activeArtifact = active ? artifactForPresentation(active) : undefined;
  const showingProjection = Boolean(active && minimizedId !== active.id && presentation !== "analytics");
  const showingLocalFullscreen = Boolean(localFullscreen && presentation !== "analytics");
  const sidebarVisible = wideWorkspace && !sidebarCollapsed;
  const displayIds = listTab === "recommended" ? recommendedIds : listTab === "selected" ? selectedIds : [...students].sort((a, b) => Number(Boolean(presentable(b.artifacts))) - Number(Boolean(presentable(a.artifacts)))).map((student) => student.studentId);
  const visibleStudents = displayIds.flatMap((id) => students.find((student) => student.studentId === id) ?? []).filter((student) => student.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      const wide = workspace.clientWidth >= 1100;
      setWideWorkspace(wide);
      if (wide) setStudentsOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [data, showingProjection, showingLocalFullscreen, browseOpen]);

  function openStudentList() {
    if (wideWorkspace) {
      setSidebarCollapsed(false);
      window.requestAnimationFrame(() => workspaceRef.current?.querySelector<HTMLInputElement>('[aria-label="搜索学生姓名"]')?.focus());
    } else setStudentsOpen(true);
  }

  useEffect(() => {
    if (!browseOpen || showingLocalFullscreen) return;
    const dialog = document.querySelector<HTMLElement>('[aria-label="浏览学生作品"]');
    const previousFocus = document.activeElement as HTMLElement | null;
    const first = dialog?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)");
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialog && !dialog.contains(document.activeElement)) return;
      if (event.key === "Escape") { event.preventDefault(); setBrowsePresentationId(undefined); }
      if (event.key !== "Tab" || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary")].filter((element) => element.getClientRects().length);
      const firstControl = controls[0]; const lastControl = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === firstControl) { event.preventDefault(); lastControl?.focus(); }
      else if (!event.shiftKey && document.activeElement === lastControl) { event.preventDefault(); firstControl?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [browseOpen, showingLocalFullscreen]);

  useBodyScrollLock(showingProjection || browseOpen || showingLocalFullscreen);

  useEffect(() => {
    const synchronize = () => {
      const session = localFullscreenSession.current;
      if (!session) return;
      if (document.fullscreenElement) session.entered = true;
      else if (session.entered) {
        localFullscreenSession.current = undefined;
        setLocalFullscreen(undefined);
        window.requestAnimationFrame(() => localFullscreenTrigger.current?.focus());
      }
    };
    document.addEventListener("fullscreenchange", synchronize);
    return () => document.removeEventListener("fullscreenchange", synchronize);
  }, []);

  function openLocalFullscreen() {
    if (!selectedArtifact || !selectedStudent || selectedArtifact.kind === "file") return;
    const wasFullscreen = Boolean(document.fullscreenElement) && !fullscreenControl.exiting;
    localFullscreenSession.current = { wasFullscreen, entered: wasFullscreen };
    setLocalFullscreen({ artifact: selectedArtifact, studentName: selectedStudent.name, displayMode: selectedDisplayMode });
    void fullscreenControl.enter();
  }

  function closeLocalFullscreen() {
    const session = localFullscreenSession.current;
    localFullscreenSession.current = undefined;
    setLocalFullscreen(undefined);
    const restoreLocalFocus = () => window.requestAnimationFrame(() => localFullscreenTrigger.current?.focus());
    if (session && !session.wasFullscreen) void fullscreenControl.exit().then(restoreLocalFocus);
    else restoreLocalFocus();
  }

  async function runTeacherAction(action: ShowcaseAction, fallback: string) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true); setLocalError(undefined); setSaveMessage(""); retryRef.current = action;
    try {
      await runAction(action);
      retryRef.current = undefined;
      setSelectedDraft(undefined);
      setSaveMessage(action.action === "save-queue" ? "名单已保存" : "操作已完成");
      return true;
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : fallback);
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function saveSelection(ids: string[]) {
    const desired = [...new Set([...ids, ...protectedIds])];
    const movable = desired.filter((id) => !protectedIds.includes(id));
    const lockedSlots = queue.map((item, index) => protectedIds.includes(item.studentId) ? index : -1).filter((index) => index >= 0);
    if (lockedSlots.some((index) => index >= desired.length)) {
      setLocalError("为保留已开始汇报的顺序，请先加入替补学生，再移除前面的学生。");
      return false;
    }
    let movableIndex = 0;
    const merged = desired.map((_, index) => protectedIds.includes(queue[index]?.studentId) ? queue[index].studentId : movable[movableIndex++]);
    setSelectedDraft(merged);
    const config = data?.queueConfig;
    return runTeacherAction({ action: "save-queue", selectionMode: "teacher-selected", selectedStudentIds: merged,
      orderedStudentIds: merged, presentationSec: config?.presentationSec ?? 180, discussionSec: config?.discussionSec ?? 60,
      transitionSec: config?.transitionSec ?? 20, presenterCount: targetCount,
      minutesPerStudent: Math.max(1, Math.min(60, Math.ceil(((config?.presentationSec ?? 180) + (config?.transitionSec ?? 20)) / 60))),
    }, "保存汇报名单失败");
  }

  function chooseStudent(studentId: string) { setSelectedStudentId(studentId); setSelectedArtifactVersionId(undefined); setSelectedDisplayMode("slides"); }
  function toggleSelected(studentId: string) { if (!busy && !protectedIds.includes(studentId)) void saveSelection(selectedIds.includes(studentId) ? selectedIds.filter((id) => id !== studentId) : [...selectedIds, studentId]); }
  function setNext(studentId: string) {
    if (busy || protectedIds.includes(studentId)) return;
    const firstUnlocked = selectedIds.findIndex((id) => !protectedIds.includes(id));
    const ids = selectedIds.filter((id) => id !== studentId);
    ids.splice(firstUnlocked < 0 ? ids.length : firstUnlocked, 0, studentId);
    void saveSelection(ids);
  }
  function moveStudent(studentId: string, delta: number) {
    const index = selectedIds.indexOf(studentId);
    const adjacent = selectedIds[index + delta];
    if (!adjacent || busy || protectedIds.includes(studentId) || protectedIds.includes(adjacent)) return;
    const ids = [...selectedIds]; [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    void saveSelection(ids);
  }
  async function adoptRecommendations() {
    if (busy || adoptingRef.current) return;
    adoptingRef.current = true; setBusy(true); setRecommendationUpdated(false);
    try {
      const [response, currentResponse] = await Promise.all([
        boundedFetch(recommendationsUrl, { cache: "no-store" }),
        boundedFetch(`/api/courses/${encodeURIComponent(course.id)}/showcase/presentation`, { cache: "no-store", headers: { "X-OpenPBL-Role": "teacher" } }),
      ]);
      const latest = await response.json() as ShowcaseRecommendations & { message?: string };
      const currentData = await currentResponse.json() as ShowcaseData & { message?: string };
      if (!response.ok) throw new Error(latest.message ?? "推荐读取失败");
      if (!currentResponse.ok) throw new Error(currentData.message ?? "作品版本核对失败");
      setRecommendations(latest);
      void reload?.();
      const freshSelected = showcaseSelectedStudentIds(currentData);
      const base = selectedDraft ?? [...currentData.queue.map((item) => item.studentId).filter((id) => freshSelected.includes(id)), ...freshSelected.filter((id) => !currentData.queue.some((item) => item.studentId === id))];
      const additions = latest.recommendedStudentIds.slice(0, Math.max(0, latest.targetCount - base.length));
      if (additions.some((studentId) => {
        const candidate = latest.candidates.find((item) => item.studentId === studentId);
        return !candidate || !currentData.students.find((student) => student.studentId === studentId)?.artifacts.some((artifact) => artifact.versionId === candidate.artifactVersionId && artifact.kind === candidate.artifactKind);
      })) {
        setRecommendationError("作品已更新，已刷新推荐，请核对后采用");
        return;
      }
      setRecommendationError(undefined);
      await saveSelection([...base, ...additions]);
    } catch (caught) { setRecommendationError(caught instanceof Error ? caught.message : "推荐读取失败"); }
    finally { adoptingRef.current = false; setBusy(false); }
  }
  async function startPresentation() {
    if (!startTarget || active || busy) return;
    const artifact = startTarget.studentId === selectedStudent?.studentId && selectedArtifact?.kind !== "file" ? selectedArtifact : presentable(startTarget.artifacts);
    if (!artifact || artifact.kind === "file") return;
    const success = await runTeacherAction({ action: "start", studentId: startTarget.studentId, artifactKind: artifact.kind, artifactVersionId: artifact.versionId, displayMode: artifact.kind === "pdf" ? (startTarget.studentId === selectedStudent?.studentId ? selectedDisplayMode : "slides") : "continuous" }, "发起汇报投屏失败");
    if (success) { setMinimizedId(undefined); setBrowseOpen(false); }
  }
  async function stopPresentation() {
    if (!active || busy) return;
    const success = await runTeacherAction({ action: "end", presentationId: active.id }, "结束汇报失败");
    if (success) { setBrowseOpen(false); }
  }
  function flowAction() {
    return active ? <button data-tone="danger" disabled={busy} onClick={() => void stopPresentation()} type="button"><Square size={18} />结束{active.studentName ?? "当前学生"}汇报</button>
      : startTarget ? <button data-tone="primary" disabled={busy} onClick={() => void startPresentation()} type="button"><MonitorUp size={18} />开始{startTarget.studentName}汇报并投屏</button>
      : <button disabled type="button">{completed.length ? "本轮汇报完成" : "请先添加汇报学生"}</button>;
  }

  if (loading && !data) return <Card className="grid min-h-56 place-items-center"><span className="inline-flex items-center gap-2 text-sm text-stone-500"><LoaderCircle className="animate-spin" size={18} />正在读取汇报状态…</span></Card>;

  const emptyRosterTitle = query.trim() ? `没有找到“${query.trim()}”`
    : listTab === "selected" ? "还没有汇报人选"
    : listTab === "recommended" ? recommendationError ? "推荐暂时不可用"
      : !recommendations || recommendations.pendingCount > 0 ? "推荐名单准备中"
      : !presentableCount ? "还没有可展示的作品" : "本轮暂无推荐人选"
    : "暂时没有学生作品";
  const emptyRosterDescription = query.trim() ? "试试姓名中的其他字。"
    : listTab === "selected" ? "加入名单后，学生会按汇报顺序显示。"
    : listTab === "recommended" ? recommendationError ? "仍可从学生作品中安排汇报。"
      : !recommendations || recommendations.pendingCount > 0 ? recommendations?.pendingCount ? `正在分析 ${recommendations.pendingCount} 份新作品。` : "正在整理已提交的作品。"
      : !presentableCount ? "学生提交文档或 PDF 后会显示在这里。" : "可以直接挑选已提交的作品。"
    : "有作品提交后会显示在这里。";

  const errorNotice = error || localError || control.controlError ? <div className={styles.workspaceError} role="alert"><span>{localError ?? control.controlError ?? error}</span><button className={styles.toolbarButton} disabled={busy} onClick={() => { if (retryRef.current) void runTeacherAction(retryRef.current, "操作失败"); else void reload?.(); }} type="button">重试</button></div> : null;
  const rosterStatus = busy ? <p className={styles.rosterProgress} role="status">正在保存…</p> : null;
  const studentList = <section aria-label="汇报学生列表" className={styles.studentList}>
    <div className={styles.selectionTabs} role="tablist" aria-label="学生范围">{([["all", "全部学生", students.length], ["recommended", "推荐人选", recommendedIds.length], ["selected", "汇报名单", selectedIds.length]] as const).map(([tab, label, count]) => <button aria-label={tab === "selected" ? `${label} ${count}` : label} aria-selected={listTab === tab} key={tab} onClick={() => { setListTab(tab); setQuery(""); }} role="tab" type="button">{label}<span aria-hidden="true">{count}</span></button>)}</div>
    <div className={styles.studentSearchField}><Search aria-hidden="true" size={16} /><input aria-label="搜索学生姓名" type="search" placeholder="搜索姓名" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {rosterStatus}
    {errorNotice}
    {listTab === "recommended" && Boolean(visibleStudents.length) && recommendations?.pendingCount ? <div className={styles.rosterProgress} role="status"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />还有 {recommendations.pendingCount} 份作品分析中</div> : null}
    <div className={styles.studentListBody}>{visibleStudents.length ? visibleStudents.map((student) => {
      const item = queue.find((row) => row.studentId === student.studentId);
      const candidate = recommendations?.candidates.find((row) => row.studentId === student.studentId);
      const chosen = selectedIds.includes(student.studentId);
      const locked = protectedIds.includes(student.studentId);
      const ready = Boolean(presentable(student.artifacts));
      const index = selectedIds.indexOf(student.studentId);
      const browsing = selectedStudent?.studentId === student.studentId;
      const stateLabel = active?.studentId === student.studentId ? "正在汇报" : item && completedStatuses.includes(item.status) ? "已汇报" : !ready ? "待提交作品" : chosen ? next?.studentId === student.studentId ? "下一位汇报" : `第 ${index + 1} 位汇报` : "可查看作品";
      const reasonKinds = [...new Set(candidate?.reasons.map((reason) => reason.kind) ?? [])].filter((kind) => kind !== "quality" || (candidate?.analysisStatus === "complete" && candidate.qualityScore !== undefined && candidate.analysisFreshness !== "outdated")).slice(0, 2);
      return <article className={styles.studentRow} data-current={browsing} key={student.studentId}>
        <div className={styles.studentRowMain}>
          {listTab === "selected" ? <span aria-label={`汇报顺序 ${index + 1}`} className={styles.rosterOrder}>{index + 1}</span> : null}
          <button className={styles.studentRowPreview} aria-pressed={browsing} onClick={() => { chooseStudent(student.studentId); setStudentsOpen(false); }} type="button" aria-label={`浏览${student.name}作品`}><span className={styles.studentName}><strong>{student.name}</strong>{browsing ? <span className={styles.browsingBadge}>浏览中</span> : null}</span><span>{stateLabel}</span>{!chosen && ready && (reasonKinds.length || candidate?.analysisFreshness === "outdated" || candidate?.analysisFreshness === "minor-change" || candidate?.coverage?.mode === "sampled") ? <span className={styles.reasonBadges}>{reasonKinds.map((kind) => <small key={kind}>{recommendationLabels[kind]}</small>)}{candidate?.analysisFreshness === "outdated" || candidate?.analysisFreshness === "minor-change" ? <small>作品已更新</small> : null}{candidate?.coverage?.mode === "sampled" ? <small>部分内容分析</small> : null}</span> : null}</button>
          <button aria-label={`${chosen ? "移除" : "加入"}${student.name}汇报名单`} aria-pressed={chosen} className={styles.rosterSelect} disabled={busy || locked || !ready} onClick={() => toggleSelected(student.studentId)} title={locked ? "已开始汇报，名单保持不变" : !ready ? "提交文档或 PDF 后可加入汇报" : chosen ? "移出汇报名单" : "加入汇报名单"} type="button">{chosen ? "移出名单" : "加入名单"}</button>
        </div>
        {listTab === "selected" && chosen && !locked ? <div className={styles.rosterOrderActions}><button aria-label={`安排${student.name}下一位`} disabled={busy || next?.studentId === student.studentId} onClick={() => setNext(student.studentId)} type="button">安排下一位</button><button aria-label={`${student.name}上移`} disabled={busy || index <= 0 || protectedIds.includes(selectedIds[index - 1])} onClick={() => moveStudent(student.studentId, -1)} type="button"><ArrowUp size={14} />上移</button><button aria-label={`${student.name}下移`} disabled={busy || index === selectedIds.length - 1 || protectedIds.includes(selectedIds[index + 1])} onClick={() => moveStudent(student.studentId, 1)} type="button"><ArrowDown size={14} />下移</button></div> : null}
      </article>;
    }) : <div className={styles.rosterEmpty}><span className={styles.rosterEmptyIcon}>{query.trim() ? <Search size={22} /> : listTab === "recommended" ? <Sparkles size={22} /> : <Users size={22} />}</span><h3>{emptyRosterTitle}</h3><p>{emptyRosterDescription}</p>{query.trim() ? <button className={styles.toolbarButton} onClick={() => setQuery("")} type="button">清空搜索</button> : listTab !== "all" ? <button className={styles.toolbarButton} onClick={() => { setListTab("all"); setQuery(""); }} type="button">浏览全部学生</button> : null}</div>}</div>
  </section>;

  const arrangementActions = <>
    <button aria-haspopup="dialog" className={styles.toolbarButton} onClick={() => { setStudentsOpen(false); setPlanOpen(true); }} type="button">汇报安排<span className={styles.planCount}>已选 {selectedIds.length} 人 · 已汇报 {completed.length} 人</span></button>
    {selectedCandidate ? <button aria-haspopup="dialog" className={styles.toolbarButton} onClick={() => { setStudentsOpen(false); setReasonsOpen(true); }} type="button">推荐依据</button> : null}
    <button aria-haspopup="dialog" className={styles.toolbarButton} onClick={() => { setStudentsOpen(false); setMoreOpen(true); }} type="button">更多</button>
  </>;

  const workspace = <div className={`${styles.workspace} ${styles.teacherWorkspace}`} data-sidebar={sidebarVisible} ref={workspaceRef}>
    {!sidebarVisible && !studentsOpen ? errorNotice : null}
    <div className={styles.selectionLayout}>
      {sidebarVisible ? <aside aria-label="汇报学生与安排" className={styles.teacherSidebar}>
        <header className={styles.sidebarHeader}><div><h2>学生作品</h2><p className={styles.sidebarSummary}>已选 {selectedIds.length}/{targetCount} 人 · 已汇报 {completed.length} 人</p></div><button aria-label="收起汇报侧栏" className={styles.toolbarButton} onClick={() => setSidebarCollapsed(true)} type="button"><PanelLeftClose size={18} /></button></header>
        {studentList}
        <div className={styles.sidebarActions}>{arrangementActions}</div>
      </aside> : null}
      <main aria-label="学生作品浏览" className={styles.main}>
      {active ? <div className={styles.currentPresentation}><span>全班正在观看<strong>{active.studentName ?? "当前学生"}</strong></span><button className={styles.toolbarButton} onClick={() => { setBrowseOpen(false); setMinimizedId(undefined); }} type="button"><MonitorUp size={16} />返回当前汇报</button></div> : null}
      <ShowcaseMaterialToolbar className={styles.teacherMaterialToolbar} showDownload={false} artifacts={selectedStudent?.artifacts ?? []} selected={selectedArtifact} onSelect={(item) => { setSelectedArtifactVersionId(item.versionId); setSelectedDisplayMode("slides"); }} displayMode={selectedDisplayMode} onDisplayModeChange={setSelectedDisplayMode} tone="teacher" actions={<button aria-label="本机全屏展示" className={styles.toolbarButton} disabled={!selectedArtifact || selectedArtifact.kind === "file"} id={localFullscreenTriggerId} onClick={openLocalFullscreen} ref={localFullscreenTrigger} type="button"><Maximize size={16} /><span>本机全屏展示</span></button>}>
        <button className={styles.toolbarButton} onClick={openStudentList} type="button"><List size={16} />选择学生</button>
        <div className={styles.previewIdentity}><strong title={selectedStudent?.name}>{selectedStudent?.name ?? "暂无学生"}</strong><span>{selectedArtifact ? "作品预览" : "暂无可查看作品"}</span></div>
      </ShowcaseMaterialToolbar>
      <div className={`${styles.preview} ${styles.teacherPreview} ${styles.immersivePreview} ${styles.readingSurface}`} data-paged={selectedArtifact?.kind === "pdf" && selectedDisplayMode === "slides"} tabIndex={0}>
        {!selectedArtifact ? <StageEmptyState className="h-full border-0" title="尚无可展示作品" description="学生提交主文档或 PDF 后即可选择汇报。" /> : selectedArtifact.kind === "file" ? <div className="grid h-full place-items-center p-6 text-center"><div><FileText className="mx-auto text-stone-400" size={30} /><p className="mt-2 text-sm">此材料可下载查看；投屏请选择主文档或 PDF。</p>{selectedArtifact.downloadUrl ? <a className={`${styles.toolbarButton} mt-3`} download href={selectedArtifact.downloadUrl}><Download size={15} />下载资料</a> : null}</div></div> : <ShowcaseArtifactViewer artifact={selectedArtifact} courseId={course.id} displayMode={selectedArtifact.kind === "pdf" ? selectedDisplayMode : "continuous"} initialViewState={readingPositions[selectedArtifact.versionId]} key={`${selectedStudent?.studentId}:${selectedArtifact.versionId}`} mode="self" presentationLayout scale={previewScale} onViewStateChange={(patch) => setReadingPositions((old) => ({ ...old, [selectedArtifact.versionId]: { ...old[selectedArtifact.versionId], ...patch } }))} />}
        <ShowcaseZoomControls compact scale={previewScale} onChange={setPreviewScale} disabled={!selectedArtifact || selectedArtifact.kind === "file"} />
      </div>
    </main></div>
  </div>;

  const planPanel = <>
    <div className={styles.selectionSummary}><span>{targetSource === "default" ? "建议人数" : targetSource === "plan" ? "教案要求" : "目标人数"} {targetCount} 人</span><span>已选 {selectedIds.length} 人</span><span>已汇报 {completed.length} 人</span>{presentableCount < targetCount ? <span className="text-amber-800">可展示 {presentableCount} 人，尚缺 {targetCount - presentableCount} 人</span> : null}<span>剩余 {data?.budget ? `${Math.ceil(data.budget.stageRemainingSec / 60)} 分钟` : "待计时"}</span><span className="ml-auto" role="status">{busy ? "正在保存…" : saveMessage}</span></div>
    {selectedIds.length > targetCount || data?.budget?.overrunSec ? <p className="my-2 text-xs text-amber-800">{selectedIds.length > targetCount ? "所选人数超过安排人数。" : ""}{data?.budget?.overrunSec ? `预计超出 ${Math.ceil(data.budget.overrunSec / 60)} 分钟。` : ""}可继续安排，也可调整人数与时长。</p> : null}

    {active && browseOpen ? <div className={styles.handoff}>正在本机浏览；全班继续观看{active.studentName ?? "当前学生"}的作品。</div> : null}
    <div className={styles.planActions}><button className={styles.toolbarButton} onClick={() => { setPlanOpen(false); setSettingsOpen(true); }} type="button">人数与时间</button><button className={styles.toolbarButton} onClick={() => { setPlanOpen(false); setRequirementsOpen(true); }} type="button">教案要求</button><button className={styles.toolbarButton} onClick={() => { setPlanOpen(false); openStudentList(); }} type="button">调整汇报名单</button></div>
    <div className={styles.planRecommendations}>{recommendationError ? <span>{recommendationError}；可继续浏览选人。<button className="ml-2 min-h-11 underline" onClick={() => setRecommendationRetry(value => value + 1)} type="button">重试推荐</button></span> : recommendationUpdated ? "推荐已更新，已选名单保持不变。" : recommendations?.pendingCount ? `${recommendations.pendingCount} 份作品正在分析，可先开始汇报。` : recommendations ? `${recommendedIds.length} 名推荐候选，教师可优先选择。` : "推荐分析正在准备，可先手动选择。"}{startTarget ? <span className="block font-semibold text-stone-700">{active ? "下一位" : "将汇报"}：{startTarget.studentName}</span> : null}</div><button className={styles.toolbarButton} disabled={busy || !recommendedIds.length} onClick={() => void adoptRecommendations()} type="button">{selectedIds.length ? "补充推荐学生" : "采用推荐名单"}</button>
  </>;

  const projection = active && activeArtifact ? <TeacherPresentationOverlay artifact={activeArtifact} courseId={course.id} presentation={active} busy={busy} hidden={!showingProjection} onEnd={() => void stopPresentation()} onBrowse={() => { setBrowseOpen(true); }} fullscreen={fullscreenControl} onMinimize={() => setMinimizedId(active.id)} initialViewState={readingPositions[`projection:${active.id}`]} needsTakeover={control.needsTakeover} takeControl={() => void control.takeControl?.()} controlError={control.controlError ?? localError} onViewStateChange={(patch) => { setReadingPositions((old) => ({ ...old, [`projection:${active.id}`]: { ...old[`projection:${active.id}`], ...patch } })); control.updateViewState?.(patch); }} /> : null;
  return <div className={`classroom-stage teacher-presentation-content ${operationStyles.root} ${immersive ? "flex h-full min-h-0 flex-col" : ""}`} hidden={presentation === "analytics"}>
    {!showingProjection && !showingLocalFullscreen ? <>{workspace}<TeacherPresentationActions inlineFallback><div className={styles.flowAction}>{flowAction()}</div></TeacherPresentationActions></> : null}
    {projection && typeof document !== "undefined" ? createPortal(projection, document.body) : null}
    {browseOpen && showingProjection && !showingLocalFullscreen && typeof document !== "undefined" ? createPortal(<div className={styles.browseBackdrop}><section aria-label="浏览学生作品" aria-modal="true" className={styles.browseDialog} role="dialog">{workspace}</section></div>, document.body) : null}
    {showingLocalFullscreen && localFullscreen && typeof document !== "undefined" ? createPortal(<TeacherPresentationOverlay fullscreen={fullscreenControl} artifact={localFullscreen.artifact} scale={previewScale} onScaleChange={setPreviewScale} courseId={course.id} studentName={localFullscreen.studentName} displayMode={localFullscreen.displayMode} hidden={false} onMinimize={closeLocalFullscreen} initialViewState={readingPositions[localFullscreen.artifact.versionId]} onViewStateChange={(patch) => {
      setReadingPositions((old) => ({ ...old, [localFullscreen.artifact.versionId]: { ...old[localFullscreen.artifact.versionId], ...patch } }));
      if (patch.displayMode) { const displayMode = patch.displayMode; setSelectedDisplayMode(displayMode); setLocalFullscreen((old) => old ? { ...old, displayMode } : old); }
    }} />, document.body) : null}
    {planOpen ? <ShowcaseDrawer title="汇报安排" onClose={() => setPlanOpen(false)}>{planPanel}</ShowcaseDrawer> : null}
    {reasonsOpen ? <ShowcaseDrawer title="推荐依据" onClose={() => setReasonsOpen(false)}>{selectedCandidate ? <div className={styles.recommendationReasons}>{selectedCandidate.reasons.map((reason, index) => <details key={`${reason.kind}:${index}`}><summary>{reason.text}</summary>{reason.location || reason.quote ? <p>{reason.location}{reason.quote ? `：${reason.quote}` : ""}</p> : <p>依据本课堂已提交作品及过程记录。</p>}</details>)}{selectedCandidate.analysisStatus === "complete" && selectedCandidate.qualityScore === undefined ? <span>质量依据不足，可人工选择</span> : null}{selectedCandidate.analysisFreshness === "minor-change" ? <span>参考上次分析，少量修改未重分析</span> : selectedCandidate.analysisFreshness === "outdated" ? <span>作品已更新，旧分析不参与当前质量排序</span> : selectedCandidate.analysisFreshness === "reused" ? <span>正文相同，已复用分析并核对引用位置</span> : null}{selectedCandidate.analyzedAt ? <span>初筛时间：{new Date(selectedCandidate.analyzedAt).toLocaleString("zh-CN")}</span> : null}{selectedCandidate.coverage?.mode === "sampled" ? <span>部分正文初筛（{selectedCandidate.coverage.analyzedCharacters}/{selectedCandidate.coverage.sourceCharacters} 字符）</span> : null}{selectedCandidate.analysisStatus !== "complete" ? <span>质量{selectedCandidate.analysisStatus === "failed" ? "分析暂不可用，可人工选择" : selectedCandidate.analysisStatus === "unreadable" ? "无法分析，可人工选择" : selectedCandidate.analysisStatus === "running" ? "分析中" : "待分析"}</span> : null}{selectedArtifact && selectedCandidate.artifactVersionId !== selectedArtifact.versionId ? <span>作品已更新，分析对应先前版本</span> : null}</div> : null}</ShowcaseDrawer> : null}
    {studentsOpen ? <ShowcaseDrawer title="选择汇报学生" onClose={() => setStudentsOpen(false)}>{studentList}<div className={styles.sidebarActions}>{arrangementActions}</div></ShowcaseDrawer> : null}
    {settingsOpen && data ? <ShowcaseDrawer title="人数与时间" onClose={() => setSettingsOpen(false)}><ShowcaseSelectionPanel key={data.queueConfig?.updatedAt} data={data} busy={busy} save={async (action) => { if (!await runTeacherAction(action, "保存设置失败")) throw new Error("保存失败，请重试"); }} /></ShowcaseDrawer> : null}
    {requirementsOpen ? <ShowcaseDrawer title="教案要求" onClose={() => setRequirementsOpen(false)}><CourseStageRequirements course={course} stageKey="showcase" teacher expanded /></ShowcaseDrawer> : null}
    {moreOpen ? <ShowcaseDrawer title="更多操作" onClose={() => setMoreOpen(false)}>{selectedArtifact?.downloadUrl && selectedArtifact.kind !== "file" ? <a className={`${styles.toolbarButton} mb-3`} download href={selectedArtifact.downloadUrl}><Download size={15} />下载当前材料</a> : null}<a className={styles.toolbarButton} download href={`/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/export`}><Download size={15} />下载全班成果</a><h2 className="mb-3 mt-6 font-semibold">成果评分</h2>{course.evaluationContractVersion === 2 ? <EvaluationWorkspaceEntry course={course} /> : course.content.stagePlan?.evaluationRubric ? <><label className="text-sm">选择评分学生<select aria-label="选择评分学生" className="my-2 min-h-11 w-full rounded-md border px-3" value={assessmentStudentId} onChange={(event) => setAssessmentStudentId(event.target.value)}><option value="">选择学生（含未现场汇报者）</option>{course.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>{assessmentStudentId ? <CourseRubricAssessment course={course} studentId={assessmentStudentId} /> : null}</> : <p className="text-sm text-stone-500">本课程未配置成果评分表。</p>}</ShowcaseDrawer> : null}
  </div>;
}

function TeacherPresentationOverlay({ fullscreen, artifact, courseId, presentation, studentName, displayMode = "slides", busy, hidden, onEnd, onBrowse, onMinimize, initialViewState, onViewStateChange, needsTakeover, takeControl, controlError, scale: controlledScale, onScaleChange }: {
  fullscreen: TeacherFullscreenController; artifact: FinalArtifactSummary; courseId: string; presentation?: ShowcasePresentationSnapshot; studentName?: string; displayMode?: "continuous" | "slides"; busy?: boolean; hidden: boolean;
  onEnd?: () => void; onBrowse?: () => void; onMinimize: () => void; initialViewState?: ShowcaseViewStatePatch;
  onViewStateChange: (patch: ShowcaseViewStatePatch) => void; needsTakeover?: boolean; takeControl?: () => void; controlError?: string; scale?: number; onScaleChange?: (scale: number) => void;
}) {
  const [localScale, setLocalScale] = useState(1);
  const scale = controlledScale ?? localScale;
  const changeScale = (value: number) => { setLocalScale(value); onScaleChange?.(value); };
  const [elapsed, setElapsed] = useState(0);
  const overlayRef = useRef<HTMLElement>(null);
  const minimizeRef = useRef(onMinimize);
  const localOnly = !presentation;
  const startedAt = presentation?.startedAt ?? presentation?.requestedAt;
  useEffect(() => { minimizeRef.current = onMinimize; }, [onMinimize]);
  useEffect(() => {
    if (hidden) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    overlayRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (localOnly && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); minimizeRef.current(); }
      if (event.key !== "Tab" || (!localOnly && document.querySelector('[aria-modal="true"]'))) return;
      const controls = [...overlayRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),summary") ?? []].filter((element) => element.getClientRects().length);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previousFocus?.focus(); };
  }, [hidden, localOnly]);
  useEffect(() => {
    if (!startedAt) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [startedAt]);
  const currentDisplayMode = presentation?.displayMode ?? displayMode;
  return <section aria-label={`作品全屏展示：${artifact.title}`} aria-modal={presentation ? undefined : true} className={`${styles.projectionOverlay} ${presentation ? "" : styles.localFullscreen}`} hidden={hidden} ref={overlayRef} role={presentation ? "region" : "dialog"}>
    <header className={styles.projectionHeader}><strong>{presentation?.studentName ?? studentName ?? "学生"}</strong><span className="min-w-0 flex-1 truncate">{artifact.title}</span>{presentation ? <><time className="font-mono text-sm tabular-nums" aria-label="汇报时长">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</time><ShowcaseProjectionStatus courseId={courseId} presentation={presentation} /></> : <span className="text-xs text-stone-500">仅本机展示</span>}<button className={styles.toolbarButton} onClick={onMinimize} type="button">返回作品浏览</button><button className={styles.toolbarButton} onClick={() => void (fullscreen.active ? fullscreen.exit() : fullscreen.enter())} type="button">{fullscreen.active ? <Minimize size={16} /> : <Maximize size={16} />}{fullscreen.active ? "退出全屏" : "进入全屏"}</button></header>
    {fullscreen.notice ? <p aria-label="全屏提示" className={styles.fullscreenNotice} role="status">{fullscreen.notice}</p> : null}
    {controlError || needsTakeover ? <div className="flex min-h-11 items-center gap-3 bg-amber-50 px-4 text-sm text-amber-900" role="alert"><span>{controlError ?? "另一教师窗口正在控制投屏"}</span>{needsTakeover ? <button className={styles.toolbarButton} onClick={takeControl} type="button">接管投屏</button> : null}</div> : null}
    <div className={`${styles.projectionBody} ${styles.readingSurface}`} data-paged={artifact.kind === "pdf" && currentDisplayMode === "slides"} tabIndex={0}><ShowcaseArtifactViewer artifact={artifact} courseId={courseId} displayMode={currentDisplayMode} initialViewState={initialViewState} key={presentation?.id ?? artifact.versionId} mode={presentation ? needsTakeover ? "teacher" : "controller" : "self"} presentation={presentation} presentationLayout scale={scale} onViewStateChange={onViewStateChange} /><ShowcaseZoomControls compact scale={scale} onChange={changeScale} /></div>
    {presentation || artifact.kind === "pdf" ? <footer className={styles.projectionFooter}>{artifact.kind === "pdf" ? <button aria-label={presentation ? "切换投屏阅读方式" : "切换本机阅读方式"} className={styles.toolbarButton} disabled={needsTakeover} onClick={() => onViewStateChange({ displayMode: currentDisplayMode === "slides" ? "continuous" : "slides", page: 1, scrollRatio: 0 })} type="button">{currentDisplayMode === "slides" ? "连续阅读" : "逐页演示"}</button> : null}{presentation ? <><button className={styles.toolbarButton} onClick={onBrowse} type="button"><List size={16} />浏览学生作品</button><div className={styles.flowAction}><button data-tone="danger" disabled={busy} onClick={onEnd} type="button"><Square size={16} />结束{presentation.studentName ?? "当前学生"}汇报</button></div></> : null}</footer> : null}
  </section>;
}
