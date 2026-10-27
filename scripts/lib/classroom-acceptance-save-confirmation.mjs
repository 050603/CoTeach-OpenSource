import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as eventCursorModule from '../../src/lib/realtime/event-cursor.ts';
import { assertInitialSaveProof } from './classroom-acceptance-save-recovery.mjs';

// Native Node loads this TS module as ESM; the verification CLI's tsx loader
// exposes its CommonJS namespace under default. Reuse the same real codec.
const { decodeEventCursor } = eventCursorModule.default ?? eventCursorModule;

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const view = row => object(row.payload).view ?? row.payload;
const businessValue = saved => [saved.courseId, saved.studentId, saved.studentName ?? null, saved.groupId ?? null,
  saved.stageKey, saved.type, saved.title, saved.content,
  (saved.files ?? []).map(file => [file.name, file.type, file.size ?? null, file.url ?? null]),
  saved.status ?? 'submitted', saved.submittedAt ?? null];

/** Observe auto and manual saves before editing. Never submit a request to get
 * a receipt, and never accept a database snapshot as a browser acknowledgement.
 */
export function observeSubmissionSaveReceipts(page, { origin, courseId, studentId }) {
  const entries = []; const pending = new Set();
  const onResponse = response => {
    const request = response.request(); const url = new URL(response.url());
    if (request.method() !== 'POST' || url.origin !== origin || url.pathname !== `/api/courses/${courseId}/actions`) return;
    let body; try { body = request.postDataJSON(); } catch { return; }
    if (body?.action?.type !== 'UPSERT_SUBMISSION' || body.action.payload?.courseId !== courseId
      || body.action.payload?.submission?.studentId !== studentId) return;
    const entry = { request: body, status: response.status() }; entries.push(entry);
    const work = response.json().then(ack => { entry.ack = ack; })
      .catch(error => { entry.error = String(error.message ?? error); }).finally(() => pending.delete(work));
    pending.add(work);
  };
  page.on('response', onResponse);
  return { entries, async close() {
    page.off('response', onResponse); await Promise.allSettled([...pending]);
  } };
}

/** This function is serialized into the real page. Storage access/parsing
 * failures throw, rather than turning an unreadable queue into an empty one.
 * Resolved conflict archives and every other scope remain untouched.
 */
export function submissionSaveScopeSettled({ courseId, studentId, stageKey, type }) {
  const prefix = `openpbl:submission-save:v1:${encodeURIComponent(studentId)}:`;
  return Object.keys(localStorage).filter(key => key.startsWith(prefix)).every(key => {
    const record = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!record || record.actorId !== studentId || !record.action?.payload
      || !['pending', 'conflict', 'resolved'].includes(record.state)) throw new Error('Cannot confirm an unreadable browser save record');
    const payload = record.action.payload; const target = payload.submission;
    if (!target || target.studentId !== studentId) throw new Error('Browser save actor differs from its storage scope');
    return record.state === 'resolved' || payload.courseId !== courseId || target.stageKey !== stageKey || target.type !== type;
  });
}

/** A later reload reuses an already observed own ACK when no new POST occurred.
 * It must match the exact saved content/version and the durable DomainEvent.
 * Only after the browser consumes its pending save may a caller remove drafts.
 */
export async function confirmSubmissionSave({ page, db, courseId, studentId, participationId,
  submission, observations, marker = view(submission).content, timeoutMs = 45000 }) {
  const saved = view(submission); let response;
  const end = Date.now() + timeoutMs;
  do {
    const entries = typeof observations === 'function' ? observations() : observations;
    response = entries.find(item => item?.status === 200
      && item.request?.action?.type === 'UPSERT_SUBMISSION'
      && item.request.action.payload.courseId === courseId
      && item.request.action.payload.submission.studentId === studentId
      && item.request.action.payload.submission.id === saved.id
      && item.request.action.payload.submission.stageKey === saved.stageKey
      && item.request.action.payload.submission.type === saved.type
      && item.request.action.payload.submission.content === saved.content
      && item.ack?.requestId === item.request.requestId && item.ack?.submissionVersion === saved.version);
    if (response) break;
    if (Date.now() >= end) break;
    await delay(250);
  } while (Date.now() < end);
  assert.ok(response, 'Server reload requires this exact editor snapshot and its actual browser ACK');
  const cursor = decodeEventCursor(response.ack.eventCursor);
  assert.ok(cursor, 'Browser save ACK lacks a valid domain-event cursor');
  const receipt = await db.domainEvent.findUnique({ where: { idempotencyKey: `course-action:${studentId}:${response.request.requestId}` } });
  assertInitialSaveProof({ ...response, receipt, row: submission, courseId, studentId, participationId, marker, submissionType: saved.type });
  assert.deepEqual(businessValue(saved), businessValue(response.request.action.payload.submission),
    'Saved business fields differ from the actual browser request');
  assert.equal(cursor.id, receipt.id, 'Browser ACK cursor names another domain event');
  assert.equal(cursor.createdAt.getTime(), new Date(receipt.createdAt).getTime(), 'Browser ACK cursor time differs from its domain event');
  const baseline = response.request.action.payload.expectedSubmissionVersion;
  assert.ok(Number.isSafeInteger(baseline) && baseline >= 0, 'Saved request lacks its exact editor baseline');
  assert.equal(saved.version, baseline + 1, 'Saved version did not advance from the observed request baseline');
  await page.waitForFunction(submissionSaveScopeSettled, { studentId, courseId, stageKey: saved.stageKey, type: saved.type }, { timeout: timeoutMs });
  return { request: response.request, ack: response.ack, status: response.status, receiptId: receipt.id,
    baseline, contentSha256: createHash('sha256').update(saved.content).digest('hex') };
}

/** Remove only a confirmed draft for this exact scope; never discard review outboxes. */
export async function removeAcknowledgedDocumentDrafts(page, { courseId, studentId, submission, workspaceKind = 'document' }) {
  const saved = view(submission); const scope = `${courseId}:${studentId}:${saved.stageKey ?? 'make'}:${workspaceKind}`;
  assert.equal(saved.studentId, studentId); assert.equal(saved.courseId, courseId);
  return page.evaluate(({ scope, saved }) => {
    // Recheck in the same browser turn as deletion: a save can start after
    // the earlier receipt/outbox wait. Never remove that operation's outbox.
    const savePrefix = `openpbl:submission-save:v1:${encodeURIComponent(saved.studentId)}:`;
    for (const key of Object.keys(localStorage).filter(key => key.startsWith(savePrefix))) {
      const record = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (!record || record.actorId !== saved.studentId || !record.action?.payload
        || !['pending', 'conflict', 'resolved'].includes(record.state)) throw new Error('Cannot inspect a browser save before draft removal');
      const payload = record.action.payload; const target = payload.submission;
      if (!target || target.studentId !== saved.studentId) throw new Error('Browser save actor differs before draft removal');
      if (record.state !== 'resolved' && payload.courseId === saved.courseId
        && target.stageKey === saved.stageKey && target.type === saved.type) throw new Error('Unacknowledged submission save must not be removed');
    }
    const prefix = `openpbl:document-draft:v1:${encodeURIComponent(scope)}:`;
    const matching = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => {
      const serialized = localStorage.getItem(key); const draft = JSON.parse(serialized ?? 'null');
      if (!draft || draft.key !== key || draft.scope !== scope || draft.submissionId !== saved.id
        || (draft.requiresConfirmation !== undefined && draft.requiresConfirmation !== false)
        || draft.content !== saved.content || !Number.isInteger(draft.expectedVersion)
        || draft.expectedVersion < 0 || draft.expectedVersion > saved.version) throw new Error('Unacknowledged document draft must not be removed');
      return { key, serialized };
    });
    for (const { key, serialized } of matching) {
      if (localStorage.getItem(key) !== serialized) throw new Error('Document draft changed after its server ACK comparison');
      localStorage.removeItem(key);
    }
    return matching.map(item => item.key);
  }, { scope, saved });
}
