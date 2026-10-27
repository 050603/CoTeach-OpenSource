"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Cloud, CloudOff, RotateCcw } from "lucide-react";
import { ExperimentQuestionList, type ExperimentDisplayAnswer, type ExperimentDisplayQuestion } from "./experiment-question-card";
import { ExperimentReferenceDialog } from "./experiment-reference-dialog";
import type { ExperimentQuestionGroup } from "@/lib/platform/experiment";
import { completeDesignAnswer, designPromptParts } from "@/lib/platform/experiment-design-answer";
import styles from "./experiment-assessment.module.css";

export type ExperimentQuestion = ExperimentDisplayQuestion;
export type ExperimentPhase = "pretest" | "posttest";
type Answers = Record<string, ExperimentDisplayAnswer>;
type Draft = { answers: Answers; currentPage: number; version: number; updatedAt: string };
type Submission = { id: string; answers: Answers; submittedAt: string };
type Assessment = { enabled: boolean; available: boolean; questions: ExperimentQuestion[]; draft: Draft | null; submission: Submission | null; studentKey: string; questionVersion?: string; accessVersion?: number; blockedReason?: string | null; introduction?: string; minutes?: number; skipReasonPrompt?: string; variant?: "none" | "A_PRE_B_POST" | "B_PRE_A_POST" };
type LocalDraft = Draft & { pending: boolean };
type Page = { questions: ExperimentQuestion[]; startIndex: number; group?: ExperimentQuestionGroup };
const phaseLabel = { pretest: "前测", posttest: "后测" } as const;
const subscribeToDocument = () => () => {};

export function paginateExperimentQuestions(questions: ExperimentQuestion[]): Page[] {
  const pages: Page[] = [];
  for (let index = 0; index < questions.length;) {
    const group = questions[index].group;
    let end = index + 1;
    while (end < questions.length && questions[end].group?.id === group?.id) end++;
    // A page follows an authored topic, never an arbitrary question count or screen size.
    pages.push({ questions: questions.slice(index, end), startIndex: index, ...(group ? { group } : {}) });
    index = end;
  }
  return pages;
}

function answered(value: ExperimentDisplayAnswer | undefined) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
}
function questionAnswered(question: ExperimentQuestion, value: ExperimentDisplayAnswer | undefined) {
  if (question.type === "short-answer" && designPromptParts(question.prompt)) return typeof value === "string" && completeDesignAnswer(value);
  return answered(value);
}
function readLocal(key: string): LocalDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<LocalDraft> | null;
    return value && value.answers && typeof value.version === "number" && typeof value.currentPage === "number" ? value as LocalDraft : null;
  } catch { return null; }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; } catch { return {}; }
}
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

export function StudentExperimentAssessment({ instanceId, activityId, phase, onCancel, onSubmitted, layout = "contained" }: ({ instanceId: string; activityId?: never } | { activityId: string; instanceId?: never }) & {
  phase: ExperimentPhase;
  /** The assigned question snapshot is loaded through GET. Retained for existing activity callers. */
  questions?: ExperimentQuestion[];
  onCancel?: () => void;
  onSubmitted?: () => void;
  layout?: "contained" | "full";
}) {
  const endpoint = activityId ? `/api/platform/activities/${encodeURIComponent(activityId)}/posttest` : `/api/platform/classroom-instances/${encodeURIComponent(instanceId!)}/experiment`;
  const instructionsId = useId();
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [review, setReview] = useState(false);
  const [readReferences, setReadReferences] = useState<string[]>([]);
  const [reopenedReference, setReopenedReference] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const footerMounted = useSyncExternalStore(subscribeToDocument, () => true, () => false);
  const [footerHeight, setFooterHeight] = useState(96);
  const [headerHeight, setHeaderHeight] = useState(96);
  const footerRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "pending" | "conflict">("saved");
  const [saveTick, setSaveTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [invalidQuestionId, setInvalidQuestionId] = useState<string | null>(null);
  const [conflictDraft, setConflictDraft] = useState<Draft | null>(null);
  const [questionChanged, setQuestionChanged] = useState(false);
  const [accessChanged, setAccessChanged] = useState(false);
  const accessVersionRef = useRef<number | undefined>(undefined);
  const localKey = useRef<string | null>(null);
  const draftRef = useRef({ answers: {} as Answers, currentPage: 0 });
  const versionRef = useRef(0);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const questionChangedRef = useRef(false);
  const questionVersionRef = useRef<string | undefined>(undefined);
  const submittingRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pages = useMemo(() => paginateExperimentQuestions(assessment?.questions ?? []), [assessment?.questions]);
  const currentPage = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  const referenceGroup = currentPage?.group;
  const referenceKey = JSON.stringify([endpoint, phase, assessment?.studentKey, referenceGroup?.id, referenceGroup?.referenceNote]);
  const answeredCount = (assessment?.questions ?? []).filter((question) => questionAnswered(question, answers[question.id])).length;
  const requiredQuestions = (assessment?.questions ?? []).filter((question) => !question.optional);
  const requiredAnswered = requiredQuestions.filter((question) => questionAnswered(question, answers[question.id])).length;
  const progressTotal = requiredQuestions.length || assessment?.questions.length || 1;
  const progressAnswered = requiredQuestions.length ? requiredAnswered : answeredCount;
  const missing = (assessment?.questions ?? []).filter((question) => !question.optional && !questionAnswered(question, answers[question.id]));
  const skippedWithReason = (assessment?.questions ?? []).filter((question) => question.skipReasonRequired && !questionAnswered(question, answers[question.id]));
  const reasonMissing = skippedWithReason.length > 0 && !answered(answers.__skipReason);

  const persistLocal = useCallback((pending: boolean) => {
    if (!localKey.current) return;
    try {
      localStorage.setItem(localKey.current, JSON.stringify({
        ...draftRef.current, version: versionRef.current, updatedAt: new Date().toISOString(), pending,
      } satisfies LocalDraft));
    } catch { /* Database saving remains available if browser storage is disabled. */ }
  }, []);

  const load = useCallback(async (preserve = false): Promise<Assessment> => {
    const response = await fetch(activityId ? endpoint : `${endpoint}?phase=${phase}`, { cache: "no-store" });
    const data = await json(response);
    if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "测验加载失败");
    const next = data as Assessment;
    if (!Array.isArray(next.questions) || typeof next.studentKey !== "string") throw new Error("测验数据格式不正确");
    if (activityId && next.available && preserve && questionVersionRef.current && next.questionVersion !== questionVersionRef.current && !next.submission) {
      questionChangedRef.current = true;
      conflictRef.current = true;
      setQuestionChanged(true);
      setSaveStatus("conflict");
      throw new Error("教师已更新题目，请重新加载后作答。");
    }
    if (!activityId && preserve && next.available && !next.submission && accessVersionRef.current !== undefined && next.accessVersion !== accessVersionRef.current) {
      conflictRef.current = true;
      dirtyRef.current = false;
      setAccessChanged(true);
      setSaveStatus("conflict");
      throw new Error("教师已调整后测开放状态，请重新加载后继续作答。");
    }
    accessVersionRef.current = next.accessVersion;
    questionVersionRef.current = next.questionVersion;
    setAssessment(next);
    const key = activityId ? `posttest-draft:v1:${next.studentKey}:${activityId}:${next.questionVersion}` : `experiment-draft:v1:${next.studentKey}:${instanceId}:${phase}${next.accessVersion === undefined ? "" : `:access-${next.accessVersion}`}`;
    localKey.current = next.available && !next.submission ? key : null;
    if (!next.available) dirtyRef.current = false;
    if (next.submission) {
      setAnswers(next.submission.answers);
      draftRef.current = { answers: next.submission.answers, currentPage: 0 };
      setSaveStatus("saved");
      if (next.available) try { localStorage.removeItem(key); } catch { /* ignore */ }
      return next;
    }
    if (!next.available) return next;
    if (preserve) return next;
    const serverVersion = next.draft?.version ?? 0;
    const local = readLocal(key);
    const ids = new Set(next.questions.map((question) => question.id));
    const source = local?.pending ? local : next.draft;
    const safeAnswers = Object.fromEntries(Object.entries(source?.answers ?? {}).filter(([id]) => ids.has(id) || id === "__skipReason"));
    const currentPage = Math.max(0, Math.min(source?.currentPage ?? 0, Math.max(0, paginateExperimentQuestions(next.questions).length - 1)));
    draftRef.current = { answers: safeAnswers, currentPage };
    versionRef.current = local?.pending ? local.version : serverVersion;
    setAnswers(safeAnswers);
    setPageIndex(currentPage);
    if (local?.pending && local.version !== serverVersion) {
      setConflictDraft(next.draft ?? { answers: {}, currentPage: 0, version: 0, updatedAt: "" });
      conflictRef.current = true;
      setSaveStatus("conflict");
    } else if (local?.pending) {
      dirtyRef.current = true;
      setSaveStatus("pending");
    } else setSaveStatus("saved");
    return next;
  }, [activityId, endpoint, instanceId, phase]);

  const saveNow = useCallback(async (): Promise<void> => {
    if (!assessment?.available || assessment.submission || submittingRef.current || conflictRef.current || !dirtyRef.current) return;
    if (inFlightRef.current) { await inFlightRef.current; return; }
    const snapshot = { answers: { ...draftRef.current.answers }, currentPage: draftRef.current.currentPage };
    const version = versionRef.current;
    dirtyRef.current = false;
    setSaveStatus("saving");
    const request = (async () => {
      try {
        const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(activityId ? { questionVersion: assessment.questionVersion } : { phase, ...(assessment.accessVersion === undefined ? {} : { accessVersion: assessment.accessVersion }) }), ...snapshot, version }) });
        const data = await json(response);
        if (!response.ok && (data.code === "ASSESSMENT_UNAVAILABLE" || data.code === "POSTTEST_UNAVAILABLE")) {
          const fresh = await load(true);
          if (!fresh.available || fresh.submission) { dirtyRef.current = false; setSaveStatus("saved"); setError(null); return; }
        }
        if (response.status === 409 && data.code === "ASSESSMENT_ACCESS_VERSION_CONFLICT") {
          conflictRef.current = true;
          dirtyRef.current = false;
          setAccessChanged(true);
          setSaveStatus("conflict");
          setError("教师已调整后测开放状态，请重新加载后继续作答。");
          return;
        }
        if (response.status === 409 && data.code === "QUESTION_VERSION_CONFLICT") {
          questionChangedRef.current = true;
          setQuestionChanged(true);
          conflictRef.current = true;
          setSaveStatus("conflict");
          setError("教师已更新题目，请重新加载后作答。");
          return;
        }
        if (response.status === 409) {
          dirtyRef.current = true;
          conflictRef.current = true;
          setSaveStatus("conflict");
          setError("另一页面已更新这份测验，请选择要保留的版本。");
          try {
            const fresh = await load(true);
            if (fresh.submission) { conflictRef.current = false; setConflictDraft(null); setSaveStatus("saved"); }
            else setConflictDraft(fresh.draft ?? { answers: {}, currentPage: 0, version: 0, updatedAt: "" });
          }
          catch { setConflictDraft({ answers: {}, currentPage: 0, version, updatedAt: "" }); }
          return;
        }
        if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "草稿保存失败");
        const draft = data.draft as Draft | undefined;
        if (!draft || typeof draft.version !== "number") throw new Error("草稿保存结果不完整");
        versionRef.current = draft.version;
        setSaveStatus(dirtyRef.current ? "pending" : "saved");
        setError(null);
        persistLocal(dirtyRef.current);
        if (dirtyRef.current && navigator.onLine) setSaveTick((tick) => tick + 1);
      } catch (reason) {
        dirtyRef.current = true;
        setSaveStatus("pending");
        setError(message(reason, "保存失败，请检查网络后重试。"));
        persistLocal(true);
      }
    })();
    inFlightRef.current = request;
    await request;
    inFlightRef.current = null;
  }, [activityId, assessment, endpoint, load, persistLocal, phase]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => load()).catch((reason) => { if (active) setError(message(reason, "测验加载失败")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (timerRef.current) clearTimeout(timerRef.current); };
  }, [load]);

  useEffect(() => {
    if (!footerMounted || !footerRef.current) return;
    const footer = footerRef.current;
    const updateHeight = () => {
      setFooterHeight(footer.getBoundingClientRect().height || 96);
      setHeaderHeight(headerRef.current?.getBoundingClientRect().height || 96);
    };
    updateHeight();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateHeight) : null;
    observer?.observe(footer);
    if (headerRef.current) observer?.observe(headerRef.current);
    return () => observer?.disconnect();
  }, [footerMounted, assessment, review, pageIndex, submitting, onCancel]);

  useEffect(() => {
    const retry = () => { if (dirtyRef.current && !conflictRef.current) void saveNow(); };
    window.addEventListener("online", retry);
    window.addEventListener("visibilitychange", retry);
    return () => { window.removeEventListener("online", retry); window.removeEventListener("visibilitychange", retry); };
  }, [saveNow]);

  useEffect(() => {
    if (!dirtyRef.current || conflictRef.current || submittingRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void saveNow(), 700);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [answers, pageIndex, saveNow, saveTick]);

  function updateAnswer(id: string, value: ExperimentDisplayAnswer) {
    if (!assessment?.available || assessment.submission) return;
    const next = { ...draftRef.current.answers, [id]: value };
    draftRef.current = { ...draftRef.current, answers: next };
    dirtyRef.current = true;
    setAnswers(next);
    setError(null);
    if (invalidQuestionId === id) setInvalidQuestionId(null);
    if (!conflictRef.current) setSaveStatus("pending");
    persistLocal(true);
  }
  function goToPage(index: number, questionId?: string) {
    const bounded = Math.max(0, Math.min(index, pages.length - 1));
    if (assessment?.available && !assessment.submission) {
      draftRef.current = { ...draftRef.current, currentPage: bounded };
      dirtyRef.current = true;
      persistLocal(true);
      void saveNow();
    }
    setPageIndex(bounded);
    setReview(false);
    window.requestAnimationFrame(() => {
      const target = questionId ? document.getElementById(`experiment-${phase}-${questionId}`) : contentRef.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: "start", behavior: "instant" });
    });
  }
  function resolveConflict(useLocal: boolean) {
    if (!conflictDraft) return;
    versionRef.current = conflictDraft.version;
    conflictRef.current = false;
    setConflictDraft(null);
    setError(null);
    if (useLocal) {
      dirtyRef.current = true;
      setSaveStatus("pending");
      persistLocal(true);
      void saveNow();
    } else {
      dirtyRef.current = false;
      draftRef.current = { answers: conflictDraft.answers, currentPage: conflictDraft.currentPage };
      setAnswers(conflictDraft.answers);
      setPageIndex(Math.max(0, Math.min(conflictDraft.currentPage, pages.length - 1)));
      setSaveStatus("saved");
      persistLocal(false);
    }
  }
  async function submit() {
    if (submitting || !assessment?.available || assessment.submission || conflictRef.current) return;
    if (missing.length) {
      setInvalidQuestionId(missing[0].id);
      setError(`还有 ${missing.length} 题未完成，请先作答。`);
      goToPage(pages.findIndex((page) => page.questions.some((question) => question.id === missing[0].id)), missing[0].id);
      return;
    }
    if (reasonMissing) { setReview(true); setError("跳过体验题时请填写原因。"); return; }
    if (timerRef.current) clearTimeout(timerRef.current);
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const attemptedAnswers = { ...draftRef.current.answers };
    try {
      if (inFlightRef.current) await inFlightRef.current;
      if (conflictRef.current) throw new Error("草稿版本冲突，请先选择要保留的版本。");
      const finalAnswers = Object.fromEntries([
        ...assessment.questions.filter((question) => questionAnswered(question, draftRef.current.answers[question.id])).map((question) => [question.id, draftRef.current.answers[question.id]]),
        ...(answered(draftRef.current.answers.__skipReason) ? [["__skipReason", draftRef.current.answers.__skipReason]] : []),
      ]);
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(activityId ? { questionVersion: assessment.questionVersion } : { phase, ...(assessment.accessVersion === undefined ? {} : { accessVersion: assessment.accessVersion }) }), answers: finalAnswers }) });
      const data = await json(response);
      if (response.status === 409 && data.code === "ASSESSMENT_ACCESS_VERSION_CONFLICT") {
        conflictRef.current = true;
        dirtyRef.current = false;
        setAccessChanged(true);
        setSaveStatus("conflict");
        setError("教师已调整后测开放状态，请重新加载后继续作答。");
        return;
      }
      if (response.status === 409 && data.code === "QUESTION_VERSION_CONFLICT") {
        questionChangedRef.current = true;
        setQuestionChanged(true);
        conflictRef.current = true;
        setSaveStatus("conflict");
        throw new Error("教师已更新题目，请重新加载后作答。");
      }
      if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "提交失败");
      const row = (data.submission ?? data) as Submission;
      setAssessment({ ...assessment, submission: { id: row.id, submittedAt: row.submittedAt, answers: finalAnswers } });
      if (localKey.current) try { localStorage.removeItem(localKey.current); } catch { /* ignore */ }
      setSaveStatus("saved");
      onSubmitted?.();
    } catch (reason) {
      if (questionChangedRef.current) { setError(message(reason, "教师已更新题目，请重新加载后作答。")); persistLocal(true); return; }
      try {
        const fresh = await load(true);
        if (fresh.submission) {
          if (localKey.current) localStorage.removeItem(localKey.current);
          if (JSON.stringify(fresh.submission.answers) !== JSON.stringify(attemptedAnswers)) setError("本场测验此前已提交，当前显示已保存的答案。");
          onSubmitted?.();
          return;
        }
      } catch { /* Keep local answers for retry. */ }
      setError(questionChangedRef.current ? "教师已更新题目，请重新加载后作答。" : message(reason, "提交失败，请重试。"));
      persistLocal(true);
    } finally { submittingRef.current = false; setSubmitting(false); }
  }

  if (loading) return <div aria-busy="true" className="mt-6 rounded-2xl border border-[var(--pbl-border)] bg-white p-8 text-sm">正在加载个人{phaseLabel[phase]}…</div>;
  if (!assessment) return <div className="mt-6 rounded-2xl border border-[var(--pbl-border)] bg-white p-6"><p role="alert" className="text-sm text-[var(--pbl-danger)]">{error ?? "暂时无法加载测验"}</p><button className="mt-4 min-h-11 rounded-xl bg-[var(--pbl-student)] px-5 text-sm font-semibold text-white" onClick={() => { setLoading(true); void load().catch((reason) => setError(message(reason, "加载失败"))).finally(() => setLoading(false)); }} type="button">重新加载</button></div>;
  if (!assessment.enabled) return <div className="mt-6 rounded-2xl border border-[var(--pbl-border)] bg-white p-8 text-center"><ClipboardCheck className="mx-auto text-[var(--pbl-student)]" size={32} /><h2 className="mt-3 text-xl font-bold">本课堂未开启后测</h2><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">教师开启实验模式后，这里会显示本次课堂的后测。</p></div>;
  if (!assessment.available && !assessment.submission) return <div className="mt-6 rounded-2xl border border-[var(--pbl-border)] bg-white p-8 text-center"><ClipboardCheck className="mx-auto text-[var(--pbl-student)]" size={32} /><h2 className="mt-3 text-xl font-bold">暂时无法作答{phaseLabel[phase]}</h2><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">{assessment.blockedReason ?? "请稍后查看。"}</p><button className="mt-5 min-h-11 rounded-xl border border-[var(--pbl-border)] px-5 text-sm font-semibold" onClick={() => { setLoading(true); void load().catch((reason) => setError(message(reason, "加载失败"))).finally(() => setLoading(false)); }} type="button">刷新状态</button></div>;
  if (!pages.length) return <p className="mt-6 rounded-2xl border border-[var(--pbl-border)] bg-white p-6 text-sm">本次测验尚无题目，请联系教师。</p>;

  const submitted = Boolean(assessment.submission);
  const activeAnswers = assessment.submission?.answers ?? answers;
  const status = submitted ? "已提交" : saveStatus === "saved" ? "已保存" : saveStatus === "saving" ? "正在保存" : saveStatus === "conflict" ? "版本冲突" : "待同步";
  const StatusIcon = submitted || saveStatus === "saved" ? CheckCircle2 : saveStatus === "conflict" ? AlertCircle : saveStatus === "pending" ? CloudOff : Cloud;
  const title = phaseLabel[phase];
  const scenario = assessment.variant === "none" || !assessment.variant ? null : phase === "pretest" ? assessment.variant === "A_PRE_B_POST" ? "A" : "B" : assessment.variant === "A_PRE_B_POST" ? "B" : "A";
  const openReview = () => {
    setReview(true);
    window.requestAnimationFrame(() => {
      contentRef.current?.focus({ preventScroll: true });
      contentRef.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
    });
  };

  return <div className={`${styles.assessment}${layout === "full" ? ` ${styles.full}` : ""}`} style={{ paddingBottom: footerHeight + 16, "--assessment-header-height": `${headerHeight}px` } as CSSProperties}>
    <header className={styles.header} ref={headerRef}>
      <div className={styles.headerInner}>
        <div className={styles.heading}>
          <h2>{title}{scenario ? `｜情境${scenario}` : ""}</h2>
          <span aria-live="polite" className={styles.status} data-conflict={saveStatus === "conflict"}><StatusIcon size={15} />{status}</span>
        </div>
        <div className={styles.progress}>
          <div aria-label={`${title}作答进度`} aria-valuemax={progressTotal} aria-valuemin={0} aria-valuenow={submitted ? progressTotal : progressAnswered} className={styles.progressTrack} role="progressbar">
            <div className={styles.progressFill} style={{ width: `${submitted ? 100 : progressAnswered / progressTotal * 100}%` }} />
          </div>
          <span>{submitted ? "完成作答" : `已完成 ${Math.round(progressAnswered / progressTotal * 100)}%`}</span>
        </div>
      </div>
    </header>
    <div className={styles.body}>
      <section aria-labelledby={instructionsId} className={styles.introduction}>
        <h3 id={instructionsId}>{title}作答说明</h3>
        <p>{assessment.introduction || (phase === "pretest" ? "请根据课前的知识理解独立作答，并先阅读下面各题组的说明。" : "请根据本次课堂的知识理解与真实学习体验作答，并先阅读各题组的说明与评分含义。")}</p>
        {assessment.minutes ? <p className={styles.duration}>建议用时 {assessment.minutes} 分钟</p> : null}
      </section>
      {submitted ? <p className="mt-2 text-xs text-[var(--pbl-text-muted)]">提交时间：{new Date(assessment.submission!.submittedAt).toLocaleString("zh-CN")}</p> : null}
      {conflictDraft ? <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950" role="alert"><p className="font-semibold">另一页面更新了这份草稿</p><p className="mt-1 leading-6">请选择使用服务器上的作答，或保留当前页面的作答并同步。</p><div className="mt-4 flex flex-wrap gap-3"><button className="min-h-11 rounded-lg border border-amber-400 bg-white px-4 font-semibold" onClick={() => resolveConflict(false)} type="button">使用服务器版本</button><button className="min-h-11 rounded-lg bg-[var(--pbl-student)] px-4 font-semibold text-white" onClick={() => resolveConflict(true)} type="button">保留本机作答</button></div></div> : null}
      {error && !conflictDraft ? <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--pbl-danger)] bg-white p-4 text-sm text-[var(--pbl-danger)]" role="alert"><span>{error}</span>{questionChanged || accessChanged ? <button className="min-h-11 font-semibold underline" onClick={() => window.location.reload()} type="button">{accessChanged ? "重新加载测验" : "重新加载题目"}</button> : null}{saveStatus === "pending" ? <button className="inline-flex min-h-11 items-center gap-2 font-semibold underline" onClick={() => void saveNow()} type="button"><RotateCcw size={16} />重试同步</button> : null}</div> : null}
      <div className={styles.content} ref={contentRef} tabIndex={-1}>
          {review && !submitted ? <section className="rounded-2xl border border-[var(--pbl-border)] bg-white p-5 sm:p-7"><p className="text-xs font-bold tracking-wider text-[var(--pbl-student)]">提交前检查</p><h3 className="mt-2 text-2xl font-bold">{missing.length ? `还有 ${missing.length} 题待完成` : assessment.questions.some((question) => question.optional) ? "必答题已完成" : "所有题目已完成"}</h3><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">提交后答案将锁定，请确认作答内容。{assessment.questions.some((question) => question.optional) ? "选答题和允许跳过的体验题可以留空。" : ""}</p>{missing.length ? <div className="mt-5 flex flex-wrap gap-2">{missing.map((question) => { const index = assessment.questions.indexOf(question); return <button className="min-h-11 rounded-lg border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-900" key={question.id} onClick={() => goToPage(pages.findIndex((page) => page.questions.some((item) => item.id === question.id)), question.id)} type="button">第 {index + 1} 题未答</button>; })}</div> : <div className="mt-5 flex items-center gap-2 rounded-xl bg-[var(--pbl-student-soft)] p-4 text-sm font-semibold text-[var(--pbl-student)]"><CheckCircle2 size={18} />可以提交{title}</div>}{skippedWithReason.length ? <label className="mt-5 block text-sm font-semibold">{assessment.skipReasonPrompt || "跳过体验题的原因"}<textarea aria-label="跳题原因" className="mt-2 min-h-20 w-full rounded-lg border border-[var(--pbl-border)] p-3 text-sm" maxLength={1000} value={typeof answers.__skipReason === "string" ? answers.__skipReason : ""} onChange={(event) => updateAnswer("__skipReason", event.target.value)} />{reasonMissing ? <span className="mt-1 block text-xs text-[var(--pbl-danger)]">请填写跳题原因</span> : null}</label> : null}</section> : <><div className={styles.pageHeading}><span>{currentPage.questions.every((question) => question.type === "scale") ? "按真实感受，每行选择一个分值" : "请依次完成以下作答"}</span><span>{currentPage.questions.length} 题</span></div><ExperimentQuestionList compact onReadReference={() => setReopenedReference(referenceKey)} answers={activeAnswers} inputNamePrefix={`experiment-${phase}`} invalidQuestionId={invalidQuestionId} onAnswerChange={updateAnswer} questionIdPrefix={`experiment-${phase}`} questions={currentPage.questions} readOnly={submitted} startIndex={currentPage.startIndex} /></>}
      </div>
    </div>
    {referenceGroup?.referenceNote && !review && !conflictDraft ? <ExperimentReferenceDialog
      note={referenceGroup.referenceNote}
      onAcknowledge={() => {
        setReadReferences((current) => current.includes(referenceKey) ? current : [...current, referenceKey]);
        setReopenedReference(null);
      }}
      onReturnFocus={() => document.getElementById(`experiment-${phase}-${currentPage.questions[0].id}`)?.focus({ preventScroll: true })}
      open={reopenedReference === referenceKey || (!submitted && assessment.available && !readReferences.includes(referenceKey))}
      title={referenceGroup.title}
    /> : null}
    {footerMounted ? createPortal(<footer ref={footerRef} className={`${layout === "full" ? "pbl-platform-theme " : ""}${styles.footer}`} aria-label={`${title}操作栏`}>
      <div className={styles.footerInner}>
        <div className={styles.footerInfo}>{submitted ? "答案已锁定" : review ? "请检查后提交" : pages.length === 1 ? "请完成作答" : `第 ${pageIndex + 1} / ${pages.length} 部分`}</div>
        <div className={styles.footerActions}>
          {onCancel ? <button className="rounded-lg border border-[var(--pbl-border)] px-4 text-sm font-semibold" onClick={onCancel} type="button">返回</button> : null}
          {review && !submitted ? <button className="inline-flex items-center gap-1 rounded-lg border border-[var(--pbl-border)] px-4 text-sm font-semibold" onClick={() => goToPage(pageIndex)} type="button"><ChevronLeft size={16} />返回作答</button> : pages.length > 1 ? <button className="inline-flex items-center gap-1 rounded-lg border border-[var(--pbl-border)] px-4 text-sm font-semibold disabled:opacity-40" disabled={pageIndex === 0} onClick={() => goToPage(pageIndex - 1)} type="button"><ChevronLeft size={16} />上一步</button> : null}
          {!submitted && !review && pageIndex < pages.length - 1 ? <button className="px-3 text-sm font-semibold text-[var(--pbl-student)]" onClick={openReview} type="button">提交检查</button> : null}
          {review && !submitted ? <button className="rounded-lg bg-[var(--pbl-student)] px-5 text-sm font-bold text-white disabled:opacity-50" disabled={Boolean(missing.length) || reasonMissing || submitting || Boolean(conflictDraft)} onClick={() => void submit()} type="button">{submitting ? "提交中…" : `确认提交${title}`}</button> : !submitted || pageIndex < pages.length - 1 ? <button className="inline-flex items-center gap-1 rounded-lg bg-[var(--pbl-student)] px-5 text-sm font-bold text-white" onClick={() => pageIndex === pages.length - 1 ? openReview() : goToPage(pageIndex + 1)} type="button">{pageIndex === pages.length - 1 ? "检查并提交" : "下一步"}<ChevronRight size={16} /></button> : null}
        </div>
      </div>
    </footer>, document.body) : null}
  </div>;
}
