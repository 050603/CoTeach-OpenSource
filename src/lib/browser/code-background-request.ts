import { boundedFetch } from './bounded-fetch';
import { clientUUID } from '@/lib/uuid';
import { COLLABORATION_BROWSER_TIMEOUT_MS } from '@/lib/ai-collaboration/request-budget';
import { subscribeDocumentReviewCompletion } from './document-review-notifications';

const PREFIX = 'openpbl:code-background:v1:';
export type PendingBackgroundCodeAi = { version: 1; scope: string; requestId: string; body: string; createdAt: number;
  resume?: { requestId: string; body: string; acknowledged: boolean };
  terminalScope?: { error: string; at: number } };
export function codeBackgroundScope(body: Record<string, unknown>): string {
  return JSON.stringify([body.courseId, body.studentId, body.stageKey, body.language]);
}
function key(row: PendingBackgroundCodeAi) { return `${PREFIX}${encodeURIComponent(row.scope)}:${row.requestId}`; }
function originalBody(body: Record<string, unknown>) { const original = { ...body }; delete original.requestId; return JSON.stringify(original); }
export function readPendingBackgroundCodeAi(scope: string): PendingBackgroundCodeAi[] {
  const rows: PendingBackgroundCodeAi[] = [];
  const prefix = `${PREFIX}${encodeURIComponent(scope)}:`;
  for (let index = 0; index < localStorage.length; index += 1) {
    const itemKey = localStorage.key(index);
    if (!itemKey?.startsWith(prefix)) continue;
    const row = JSON.parse(localStorage.getItem(itemKey) ?? 'null') as PendingBackgroundCodeAi | null;
    if (!row || row.version !== 1 || row.scope !== scope || typeof row.requestId !== 'string' || typeof row.body !== 'string'
      || key(row) !== itemKey || JSON.parse(row.body).requestId !== row.requestId) throw new Error('本机代码审阅恢复记录无法读取，请保留草稿后重试。');
    if (row.resume && (typeof row.resume.requestId !== 'string' || typeof row.resume.body !== 'string'
      || JSON.parse(row.resume.body).requestId !== row.resume.requestId || JSON.parse(row.resume.body).targetRequestId !== row.requestId)) {
      throw new Error('本机代码审阅重试记录无法读取，请保留草稿后重试。');
    }
    rows.push(row);
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}
function wait(ms: number, signal: AbortSignal, registerWake: (wake: () => void) => () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let unregister = () => {};
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); unregister(); };
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(done, ms);
    unregister = registerWake(done);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

/** Client aliases survive a lost 202. Only waiting is cancelled; accepted work belongs to the server queue. */
export async function requestBackgroundCodeAi(body: Record<string, unknown>, signal: AbortSignal, options?: { resume: true }): Promise<Response> {
  signal.throwIfAborted();
  const scope = codeBackgroundScope(body);
  const rows = readPendingBackgroundCodeAi(scope);
  const serialized = originalBody(body);
  let pending = rows.find(row => !row.terminalScope && originalBody(JSON.parse(row.body)) === serialized);
  const fresh = !pending;
  if (!pending) {
    if (rows.filter(row => !row.terminalScope).length >= 80) throw new Error('本机尚有待恢复的代码审阅，请先恢复这些请求。');
    const requestId = `code-background-client:${clientUUID()}`;
    pending = { version: 1, scope, requestId, body: JSON.stringify({ ...body, requestId }), createdAt: Date.now() };
    // Never start paid work without its exact recoverable input.
    localStorage.setItem(key(pending), JSON.stringify(pending));
  }
  if (options?.resume && !fresh && (!pending.resume || pending.resume.acknowledged)) {
    const requestId = `code-background-resume:${clientUUID()}`;
    pending = { ...pending, resume: { requestId, acknowledged: false, body: JSON.stringify({ courseId: body.courseId,
      studentId: body.studentId, stageKey: body.stageKey, language: body.language,
      action: 'retry-code-background', targetRequestId: pending.requestId, requestId }) } };
    localStorage.setItem(key(pending), JSON.stringify(pending));
  }
  let retained = pending;
  let canonicalRequestId: string | undefined;
  const hintedIds = new Set<string>();
  let wake: (() => void) | undefined;
  const unsubscribe = subscribeDocumentReviewCompletion({ courseId: String(body.courseId), studentId: String(body.studentId) }, notification => {
    if (hintedIds.size < 80) hintedIds.add(notification.requestId);
    if (notification.requestId === retained.requestId || notification.requestId === canonicalRequestId) wake?.();
  });
  try {
  const query = new URLSearchParams({ courseId: String(body.courseId), studentId: String(body.studentId),
    stageKey: String(body.stageKey), language: String(body.language), requestId: retained.requestId });
  const read = () => boundedFetch(`/api/ai-collaboration/code?${query}`, { cache: 'no-store', signal });
  const post = () => boundedFetch('/api/ai-collaboration/code', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': retained.requestId }, body: retained.body }, COLLABORATION_BROWSER_TIMEOUT_MS);
  const missing = async (response: Response) => {
    const state = await response.clone().json().catch(() => null);
    return (response.status === 404 && state?.error === 'REQUEST_NOT_FOUND')
      || (response.status === 503 && state?.requestId === retained.requestId && state?.error === 'REQUEST_STATE_UNAVAILABLE');
  };
  let response: Response;
  if (options?.resume && !fresh) {
    response = await boundedFetch('/api/ai-collaboration/code', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: retained.resume!.body });
  } else if (fresh) {
    try { response = await post(); }
    catch (error) { if (signal.aborted) throw error; response = await read(); if (await missing(response)) response = await post(); }
  } else {
    response = await read();
    if (await missing(response)) response = await post();
  }
  const deadline = Date.now() + COLLABORATION_BROWSER_TIMEOUT_MS;
  let interval = 5_000;
  while (true) {
    signal.throwIfAborted();
    const receipt = await response.clone().json().catch(() => null);
    if (response.ok && receipt?.requestId !== retained.requestId) throw new Error('代码审阅回执尚未匹配原请求，本机请求已保留。');
    if (options?.resume && response.ok && retained.resume && !retained.resume.acknowledged) {
      const acknowledged = { ...retained, resume: { ...retained.resume, acknowledged: true } };
      if (localStorage.getItem(key(retained)) === JSON.stringify(retained)) {
        localStorage.setItem(key(retained), JSON.stringify(acknowledged)); retained = acknowledged;
      }
    }
    if (response.ok && typeof receipt?.canonicalRequestId === 'string') canonicalRequestId = receipt.canonicalRequestId;
    if (response.status === 200 && receipt?.status === 'completed') {
      const stored = localStorage.getItem(key(retained));
      if (stored === JSON.stringify(retained)) localStorage.removeItem(key(retained));
      return response;
    }
    if (receipt?.status === 'failed' || receipt?.status === 'cancelled') {
      if (['REVIEW_SCOPE_CHANGED', 'REVIEW_IDENTITY_CHANGED', 'REVIEW_STAGE_CHANGED'].includes(receipt.error)
        && localStorage.getItem(key(retained)) === JSON.stringify(retained)) {
        localStorage.setItem(key(retained), JSON.stringify({ ...retained, terminalScope: { error: receipt.error, at: Date.now() } }));
      }
      throw new Error('代码审阅尚未完成，原请求和代码已保留。');
    }
    if (response.ok && (response.status !== 202 || receipt?.status !== 'processing')) throw new Error('代码审阅回执不完整，原请求和代码已保留。');
    if (response.status !== 202) return response;
    if (Date.now() >= deadline) throw new Error('代码后台审阅仍在处理中，原请求已保留，稍后自动恢复。');
    if (!hintedIds.has(retained.requestId) && (!canonicalRequestId || !hintedIds.has(canonicalRequestId))) {
      await wait(Math.min(15_000, interval + Math.random() * 1_000, deadline - Date.now()), signal,
        notify => { wake = notify; return () => { if (wake === notify) wake = undefined; }; });
    }
    hintedIds.clear();
    interval = Math.min(15_000, interval * 1.5);
    response = await read();
  }
  } finally { unsubscribe(); }
}
