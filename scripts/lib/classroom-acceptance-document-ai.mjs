import { confirmSubmissionSave, removeAcknowledgedDocumentDrafts } from './classroom-acceptance-save-confirmation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';

export const DOCUMENT_AI_FEATURES = Object.freeze([
  'document-proactive-review-real-model',
  'document-proactive-comment-read-reply-reopen',
  'document-ai-edit-adopt-reject-undo',
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const view = row => object(row.payload).view ?? row.payload;
class UnverifiedCoverage extends Error {}
const REVIEW_RECOVERY_FEATURE = 'document-prior-review-recovery';

/** Observe the browser's existing outbox; only the real UI may retry or clear it. */
export async function waitForNaturalDocumentReviewRecovery({ page, db, student, instanceId, entries,
  evidence, timeoutMs = 300000, now = () => performance.now(), wait = delay,
  minimumObservationMs = 0, pollMs = 500, allowCancelled = true, auditEveryPoll = true, finalProof = async () => true }) {
  const scope = `${instanceId}:${student.user.id}:make:document`;
  const started = now(); const tracked = new Map(); const snapshots = new Map();
  let quietSince;
  Object.assign(evidence, { startedAt: new Date().toISOString(), timeoutMs,
    scope: 'Existing durable review queue before reload/new-paragraph stimulus; natural browser retries only',
    localQueueChanges: [], taskTransitions: [], audit: [], browserAttempts: [], status: 'running' });
  const readBeforeDeadline = async operation => {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Document review recovery observation exceeded ${timeoutMs}ms`)),
          Math.max(0, timeoutMs - (now() - started)));
      })]);
    } finally { clearTimeout(timer); }
  };
  const browserPending = () => page.evaluate(expectedScope => {
    const prefix = `openpbl:document-review:v1:${encodeURIComponent(expectedScope)}:`;
    return Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => {
      const row = JSON.parse(localStorage.getItem(key) ?? 'null');
      const body = row && JSON.parse(row.body);
      if (!row || row.key !== key || row.scope !== expectedScope || !row.requestId
        || key !== `${prefix}${row.requestId}` || !Number.isFinite(row.createdAt)
        || body?.requestId !== row.requestId || body.action !== 'proactive-document-comments'
        || `${body.courseId}:${body.studentId}:${body.stageKey}:${body.workspaceKind}` !== expectedScope
        || typeof body.documentHtml !== 'string' || !Array.isArray(body.paragraphs) || !body.paragraphs.length) {
        throw new Error('Existing document review outbox is corrupt or belongs to another scope');
      }
      return { requestId: row.requestId, createdAt: row.createdAt, body };
    });
  }, scope);
  try {
    while (now() - started < timeoutMs) {
      const pending = await readBeforeDeadline(browserPending());
      for (const item of pending) {
        const previous = tracked.get(item.requestId);
        if (previous) assert.deepEqual(item, previous, 'A pending request changed its immutable content');
        else tracked.set(item.requestId, item);
      }
      const local = pending.map(item => item.requestId).sort();
      if (JSON.stringify(local) !== JSON.stringify(evidence.localQueueChanges.at(-1)?.requestIds)) {
        evidence.localQueueChanges.push({ at: new Date().toISOString(), elapsedMs: now() - started, requestIds: local });
      }
      const requestIds = [...tracked.keys()];
      const tasks = requestIds.length ? await readBeforeDeadline(db.aiTask.findMany({ where: {
        taskType: 'DOCUMENT_COLLABORATION', createdById: student.user.id,
        conversation: { participationId: student.participation.id },
        OR: requestIds.map(requestId => ({ input: { path: ['requestId'], equals: requestId } })),
      }, select: { id: true, status: true, error: true, input: true, output: true,
        createdAt: true, startedAt: true, completedAt: true } })) : [];
      let terminal = tasks.length === requestIds.length;
      const seen = new Set();
      for (const task of tasks) {
        const input = object(task.input); const pendingRequest = tracked.get(input.requestId);
        assert.ok(pendingRequest); assert.ok(!seen.has(input.requestId), 'One request has multiple durable tasks');
        seen.add(input.requestId);
        assert.equal(input.participationId, student.participation.id);
        assert.equal(input.intent, 'proactive-document-comments'); assert.equal(input.workspaceKind, 'document');
        assert.equal(input.stageKey, 'make');
        assert.equal(input.documentVersion, sha(JSON.stringify(pendingRequest.body.documentHtml)));
        const snapshot = { id: task.id, requestId: input.requestId, status: task.status, error: task.error,
          attemptHash: input.token ? sha(input.token) : null, createdAt: task.createdAt,
          startedAt: task.startedAt, completedAt: task.completedAt };
        const signature = JSON.stringify(snapshot);
        if (snapshots.get(task.id) !== signature) {
          snapshots.set(task.id, signature);
          evidence.taskTransitions.push({ observedAt: new Date().toISOString(), elapsedMs: now() - started, ...snapshot });
        }
        if (task.status === 'COMPLETED') {
          const receipt = object(object(task.output).response);
          assert.equal(receipt.requestId, input.requestId); assert.equal(receipt.status, 'completed');
          assert.equal(receipt.documentVersion, input.documentVersion);
          assert.equal(receipt.reviewDecision?.documentVersion, input.documentVersion);
          assert.equal(receipt.reviewDecision?.action, 'proactive-document-comments');
        } else if (!allowCancelled || task.status !== 'CANCELLED') terminal = false;
      }
      const events = auditEveryPoll && requestIds.length ? await readBeforeDeadline(db.aiInteractionEvent.findMany({ where: {
        participationId: student.participation.id, userId: student.user.id, requestId: { in: requestIds },
      }, orderBy: { createdAt: 'asc' }, select: { id: true, requestId: true, eventType: true,
        createdAt: true, content: true, payload: true } })) : [];
      evidence.audit = events.map(event => {
        const detail = object(object(event.payload).detail);
        if (detail.kind === 'model-output') {
          assert.equal(detail.rawSha256, sha(event.content ?? ''), 'Retained recovery model output digest differs');
          assert.equal(detail.rawLength, event.content?.length);
        }
        return { id: event.id, requestId: event.requestId, eventType: event.eventType, at: event.createdAt,
          attemptHash: detail.requestAttemptId ? sha(detail.requestAttemptId) : null,
          kind: detail.kind, failureKind: detail.failureKind, elapsedMs: detail.elapsedMs,
          error: event.eventType === 'error' ? event.content : undefined,
          modelAttempt: detail.modelAttempt, validation: detail.validation,
          rawSha256: detail.rawSha256, retainedRawSha256: detail.kind === 'model-output' ? sha(event.content ?? '') : undefined };
      });
      if (!pending.length && terminal && now() - started >= minimumObservationMs
        && await readBeforeDeadline(finalProof())) {
        quietSince ??= now();
        // Also observe the existing 1.5s wake + 1s attempt after a stale ACK.
        if ((!tracked.size && minimumObservationMs === 0) || now() - quietSince >= 3500) {
          evidence.status = 'completed';
          return { priorRequests: tracked.size, elapsedMs: now() - started,
            capacityRejections: auditEveryPoll ? evidence.audit.filter(event => event.error === 'AI_PROACTIVE_REVIEW_BUSY').length : null,
            terminalReceiptsAndLocalRemoval: true };
        }
      } else quietSince = undefined;
      await wait(Math.min(pollMs, Math.max(0, timeoutMs - (now() - started))));
    }
    throw new Error(`Document review queue did not naturally reach durable terminal receipts, local removal and final coverage within ${timeoutMs}ms`);
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
  } finally {
    evidence.elapsedMs = now() - started; evidence.finishedAt = new Date().toISOString();
    evidence.pendingRequests = [...tracked.values()].map(item => ({ requestId: item.requestId,
      createdAt: item.createdAt, documentVersion: sha(JSON.stringify(item.body.documentHtml)),
      paragraphs: item.body.paragraphs.map(candidate => ({ candidateId: candidate.candidateId,
        blockId: candidate.blockId, blockIndex: candidate.blockIndex, textSha256: sha(candidate.targetText) })) }));
    evidence.browserAttempts = (typeof entries === 'function' ? entries() : entries).filter(entry => tracked.has(entry.body?.requestId ?? entry.query?.requestId)).map(entry => ({
      requestId: entry.body.requestId ?? entry.query?.requestId, method: entry.method, at: entry.at, status: entry.status, elapsedMs: entry.elapsedMs,
      completedElapsedMs: entry.completedElapsedMs, retryAfter: entry.retryAfter,
      responseStatus: entry.response?.status, error: entry.response?.error,
      retryAfterMs: entry.response?.retryAfterMs, networkError: entry.networkError, bodyError: entry.bodyError,
    }));
  }
}

export function documentAiParagraphs(index) {
  return {
    review: `科学观察记录${index}：原始日志记载，10月15日同一观察员在校园东侧和西侧分别观察十分钟，东侧记录4只麻雀，西侧记录7只麻雀。两次观察都采用同一计数规则，不将重复出现的个体重复计数。汇总表却写成东侧40只、西侧7只，并据此宣称东侧比西侧更多，两个地点总计44只。汇报稿准备直接沿用这个总数和地点排序，但没有说明从4只变成40只的依据，也没有提供额外观察记录。我们将用原始日志核验统计表，保留日期、地点、观察时长和计数规则，不能用没有记录的数字替换原始数据。`,
    auxiliary: `辅助记录${index}：请在周一登记观察时段。`,
  };
}

// Work on a detached copy only; never change the live document or its selection.
function inspectText(input) {
  const root = typeof input === 'string' ? new DOMParser().parseFromString(input, 'text/html').body : input.cloneNode(true);
  root.querySelectorAll('[contenteditable="false"],button,[data-slate-spacer]').forEach(node => node.remove());
  return (root.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/gu, '');
}

function nativeSelection(editor) {
  const clean = value => (value ?? '').replace(/[\u200B-\u200D\uFEFF]/gu, '');
  const blocks = [...editor.querySelectorAll('[data-slate-node="element"]')].filter(node => {
    const parent = node.parentElement?.closest('[data-slate-node="element"]');
    return !parent || !editor.contains(parent);
  });
  const last = blocks.at(-1);
  const lastCopy = last?.cloneNode(true);
  lastCopy?.querySelectorAll('[contenteditable="false"],button,[data-slate-spacer]').forEach(node => node.remove());
  let lastText;
  if (last) {
    const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('[contenteditable="false"],button,[data-slate-spacer]')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) lastText = walker.currentNode;
  }
  const selection = window.getSelection();
  const point = (node, offset) => ({ block: blocks.findIndex(block => block.contains(node)), offset,
    text: node?.textContent ?? null });
  return { active: document.activeElement === editor, collapsed: selection?.isCollapsed ?? false,
    selected: selection?.toString() ?? '', anchor: point(selection?.anchorNode, selection?.anchorOffset),
    focus: point(selection?.focusNode, selection?.focusOffset), blocks: blocks.length,
    lastText: clean(lastCopy?.textContent),
    atEnd: Boolean(selection?.isCollapsed && last?.contains(selection.focusNode)
      && (clean(lastCopy?.textContent) === ''
        || selection.focusNode === lastText && selection.focusOffset === lastText.textContent.length
        || selection.focusNode?.nodeType === Node.ELEMENT_NODE && selection.focusNode.contains(lastText)
          && selection.focusOffset === selection.focusNode.childNodes.length)),
  };
}

async function stableSelection(editor, predicate, evidence, action) {
  let previous; let since = 0; let samples = 0;
  await expect.poll(async () => {
    const snapshot = await editor.evaluate(nativeSelection);
    const signature = JSON.stringify(snapshot); const now = performance.now();
    if (!predicate(snapshot) || signature !== previous) { since = now; samples = predicate(snapshot) ? 1 : 0; }
    else samples++;
    previous = predicate(snapshot) ? signature : undefined;
    evidence.push({ action, at: new Date().toISOString(), snapshot, samples, stableMs: Math.floor(now - since) });
    return samples >= 3 && now - since >= 250;
  }, { timeout: 10000, intervals: [100, 150, 250], message: action }).toBe(true);
}

async function focusEnd(page, editor, evidence) {
  if (await editor.evaluate(node => document.activeElement === node)) await page.keyboard.press('ArrowRight');
  const last = editor.locator('[data-slate-node="element"]').last();
  await last.scrollIntoViewIfNeeded();
  const position = await last.evaluate(node => {
    const rect = node.getBoundingClientRect();
    for (const y of [0.5, 0.25, 0.75]) for (const x of [0.03, 0.97, 0.12, 0.88, 0.5]) {
      const px = rect.left + rect.width * x; const py = rect.top + rect.height * y;
      const hit = document.elementFromPoint(px, py);
      if (hit && node.contains(hit) && !hit.closest('[contenteditable="false"],button,input,textarea')) {
        return { x: px - rect.left, y: py - rect.top };
      }
    }
    return null;
  });
  assert.ok(position, 'No unobstructed native editing position');
  await last.click({ position });
  await stableSelection(editor, state => state.active && state.collapsed && state.focus.block === state.blocks - 1,
    evidence, 'clicked-last-block-stable');
  await page.keyboard.press('ControlOrMeta+End');
  await stableSelection(editor, state => state.active && state.collapsed && state.atEnd,
    evidence, 'single-ctrl-end-stable');
}

async function appendParagraph(page, editor, text, evidence) {
  await focusEnd(page, editor, evidence);
  const before = await editor.evaluate(nativeSelection);
  if (before.lastText) {
    await page.keyboard.press('Enter');
    await stableSelection(editor, state => state.active && state.collapsed && state.blocks > before.blocks && !state.lastText,
      evidence, 'new-paragraph-stable');
  }
  await page.keyboard.insertText(text);
  await expect(editor).toContainText(text);
  await stableSelection(editor, state => state.active && state.collapsed && state.atEnd && state.lastText === text,
    evidence, 'inserted-paragraph-stable');
}

async function until(read, message, timeout = 30000) {
  const end = performance.now() + timeout; let last;
  do {
    try { const result = await read(); if (result) return result; } catch (error) { last = error; }
    await delay(200);
  } while (performance.now() < end);
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}

/** Validate real provider evidence independently of a successful HTTP status. */
export function assertDocumentModelEvidence({ task, body, events, participationId, studentId, expectedIntent }) {
  assert.equal(task.taskType, 'DOCUMENT_COLLABORATION'); assert.equal(task.status, 'COMPLETED');
  assert.equal(task.createdById, studentId);
  assert.equal(task.input.participationId, participationId); assert.equal(task.input.requestId, body.requestId);
  assert.equal(task.input.intent, expectedIntent); assert.equal(task.input.workspaceKind, 'document');
  assert.equal(task.input.documentVersion, sha(JSON.stringify(body.documentHtml)));
  assert.ok(task.startedAt && task.completedAt && task.completedAt - task.startedAt >= 0
    && task.completedAt - task.startedAt <= 110000, 'Document model server deadline exceeded');
  const raw = events.filter(event => object(object(event.payload).detail).kind === 'model-output');
  assert.ok(raw.length, 'Missing original model output for the actual UI request');
  for (const event of raw) {
    const detail = object(object(event.payload).detail);
    assert.equal(event.participationId, participationId); assert.equal(event.userId, studentId);
    assert.equal(event.requestId, body.requestId); assert.ok(event.content?.trim());
    assert.equal(detail.rawSha256, sha(event.content));
    assert.equal(detail.rawLength, event.content.length);
    assert.ok(Number.isInteger(detail.modelAttempt) && detail.modelAttempt > 0);
    assert.equal(detail.documentVersion, task.input.documentVersion);
  }
  if (['proactive-document-comments', 'comment-reply'].includes(expectedIntent)) {
    assert.ok(raw.some(event => object(object(event.payload).detail).validation === 'valid'), 'No validated real structured model output');
  } else {
    // Ordinary local edits record only a successfully repaired/parsed output
    // with effectiveIntent. Invalid attempts have a different event kind.
    assert.ok(raw.some(event => object(object(event.payload).detail).effectiveIntent === expectedIntent),
      'No successful real model output for the requested edit intent');
  }
  return raw;
}

const DOCUMENT_AI_BROWSER_COMPLETION_MS = 120000;
const documentPost = entry => entry.pathname === '/api/ai-collaboration/document'
  && entry.method === 'POST' && typeof entry.observerId === 'string'
  && typeof entry.body?.requestId === 'string' && entry.body.requestId.length > 0;
const sameDocumentScope = (query, body) => query?.courseId === body.courseId
  && query?.studentId === body.studentId && query?.stageKey === body.stageKey
  && query?.workspaceKind === (body.workspaceKind ?? 'document') && query?.requestId === body.requestId;

/** A logical result view; raw POST/GET entries remain untouched in the report. */
export function findDocumentAiCompletion(entries, matches) {
  const sent = entries.find(entry => documentPost(entry) && matches(entry.body));
  if (!sent) return undefined;
  const posts = entries.filter(entry => documentPost(entry) && entry.observerId === sent.observerId
    && sameDocumentScope({ ...entry.body, workspaceKind: entry.body.workspaceKind ?? 'document' }, sent.body));
  const first = posts.reduce((earliest, entry) => entry.started < earliest.started ? entry : earliest, sent);
  for (const entry of posts) assert.deepEqual(entry.body, first.body, 'A retried document request changed its immutable body');
  const completions = entries.filter(entry => entry.observerId === first.observerId
    && entry.pathname === first.pathname && entry.started >= first.started
    && entry.status === 200 && entry.response?.status === 'completed'
    && !entry.networkError && !entry.bodyError
    && entry.response.requestId === first.body.requestId && Number.isFinite(entry.completedAt)
    && (posts.includes(entry) || entry.method === 'GET' && sameDocumentScope(entry.query, first.body)))
    .sort((left, right) => left.completedAt - right.completedAt);
  const completed = completions[0];
  if (!completed) return undefined;
  const completedElapsedMs = completed.completedAt - first.started;
  assert.ok(completedElapsedMs >= 0 && completedElapsedMs <= DOCUMENT_AI_BROWSER_COMPLETION_MS,
    'Document AI browser deadline exceeded');
  return { ...first, status: completed.status, response: completed.response, completedElapsedMs,
    acceptedStatus: first.status, completionTransport: { method: completed.method, at: completed.at,
      status: completed.status, started: completed.started, completedAt: completed.completedAt,
      elapsedMs: completed.elapsedMs, query: completed.query } };
}

/** Wait only on observed browser traffic; never send an API request or infer an ACK from the database. */
export async function waitForDocumentAiCompletion({ entries, matches, now = () => performance.now(), wait = delay }) {
  const entered = now();
  for (;;) {
    const completed = findDocumentAiCompletion(entries, matches);
    if (completed) return completed;
    const sent = entries.find(entry => documentPost(entry) && matches(entry.body));
    const remaining = Math.min(entered + DOCUMENT_AI_BROWSER_COMPLETION_MS,
      (sent?.started ?? entered) + DOCUMENT_AI_BROWSER_COMPLETION_MS) - now();
    if (remaining <= 0) throw new Error('The actual browser request has no completed response');
    await wait(Math.min(200, remaining));
  }
}

/** GET adds only the authenticated receipt projection; preserve exact comparison of every result field. */
export function assertDocumentBrowserReceipt(task, entry) {
  const receipt = object(task.output).response;
  const expected = entry.completionTransport?.method === 'GET'
    ? { ...receipt, requestId: task.input.requestId, status: 'completed',
      conversationId: task.input.conversationId, documentVersion: task.input.documentVersion }
    : receipt;
  assert.deepEqual(entry.response, expected);
}

export function observeDocumentAiTraffic(page, instanceId, studentId, { now = () => performance.now() } = {}) {
  const entries = []; const byRequest = new WeakMap(); const pending = new Set();
  // Each page observer owns its identity, even for two tabs logged in as the same student.
  const observerId = randomUUID(); const origin = new URL(page.url()).origin;
  const onRequest = req => {
    const url = new URL(req.url()); const pathname = url.pathname; const method = req.method();
    if (url.origin !== origin) return;
    if (pathname !== '/api/ai-collaboration/document' && pathname !== `/api/courses/${instanceId}/actions`) return;
    let body = {}; let query;
    if (method === 'POST') {
      try { body = req.postDataJSON(); } catch { return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      if (pathname === '/api/ai-collaboration/document' && (body.studentId !== studentId || body.courseId !== instanceId)) return;
    } else if (method === 'GET' && pathname === '/api/ai-collaboration/document') {
      query = Object.fromEntries(['courseId', 'studentId', 'stageKey', 'workspaceKind', 'requestId']
        .map(key => [key, url.searchParams.get(key)]));
      if (!query.requestId || query.courseId !== instanceId || query.studentId !== studentId) return;
    } else return;
    const entry = { pathname, method, observerId, body, ...(query ? { query } : {}),
      at: new Date().toISOString(), started: now() };
    byRequest.set(req, entry); entries.push(entry);
  };
  const onResponse = response => {
    const entry = byRequest.get(response.request()); if (!entry) return;
    entry.status = response.status(); entry.elapsedMs = now() - entry.started;
    entry.retryAfter = response.headers()['retry-after'];
    const work = response.json().then(body => {
      entry.response = body; entry.completedAt = now(); entry.completedElapsedMs = entry.completedAt - entry.started;
    }).catch(error => { entry.bodyError = error.message; }).finally(() => pending.delete(work));
    pending.add(work);
  };
  const onFailed = req => { const entry = byRequest.get(req); if (entry) entry.networkError = req.failure()?.errorText; };
  page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
  return { entries, async close() {
    page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailed);
    await Promise.allSettled([...pending]);
  } };
}

/** Two-brand functional proof is separate from the unchanged 30-student load.
 * Every model request begins in the live UI. Read-only API/DB calls reconcile
 * its receipts; they never create comments, suggestions or student decisions.
 */
export async function runDocumentAiAcceptance({ students, instance, origin, db, request, record, output }) {
  const directory = path.join(output, 'document-ai'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { rosterContexts: students.length, representatives: [], fullClassConcurrency: false,
    normalRealtimeAndTimers: true, businessApiMocks: false, editorInternalMethods: false };
  const write = (name, data) => writeFile(path.join(directory, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  for (const brand of ['google-chrome', 'microsoft-edge']) {
    const student = students.find(candidate => candidate.label === brand);
    assert.ok(student, `Missing actual ${brand} representative`);
    const peer = students.find(candidate => candidate.label !== brand);
    assert.ok(peer, 'A peer from the other browser process must remain active');
    const page = student.page; const editor = page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
    assert.equal(new URL(page.url()).origin, origin, 'Document UI must use the isolated classroom origin');
    const row = { index: student.index, studentId: student.user.id, participationId: student.participation.id,
      brand, selection: [], features: {}, peerSaves: [], model: [] };
    report.representatives.push(row); const observed = observeDocumentAiTraffic(page, instance.id, student.user.id);
    const step = async (feature, work) => {
      try { const value = await work(); row.features[feature] = { status: '通过', detail: value }; return value; }
      catch (error) {
        row.features[feature] = { status: error instanceof UnverifiedCoverage ? '未验证' : '失败', error: String(error.stack ?? error) };
        await page.screenshot({ path: path.join(directory, `student-${student.index}-${feature}-failure.png`) }).catch(() => undefined);
        return null;
      }
    };
    const submission = () => db.classroomSubmission.findUniqueOrThrow({ where: { id: student.saved.id } });
    const serverText = async saved => page.evaluate(inspectText, view(saved).content);
    const savedText = async () => { const saved = await submission(); return { saved, text: await serverText(saved) }; };
    const saveText = async expected => {
      await page.getByRole('button', { name: '保存', exact: true }).click();
      return until(async () => { const result = await savedText(); return result.text === expected && result; }, 'Visible document was not saved exactly');
    };
    const history = () => request(student.context, 'GET', `/api/ai-collaboration/document?${new URLSearchParams({
      courseId: instance.id, studentId: student.user.id, stageKey: 'make', workspaceKind: 'document',
    })}`);
    const processProof = title => until(async () => {
      const saved = await db.aiSupportRecord.findMany({ where: { participationId: student.participation.id,
        createdById: student.user.id, type: 'COMPANION_PROCESS', structuredPayload: { path: ['title'], equals: title } } });
      if (!saved.length) return false;
      assert.equal(saved.length, 1, 'A student AI action duplicated its process record');
      assert.equal(object(saved[0].structuredPayload).stageKey, 'make');
      assert.equal(object(saved[0].structuredPayload).source, 'student');
      return saved[0];
    }, `The actual student process record is absent: ${title}`);
    const restore = async expected => {
      const before = await savedText(); assert.equal(before.text, expected);
      await confirmSubmissionSave({ page, db, courseId: instance.id, studentId: student.user.id,
        participationId: student.participation.id, submission: before.saved,
        observations: () => observed.entries.filter(entry => entry.pathname.endsWith('/actions'))
          .map(entry => ({ request: entry.body, ack: entry.response, status: entry.status })) });
      await removeAcknowledgedDocumentDrafts(page, { courseId: instance.id, studentId: student.user.id, submission: before.saved });
      await page.reload({ waitUntil: 'domcontentloaded' }); await editor.waitFor({ state: 'visible', timeout: 60000 });
      await expect.poll(() => editor.evaluate(inspectText)).toBe(expected);
      const actual = await savedText(); assert.equal(actual.text, expected); student.saved = actual.saved;
    };
    const resultOf = matches => waitForDocumentAiCompletion({ entries: observed.entries, matches });
    const modelProof = async entry => {
      assert.ok(entry.body.requestId); assert.ok(entry.completedElapsedMs <= 120000, 'Document AI browser deadline exceeded');
      const task = await db.aiTask.findFirstOrThrow({ where: { createdById: student.user.id, taskType: 'DOCUMENT_COLLABORATION',
        input: { path: ['requestId'], equals: entry.body.requestId }, conversation: { participationId: student.participation.id } } });
      const events = await until(async () => {
        const events = await db.aiInteractionEvent.findMany({ where: { participationId: student.participation.id, requestId: entry.body.requestId } });
        return events.some(event => object(object(event.payload).detail).kind === 'model-output') && events;
      }, 'Original model evidence has not been retained');
      const raw = assertDocumentModelEvidence({ task, body: entry.body, events, participationId: student.participation.id,
        studentId: student.user.id, expectedIntent: entry.body.action === 'reply-document-comment' ? 'comment-reply' : entry.body.action ?? entry.body.intent });
      assertDocumentBrowserReceipt(task, entry);
      row.model.push({ task, events, rawOutputIds: raw.map(event => event.id), browserRequest: entry.body, browserCompletion: entry.completionTransport,
        browserCompletedElapsedMs: entry.completedElapsedMs });
      return task;
    };
    let prepared; let review;
    try {
      await page.bringToFront(); await editor.waitFor({ state: 'visible', timeout: 30000 });
      await expect(page.getByRole('button', { name: '查看待确认的 AI 修改', exact: true })).toHaveCount(0);
      const initial = await savedText(); row.initialText = initial.text;
      row.priorReviewRecovery = {};
      await step(REVIEW_RECOVERY_FEATURE, () => waitForNaturalDocumentReviewRecovery({ page, db, student,
        instanceId: instance.id, entries: observed.entries, evidence: row.priorReviewRecovery }));
      // Begin the new paragraph's natural first settle period in a fresh
      // component, retaining real drafts/pending requests and server history.
      // A retry counter from the earlier full-class batch is not this stimulus.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await editor.waitFor({ state: 'visible', timeout: 60000 });
      await expect.poll(() => editor.evaluate(inspectText)).toBe(initial.text);
      const paragraphs = documentAiParagraphs(student.index); row.paragraphs = paragraphs;
      await appendParagraph(page, editor, paragraphs.review, row.selection);
      await appendParagraph(page, editor, paragraphs.auxiliary, row.selection);
      const text = await editor.evaluate(inspectText); assert.ok(text.includes(initial.text));
      prepared = await saveText(text); row.preparedVersion = view(prepared.saved).version;
      review = await step(DOCUMENT_AI_FEATURES[0], async () => {
        // A different student's real saves keep normal class updates active.
        // Do not disable polling, change settle timers or invoke review APIs.
        let stop = false; const peerFailure = [];
        const peerWork = (async () => {
          const peerEditor = peer.page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
          while (!stop) {
            await peer.page.bringToFront(); await focusEnd(peer.page, peerEditor, []);
            const marker = `同行核对${student.index}-${row.peerSaves.length}。`;
            await peer.page.keyboard.insertText(marker);
            await peer.page.getByRole('button', { name: '保存', exact: true }).click();
            peer.saved = await until(async () => {
              const saved = await db.classroomSubmission.findUniqueOrThrow({ where: { id: peer.saved.id } });
              return view(saved).content.includes(marker) && saved;
            }, 'The peer document save was not acknowledged');
            row.peerSaves.push({ index: peer.index, at: new Date().toISOString(), marker, version: view(peer.saved).version });
            const wakeAt = performance.now() + 5000;
            while (!stop && performance.now() < wakeAt) await delay(100);
          }
        })().catch(error => peerFailure.push(error));
        let entry;
        try {
          const sent = await until(() => observed.entries.find(entry => entry.body.action === 'proactive-document-comments'
            && entry.body.paragraphs?.some(candidate => candidate.targetText === paragraphs.review)),
          'A stable saved paragraph never triggered its natural automatic review', 60000);
          entry = await resultOf(body => body.requestId === sent.body.requestId);
        } finally { stop = true; await peerWork; }
        assert.deepEqual(peerFailure, []); assert.ok(row.peerSaves.length >= 3, 'Automatic review was not exercised during peer activity');
        await modelProof(entry);
        assert.equal(entry.response.complete, true); assert.ok(Array.isArray(entry.response.commentThreads));
        assert.equal(await editor.evaluate(inspectText), text, 'Automatic review changed the student document');
        const messages = await db.aiMessage.findMany({ where: { conversationId: row.model.at(-1).task.conversationId } });
        const checkpoints = messages.filter(message => message.content.startsWith('OPENPBL_DOCUMENT_COMMENT_REVIEW:'))
          .map(message => JSON.parse(message.content.slice('OPENPBL_DOCUMENT_COMMENT_REVIEW:'.length)));
        const target = entry.body.paragraphs.find(candidate => candidate.targetText === paragraphs.review);
        assert.ok(checkpoints.some(item => item.blockId === target.blockId && item.blockIndex === target.blockIndex), 'Missing durable paragraph checkpoint');
        const comments = entry.response.commentThreads.filter(thread => thread.blockText === paragraphs.review);
        return { requestId: entry.body.requestId, comments, noComment: comments.length === 0,
          reviewDecision: entry.response.reviewDecision, checkpoints, peerSaves: row.peerSaves.length };
      });
      await step(DOCUMENT_AI_FEATURES[1], async () => {
        if (!review?.comments.length) throw new UnverifiedCoverage('No actionable automatic comment: the actual no-comment/missing-review branch cannot prove comment UI actions');
        const thread = review.comments[0]; row.commentThread = thread;
        const block = editor.locator('[data-slate-node="element"]').filter({ hasText: paragraphs.review }).first();
        const marker = block.locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," justify-between ")][1]')
          .getByRole('button', { name: /^查看(?:未读|该段)批注/ });
        const commentCard = dialog => dialog.getByText(thread.comments[0].content, { exact: true })
          .locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," p-4 ")][1]');
        await marker.click();
        let dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '发送批注回复', exact: true }) }).filter({ visible: true });
        await expect(commentCard(dialog)).toBeVisible();
        await until(async () => (await history()).commentThreads?.find(item => item.id === thread.id && item.readAt), 'Opening did not retain the read acknowledgement');
        const statusReply = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/ai-collaboration/document'
          && response.request().postDataJSON()?.action === 'set-document-comment-status'
          && response.request().postDataJSON()?.commentThreadId === thread.id);
        await commentCard(dialog).getByRole('button', { name: '暂不处理', exact: true }).click();
        assert.equal((await statusReply).status(), 200);
        await until(async () => (await history()).commentThreads?.find(item => item.id === thread.id && item.status === 'deferred'),
          'Deferring the comment did not retain its actual status');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '批注历史' }) });
        await details.locator('summary').click();
        const historical = details.locator('div.rounded-lg').filter({ hasText: thread.comments[0].content }).first();
        await expect(historical).toContainText('暂不处理');
        await historical.getByRole('button', { name: '重新打开', exact: true }).click();
        await until(async () => (await history()).commentThreads?.find(item => item.id === thread.id && item.status === 'open'), 'Reopened comment was not saved');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await marker.click();
        dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '发送批注回复', exact: true }) }).filter({ visible: true });
        const message = `我会亲自核对原始日志。请只说明这条批注需要核验哪两处已有数字，不修改正文。核验学生${student.index}。`;
        await commentCard(dialog).locator('[data-slate-editor="true"][contenteditable="true"]').fill(message);
        await commentCard(dialog).getByRole('button', { name: '发送批注回复', exact: true }).click();
        const reply = await resultOf(body => body.action === 'reply-document-comment' && body.message === message);
        await modelProof(reply);
        assert.ok(reply.response.result?.message); assert.equal(reply.response.result.suggestion, undefined,
          'A request explicitly prohibiting edits must not create a pending write');
        await expect(commentCard(dialog).getByText(reply.response.result.message, { exact: true })).toBeVisible();
        const savedHistory = await history();
        const stored = savedHistory.commentThreads.find(item => item.id === thread.id);
        assert.deepEqual(stored.comments, reply.response.commentThread.comments);
        await restore(text);
        await expect(marker).toBeVisible();
        await marker.click();
        dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '发送批注回复', exact: true }) }).filter({ visible: true });
        await expect(commentCard(dialog).getByText(message, { exact: true })).toBeVisible();
        await expect(commentCard(dialog).getByText(reply.response.result.message, { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '保存', exact: true }).click();
        return { threadId: thread.id, read: true, deferredAndReopened: true, replyRequestId: reply.body.requestId,
          originalDocumentUnchanged: true, serverHistoryRestored: true };
      });
      await step(DOCUMENT_AI_FEATURES[2], async () => {
        // This independent auxiliary edit is mandatory even if the model's
        // proactive review reasonably returned no comments or edit proposals.
        await restore(text); await page.bringToFront();
        await focusEnd(page, editor, row.selection);
        await page.getByRole('button', { name: 'AI 组员', exact: true }).click();
        const panel = page.getByRole('region', { name: 'AI 组员工作区', exact: true });
        const decisions = [];
        for (const action of ['adopted', 'rejected']) {
          await focusEnd(page, editor, row.selection);
          // Real keyboard selection from the verified end is independent of
          // line wrapping after the AI panel reduces the editor width.
          for (let index = 0; index < [...paragraphs.auxiliary].length; index++) await page.keyboard.press('Shift+ArrowLeft');
          await stableSelection(editor, state => state.active && !state.collapsed && state.selected === paragraphs.auxiliary,
            row.selection, `${action}-exact-auxiliary-selection`);
          const message = `仅做辅助措辞修改：将我选中这句中的“周一”替换为“星期一”，其余原文、数字和判断逐字保留。请提供可接受或拒绝的局部修改建议。学生${student.index}第${decisions.length + 1}次独立审阅。`;
          await panel.locator('textarea').fill(message);
          await panel.getByRole('button', { name: '发送给 AI 组员', exact: true }).click();
          const entry = await resultOf(body => !body.action && body.message === message);
          assert.equal(entry.body.intent, 'edit'); assert.equal(entry.body.selectedText, paragraphs.auxiliary);
          await modelProof(entry);
          const suggestion = entry.response.result?.suggestion;
          if (!suggestion) throw new UnverifiedCoverage(`Real auxiliary edit returned ${entry.response.result?.kind ?? 'no result'}; accept/reject was not exercised`);
          assert.equal(suggestion.targetText, paragraphs.auxiliary);
          assert.equal(suggestion.replacement, paragraphs.auxiliary.replace('周一', '星期一'));
          const pending = panel.getByRole('region', { name: '待确认的 AI 修改', exact: true });
          await expect(pending).toBeVisible(); await expect(pending.getByRole('alert')).toHaveCount(0);
          const beforeDecision = await savedText(); assert.equal(beforeDecision.text, text, 'An unaccepted AI proposal reached the server document');
          assert.equal(view(beforeDecision.saved).content, view(prepared.saved).content, 'An unaccepted proposal changed the saved document structure');
          await pending.getByRole('button', { name: action === 'adopted' ? '接受并写入' : '保留原文', exact: true }).click();
          const contributionId = entry.body.contributionId;
          assert.ok(contributionId);
          const decision = await until(async () => {
            const rows = await db.aiSupportRecord.findMany({ where: { participationId: student.participation.id,
              structuredPayload: { path: ['collection'], equals: 'studentAiDecisions' } } });
            return rows.find(row => object(row.structuredPayload).view?.contributionId === contributionId
              && object(row.structuredPayload).view?.decision === action);
          }, 'Student decision did not reach its authoritative record');
          const approvals = await db.aiActionConfirmation.findMany({ where: { requestedById: student.user.id,
            payload: { path: ['detail', 'contributionId'], equals: contributionId } } });
          assert.equal(approvals.length, 1); const approval = approvals[0];
          assert.equal(approval.status, action === 'adopted' ? 'APPROVED' : 'REJECTED');
          const decisionView = object(decision.structuredPayload).view;
          const process = await processProof(`${action === 'adopted' ? '确认' : '拒绝'} AI 修改“${suggestion.title}”`);
          if (action === 'adopted') {
            assert.equal(text.split(suggestion.targetText).length, 2, 'A model target is ambiguous in the complete document');
            const expected = text.replace(suggestion.targetText, suggestion.replacement);
            const accepted = await until(async () => { const value = await savedText(); return value.text === expected && value; }, 'Accepted edit did not persist exactly');
            assert.ok(view(accepted.saved).version > view(beforeDecision.saved).version);
            row.accepted = { content: view(accepted.saved).content, decision, approval };
            // Deliberately wait for committed adoption before the actual Undo.
            // The persistent toolbar remains available beyond the short toast.
            const undo = page.getByRole('button', { name: `撤销 AI 修改“${suggestion.title}”`, exact: true }).filter({ visible: true });
            if (!await undo.count()) {
              await page.locator('.pbl-document-editor [role="toolbar"]').first()
                .locator('[data-toolbar-overflow-more] button').first().click();
            }
            await expect(undo).toBeVisible(); await expect(undo).toBeEnabled(); await undo.click();
            const undone = await until(async () => { const value = await savedText(); return value.text === text
              && view(value.saved).version > view(accepted.saved).version && value; }, 'Undo did not save a newer restored document');
            assert.equal(view(undone.saved).content, view(beforeDecision.saved).content, 'Undo did not retain the exact original rich document');
            const allDecisions = await until(async () => {
              const rows = await db.aiSupportRecord.findMany({ where: { participationId: student.participation.id,
                structuredPayload: { path: ['collection'], equals: 'studentAiDecisions' } } });
              const relevant = rows.filter(row => object(row.structuredPayload).view?.contributionId === contributionId);
              return relevant.some(row => row.id !== decision.id && object(row.structuredPayload).view?.decision === 'rejected') && relevant;
            }, 'Undo has no independent durable rejection decision');
            assert.deepEqual(await db.aiSupportRecord.findUniqueOrThrow({ where: { id: decision.id } }), decision);
            assert.deepEqual(await db.aiActionConfirmation.findUniqueOrThrow({ where: { id: approval.id } }), approval);
            const undoAudit = await until(async () => {
              const events = await db.aiInteractionEvent.findMany({ where: { participationId: student.participation.id, eventType: 'undo' } });
              return events.find(event => object(object(event.payload).detail).adoptedDecisionId === decisionView.id);
            }, 'Undo audit did not retain its link to the original adoption');
            assert.notEqual(object(object(undoAudit.payload).detail).decisionId, decisionView.id);
            const undoProcess = await processProof(`撤销 AI 内容“${suggestion.title}”`);
            row.undone = { saved: undone.saved, decisions: allDecisions, undoAudit, process: undoProcess };
          } else {
            const rejected = await savedText();
            assert.equal(rejected.text, text, 'Rejecting an AI proposal changed the original');
            assert.equal(view(rejected.saved).content, view(beforeDecision.saved).content, 'Rejecting an AI proposal changed saved rich document structure');
            await expect(pending).toHaveCount(0);
          }
          decisions.push({ action, requestId: entry.body.requestId, contributionId, decisionId: decisionView.id,
            approvalId: approval.id, processRecordId: process.id });
        }
        await panel.getByRole('button', { name: '收起 AI 组员', exact: true }).click();
        const actionReceipts = await until(() => {
          const actions = observed.entries.filter(entry => entry.pathname.endsWith('/actions'));
          return actions.every(entry => entry.response || entry.networkError || entry.bodyError) && actions;
        }, 'A student document AI action has no actual HTTP acknowledgement');
        const actionErrors = actionReceipts.filter(entry => entry.status !== 200 || entry.networkError || entry.bodyError);
        assert.deepEqual(actionErrors, [], 'An AI action failed even if the visible document later recovered');
        for (const entry of actionReceipts) {
          assert.equal(entry.response.requestId, entry.body.requestId);
          assert.ok(Number.isInteger(entry.response.courseVersion));
          assert.equal(typeof entry.response.eventCursor, 'string');
        }
        await restore(text);
        return { decisions, adoptedThenUndone: true, originalApprovalAndAdoptionPreserved: true,
          independentUndoDecision: true, rejectedUnchanged: true, serverReloadRestored: true };
      });
    } catch (error) {
      row.error = String(error.stack ?? error);
      for (const feature of [...DOCUMENT_AI_FEATURES, REVIEW_RECOVERY_FEATURE]) row.features[feature] ??= { status: '失败', error: row.error };
    } finally {
      await observed.close(); row.traffic = observed.entries;
      // Navigation discards only an unaccepted transient preview. Confirmed
      // document versions and failed action receipts remain available as evidence.
      if (prepared) await page.reload({ waitUntil: 'domcontentloaded' }).catch(error => { row.cleanupError = error.message; });
      await write(`student-${student.index}.json`, row);
    }
  }
  for (const feature of [...DOCUMENT_AI_FEATURES, REVIEW_RECOVERY_FEATURE]) {
    const results = report.representatives.map(row => ({ index: row.index, brand: row.brand, ...row.features[feature] }));
    const status = results.some(row => row.status === '失败') ? '失败' : results.every(row => row.status === '通过') ? '通过' : '未验证';
    record(feature, status, { representatives: results, rosterContexts: students.length,
      scope: 'One real Chrome and one real Edge functional scenario; the independent full-class AI load is unchanged' },
    feature === REVIEW_RECOVERY_FEATURE ? 'browser-real-backend' : 'browser-real-provider');
  }
  await write('document-ai.json', report); return report;
}
