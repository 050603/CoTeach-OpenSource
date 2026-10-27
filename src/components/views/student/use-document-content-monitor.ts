'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlateDocumentPaste } from '@/components/plate-document-editor';
import { boundedFetch } from '@/lib/browser/bounded-fetch';
import { DocumentPasteCandidates, documentHtmlText, normalizePasteText } from '@/lib/browser/document-paste-candidates';
import {
  CONTENT_MONITOR_MAX_TEXT,
  type ContentMonitorCheckInput,
  type ContentMonitorEvent,
  type ContentMonitorEventAction,
  type ContentMonitorReceipt,
  type ContentMonitorSource,
} from '@/lib/project-practice/content-monitor-contract';
import { clientUUID } from '@/lib/uuid';

const ENDPOINT = '/api/project-practice/content-monitor';
const STORAGE_PREFIX = 'openpbl:document-content-monitor:';
type PendingCheck = { requestId: string; input?: ContentMonitorCheckInput; posts: number; startedAt: number };
type Runtime = {
  scope: string;
  observe: (paste: PlateDocumentPaste) => void;
  shown: (id: string | null) => void;
  explain: (id: string, source: ContentMonitorSource, explanation: string) => Promise<void>;
};

function readIds(key: string): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string').slice(-200) : [];
  } catch { return []; }
}

function writeIds(key: string, ids: Iterable<string>): void {
  try {
    const values = [...ids].slice(-200);
    if (values.length) sessionStorage.setItem(key, JSON.stringify(values));
    else sessionStorage.removeItem(key);
  } catch { /* The server remains authoritative if browser storage is unavailable. */ }
}

export function useDocumentContentMonitor(input: {
  courseId: string;
  studentId: string;
  enabled: boolean;
  documentHtml: string;
}) {
  const { courseId, studentId, enabled, documentHtml } = input;
  const scope = `${courseId}:${studentId}`;
  const documentRef = useRef('');
  documentRef.current = documentHtml;
  const runtimeRef = useRef<Runtime | null>(null);
  const [reminders, setReminders] = useState<{ scope: string; events: ContentMonitorEvent[] }>({ scope: '', events: [] });
  const [notice, setNotice] = useState<{ scope: string; text: string } | null>(null);

  useEffect(() => {
    const pendingKey = `${STORAGE_PREFIX}${scope}:pending`;
    const seenKey = `${STORAGE_PREFIX}${scope}:seen`;
    if (!enabled || !courseId || !studentId) {
      writeIds(pendingKey, []);
      return;
    }
    const controller = new AbortController();
    const candidates = new DocumentPasteCandidates();
    const seen = new Set(readIds(seenKey));
    const acknowledged = new Set<string>();
    const checks = new Map<string, PendingCheck>(readIds(pendingKey).map(requestId => [requestId, { requestId, posts: 2, startedAt: Date.now() }]));
    const scheduled = new Set<ReturnType<typeof setTimeout>>();
    let draining = false;
    let readingEvents = false;
    let lastEventRead = 0;
    let presentedId: string | null = null;
    const isCurrent = () => !controller.signal.aborted;
    queueMicrotask(() => {
      if (!isCurrent()) return;
      setReminders({ scope, events: [] });
      setNotice(null);
    });
    const savePending = () => writeIds(pendingKey, checks.keys());
    const patchEvent = async (id: string, action: ContentMonitorEventAction) => {
      const response = await boundedFetch(`${ENDPOINT}/events/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action), signal: controller.signal,
      });
      if (!response.ok) throw new Error('来源说明暂未保存，请重试。');
      const result = await response.json() as { event?: ContentMonitorEvent };
      const saved = result.event;
      if (!saved || saved.id !== id || saved.studentId !== studentId || !saved.acknowledgedAt
        || (action.action === 'explain' && (saved.studentSource !== action.source || saved.studentExplanation !== action.explanation))) {
        throw new Error('来源说明尚未确认保存，请重试。');
      }
    };
    const acknowledge = async (id: string) => {
      if (acknowledged.has(id) || !isCurrent()) return;
      acknowledged.add(id);
      try { await patchEvent(id, { courseId, action: 'acknowledge' }); }
      catch { acknowledged.delete(id); }
    };
    const receive = (events: ContentMonitorEvent[]) => {
      if (!isCurrent()) return;
      const documentText = normalizePasteText(documentHtmlText(documentRef.current));
      const owned = events.filter(event => event.studentId === studentId);
      const eligible = owned.filter(event => {
        if (event.status !== 'pending' || event.acknowledgedAt) return false;
        if (seen.has(event.id)) { void acknowledge(event.id); return false; }
        // Saved drafts can lag the paste. Inspect the current editor as well,
        // so a server 'unknown' never suppresses a still-present excerpt.
        return Boolean(event.excerpt) && documentText.includes(normalizePasteText(event.excerpt));
      });
      setReminders(previous => {
        if (!isCurrent()) return previous;
        const current = previous.scope === scope ? previous.events : [];
        const updates = new Map(owned.map(event => [event.id, event]));
        const retained = current.flatMap(event => {
          const latest = updates.get(event.id);
          if (!latest) return [event]; // A partial receipt/page cannot revoke other events.
          // Preserve the open dialog and any explanation being typed after its
          // own acknowledgement; processed items waiting behind it are retired.
          if (event.id !== presentedId && (latest.status !== 'pending' || latest.acknowledgedAt)) return [];
          return [latest];
        });
        const known = new Set(retained.map(event => event.id));
        return { scope, events: [...retained, ...eligible.filter(event => !known.has(event.id))] };
      });
    };
    const readEvents = async () => {
      if (readingEvents || !isCurrent()) return;
      readingEvents = true;
      lastEventRead = Date.now();
      try {
        const query = new URLSearchParams({ courseId });
        const response = await boundedFetch(`${ENDPOINT}/events?${query}`, { cache: 'no-store', signal: controller.signal });
        if (response.ok) {
          const payload = await response.json() as { events?: ContentMonitorEvent[] };
          receive(payload.events ?? []);
        }
      } catch { /* Recover on the next read or when the browser reconnects. */ }
      finally { readingEvents = false; }
    };
    const drain = async () => {
      if (draining || !isCurrent()) return;
      draining = true;
      try {
        for (const check of [...checks.values()].slice(0, 2)) {
          if (!isCurrent()) break;
          if (Date.now() - check.startedAt > 180_000) {
            checks.delete(check.requestId); savePending();
            setNotice({ scope, text: '部分粘贴检查暂未完成，不影响编辑、保存或提交。' });
            continue;
          }
          const post = check.input && check.posts < 2;
          try {
            const query = new URLSearchParams({ courseId, requestId: check.requestId });
            const response = post
              ? await boundedFetch(`${ENDPOINT}/checks`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(check.input), signal: controller.signal,
              })
              : await boundedFetch(`${ENDPOINT}/checks?${query}`, { cache: 'no-store', signal: controller.signal });
            if (!isCurrent()) break;
            if (!response.ok) {
              if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                checks.delete(check.requestId); savePending();
              }
              throw new Error('检查暂未完成');
            }
            const receipt = await response.json() as ContentMonitorReceipt;
            if (!isCurrent() || receipt.requestId !== check.requestId) continue;
            check.input = undefined; // Release paste text as soon as the server accepts it.
            if (receipt.status !== 'pending') {
              checks.delete(check.requestId); savePending();
              if (receipt.status === 'incomplete') setNotice({ scope, text: '部分粘贴检查未完成，不影响编辑、保存或提交。' });
            }
            if (receipt.event) receive([receipt.event]);
          } catch {
            if (post) check.posts += 1;
          }
        }
      } finally { draining = false; }
    };
    runtimeRef.current = {
      scope,
      observe(paste) {
        if (!isCurrent()) return;
        if (paste.text.length > CONTENT_MONITOR_MAX_TEXT) {
          setNotice({ scope, text: '本次粘贴过长，未完成检测；不影响编辑、保存或提交。' });
          return;
        }
        const batches = candidates.add(paste);
        if (!batches.length) return;
        // Let Plate finish its own paste and React update the current document.
        const timer = setTimeout(() => {
          scheduled.delete(timer);
          if (!isCurrent()) return;
          for (const fragments of batches) {
            const requestId = clientUUID();
            const documentText = paste.documentText ?? documentHtmlText(documentRef.current);
            const anchor = paste.text.split(/\r?\n/).map(line => line.trim()).find(line => line.length >= 16)?.slice(0, 80) ?? paste.text.slice(0, 80);
            const pastedAt = anchor ? documentText.indexOf(anchor) : -1;
            const contextStart = pastedAt > 4_000 ? pastedAt - 2_000 : 0;
            checks.set(requestId, {
              requestId, posts: 0, startedAt: Date.now(),
              input: { courseId, requestId, fragments, documentText: documentText.slice(contextStart, contextStart + CONTENT_MONITOR_MAX_TEXT) },
            });
          }
          savePending(); void drain();
        }, 0);
        scheduled.add(timer);
      },
      shown(id) { presentedId = id; if (id) { seen.add(id); writeIds(seenKey, seen); void acknowledge(id); } },
      async explain(id, source, explanation) {
        await patchEvent(id, { courseId, action: 'explain', source, explanation });
        if (!isCurrent()) return;
        setReminders(previous => previous.scope === scope ? { scope, events: previous.events.filter(event => event.id !== id) } : previous);
      },
    };
    const tick = () => { void drain(); if (Date.now() - lastEventRead >= 20_000) void readEvents(); };
    const reconnect = () => { void drain(); void readEvents(); };
    const timer = setInterval(tick, 2_000);
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', reconnect);
    void readEvents(); void drain();
    return () => {
      controller.abort(); clearInterval(timer); scheduled.forEach(clearTimeout);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('focus', reconnect);
      if (runtimeRef.current?.scope === scope) runtimeRef.current = null;
    };
  }, [courseId, studentId, enabled, scope]);

  const currentText = useMemo(() => enabled ? normalizePasteText(documentHtmlText(documentHtml)) : '', [enabled, documentHtml]);
  const event = enabled && reminders.scope === scope && runtimeRef.current?.scope === scope
    ? reminders.events.find(item => Boolean(item.excerpt) && currentText.includes(normalizePasteText(item.excerpt))) ?? null : null;
  useEffect(() => {
    if (runtimeRef.current?.scope === scope) runtimeRef.current.shown(event?.id ?? null);
  }, [event, scope]);
  const onPaste = useCallback((paste: PlateDocumentPaste) => {
    if (enabled && runtimeRef.current?.scope === scope) runtimeRef.current.observe(paste);
  }, [enabled, scope]);
  const dismiss = useCallback(() => {
    if (!event) return;
    setReminders(previous => previous.scope === scope ? { scope, events: previous.events.filter(item => item.id !== event.id) } : previous);
  }, [event, scope]);
  const explain = useCallback(async (source: ContentMonitorSource, explanation: string) => {
    if (!event || runtimeRef.current?.scope !== scope) return;
    await runtimeRef.current.explain(event.id, source, explanation);
  }, [event, scope]);
  return { event, onPaste, dismiss, explain, notice: enabled && notice?.scope === scope ? notice.text : null };
}
