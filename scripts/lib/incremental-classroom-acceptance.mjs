/** Focused supplement, hosted only by verify-prelaunch-functional's disposable lifecycle. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { SignJWT } from 'jose';
import JSZip from 'jszip';
import templateModule from '../../src/lib/platform/pbl-template.ts';
import { inspectBrowserIdentity } from './prelaunch-browser.mjs';
import { capacityBrowserEnvironment } from '../capacity-network.mjs';
import { incrementalClassroomOptions, assertIncrementalIsolation, evaluateIncrementalClassroom, summarizeIncrementalTraffic, assertShowcaseLoadOnlyOptions, evaluateShowcaseLoadOnly, isIncrementalRestartConsoleFailure } from './incremental-classroom-contract.mjs';
import { classifyClassroomRequest, measureClassroomRequestTiming } from './classroom-acceptance-traffic.mjs';
import { runClassroomSaveRecovery, appendSaveRecoveryText } from './classroom-acceptance-save-recovery.mjs';
import { runClassroomSaveConcurrency } from './classroom-acceptance-save-concurrency.mjs';
import { observeSubmissionSaveReceipts } from './classroom-acceptance-save-confirmation.mjs';
import { captureWorkspaceIdentity, assertAcceptanceIdentityUnchanged } from './classroom-acceptance-contract.mjs';
import { assertIncrementalArchiveText } from './incremental-showcase-acceptance.mjs';

const { createPblTemplateCourse, encodePblTemplate } = templateModule;
const sha = value => createHash('sha256').update(value).digest('hex');
const view = row => row.payload?.view ?? row.payload;
async function settled(work) {
  const results = await Promise.allSettled(work);
  const failed = results.filter(row => row.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(row => row.reason), `${failed.length} operations failed: ${failed[0].reason.message}`);
  return results.map(row => row.value);
}
async function until(read, message, timeout = 45000) {
  const end = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await delay(250); } while (Date.now() < end);
  throw new Error(message);
}

export async function runIncrementalClassroomAcceptance({ root, origin, env, output, db, browser, teacher: teacherContext,
  buildId, record, applicationProcessTreeMemory, restart, snapshot }) {
  const options = incrementalClassroomOptions();
  const showcaseLoadOnly = process.env.INCREMENTAL_SHOWCASE_LOAD_ONLY === '1';
  if (showcaseLoadOnly) assertShowcaseLoadOnlyOptions(options, { ...process.env, ...env });
  const marker = (await db.$queryRaw`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${env.OPENPBL_VERIFICATION_MARKER}`)[0]?.marker;
  assertIncrementalIsolation({ origin, environment: env, marker });
  await mkdir(output, { recursive: true });
  const identity = await captureWorkspaceIdentity(root);
  await writeFile(path.join(output, 'source-identity.json'), JSON.stringify(identity, null, 2));
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), buildId, commit: identity.commit,
    sourceSha256: identity.source.sha256, options, students: options.students, teachers: 2,
    brands: { 'google-chrome': 0, 'microsoft-edge': 0 }, browserIdentities: {}, checks: [], phases: [], errors: [],
    aiRounds: [], projections: [], periodicLoad: [], saveReconciliation: [], injectedFailures: [], phase: 'setup', performance: {}, outcome: 'running', evidence: {
      browser: 'Actual branded browsers, shipped assets, real disposable APIs and WebSocket messages',
      periodicLoad: 'Authenticated BrowserContext API writes/reads at five-second deadlines; distinct from UI editing proof',
      ai: 'Actual configured providers with durable requests and final messages; no model substitute',
      limitations: ['Linux only', '35-minute supplement; not long-classroom or three-class acceptance'] } };
  const students = [], teachers = [], ownedBrowsers = [], contexts = [], traffic = [], pending = new Set(), projectionWaiters = new Map(), faultWindows = [];
  const loops = [];
  let timer, projectionTimer, sampleFlight, projectionFlight, stopped = false, restartInProgress = false, browserEditing = false, instance, offering, classroomId;
  const save = async () => writeFile(path.join(output, 'incremental-classroom.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const loadRow = (client, phase) => {
    let row = report.periodicLoad.find(row => row.client === client && row.phase === phase);
    if (!row) { row = { client, phase, scheduledTicks: 0, saveAttempts: 0, saveSuccesses: 0, readSuccesses: 0,
      protocolSaveSuccesses: 0, browserSaveSuccesses: 0, protocolReadSuccesses: 0, browserReadSuccesses: 0, missedDeadlines: 0, maxLatenessMs: 0 }; report.periodicLoad.push(row); }
    return row;
  };
  const observeLoad = ({ client, phase, method, pathname, body, status, source }) => {
    if (!client.startsWith('student-') || !options.phases.some(item => item.name === phase)) return;
    const row = loadRow(client, phase);
    if (method === 'POST' && pathname === `/api/courses/${instance.id}/actions`
      && body?.action?.type === 'UPSERT_SUBMISSION' && body.action.payload?.courseId === instance.id) {
      row.saveAttempts++;
      if (status === 200) { row.saveSuccesses++; row[`${source}SaveSuccesses`]++; }
    }
    if (method === 'GET' && pathname === `/api/courses/${instance.id}/state` && status === 200) { row.readSuccesses++; row[`${source}ReadSuccesses`]++; }
  };
  const injectedFailure = (client, start, end, status) => [0, 502, 503, 504].includes(status)
    && faultWindows.some(window => (!window.client || window.client === client) && start <= (window.end ?? Infinity) && end >= window.start);
  const check = async (name, operation) => {
    const result = { name, status: 'running', startedAt: new Date().toISOString() }; report.checks.push(result);
    try { result.detail = await operation(); result.status = 'passed'; record(`incremental-${name}`, '通过', result.detail ?? '', 'browser-real-backend'); return result.detail; }
    catch (error) { result.status = 'failed'; result.error = String(error.stack ?? error).slice(0, 4000); record(`incremental-${name}`, '失败', result.error, 'browser-real-backend'); }
    finally { result.finishedAt = new Date().toISOString(); await save(); }
  };
  const journal = row => {
    const finishedAtEpochMs = row.nativeFinishedAtEpochMs ?? performance.timeOrigin + performance.now();
    const measured = { ...row, finishedAtEpochMs,
      startedAtEpochMs: row.nativeStartedAtEpochMs ?? finishedAtEpochMs - (row.observerElapsedMs ?? row.elapsedMs) };
    traffic.push(measured);
    const promise = appendFile(path.join(output, 'incremental-traffic.ndjson'), `${JSON.stringify(measured)}\n`, { mode: 0o600 });
    pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => undefined);
  };
  const watch = (context, client) => {
    context.on('page', page => {
      page.on('pageerror', error => report.errors.push({ client, phase: report.phase, kind: 'pageerror', error: error.message }));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        const error = message.text().slice(0, 1000);
        const injected = (report.phase === 'functional-recovery' && /Failed to load resource.*(409|ERR_FAILED|ERR_ABORTED)/.test(error))
          || (context.incrementalOffline && /ERR_INTERNET_DISCONNECTED|Failed to fetch|Course synchronization failed/.test(error))
          || isIncrementalRestartConsoleFailure(error, restartInProgress);
        (injected ? report.injectedFailures : report.errors).push({ client, phase: report.phase, kind: 'console', error,
          ...(injected ? { reason: context.incrementalOffline ? 'selected-browser-offline' : restartInProgress ? 'isolated-app-restart' : 'native-save-injection' } : {}) });
      });
      page.on('websocket', socket => {
        socket.on('close', () => {
          if (context.incrementalSubscriptionSocket === socket) context.incrementalSubscribed = false;
        });
        socket.on('framereceived', ({ payload }) => {
        try {
          const data = JSON.parse(String(payload));
          if (data.type === 'subscribed') {
            context.incrementalSubscribed = true;
            context.incrementalSubscriptionSocket = socket;
          }
          const title = data.event?.payload?.teacherResourceProjection?.title;
          const waiter = projectionWaiters.get(title);
          if (waiter && !waiter.receivers.has(client)) waiter.receivers.set(client, performance.now() - waiter.started);
        } catch { /* Non-JSON frames are outside the application protocol. */ }
        });
      });
    });
    const starts = new WeakMap();
    context.on('request', request => starts.set(request, { at: performance.now(), phase: report.phase }));
    context.on('response', response => {
      const request = response.request(), url = new URL(response.url());
      if (!url.pathname.startsWith('/api/')) return;
      const start = starts.get(request) ?? { at: performance.now(), phase: report.phase };
      const task = response.finished().then(async error => {
        if (error) return;
        let body; try { body = request.postDataJSON(); } catch { /* GET/multipart */ }
        const classification = classifyClassroomRequest({ path: url.pathname, method: request.method(), body, query: url.searchParams });
        observeLoad({ client, phase: start.phase, method: request.method(), pathname: url.pathname, body, status: response.status(), source: 'browser' });
        journal({ client, phase: start.phase, path: url.pathname, method: request.method(), status: response.status(),
          ...classification, ...measureClassroomRequestTiming(request.timing(), start.at, performance.now()),
          injected: injectedFailure(client, start.at, performance.now(), response.status()) });
      });
      pending.add(task); void task.finally(() => pending.delete(task)).catch(() => undefined);
    });
    context.on('requestfailed', request => {
      if (!new URL(request.url()).pathname.startsWith('/api/')) return;
      const start = starts.get(request) ?? { at: performance.now(), phase: report.phase };
      journal({ client, phase: start.phase, path: new URL(request.url()).pathname, method: request.method(), status: 0,
        category: request.method() === 'GET' ? 'read' : 'write', operation: request.method(),
        networkFailure: request.failure()?.errorText, elapsedMs: performance.now() - start.at, timingSource: 'unavailable',
        injected: injectedFailure(client, start.at, performance.now(), 0) });
    });
  };
  const send = async (actor, method, endpoint, body, expected = 200, operation) => {
    const start = performance.now(), phase = report.phase;
    let status = 0, result;
    try {
      const response = await actor.context.request.fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin, 'X-OpenPBL-Role': actor.role },
        ...(body === undefined ? {} : { data: body }), timeout: 30000 });
      status = response.status(); result = await response.json().catch(() => ({}));
      assert.equal(status, expected, `${method} ${endpoint}: ${status} ${JSON.stringify(result).slice(0, 350)}`);
      return result;
    } catch (error) {
      error.incrementalInjected = injectedFailure(actor.client, start, performance.now(), status);
      throw error;
    } finally {
      const url = new URL(endpoint, origin);
      observeLoad({ client: actor.client, phase, method, pathname: url.pathname, body, status, source: 'protocol' });
      journal({ client: actor.client, phase, path: url.pathname, method, status,
        expectedStatus: expected, errorCode: result?.code ?? result?.error,
        ...classifyClassroomRequest({ path: url.pathname, method, body, query: url.searchParams }),
        ...(operation ? { operation } : {}), elapsedMs: performance.now() - start, timingSource: 'api-request-monotonic',
        injected: injectedFailure(actor.client, start, performance.now(), status) });
    }
  };
  const saved = student => db.classroomSubmission.findFirstOrThrow({ where: { participationId: student.participation.id, stageKey: 'make:document' } });
  const state = () => send(teachers[0], 'GET', `/api/courses/${instance.id}/state`);
  const action = (actor, value, requestId = randomUUID(), expected = 200) => send(actor, 'POST', `/api/courses/${instance.id}/actions`, { requestId, action: value }, expected);
  const saveDraft = async (student, suffix) => {
    const now = new Date().toISOString();
    const content = `<h1>观察记录${student.index}</h1><p>${'比较相同时长、地点与日期，保留原始计数作为证据。'.repeat(30)}</p>${student.aiEditMarker ? `<p>${student.aiEditMarker}</p>` : ''}${(student.nativeMarkers ?? []).map(marker => `<p>${marker}</p>`).join('')}<p>${suffix}</p>`;
    const body = student.pendingSave ?? { requestId: randomUUID(), action: { type: 'UPSERT_SUBMISSION', payload: { courseId: instance.id,
      expectedSubmissionVersion: student.version, submission: { ...student.submission, content, version: student.version + 1, updatedAt: now } } } };
    student.pendingSave = body;
    const ack = await send(student, 'POST', `/api/courses/${instance.id}/actions`, body);
    assert.equal(ack.submissionVersion, student.version + 1); assert.equal(ack.requestId, body.requestId);
    student.version = ack.submissionVersion; student.submission = { ...body.action.payload.submission, version: student.version };
    student.lastSave = { body, ack, sha256: sha(body.action.payload.submission.content), acknowledgedAt: new Date().toISOString() }; student.pendingSave = undefined;
  };
  const sample = async () => {
    const response = await fetch(`${origin}/api/metrics`, { headers: { Authorization: `Bearer ${env.INTERNAL_MONITOR_TOKEN}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.text();
    const row = { at: new Date().toISOString(), phase: report.phase, driver: process.memoryUsage(),
      application: await applicationProcessTreeMemory?.(),
      metrics: body.split('\n').filter(line => /^(process_|nodejs_|classroom_ai_|db_|openpbl_|course_read_|document_review_)/.test(line)) };
    await appendFile(path.join(output, 'incremental-resources.ndjson'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    await save();
  };
  const editActualStudent = async (student, marker, offline = false, prepared = false) => {
    student.paused = true; await Promise.allSettled([student.inFlight]);
    if (student.pendingSave) await saveDraft(student, 'immutable-receipt-recovery-before-native-edit');
    const observer = observeSubmissionSaveReceipts(student.page, { origin, courseId: instance.id, studentId: student.user.id });
    try {
      if (!prepared) await student.page.goto(`${origin}/student/ai-collaboration/${instance.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const editor = student.page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
      await editor.waitFor({ timeout: 45000 });
      if (offline) {
        student.context.incrementalOffline = true;
        student.offlineWindow = { client: student.client, kind: 'offline', start: performance.now() };
        faultWindows.push(student.offlineWindow); await student.context.setOffline(true);
      }
      await appendSaveRecoveryText(student.page, editor, marker);
      await student.page.getByRole('button', { name: '保存', exact: true }).click();
      if (offline) {
        const pendingRequest = await until(() => student.page.evaluate(({ studentId, marker }) => {
          const prefix = `openpbl:submission-save:v1:${encodeURIComponent(studentId)}:`;
          return Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key)))
            .find(row => row.state === 'pending' && row.action?.payload?.submission?.content?.includes(marker));
        }, { studentId: student.user.id, marker }), 'Offline edit did not enter the durable browser outbox');
        assert.ok(pendingRequest.requestId);
        assert.ok(!observer.entries.some(row => row.status === 200 && row.request.requestId === pendingRequest.requestId),
          'An offline edit was acknowledged before reconnection');
        return { student, marker, observer, pendingRequest };
      }
      const result = await until(() => observer.entries.find(row => row.status === 200 && row.ack && row.request.action.payload.submission.content.includes(marker)), 'Actual edit did not receive a durable save ACK');
      student.version = result.ack.submissionVersion; student.submission = result.request.action.payload.submission;
      (student.nativeMarkers ??= []).push(marker);
      student.lastSave = { body: result.request, ack: result.ack, sha256: sha(student.submission.content), acknowledgedAt: new Date().toISOString() };
      return { studentId: student.user.id, marker, requestId: result.request.requestId, ack: result.ack,
        acknowledgedAt: student.lastSave.acknowledgedAt, sha256: student.lastSave.sha256 };
    } finally { if (!offline) { await observer.close(); student.paused = false; } }
  };
  const clearProjection = async () => {
    const { course } = await state();
    await action(teachers[0], { type: 'SET_UI_STATE', payload: { courseId: instance.id,
      projectionControl: { clientId: 'incremental-projection', takeover: true, baseStageVersion: course.stageVersion ?? 1, stageKey: course.stages[course.currentStageIndex].key },
      patch: { teacherResourceProjection: null, resourceProjection: null } } });
  };
  const project = async () => {
    const { course } = await state(), title = `incremental-${randomUUID()}`;
    const waiter = { started: performance.now(), receivers: new Map() }; projectionWaiters.set(title, waiter);
    try {
      await action(teachers[0], { type: 'SET_UI_STATE', payload: { courseId: instance.id,
        projectionControl: { clientId: 'incremental-projection', takeover: true, baseStageVersion: course.stageVersion ?? 1, stageKey: course.stages[course.currentStageIndex].key },
        patch: { teacherResourceProjection: { classroomId, sceneId: 'incremental-reference', sceneType: 'slide', stageKey: 'make', title, startedAt: new Date().toISOString() } } } });
      const httpMs = performance.now() - waiter.started;
      await until(() => waiter.receivers.size === options.students + 2, 'Projection did not reach every browser subscriber', 10000);
      const result = { phase: report.phase, httpMs, receivers: waiter.receivers.size, lastReceiverMs: Math.max(...waiter.receivers.values()) };
      report.projections.push(result); return result;
    } finally { projectionWaiters.delete(title); }
  };
  const round = async index => {
    const evidence = { index, startedAt: new Date().toISOString(), requested: options.aiStudents, completed: 0, requests: [] };
    report.aiRounds.push(evidence);
    await check(`ai-round-${index}`, async () => {
      const nativeStudents = [students[0], students[options.students / 2]];
      browserEditing = true;
      try {
        await clearProjection();
        for (const student of nativeStudents) student.paused = true;
        await settled(nativeStudents.map(async student => {
          await Promise.allSettled([student.inFlight]);
          if (student.pendingSave) await saveDraft(student, 'receipt-recovery-before-ai-edit');
          await student.page.goto(`${origin}/student/ai-collaboration/${instance.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await student.page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first().waitFor({ timeout: 45000 });
        }));
      } catch (error) {
        for (const student of nativeStudents) student.paused = false;
        browserEditing = false; throw error;
      }
      const jobs = settled(students.slice(0, options.aiStudents / 2).concat(students.slice(options.students / 2, options.students / 2 + options.aiStudents / 2)).map(async student => {
        const message = `第${index}轮学生${student.index}：请指出比较两个地点的观察记录还缺少什么核验信息，不修改正文。`;
        const body = { courseId: instance.id, studentId: student.user.id, stageKey: 'make', workspaceKind: 'document',
          requestId: randomUUID(), conversationId: 'legacy', intent: 'discuss', message, documentHtml: student.submission.content };
        const item = { studentId: student.user.id, requestId: body.requestId, body }; evidence.requests.push(item);
        const began = performance.now();
        student.aiEditMarker = `AI_IN_FLIGHT_EDIT_${index}_${student.index}_${randomUUID()}`;
        item.expectedEditMarker = student.aiEditMarker;
        item.attempts = [];
        const attempt = async () => {
          const start = performance.now();
          const response = await student.context.request.post(`${origin}/api/ai-collaboration/document`, { headers: { Origin: origin }, data: body, timeout: 125000 });
          const responseBody = await response.json();
          const proof = { status: response.status(), elapsedMs: performance.now() - start, response: responseBody };
          item.attempts.push(proof); return proof;
        };
        let currentAttempt = await attempt();
        item.firstStatus = currentAttempt.status; item.firstResponseMs = performance.now() - began;
        item.firstResponse = currentAttempt.response;
        if (currentAttempt.status >= 500 && currentAttempt.response.retryable === true) {
          const failedTask = await db.aiTask.findFirst({ where: { createdById: student.user.id, input: { path: ['requestId'], equals: body.requestId } },
            select: { id: true, status: true, error: true, startedAt: true, completedAt: true } });
          item.firstFailure = { ...currentAttempt, task: failedTask, recovery: 'one explicit retry with the immutable original request ID' };
          currentAttempt = await attempt();
        }
        assert.ok([200, 202].includes(currentAttempt.status), JSON.stringify(currentAttempt.response));
        let result = currentAttempt.response;
        const pollStarted = performance.now();
        while (result.status === 'processing' && performance.now() - pollStarted < options.aiCompletionBudgetMs) {
          await delay(1000); result = await send(student, 'GET', `/api/ai-collaboration/document?${new URLSearchParams({ courseId: instance.id, studentId: student.user.id, stageKey: 'make', requestId: body.requestId })}`);
        }
        item.completeMs = performance.now() - began; item.status = result.status;
        assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 250));
        item.finalMessages = result.messages;
        item.messagesSha256 = sha(JSON.stringify(result.messages));
        const tasks = await db.aiTask.findMany({ where: { createdById: student.user.id, input: { path: ['requestId'], equals: body.requestId } } });
        assert.equal(tasks.length, 1); const task = tasks[0];
        assert.equal(task.status, 'COMPLETED'); assert.ok(task.startedAt && task.completedAt);
        item.taskId = task.id; item.executionMs = task.completedAt - task.startedAt;
        item.taskCreatedAt = task.createdAt; item.taskCompletedAt = task.completedAt;
        const replay = await send(student, 'POST', '/api/ai-collaboration/document', body);
        assert.equal(replay.status, 'completed'); assert.equal(replay.requestId, body.requestId);
        assert.deepEqual(replay.messages, result.messages);
        assert.equal(await db.aiTask.count({ where: { createdById: student.user.id, input: { path: ['requestId'], equals: body.requestId } } }), 1,
          'Replaying a completed request created another model task');
        assert.ok(result.messages?.some(row => row.role === 'agent' && row.content), 'No durable model answer');
        await until(() => student.lastSave?.body.action.payload.submission.content.includes(item.expectedEditMarker), 'No distinct saved edit accompanied this AI request', 10000);
        item.concurrentSave = { requestId: student.lastSave.ack.requestId, version: student.lastSave.ack.submissionVersion,
          acknowledgedAt: student.lastSave.acknowledgedAt, sha256: student.lastSave.sha256 };
        item.concurrentSave.overlapsModelExecution = Date.parse(item.concurrentSave.acknowledgedAt) <= task.completedAt.getTime();
        const current = view(await saved(student));
        assert.ok(current.content.includes(item.expectedEditMarker), 'A model answer lost the distinct concurrent edit');
        assert.ok(current.version >= item.concurrentSave.version);
        item.recovered = Boolean(item.firstFailure);
        evidence.durablyCompleted = (evidence.durablyCompleted ?? 0) + 1;
        assert.ok(item.completeMs <= options.aiCompletionBudgetMs, 'AI completion including its original failure exceeded the existing 120s browser budget');
        assert.ok(item.executionMs <= options.aiExecutionBudgetMs);
        evidence.completed++;
      }));
      void jobs.catch(() => undefined);
      try {
        evidence.actualBrowserEdits = await settled(nativeStudents.map(student =>
          editActualStudent(student, `NATIVE_AI_EDIT_${index}_${randomUUID()}`, false, true)));
      } finally { browserEditing = false; await jobs; }
      for (const proof of evidence.actualBrowserEdits) {
        const original = evidence.requests.find(request => request.studentId === proof.studentId);
        assert.ok(Date.parse(proof.acknowledgedAt) <= Date.parse(original.taskCompletedAt), 'Native edit did not overlap this model request');
        const row = view(await saved(students.find(student => student.user.id === proof.studentId)));
        assert.ok(row.content.includes(proof.marker), 'Later AI result replaced the acknowledged native edit');
      }
      return { completed: evidence.completed, actualProviders: true, requestsReplayedWithoutNewTasks: true };
    });
    evidence.finishedAt = new Date().toISOString(); await save();
  };
  const archiveAll = () => check('word-archive-and-content', async () => {
      for (const student of students) {
        const body = { requestId: randomUUID(), courseId: instance.id, studentId: student.user.id, submissionId: student.submission.id, stageKey: 'make', expectedVersion: student.version };
        const archived = await send(student, 'POST', '/api/project-practice/submissions/finalize', body);
        student.archived = archived;
        const response = await student.context.request.get(`${origin}${archived.downloadUrl}`); assert.equal(response.status(), 200);
        const bytes = await response.body(); assert.equal(sha(bytes), archived.sha256);
        const zip = await JSZip.loadAsync(bytes); const xml = await zip.file('word/document.xml').async('string');
        assertIncrementalArchiveText(student.submission.content, xml);
        assert.deepEqual(await send(student, 'POST', '/api/project-practice/submissions/finalize', body), archived);
      }
      return { students: students.length, byteHashesMatched: true, originalReceiptsReplayed: true };
    });
  const showcase = () => check('recommendation-and-showcase-controls', async () => {
      const { runIncrementalShowcaseAcceptance } = await import('./incremental-showcase-acceptance.mjs');
      return runIncrementalShowcaseAcceptance({ teachers, students, instance, db, origin, output, send, state, action, record, options });
    });
  function startPeriodicLoops(withProjection = true) {
    for (const student of students) loops.push((async () => {
      let nextTick = performance.now();
      while (!stopped) {
        const tick = performance.now();
        const row = loadRow(student.client, report.phase);
        const lateness = Math.max(0, tick - nextTick); row.maxLatenessMs = Math.max(row.maxLatenessMs, lateness);
        if (lateness >= options.saveIntervalMs) {
          (row.lateTicks ??= []).push({ scheduledAt: nextTick, observedAt: tick, latenessMs: lateness });
          const skipped = Math.floor(lateness / options.saveIntervalMs); row.missedDeadlines += skipped; nextTick += skipped * options.saveIntervalMs;
        }
        row.scheduledTicks++;
        if (report.phase !== 'idle' && !student.context.incrementalOffline) {
          try {
            student.inFlight = (async () => {
              if (!student.paused) await saveDraft(student, `incremental-${report.phase}-${student.cycles++}`);
              await send(student, 'GET', `/api/courses/${instance.id}/state`);
            })();
            await student.inFlight;
          } catch (error) {
            const failure = { client: student.client, phase: report.phase, kind: 'periodic-load', error: error.message };
            (error.incrementalInjected ? report.injectedFailures : report.errors).push(failure);
          } finally { student.inFlight = undefined; }
        }
        nextTick += options.saveIntervalMs;
        await delay(Math.max(0, nextTick - performance.now()));
      }
    })());
    timer = setInterval(() => {
      if (!sampleFlight) {
        const began = performance.now();
        sampleFlight = sample().catch(error => (injectedFailure(null, began, performance.now(), 0) ? report.injectedFailures : report.errors)
          .push({ kind: 'resources', phase: report.phase, error: error.message })).finally(() => { sampleFlight = undefined; });
      }
    }, 15000);
    if (withProjection) projectionTimer = setInterval(() => {
      if (!projectionFlight && !browserEditing && ['warmup', 'steady'].includes(report.phase)) projectionFlight = project()
        .catch(error => report.errors.push({ kind: 'projection', phase: report.phase, error: error.message }))
        .finally(() => { projectionFlight = undefined; });
    }, 30000);
  }
  try {
    const design = createPblTemplateCourse(randomUUID(), { name: '修改后增量补测：观察证据与成果展示', subject: '科学', grade: '七年级', drivingQuestion: '如何依据可复查记录提出结论？' });
    classroomId = `incremental-${randomUUID()}`; design.aiLearningClassroomId = classroomId; design.pblConfig.makeArtifactMode = 'document';
    design.content.knowledgePoints = [{ id: 'observation', name: '公平比较与证据', description: '保持观察时长一致，记录地点日期和原始计数。' }];
    await writeFile(path.join(env.CLASSROOM_DATA_DIR, `${classroomId}.json`), JSON.stringify({ id: classroomId, revision: 1,
      stage: { id: classroomId, name: design.name, mode: 'playback', createdAt: Date.now(), updatedAt: Date.now() }, scenes: [{
        id: 'incremental-reference', type: 'slide', title: '公平比较与证据', order: 0, stageKey: 'make', audience: 'student', actions: [],
        content: { type: 'slide', canvas: { id: 'incremental-canvas', viewportSize: 1000, viewportRatio: .5625,
          background: { type: 'solid', color: '#ffffff' }, theme: { fontName: 'Noto Sans SC', fontColor: '#111111', themeColors: ['#2563eb'], backgroundColor: '#ffffff' },
          elements: [{ id: 'incremental-title', type: 'text', left: 60, top: 60, width: 880, height: 100, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#111111', content: '<p style="font-size:36px">公平比较：保留观察时长、地点与原始计数。</p>' }] } } }] }));
    const browserEnv = capacityBrowserEnvironment();
    for (const brand of ['google-chrome', 'microsoft-edge']) {
      const executablePath = brand === 'google-chrome' ? process.env.PRELAUNCH_CHROME_EXECUTABLE_PATH : process.env.PRELAUNCH_EDGE_EXECUTABLE_PATH;
      assert.ok(executablePath, `Missing ${brand} executable`);
      // Four processes keep the same ten-context grouping as the existing 40-student profile.
      for (let shard = 0; shard < (options.smoke ? 1 : 2); shard++) {
        const launched = await chromium.launch({ executablePath, env: browserEnv, args: ['--no-proxy-server', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] }); ownedBrowsers.push(launched);
        for (let i = 0; i < (options.smoke ? 2 : 10); i++) {
          const context = await launched.newContext({ viewport: { width: 1366, height: 768 } }); contexts.push(context);
          const index = students.length, user = await db.user.create({ data: { username: `${classroomId}-s${index}`, usernameKey: `${classroomId}-s${index}`, role: 'STUDENT', displayName: `补测学生${index}`, passwordHash: `unusable-${randomBytes(16).toString('hex')}` } });
          students.push({ role: 'student', context, index, user, label: brand, client: `student-${index}`, version: 0, cycles: 0 }); report.brands[brand]++;
        }
      }
    }
    for (let index = 0; index < 2; index++) {
      const context = index === 0 ? teacherContext : await browser.newContext({ viewport: { width: 1366, height: 768 } });
      if (index) contexts.push(context);
      const user = await db.user.create({ data: { username: `${classroomId}-t${index}`, usernameKey: `${classroomId}-t${index}`, role: 'TEACHER', displayName: `补测教师${index}`, passwordHash: `unusable-${randomBytes(16).toString('hex')}` } });
      teachers.push({ role: 'teacher', context, user, client: `teacher-${index}` });
    }
    const template = await db.classroomTemplate.create({ data: { id: design.id, ownerId: teachers[0].user.id, title: design.name, status: 'PUBLISHED', versions: { create: { version: 1, status: 'PUBLISHED', snapshot: encodePblTemplate(design) } } }, include: { versions: true } });
    offering = await db.courseOffering.create({ data: { name: design.name, status: 'OPEN', teachers: { create: teachers.map(actor => ({ userId: actor.user.id })) } } });
    const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: '增量补测', position: 0, isOpen: true } });
    const activity = await db.activity.create({ data: { chapterId: chapter.id, title: design.name, position: 0, type: 'CLASSROOM', isOpen: true } });
    instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: template.versions[0].id, status: 'TEACHING', startedAt: new Date(), runtimeConfig: { version: 1, currentStageIndex: 2, classConfig: { groupMode: 'solo', totalStudents: options.students, perGroup: 1, crossClass: false } } } });
    report.fixture = { classroomId, instanceId: instance.id, offeringId: offering.id };
    for (const actor of [...teachers, ...students]) {
      const token = await new SignJWT({ role: actor.role, sv: actor.user.sessionVersion, username: actor.user.username, displayName: actor.user.displayName, studentName: actor.user.displayName, userId: actor.user.id })
        .setSubject(actor.user.id).setProtectedHeader({ alg: 'HS256' }).setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('3h').sign(new TextEncoder().encode(env.JWT_SECRET));
      await actor.context.addCookies([{ name: `openpbl_${actor.role}`, value: token, url: origin }]);
      await actor.context.addInitScript(() => { if (location.protocol !== 'about:') localStorage.setItem('locale', 'zh-CN'); });
      watch(actor.context, actor.client); actor.page = await actor.context.newPage();
      if (actor.role === 'student') {
        const enrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: actor.user.id } });
        actor.participation = await db.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id, firstEnteredAt: new Date() } });
        const groupId = `grp-${actor.user.id}`;
        await db.projectGroup.create({ data: { id: `${offering.id}:${groupId}`, offeringId: offering.id, name: `补测个人组${actor.index}`,
          members: { create: { userId: actor.user.id, participationId: actor.participation.id } } } });
        const now = new Date().toISOString(); actor.submission = { id: randomUUID(), courseId: instance.id, studentId: actor.user.id, studentName: actor.user.displayName,
          groupId, stageKey: 'make', type: 'document', title: `观察报告${actor.index}`, status: 'draft', createdAt: now, updatedAt: now };
        if (!report.browserIdentities[actor.label]) report.browserIdentities[actor.label] = await inspectBrowserIdentity({ label: actor.label,
          executablePath: actor.label === 'google-chrome' ? process.env.PRELAUNCH_CHROME_EXECUTABLE_PATH : process.env.PRELAUNCH_EDGE_EXECUTABLE_PATH }, actor.context);
      }
    }
    await settled(students.map(student => saveDraft(student, 'incremental-initial')));
    for (let index = 0; index < students.length; index += 8) await settled(students.slice(index, index + 8).map(async student => {
      await student.page.goto(`${origin}/student/ai-collaboration/${instance.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await student.page.locator('[data-slate-editor="true"][contenteditable="true"]').first().waitFor({ timeout: 60000 });
    }));
    await settled(teachers.map(actor => actor.page.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded', timeout: 60000 })));
    await check('roster-and-live-subscriptions', async () => {
      await until(() => [...teachers, ...students].every(actor => actor.context.incrementalSubscribed), 'Not every browser subscribed', 60000);
      assert.equal((await state()).course.students.length, options.students);
      return { students: options.students, teachers: 2, browserCounts: report.brands };
    });
    if (showcaseLoadOnly) {
      report.scope = 'showcase-save-load-only'; report.fullClassroomAcceptance = false;
      report.evidence.limitations[1] = 'Focused showcase/save supplement only; no 35-minute or full-classroom claim';
      const beforeVersions = new Map(students.map(student => [student.client, student.version]));
      await check('load-resource-baseline', sample);
      report.phase = 'steady'; const began = performance.now(), startedAt = new Date().toISOString(); startPeriodicLoops(false);
      await check('recommendation-and-showcase-controls', async () => {
        const { runIncrementalMixedShowcase } = await import('./incremental-mixed-showcase.mjs');
        return runIncrementalMixedShowcase({ students, teachers, instance, db, origin, output, send, record, options });
      });
      const durationMs = performance.now() - began;
      stopped = true; clearInterval(timer);
      const during = await db.classroomSubmission.findMany({ where: { participationId: { in: students.map(student => student.participation.id) }, stageKey: 'make:document' } });
      const duringVersions = new Map(during.map(row => [row.participationId, view(row).version]));
      await Promise.all(loops); await sampleFlight;
      report.phases.push({ name: 'steady', startedAt, durationMs }); report.phase = 'reconciliation';
      await check('all-save-receipts-and-replay', async () => {
        const receipts = []; report.saveReconciliation = receipts;
        for (const student of students) {
          assert.equal(student.pendingSave, undefined); const row = await saved(student), current = view(row);
          assert.equal(row.participationId, student.participation.id); assert.equal(current.courseId, instance.id);
          assert.equal(current.studentId, student.user.id); assert.equal(current.id, student.submission.id);
          assert.equal(current.content, student.submission.content); assert.equal(current.version, student.version);
          const duringVersion = duringVersions.get(student.participation.id);
          assert.ok(duringVersion > beforeVersions.get(student.client), 'A main-course draft did not advance during showcase load');
          assert.ok(current.version >= duringVersion);
          const ack = await send(student, 'POST', `/api/courses/${instance.id}/actions`, student.lastSave.body);
          assert.deepEqual(ack, student.lastSave.ack); const replayedVersion = view(await saved(student)).version;
          assert.equal(replayedVersion, current.version, 'Replaying a confirmed request duplicated its draft version');
          const event = await db.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: `course-action:${student.user.id}:${ack.requestId}` } });
          assert.deepEqual(event.payload.ack, ack);
          receipts.push({ client: student.client, courseId: current.courseId, studentId: current.studentId,
            participationId: row.participationId, submissionId: current.id, beforeVersion: beforeVersions.get(student.client),
            version: current.version, duringVersion, replayedVersion, pendingSave: false, requestId: ack.requestId, sha256: sha(current.content) });
        }
        await writeFile(path.join(output, 'save-reconciliation.json'), JSON.stringify(receipts, null, 2));
        return { students: receipts.length, duplicateVersions: 0 };
      });
      await check('source-identity-unchanged', async () => {
        assertAcceptanceIdentityUnchanged(identity, await captureWorkspaceIdentity(root));
        return { commit: identity.commit, sourceSha256: identity.source.sha256, buildId };
      });
      report.phase = 'cleanup';
      await check('focused-context-cleanup', () => settled([...contexts, teacherContext].map(context => context.close())));
      await Promise.allSettled([...pending]);
      for (const phase of ['steady', 'reconciliation']) report.performance[phase] = summarizeIncrementalTraffic(traffic, phase);
      report.performanceByClient = Object.fromEntries([...students, ...teachers].map(actor => [actor.client,
        Object.fromEntries(['steady', 'reconciliation'].map(phase => [phase,
          summarizeIncrementalTraffic(traffic.filter(row => row.client === actor.client), phase)]))]));
      Object.assign(report, evaluateShowcaseLoadOnly(report, options)); report.outcome = report.status;
      record('incremental-profile', report.status === 'passed' ? '通过' : '失败', { status: report.status,
        scope: report.scope, failures: report.failures, fullClassroomAcceptance: false });
      return report;
    }
    if (process.env.INCREMENTAL_CALLERS_ONLY === '1') {
      assert.equal(options.smoke, true, 'Representative caller diagnostics require INCREMENTAL_SMOKE=1');
      assert.notEqual(process.env.INCREMENTAL_SHOWCASE_ONLY, '1', 'Choose one focused diagnostic');
      report.phase = 'representative-callers';
      await check('representative-code-ai', async () => {
        const { runIncrementalCodeAiAcceptance } = await import('./incremental-code-ai-acceptance.mjs');
        return runIncrementalCodeAiAcceptance({ students, teachers, instance, db, origin, env, output, send, record });
      });
      await check('representative-tutor-ai', async () => {
        const { runIncrementalTutorAcceptance } = await import('./incremental-tutor-acceptance.mjs');
        return runIncrementalTutorAcceptance({ students, teachers, instance, db, origin, env, output, send, record });
      });
      await settled([...contexts, teacherContext].map(context => context.close()));
      await check('final-backup-and-isolated-restore', () => snapshot({ label: 'final', restore: true }));
      report.status = report.checks.some(check => check.status !== 'passed') || report.errors.length ? 'failed' : 'partial';
      report.outcome = report.status; report.scope = 'representative-callers-only';
      record('incremental-profile', report.status === 'failed' ? '失败' : '未验证', { status: report.status, scope: report.scope, fullClassroomAcceptance: false });
      return report;
    }
    if (process.env.INCREMENTAL_SHOWCASE_ONLY === '1') {
      assert.equal(options.smoke, true, 'A showcase-only diagnostic must explicitly use INCREMENTAL_SMOKE=1');
      report.phase = 'showcase-diagnostic';
      await archiveAll(); await showcase();
      await settled([...contexts, teacherContext].map(context => context.close()));
      await check('final-backup-and-isolated-restore', () => snapshot({ label: 'final', restore: true }));
      report.status = report.checks.some(check => check.status !== 'passed') || report.errors.length ? 'failed' : 'partial';
      report.outcome = report.status; report.scope = 'showcase-only-diagnostic';
      record('incremental-profile', report.status === 'failed' ? '失败' : '未验证', { status: report.status, scope: report.scope, fullClassroomAcceptance: false });
      return report;
    }
    report.phase = 'functional-recovery';
    await check('native-save-conflict-and-shared-outbox', async () => {
      const result = await runClassroomSaveConcurrency({ students, instance, db, origin, record, output, watch });
      assert.ok(result.crossSession.length === 2 && result.sharedOutbox.length === 2);
      assert.ok([...result.crossSession, ...result.sharedOutbox].every(row => row.passed));
      for (const proof of result.crossSession) {
        const student = students.find(student => student.user.id === proof.studentId);
        for (const failure of [...report.errors]) {
          if (failure.client === `save-cross-session-${student.index}`
            && /SessionActionRequestError: 草稿已在其他窗口更新，请保留本地内容并检查最新版本/.test(failure.error)
            && proof.conflict?.status === 409 && proof.conflict.ack?.code === 'DRAFT_VERSION_CONFLICT') {
            report.errors.splice(report.errors.indexOf(failure), 1);
            report.injectedFailures.push({ ...failure, reason: 'verified-cross-session-version-conflict', requestId: proof.conflict.request.requestId });
          }
        }
      }
      return { crossSession: 2, sharedOutbox: 2 };
    });
    await check('lost-save-receipt', async () => {
      const result = await runClassroomSaveRecovery({ teacher: teachers[0], students, instance, db, origin, record, output });
      assert.equal(result.passed, true); return { brands: result.students.map(row => row.brand), originalReceiptsRetained: true };
    });
    // Native recovery scenarios change only the two representative drafts; resume each real saved revision.
    for (const student of students) { const row = await saved(student); student.version = view(row).version; student.submission = view(row); }
    report.phase = 'warmup';
    startPeriodicLoops();
    for (const phase of options.phases) {
      if (phase.name === 'recovery') { clearInterval(projectionTimer); await projectionFlight; }
      report.phase = phase.name; const start = Date.now(); const end = start + phase.durationMs;
      console.log(`Incremental ${phase.name}: ${phase.durationMs / 60000} minutes, ${options.students} real students`);
      if (phase.name === 'warmup') await check('initial-projection', project);
      if (phase.name === 'steady') {
        const first = round(1); await delay(1000);
        await until(() => !browserEditing, 'Native editor proof did not settle before projection');
        await check('projection-under-ai-load', project);
        await delay(Math.max(0, start + (options.smoke ? 1000 : 5 * 60000) - Date.now()));
        await check('online-export-and-backup', async () => {
          const sourceBefore = await db.aiMessage.findMany({ where: { conversation: {
            participationId: { in: students.map(student => student.participation.id) } } },
          select: { id: true, content: true, role: true } });
          const exported = await send(teachers[0], 'GET', `/api/platform/offerings/${offering.id}/research-export?type=ai_messages&includeContent=true&take=500`);
          assert.ok(Array.isArray(exported.rows));
          const pages = [exported], rows = [...exported.rows];
          while (pages.at(-1).nextCursor) {
            const page = await send(teachers[0], 'GET', `/api/platform/offerings/${offering.id}/research-export?${new URLSearchParams({
              type: 'ai_messages', includeContent: 'true', take: '500', cursor: pages.at(-1).nextCursor })}`);
            pages.push(page); rows.push(...page.rows);
          }
          assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'Export pagination duplicated a message');
          const exportedById = new Map(rows.map(row => [row.id, row]));
          for (const source of sourceBefore) {
            const row = exportedById.get(source.id);
            assert.ok(row, 'Export lost a message committed before its snapshot');
            assert.equal(row.content, source.content); assert.equal(row.role, source.role);
          }
          const actual = await db.aiMessage.findMany({ where: { id: { in: rows.map(row => row.id) } }, include: { conversation: true } });
          for (const row of rows) {
            const source = actual.find(message => message.id === row.id);
            assert.ok(source); assert.equal(row.content, source.content); assert.equal(row.role, source.role);
            assert.equal(row.classroomInstanceId, instance.id);
            assert.ok(students.some(student => student.participation.id === source.conversation.participationId
              && student.user.id === source.conversation.userId), 'Export mixed classroom ownership');
          }
          if (!options.smoke) assert.ok(sourceBefore.length > 0, 'The formal export cannot pass with an empty AI fixture');
          const query = new URLSearchParams({ type: 'ai_messages', includeContent: 'true', take: '500', ...exported.window });
          const repeated = await send(teachers[0], 'GET', `/api/platform/offerings/${offering.id}/research-export?${query}`);
          assert.deepEqual(repeated.rows, exported.rows, 'The same fixed-window export changed');
          const reconciliation = { pages: pages.length, rows: rows.length, preexistingMessagesMatched: sourceBefore.length,
            sourceContentMatched: actual.length, repeatedFirstPageMatched: true, snapshotWindow: exported.window };
          await writeFile(path.join(output, 'research-export-online.json'), JSON.stringify({ ...exported, pages, reconciliation }), { mode: 0o600 });
          return { ...await snapshot({ label: 'online', restore: false }), exportReconciliation: reconciliation };
        });
        const mixedShowcase = check('recommendation-and-showcase-controls', async () => {
          const before = await db.classroomSubmission.findMany({ where: { participationId: { in: students.map(student => student.participation.id) },
            stageKey: 'make:document' } });
          const { runIncrementalMixedShowcase } = await import('./incremental-mixed-showcase.mjs');
          const proof = await runIncrementalMixedShowcase({ students, teachers, instance, db, origin, output, send, record, options });
          assert.equal(report.phase, 'steady', 'Showcase proof escaped the simultaneous load window');
          const after = await db.classroomSubmission.findMany({ where: { participationId: { in: students.map(student => student.participation.id) },
            stageKey: 'make:document' } });
          const advanced = before.filter(row => view(after.find(current => current.id === row.id)).version > view(row).version).length;
          assert.equal(advanced, options.students, 'Not every main-course student kept saving during the showcase proof');
          return { ...proof, simultaneousSavingStudents: advanced, mainCourseId: instance.id, phase: report.phase };
        });
        const nextRound = start + (options.smoke ? 2000 : 10 * 60000); await delay(Math.max(0, nextRound - Date.now()));
        await first;
        const second = round(2); await delay(1000); await until(() => !browserEditing, 'Native editor proof did not settle');
        await check('projection-during-second-ai-round', project);
        await Promise.all([first, second]);
        await check('projection-after-ai-load', project);
        await mixedShowcase;
      }
      if (phase.name === 'recovery') {
        await check('offline-60s-and-isolated-restart', async () => {
          const selected = [students[0], students[options.students / 2]];
          await clearProjection();
          for (const student of selected) student.paused = true;
          await Promise.allSettled(selected.map(student => student.inFlight));
          const offlineEdits = [], offlineWindows = [];
          for (const student of selected) {
            offlineEdits.push(await editActualStudent(student, `OFFLINE_EDIT_${randomUUID()}`, true));
            offlineWindows.push(student.offlineWindow);
          }
          await delay(options.smoke ? 1000 : 60000);
          for (const item of offlineEdits) assert.ok(!view(await saved(item.student)).content.includes(item.marker),
            'Offline content reached the server before reconnection');
          for (const student of selected) { await student.context.setOffline(false); student.context.incrementalOffline = false; }
          for (const window of offlineWindows) window.end = performance.now();
          for (const item of offlineEdits) {
            try {
              const result = await until(() => item.observer.entries.find(row => row.status === 200 && row.ack
                && row.request.requestId === item.pendingRequest.requestId), 'Offline browser did not recover its original save request');
              assert.deepEqual(result.request.action, item.pendingRequest.action);
              assert.equal(result.ack.requestId, item.pendingRequest.requestId);
              const student = item.student; student.version = result.ack.submissionVersion; student.submission = result.request.action.payload.submission;
              (student.nativeMarkers ??= []).push(item.marker);
              student.lastSave = { body: result.request, ack: result.ack, sha256: sha(student.submission.content), acknowledgedAt: new Date().toISOString() };
            } finally { await item.observer.close(); }
          }
          restartInProgress = true;
          const restartWindow = { kind: 'isolated-restart', start: performance.now() }; faultWindows.push(restartWindow);
          try {
            for (const actor of [...students, ...teachers]) actor.context.incrementalSubscribed = false;
            await restart();
            await until(() => [...students, ...teachers].every(actor => actor.context.incrementalSubscribed),
              'Browser subscriptions did not recover after the isolated application restart', 45000);
            await Promise.allSettled(students.map(student => student.inFlight));
          } finally { restartInProgress = false; restartWindow.end = performance.now(); }
          for (const student of selected) {
            await student.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            await student.page.locator('[data-slate-editor="true"][contenteditable="true"]').first().waitFor({ timeout: 45000 });
            student.paused = false;
          }
          await check('confirmed-ai-receipts-survive-restart', async () => {
            let confirmedRequests = 0;
            for (const round of report.aiRounds) for (const item of round.requests) {
              if (item.status !== 'completed' || !item.taskId) continue;
              const student = students.find(student => student.user.id === item.studentId);
              const replay = await send(student, 'POST', '/api/ai-collaboration/document', item.body);
              assert.equal(replay.status, 'completed'); assert.equal(replay.requestId, item.requestId);
              assert.deepEqual(replay.messages, item.finalMessages);
              assert.equal(await db.aiTask.count({ where: { createdById: student.user.id, input: { path: ['requestId'], equals: item.requestId } } }), 1);
              confirmedRequests++;
            }
            return { confirmedRequests,
              modelReruns: 0, inFlightModelRestartRecovery: 'not-established-by-completed-receipts' };
          });
          await check('projection-after-restart', project);
          return { brands: selected.map(student => student.label), offlineMs: options.smoke ? 1000 : 60000, installedServiceRestarted: false };
        });
      }
      await delay(Math.max(0, end - Date.now()));
      report.phases.push({ name: phase.name, startedAt: new Date(start).toISOString(), durationMs: Date.now() - start }); await save();
    }
    stopped = true; await Promise.all(loops); clearInterval(timer); clearInterval(projectionTimer); await sampleFlight; await projectionFlight;
    report.phase = 'reconciliation';
    await check('all-save-receipts-and-replay', async () => {
      const receipts = [];
      for (const student of students) {
        assert.equal(student.pendingSave, undefined, 'An immutable save remains unconfirmed after recovery');
        const row = await saved(student); const current = view(row);
        assert.equal(current.studentId, student.user.id); assert.equal(current.content, student.submission.content); assert.equal(current.version, student.version);
        const ack = await send(student, 'POST', `/api/courses/${instance.id}/actions`, student.lastSave.body);
        assert.deepEqual(ack, student.lastSave.ack); assert.equal(view(await saved(student)).version, student.version);
        const receipt = await db.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: `course-action:${student.user.id}:${ack.requestId}` } });
        assert.deepEqual(receipt.payload.ack, ack); receipts.push({ client: student.client, studentId: student.user.id, cycles: student.cycles,
          pendingSave: Boolean(student.pendingSave), version: student.version, sha256: sha(current.content), requestId: ack.requestId });
      }
      report.saveReconciliation = receipts;
      await writeFile(path.join(output, 'save-reconciliation.json'), JSON.stringify(receipts, null, 2)); return { students: receipts.length, duplicateVersions: 0 };
    });
    await archiveAll();
    report.phase = 'backup-restore';
    await settled([...contexts, teacherContext].map(context => context.close()));
    await check('final-backup-and-isolated-restore', () => snapshot({ label: 'final', restore: true }));
    await check('source-identity-unchanged', async () => {
      assertAcceptanceIdentityUnchanged(identity, await captureWorkspaceIdentity(root));
      return { commit: identity.commit, sourceSha256: identity.source.sha256, buildId };
    });
    await Promise.allSettled([...pending]);
    report.faultWindows = faultWindows;
    for (const phase of options.phases.map(phase => phase.name)) report.performance[phase] = summarizeIncrementalTraffic(traffic, phase);
    report.operationPerformance = {};
    for (const name of ['online-export-and-backup', 'recommendation-and-showcase-controls']) {
      const observation = report.checks.find(check => check.name === name);
      if (!observation?.finishedAt) continue;
      const start = Date.parse(observation.startedAt), end = Date.parse(observation.finishedAt);
      const overlaps = row => row.startedAtEpochMs <= end && row.finishedAtEpochMs >= start;
      const rows = traffic.filter(row => row.phase === 'steady');
      report.operationPerformance[name] = { startedAt: observation.startedAt, finishedAt: observation.finishedAt,
        during: summarizeIncrementalTraffic(rows.filter(overlaps), 'steady'),
        outside: summarizeIncrementalTraffic(rows.filter(row => !overlaps(row)), 'steady') };
    }
    Object.assign(report, evaluateIncrementalClassroom(report, options)); report.outcome = report.status;
    record('incremental-profile', report.status === 'passed' ? '通过' : report.status === 'partial' ? '未验证' : '失败', { status: report.status, failures: report.failures, fullClassroomAcceptance: false });
    return report;
  } catch (error) {
    report.outcome = 'failed'; report.errors.push({ phase: report.phase, kind: 'fatal', error: String(error.stack ?? error).slice(0, 4000) });
    throw error;
  } finally {
    stopped = true; clearInterval(timer); clearInterval(projectionTimer); await sampleFlight; await projectionFlight;
    await Promise.allSettled(loops);
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(ownedBrowsers.map(owned => owned.close()));
    await Promise.allSettled([...pending]);
    report.finishedAt = new Date().toISOString(); await save();
  }
}
