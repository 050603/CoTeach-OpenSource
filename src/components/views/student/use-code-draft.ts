"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildDocumentDraftExport, documentDraftKey, readDocumentDrafts, writeDocumentDraft, type PendingDocumentDraft } from "@/lib/browser/document-draft";
import { clientUUID } from "@/lib/uuid";

type InitialDraft = { id?: string; version: number; content: string };
type SavedDraft = { id: string; version?: number };

/** Synchronous compare/remove: never clear a replaced record or a sibling key. */
function removeExactDraft(draft: PendingDocumentDraft): void {
  if (localStorage.getItem(draft.key) === JSON.stringify(draft)) localStorage.removeItem(draft.key);
}

/** The edit baseline belongs to this editor, never to a newer background session snapshot. */
export function useCodeDraft(input: {
  scope: string; content: string; initial: InitialDraft; enabled: boolean;
  restore: (content: string) => void;
  persist: (content: string, id: string, expectedVersion: number, draftKey: string, recoveredDraftKey?: string) => Promise<SavedDraft | undefined>;
}) {
  const latest = useRef(input);
  useEffect(() => { latest.current = input; }, [input]);
  const state = useRef<{ scope: string; key: string; id: string; version: number; saved: string; recoveredKey?: string;
    pending: number; uncertain: boolean; ownDraft?: PendingDocumentDraft; recoveredDraft?: PendingDocumentDraft } | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [status, setStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const retain = useCallback((content: string, baseline = state.current): PendingDocumentDraft | null => {
    if (!baseline) return null;
    const draft = { key: baseline.key, scope: baseline.scope, submissionId: baseline.id,
      expectedVersion: baseline.version, content, updatedAt: Date.now(),
      ...(baseline.pending > 0 || baseline.uncertain ? { requiresConfirmation: true } : {}) };
    try { writeDocumentDraft(draft); baseline.ownDraft = draft; return draft; }
    catch { setError("浏览器无法保存本机代码草稿，请保持页面打开并保存到服务器。"); return null; }
  }, []);

  useEffect(() => {
    if (!input.enabled || state.current?.scope === input.scope) return;
    const drafts = readDocumentDrafts(input.scope);
    const recovered = drafts.find(draft => draft.expectedVersion >= input.initial.version
      && (draft.expectedVersion > input.initial.version || draft.requiresConfirmation === true
        || draft.content !== input.initial.content));
    state.current = { scope: input.scope, key: documentDraftKey(input.scope), recoveredKey: recovered?.key, recoveredDraft: recovered,
      id: recovered?.submissionId ?? input.initial.id ?? clientUUID(),
      version: recovered?.expectedVersion ?? input.initial.version, saved: input.initial.id ? input.initial.content : "",
      pending: 0, uncertain: recovered?.requiresConfirmation === true
        || Boolean(recovered && recovered.expectedVersion > input.initial.version) };
    const conflicts = drafts.some(draft => draft.expectedVersion < input.initial.version && draft.content !== input.initial.content);
    setError(conflicts ? "本机有与服务器版本冲突的代码草稿，请下载核对后再编辑。" : null);
    setStatus(recovered ? "unsaved" : "saved");
    if (recovered) input.restore(recovered.content);
  }, [input]);

  const save = useCallback((content = latest.current.content): Promise<boolean> => {
    const baseline = state.current;
    const persist = latest.current.persist;
    if (baseline) baseline.pending += 1; // Include queued work before its first microtask.
    const perform = async () => {
      if (!baseline || state.current !== baseline || !latest.current.enabled) return false;
      if (content === baseline.saved && !baseline.uncertain) { setStatus(latest.current.content === content ? "saved" : "unsaved"); return true; }
      // The provider separately retains the immutable request snapshot. This
      // record belongs to current typing, including while older saves wait.
      const draft = retain(latest.current.content, baseline);
      if (!draft) { setStatus("error"); return false; }
      setStatus("saving");
      try {
        baseline.uncertain = true; // An error may follow a committed write with a lost ACK.
        const attemptedId = baseline.id;
        const result = await persist(content, attemptedId, baseline.version, baseline.key, baseline.recoveredKey);
        if (state.current !== baseline) return false;
        if (!result) throw new Error("代码尚未保存成功。请重试；若其他窗口已修改，请下载本机草稿并刷新核对。");
        if (result.version !== undefined && result.version < baseline.version) {
          throw new Error("服务器返回的代码版本早于本机已确认版本，请保留本机草稿并刷新核对。");
        }
        baseline.id = result.id;
        baseline.version = result.version ?? baseline.version + 1;
        baseline.saved = content;
        baseline.uncertain = false;
        let cleanupFailed = false;
        try {
          if (draft.content === content) removeExactDraft(draft);
          const original = baseline.recoveredDraft;
          // The provider may return a canonical remote ID after verifying all
          // business fields. Identify the recovered input by the attempted ID.
          if (original && original.content === content && original.submissionId === attemptedId
            && Number.isSafeInteger(result.version) && result.version! > 0 && result.version! >= original.expectedVersion) {
            removeExactDraft(original);
            baseline.recoveredDraft = undefined;
            baseline.recoveredKey = undefined;
          }
        } catch { cleanupFailed = true; }
        if (latest.current.content !== content && !retain(latest.current.content, baseline)) {
          setStatus("error");
          return true; // This ACK saved its own snapshot; keep the newer draft failure visible.
        }
        setStatus(cleanupFailed ? "error" : latest.current.content === content ? "saved" : "unsaved");
        setError(cleanupFailed ? "服务器已确认保存，但浏览器无法清理本机草稿，请下载核对并重试。" : null);
        // A revert can equal the old baseline and still differ from this ACK.
        // Re-run the original debounce against the confirmed new revision.
        if (latest.current.content !== content) setRetry(value => value + 1);
        return true;
      } catch (cause) {
        if (state.current === baseline) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "代码尚未保存成功，请重试。");
        }
        return false;
      }
    };
    const result = chain.current.then(perform, perform).finally(() => { if (baseline) baseline.pending -= 1; });
    chain.current = result;
    return result;
  }, [retain]);

  useEffect(() => {
    const baseline = state.current;
    if (!input.enabled || !baseline || baseline.scope !== input.scope) return;
    if (input.content === baseline.saved && baseline.pending === 0 && !baseline.uncertain) {
      // Only this editor's exact unsent record can be discarded on a revert.
      // Recovered originals, another tab's record, and durable requests are untouched.
      const own = baseline.ownDraft;
      if (own?.key === baseline.key) {
        try {
          removeExactDraft(own);
          baseline.ownDraft = undefined;
        } catch {
          // This effect synchronizes external browser storage; surface a denied cleanup.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setError("浏览器无法清理本机代码草稿，请保持页面打开并下载核对。");
          setStatus("error");
          return;
        }
      }
      setStatus("saved");
      return;
    }
    if (!retain(input.content, baseline)) { setStatus("error"); return; }
    setStatus(current => current === "saving" ? current : "unsaved");
    const timer = setTimeout(() => { void save(input.content); }, 900);
    return () => clearTimeout(timer);
  }, [input.content, input.enabled, input.scope, retain, retry, save]);

  useEffect(() => {
    const retrySave = () => setRetry(value => value + 1);
    window.addEventListener("online", retrySave);
    window.addEventListener("focus", retrySave);
    return () => { window.removeEventListener("online", retrySave); window.removeEventListener("focus", retrySave); };
  }, []);

  const download = useCallback(() => {
    const drafts = readDocumentDrafts(latest.current.scope);
    const current = latest.current;
    const baseline = state.current?.scope === current.scope ? state.current : null;
    const recovery = buildDocumentDraftExport({ scope: current.scope,
      submissionId: baseline?.id ?? current.initial.id,
      expectedVersion: baseline?.version ?? current.initial.version, content: current.content }, drafts);
    const url = URL.createObjectURL(new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "本机代码草稿.json"; anchor.click(); URL.revokeObjectURL(url);
  }, []);
  const resolveConflict = (resolve: (content: string) => Promise<{ id: string; version?: number; content: string } | undefined>) => {
    const baseline = state.current;
    const submittedContent = latest.current.content;
    if (baseline) baseline.pending += 1;
    const perform = async (): Promise<boolean> => {
      if (!baseline || state.current !== baseline || !latest.current.enabled) return false;
      if (!retain(submittedContent, baseline)) return false;
      setStatus("saving");
      baseline.uncertain = true;
      const saved = await resolve(submittedContent);
      if (state.current !== baseline) return false;
      if (!saved) { setStatus("error"); return false; }
      const currentContent = latest.current.content;
      baseline.key = documentDraftKey(baseline.scope);
      baseline.id = saved.id;
      baseline.version = saved.version ?? 1;
      baseline.saved = saved.content;
      baseline.uncertain = false;
      if (currentContent !== submittedContent) {
        const retained = retain(currentContent, baseline);
        setStatus(retained ? "unsaved" : "error");
        if (retained) { setError(null); setRetry(value => value + 1); }
      } else {
        latest.current.restore(saved.content);
        setStatus("saved");
        setError(null);
      }
      return true;
    };
    const resolution = chain.current.then(perform, perform).finally(() => { if (baseline) baseline.pending -= 1; });
    chain.current = resolution;
    return resolution;
  };
  const finalize = async (commit: (snapshot: { id: string; version: number; content: string }) => Promise<{ submissionVersion: number }>): Promise<boolean> => {
    const content = latest.current.content;
    if (!await save(content)) return false;
    const baseline = state.current;
    if (baseline) baseline.pending += 1;
    const perform = async () => {
      if (!baseline || state.current !== baseline || !latest.current.enabled || baseline.saved !== content || baseline.uncertain) return false;
      setStatus("saving");
      try {
        const result = await commit({ id: baseline.id, version: baseline.version, content });
        if (state.current !== baseline) return false;
        if (result.submissionVersion !== baseline.version + 1) throw new Error("提交版本未确认，请重试提交或重新加载核对。");
        baseline.version = result.submissionVersion;
        if (latest.current.content !== content) {
          retain(latest.current.content, baseline);
          setRetry(value => value + 1);
        }
        setStatus(latest.current.content === content ? "saved" : "unsaved");
        setError(null);
        return true;
      } catch (cause) {
        if (state.current === baseline) { setStatus("error"); setError(cause instanceof Error ? cause.message : "正式提交尚未确认，请重试。"); }
        return false;
      }
    };
    const result = chain.current.then(perform, perform).finally(() => { if (baseline) baseline.pending -= 1; });
    chain.current = result;
    return result;
  };
  return { status, error, save, download, resolveConflict, finalize };
}
