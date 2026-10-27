type Notice = { instanceId: string; studentId?: string; immediate: boolean };
declare global { var __pblProcessNotices: Map<string, Notice> | undefined; }
const notices = globalThis.__pblProcessNotices ??= new Map();
/** A wake-up hint only. Committed business events remain the durable recovery source. */
export function notifyProcessEvaluation(instanceId: string, studentId?: string, immediate = false) {
  const key = `${instanceId}:${studentId ?? "*"}`;
  notices.set(key, { instanceId, studentId, immediate: immediate || !!notices.get(key)?.immediate });
}
export function takeProcessNotices() { const pending = [...notices.values()]; notices.clear(); return pending; }
