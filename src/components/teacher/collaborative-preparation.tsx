"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, LoaderCircle, MessageSquare, Send, Sparkles } from "lucide-react";
import type { ConfirmedPreparation, PreparationMutationInput, PreparationSessionSnapshot } from "@/lib/collaborative-preparation/types";
import type { CourseTextbookSelection } from "@/lib/textbook/course-evidence-types";
import { readJsonResponse } from "@/lib/http/read-json-response";
import { PreparationDiscussionHistory } from "./preparation-discussion-history";
import { PreparationPlanSidebar } from "./preparation-plan-summary";
import { PreparationPlanReview } from "./preparation-plan-review";
import styles from "./collaborative-preparation.module.css";

type Reference = { id: string; fileName: string; mimeType?: string };
type SessionResponse = { session?: PreparationSessionSnapshot | null; error?: string; detail?: string; message?: string };
const primary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--pbl-teacher)] px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45";
const secondary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-45";

function sourceIdentity(referenceIds: string[], selections: CourseTextbookSelection[]): string {
  return JSON.stringify({
    referenceIds: [...new Set(referenceIds)].sort(),
    textbookSelections: selections.map(({ revisionId, primary, sectionIds }) => ({
      revisionId, primary, sectionIds: [...sectionIds].sort(),
    })).sort((left, right) => left.revisionId.localeCompare(right.revisionId)),
  });
}

export function CollaborativePreparation({ courseId, teacherId, referenceMaterials, textbookSelections, sourceControls, generationSettings, disabled = false, onRestoreSources, onConfirmed, initialMessage, onInitialMessageConsumed }: {
  courseId: string;
  teacherId?: string;
  referenceMaterials: Reference[];
  textbookSelections: CourseTextbookSelection[];
  sourceControls: ReactNode;
  generationSettings: ReactNode;
  disabled?: boolean;
  onRestoreSources: (references: Reference[], textbooks: CourseTextbookSelection[]) => void;
  onConfirmed: (snapshot: ConfirmedPreparation) => Promise<void>;
  initialMessage?: string;
  onInitialMessageConsumed?: () => void;
}) {
  const endpoint = `/api/courses/${encodeURIComponent(courseId)}/collaborative-preparation`;
  const draftKey = teacherId ? `openpbl:preparation-message:v1:${encodeURIComponent(teacherId)}:${encodeURIComponent(courseId)}` : "";
  const [session, setSession] = useState<PreparationSessionSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(initialMessage ?? "");
  const initialSubmission = useRef(initialMessage);
  const initialSubmissionConsumed = useRef(false);
  const [selected, setSelected] = useState("");
  const [review, setReview] = useState(false);
  const [editing, setEditing] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const planDetailsOpen = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const currentQuestion = useRef<HTMLDivElement>(null);
  const focusAfterReply = useRef(false);
  const inputId = useId();
  const restoredSources = useRef(false);
  const restoreSources = useRef(onRestoreSources);
  const pending = useRef<{ method: "POST" | "PATCH"; body: PreparationMutationInput } | null>(null);
  const inFlight = useRef(false);
  const processing = session?.status === "processing";
  const locked = disabled || busy || processing || !loaded;
  useEffect(() => { restoreSources.current = onRestoreSources; }, [onRestoreSources]);

  const acceptSession = useCallback((next: PreparationSessionSnapshot | null) => {
    setSession(next);
    if (!restoredSources.current) {
      restoredSources.current = true;
      if (next) restoreSources.current(next.referenceMaterials ?? next.referenceIds.map((id) => ({ id, fileName: "已保存的参考资料" })), next.textbookSelections);
    }
    setLoaded(true);
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { cache: "no-store", signal });
    const payload = await readJsonResponse<SessionResponse>(response, "备课会话读取失败，请重试。");
    if (!response.ok) throw new Error(payload.detail || payload.message || payload.error || "无法读取备课会话");
    if (!signal?.aborted) acceptSession(payload.session ?? null);
  }, [acceptSession, endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取备课会话"); }), 0);
    if (draftKey && !initialSubmission.current) try { const saved = window.sessionStorage.getItem(draftKey); if (saved) queueMicrotask(() => setMessage(saved)); } catch { /* Browser draft is optional. */ }
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [draftKey, load]);
  useEffect(() => {
    if (!loaded || !draftKey) return;
    try { window.sessionStorage.setItem(draftKey, message); } catch { /* Server saves submitted turns. */ }
  }, [draftKey, loaded, message]);
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : "会话同步失败，请重试")), 2_000);
    return () => window.clearInterval(timer);
  }, [load, processing]);

  const latestAssistant = session?.turns.findLast((turn) => turn.role === "assistant");
  const latestAnswer = session?.turns.findLast((turn) => turn.role === "user");
  const questionIdentity = `${latestAssistant?.id ?? ""}:${session?.currentQuestion?.id ?? ""}`;
  const canSubmit = !locked && Boolean(message.trim() || (selected && selected !== "other"));
  useEffect(() => {
    if (!loaded || review || historyOpen || planDetailsOpen.current || busy || processing) return;
    const frame = requestAnimationFrame(() => {
      if (planDetailsOpen.current) return;
      const body = currentQuestion.current;
      if (body) body.scrollTop = 0;
      const element = panel.current;
      if (element) {
        const rect = element.getBoundingClientRect();
        const top = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
        if (rect.top < top || rect.bottom > window.innerHeight) element.scrollIntoView?.({ block: "start", behavior: "instant" });
      }
      if (focusAfterReply.current) { body?.focus({ preventScroll: true }); focusAfterReply.current = false; }
    });
    return () => cancelAnimationFrame(frame);
  }, [loaded, review, historyOpen, busy, processing, questionIdentity, error]);

  const sourcesChanged = Boolean(session) && sourceIdentity(session!.referenceIds, session!.textbookSelections) !== sourceIdentity(referenceMaterials.map((item) => item.id), textbookSelections);
  const submit = useCallback(async (action?: PreparationMutationInput["action"], customMessage?: string, replay = false) => {
    if (inFlight.current || disabled || processing || !loaded) return;
    const selectedOption = session?.currentQuestion?.options.find((option) => option.id === selected);
    const answer = customMessage ?? [selectedOption?.label, message.trim()].filter(Boolean).join("\n补充：");
    if (!action && !answer) return;
    const request = replay ? pending.current : {
      method: action ? "PATCH" as const : "POST" as const,
      body: { revision: session?.revision ?? 0, requestId: crypto.randomUUID(), ...(action ? { action } : {}), ...(answer ? { message: answer } : {}), ...(!action && selectedOption ? { selectedOptionId: selectedOption.id } : {}), referenceIds: referenceMaterials.map((item) => item.id), textbookSelections },
    };
    if (!request) return;
    focusAfterReply.current = request.body.action !== "confirm";
    inFlight.current = true; setBusy(true); setError(""); pending.current = request; setRetryPending(true);
    try {
      const response = await fetch(endpoint, { method: request.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
      const payload = await readJsonResponse<SessionResponse>(response, "没有收到备课服务的响应，请重试本次提交。");
      if (!response.ok) {
        if (payload.session) acceptSession(payload.session);
        if (response.status === 409) { pending.current = null; setRetryPending(false); await load(); }
        throw new Error(payload.detail || payload.message || payload.error || "备课信息保存失败");
      }
      if (!payload.session) throw new Error("备课服务没有返回保存结果，请重试本次提交。");
      acceptSession(payload.session); pending.current = null; setRetryPending(false); setSelected("");
      if (request.body.action === "confirm" && payload.session.confirmed) await onConfirmed(payload.session.confirmed);
      else { setMessage(""); setEditing(false); setReview(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "备课提交失败，请重试"); }
    finally { inFlight.current = false; setBusy(false); }
  }, [disabled, processing, loaded, session, selected, message, referenceMaterials, textbookSelections, endpoint, acceptSession, load, onConfirmed]);
  useEffect(() => {
    const firstMessage = initialSubmission.current;
    if (!firstMessage || !loaded || disabled || initialSubmissionConsumed.current) return;
    initialSubmissionConsumed.current = true;
    onInitialMessageConsumed?.();
    // A restored discussion is authoritative; keep the idea as an unsent draft.
    if (!session) void submit(undefined, firstMessage);
  }, [loaded, disabled, session, submit, onInitialMessageConsumed]);
  async function confirm() {
    if (sourcesChanged || locked) return;
    if (!session?.confirmed) return submit("confirm");
    setBusy(true); setError("");
    try { await onConfirmed(session.confirmed); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法开始课程生成"); }
    finally { setBusy(false); }
  }
  const feedback = <>
    {error || session?.error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800"><p>{error || session?.error}</p><button className="mt-2 min-h-11 font-semibold underline" disabled={busy || disabled} onClick={() => void (pending.current ? submit(undefined, undefined, true) : session?.status === "failed" ? submit("retry") : load().then(() => setError("")).catch((cause) => setError(String(cause))))} type="button">{retryPending ? "重试本次提交" : session?.status === "failed" ? "重试本轮讨论" : "重新读取会话"}</button></div> : null}
    {sourcesChanged && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"><p>资料已调整，请更新方案后再确认生成。</p><button className="mt-2 min-h-11 font-semibold underline" disabled={locked} onClick={() => void submit("revise", "请根据本次选用的教材和参考资料更新课程方案，保留此前明确的教师要求，并说明需要进一步讨论的变化。")} type="button">根据新资料更新方案</button></div>}
  </>;

  if (review && session) return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-xl font-semibold text-slate-950">确认课程方案</h2><p className="mt-2 text-sm leading-7 text-slate-600">浏览教学安排，选择生成设置，再确认开始生成。</p></div>
      <button className={secondary} onClick={() => setReview(false)} disabled={busy} type="button"><ArrowLeft className="size-4" />返回讨论</button>
    </header>
    <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-7"><PreparationPlanReview plan={session.plan} fieldOrigins={session.fieldOrigins} confirmed={Boolean(session.confirmed)} /></div>
    <section aria-label="采用资料" className="rounded-xl border border-slate-200 bg-white p-5 text-sm leading-7 sm:p-6">
      <h3 className="text-base font-semibold text-slate-900">采用资料</h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-2"><div><h4 className="font-medium text-slate-700">参考资料</h4>{referenceMaterials.length ? <ul className="mt-1 list-disc break-words pl-5 text-slate-600">{referenceMaterials.map((item) => <li key={item.id}>{item.fileName}</li>)}</ul> : <p className="text-slate-500">未上传参考资料</p>}</div><div><h4 className="font-medium text-slate-700">课程教材</h4><p className="text-slate-600">{textbookSelections.length ? `已选 ${textbookSelections.length} 本教材，沿用已选章节。` : "未选择教材；AI 共创内容不标记为教材原文。"}</p></div></div>
      <p className="mt-4 border-t border-slate-100 pt-3 text-slate-500">项目启动使用教学方案说明卡，可在生成后补充启动 PPT。</p>
    </section>
    {session.suggestions.length > 0 && <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-7"><h3 className="font-semibold">需要留意的教学取舍</h3><ul className="list-disc pl-5">{session.suggestions.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    <fieldset className="min-w-0" disabled={locked}>{generationSettings}</fieldset>{feedback}
    <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg"><button className={secondary} disabled={locked} onClick={() => { setReview(false); setEditing(true); }} type="button">修改方案再讨论</button><button className={primary} disabled={locked || !session.readyToConfirm || sourcesChanged} onClick={() => void confirm()} type="button">{busy || disabled ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}确认方案并开始生成</button></div>
  </div>;

  return <div className={styles.workspace}>
    <div className={styles.main}>
      <section ref={panel} className={styles.conversation} aria-label="AI 协同备课对话" data-preparation-conversation>
        <div className={styles.heading}>
          <h2><MessageSquare size={19} />一起推敲这节课</h2>
          <PreparationDiscussionHistory turns={session?.turns ?? []} open={historyOpen} onOpenChange={(open) => { if (open) focusAfterReply.current = false; setHistoryOpen(open); }} />
        </div>
        <div ref={currentQuestion} className={styles.current} role="region" aria-label="当前备课问题" tabIndex={-1} data-preparation-current-scroll>
          <div className="space-y-3 empty:hidden">{feedback}</div>
          {!loaded && !error && <p role="status" className={styles.status}>正在恢复备课会话…</p>}
          {processing || busy ? <>
            <p role="status" className={styles.status}><LoaderCircle className="size-4 animate-spin" />正在推敲你的回答，下一问会显示在这里。已提交的讨论会自动保存。</p>
            {latestAnswer && <div className={styles.lastAnswer}><strong>你最近的想法</strong><p>{latestAnswer.content}</p></div>}
          </> : editing ? <div className={styles.ready}><p className={styles.eyebrow}>调整课程方案</p><h3>告诉 AI 哪些理解需要修改</h3><p>直接说明需要调整的内容。已有讨论会保留，AI 将结合你的修改继续完善方案。</p></div>
            : session?.currentQuestion ? <>
              <p className={styles.eyebrow}>当前问题 · 选择一个方向，也可以直接输入</p>
              <fieldset className={styles.question} disabled={locked}>
                <legend><h3>{session.currentQuestion.prompt}</h3></legend>
                {session.currentQuestion.reason && <p className={styles.reason}>{session.currentQuestion.reason}</p>}
                <div className={styles.options}>
                  {session.currentQuestion.options.map((option) => <label key={option.id} className={styles.option} data-selected={selected === option.id || undefined}>
                    <input name={`preparation-question-${session.currentQuestion!.id}`} type="radio" value={option.id} checked={selected === option.id} onChange={() => setSelected(option.id)} />
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </label>)}
                  <label className={styles.option} data-selected={selected === "other" || undefined}><input name={`preparation-question-${session.currentQuestion.id}`} type="radio" aria-label="其他／自己输入" value="other" checked={selected === "other"} onChange={() => setSelected("other")} /><span><strong>其他／自己输入</strong><small>在下方写下你的想法或问题。</small></span></label>
                </div>
              </fieldset>
              {latestAssistant?.content && latestAssistant.content !== session.currentQuestion.prompt && <details className={styles.explanation}><summary>AI 对这轮讨论的说明</summary><p>{latestAssistant.content}</p></details>}
            </> : loaded && !session ? <div className={styles.ready}><p className={styles.eyebrow}>从你的教学想法开始</p><h3>这次想和学生一起学什么？</h3><p>可以先说主题、学生情况，或一条你想尝试的教学思路。AI 会逐题与你讨论，不需要一次写完整教案。</p></div>
              : !session?.readyToConfirm && latestAssistant ? <p className="whitespace-pre-wrap text-sm leading-7">{latestAssistant.content}</p> : null}
          {session?.readyToConfirm && !processing && !busy && !editing && <div className={styles.ready}>
            <p className={styles.eyebrow}>可以核对课程方案了</p><h3>课程目标和教学安排已整理好</h3><p>{latestAssistant?.content || "你可以继续深入讨论，也可以核对完整方案后开始生成。"}</p>
            <div className={styles.readyActions}><button className={primary} disabled={locked || sourcesChanged} onClick={() => setReview(true)} type="button"><Sparkles className="size-4" />查看完整方案</button><button className={secondary} disabled={locked} onClick={() => void submit("continue", "请保留已经明确的课程要求，围绕最值得深入的一项教学决策继续与我讨论。")} type="button">继续深入讨论</button></div>
          </div>}
        </div>
        <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (canSubmit) void submit(editing ? "revise" : undefined); }}>
          <label htmlFor={inputId}>{editing ? "修改你的课程设想" : selected && selected !== "other" ? "补充说明（可选）" : session ? "你的想法或问题" : "描述你的课程想法"}<span>Ctrl / ⌘ + Enter 提交 · Enter 换行</span></label>
          <textarea id={inputId} aria-label={editing ? "修改课程设想" : "备课想法"} maxLength={12000} disabled={locked} value={message} onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                if (canSubmit) void submit(editing ? "revise" : undefined);
              }
            }}
            placeholder={selected && selected !== "other" ? "已选好方向，可直接提交；也可以补充理由。" : session ? "补充理由、提出不同方案，或问 AI 为什么这样安排。" : "例如：我想给初一学生上数据分析课，用图表解释生活中的问题。"} />
          <div className={styles.composerActions}>
            {session && !editing && <button className={secondary} type="button" disabled={locked} onClick={() => { setEditing(true); setSelected(""); }}>修改已有理解</button>}
            {editing && <button className={secondary} type="button" disabled={locked} onClick={() => setEditing(false)}>取消修改</button>}
            <button className={primary} disabled={!canSubmit} type="submit">{busy || processing ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}{session ? "提交回答" : "开始协同备课"}</button>
          </div>
        </form>
      </section>
      <details className={styles.sources}><summary>管理教材与参考资料（可选）{referenceMaterials.length + textbookSelections.length > 0 ? ` · 已选 ${referenceMaterials.length + textbookSelections.length} 项` : ""}</summary>{sourceControls}</details>
    </div>
    <PreparationPlanSidebar plan={session?.plan ?? {}} fieldOrigins={session?.fieldOrigins} confirmed={Boolean(session?.confirmed)} missingFields={session?.missingFields ?? []} onDetailsOpenChange={(open) => { planDetailsOpen.current = open; if (open) focusAfterReply.current = false; }} />
  </div>;
}
