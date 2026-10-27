import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const CODE_BACKGROUND_GATE = 'code-background-next-worker-after-caller-close';
const endpoint = '/api/ai-collaboration/code';
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)])) : value;
const sha = text => createHash('sha256').update(text).digest('hex');
const digest = value => sha(JSON.stringify(stable(value)));
const millis = value => typeof value === 'number' ? value : Date.parse(value);
const withoutRequestId = body => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'));
const asJson = value => JSON.parse(JSON.stringify(value));

export function assertCodeBackgroundCloseProof(proof) {
  const { admission, final, replay, alias, task, scope, request, expectedArtifact, expectedRun } = proof;
  assert.equal(proof.execution, 'production-next-automatic-worker');
  assert.equal(proof.evidence, 'browser-real-provider');
  assert.equal(proof.callerClosed, true);
  assert.equal(admission.status, 202, 'Admission is not a completed receipt');
  assert.ok(typeof request.requestId === 'string' && request.requestId.length > 0);
  assert.equal(admission.body.requestId, request.requestId);
  assert.ok(typeof admission.body.canonicalRequestId === 'string' && admission.body.canonicalRequestId.length > 0);
  for (const key of ['listenerInstalledAt', 'armedAt', 'admissionObservedAt', 'closeStartedAt', 'callerClosedAt', 'completionObservedAt']) {
    assert.ok(Number.isSafeInteger(proof[key]) && proof[key] > 0, 'Missing actual ' + key);
  }
  assert.ok(proof.listenerInstalledAt <= proof.armedAt && proof.listenerInstalledAt <= proof.admissionObservedAt
    && proof.armedAt <= proof.closeStartedAt && proof.admissionObservedAt <= proof.closeStartedAt
    && proof.closeStartedAt <= proof.callerClosedAt && proof.callerClosedAt < millis(task.completedAt)
    && millis(task.completedAt) <= proof.completionObservedAt, 'Completion must follow actual caller closure');
  assert.ok(proof.completionObservedAt - proof.armedAt <= 120000, 'Existing acceptance deadline exceeded');
  assert.equal(final.status, 200); assert.equal(final.body.status, 'completed');
  assert.deepEqual(replay, final, 'Original-ID GET receipt changed');
  assert.equal(final.body.requestId, request.requestId);
  assert.equal(final.body.canonicalRequestId, admission.body.canonicalRequestId);
  assert.equal(request.courseId, proof.courseId); assert.equal(request.studentId, proof.studentId);
  assert.equal(request.stageKey, 'make'); assert.equal(request.language, proof.language);
  assert.equal(request.action || request.intent, proof.kind);
  assert.deepEqual(request.artifact, expectedArtifact); assert.deepEqual(request.run, expectedRun);
  assert.equal(alias.participationId, proof.participationId); assert.equal(alias.clientRequestId, request.requestId);
  assert.equal(alias.taskId, task.id); assert.deepEqual(alias.requestBody, request);
  assert.equal(alias.bodyDigest, digest(withoutRequestId(request)));
  assert.equal(task.status, 'COMPLETED'); assert.equal(task.taskType, 'DOCUMENT_COLLABORATION');
  assert.equal(task.queueKey, 'document-review-v1'); assert.equal(task.createdById, proof.studentId);
  assert.equal(task.leaseUntil, null);
  const snapshot = task.input.reviewSnapshot, identity = snapshot.task, guard = snapshot.guard;
  assert.equal(snapshot.version, 2); assert.equal(snapshot.kind, 'code-background');
  assert.equal(identity.requestId, admission.body.canonicalRequestId);
  assert.equal(identity.courseId, proof.courseId); assert.equal(identity.studentId, proof.studentId);
  assert.equal(identity.participationId, proof.participationId); assert.equal(identity.stageKey, 'make');
  assert.equal(identity.intent, proof.kind); assert.equal(identity.workspaceKind, 'code:' + proof.language);
  assert.equal(task.input.requestId, identity.requestId);
  // The task snapshot stores the handler's normalized defaults; the alias above
  // separately retains the complete original browser body without normalization.
  assert.deepEqual(withoutRequestId(snapshot.body), withoutRequestId({ ...request,
    action: request.action ?? '', mode: request.mode === 'task' ? 'task' : 'discuss', message: request.message ?? '' }));
  const original = JSON.parse(snapshot.fingerprintSource);
  assert.equal(sha(snapshot.fingerprintSource), identity.fingerprint);
  assert.deepEqual(original.context, snapshot.context);
  assert.deepEqual(original.prompts, snapshot.prompts);
  assert.ok(snapshot.prompts.system && snapshot.prompts.user);
  assert.deepEqual(snapshot.context.artifact, request.artifact);
  assert.equal(sha(JSON.stringify(original.context.artifact)), identity.documentVersion);
  assert.equal(final.body.artifactVersion, identity.documentVersion);
  assert.equal(scope.participationId, proof.participationId); assert.equal(scope.courseId, proof.courseId);
  assert.equal(scope.studentId, proof.studentId); assert.equal(scope.enrollmentStatus, 'ACTIVE');
  assert.equal(scope.instanceStatus, 'TEACHING'); assert.equal(scope.offeringStatus, 'OPEN'); assert.equal(scope.archivedAt, null);
  assert.deepEqual(guard.identity, { role: scope.role, status: scope.status, sessionVersion: scope.sessionVersion });
  assert.equal(scope.role, 'STUDENT'); assert.equal(scope.status, 'ACTIVE');
  assert.equal(guard.templateVersionId, scope.templateVersionId); assert.equal(guard.offeringId, scope.offeringId);
  assert.equal(guard.stageIndex, scope.stageIndex); assert.equal(guard.stageVersion, scope.stageVersion);
  assert.equal(scope.mode, proof.language); assert.equal(scope.stageIndex, 2);
  assert.equal(snapshot.course.stageVersion, scope.stageVersion);
  assert.equal(snapshot.course.platformContext.templateVersionId, scope.templateVersionId);
  assert.equal(snapshot.course.stages[scope.stageIndex].key, 'make');
  assert.deepEqual(final.body, { ...task.output.response, requestId: request.requestId, canonicalRequestId: identity.requestId });
  assert.deepEqual(proof.afterReplay, { task, alias, messages: proof.messages, events: proof.events, messageEvents: proof.messageEvents },
    'Receipt GET must not mutate the task or append messages/audit');
  const threads = proof.kind === 'proactive-review' ? final.body.commentThreads : [];
  if (proof.kind === 'code-task-starters') assert.ok(Array.isArray(final.body.starters));
  else { assert.ok(final.body.result && Array.isArray(final.body.result.findings)); assert.ok(Array.isArray(threads)); }
  assert.equal(proof.messages.length, threads.length * 2); assert.equal(proof.events.length, threads.length);
  assert.equal(proof.messageEvents.length, proof.messages.length);
  for (const [index, thread] of threads.entries()) {
    const meta = proof.messages.find(row => row.metadata.conversationId === thread.id && row.role === 'system');
    const comment = proof.messages.find(row => row.id === thread.comments[0]?.id);
    assert.ok(meta && comment, 'Missing original persisted comment');
    const { comments, ...details } = thread;
    assert.ok(meta.content.startsWith('OPENPBL_CODE_COMMENT_META:'));
    assert.deepEqual(JSON.parse(meta.content.slice('OPENPBL_CODE_COMMENT_META:'.length)), details);
    assert.equal(comment.content, comments[0].content); assert.equal(comment.role, 'assistant');
    assert.equal(millis(comment.createdAt), millis(comments[0].createdAt));
    for (const message of [meta, comment]) {
      assert.equal(message.conversationId, task.conversationId);
      assert.equal(message.metadata.conversationId, thread.id);
      const audit = proof.messageEvents.find(row => row.idempotencyKey === 'companion-message:' + message.id);
      assert.ok(audit); assert.equal(audit.participationId, proof.participationId);
      assert.equal(audit.userId, proof.studentId); assert.equal(audit.content, message.content);
      assert.equal(audit.payload.detail.messageId, message.id);
    }
    const event = proof.events.find(row => row.idempotencyKey === 'code-ai:' + proof.participationId + ':' + identity.requestId + ':' + index);
    assert.ok(event); assert.equal(event.taskId, task.id); assert.equal(event.requestId, identity.requestId);
    assert.equal(event.participationId, proof.participationId); assert.equal(event.userId, proof.studentId);
    assert.equal(event.conversationId, task.conversationId); assert.equal(event.actor, 'assistant');
    assert.equal(event.eventType, 'comment'); assert.equal(event.content, comments[0].content);
    assert.deepEqual(event.payload, { schemaVersion: 1, legacy: { stageKey: 'make', source: 'proactive-comment',
      conversationId: thread.id, actorId: null }, detail: { commentThreadId: thread.id, filePath: thread.filePath,
      startLine: thread.startLine, endLine: thread.endLine, issueType: thread.title, targetText: thread.quotedCode, initialComment: true } });
  }
  assert.ok(['observed', 'not-observed'].includes(proof.prepared.state));
  if (proof.prepared.state === 'observed') {
    const checkpoint = proof.prepared.value;
    assert.deepEqual(task.output.response, { ...checkpoint.body, requestId: identity.requestId, status: 'completed', artifactVersion: identity.documentVersion });
    assert.equal(checkpoint.messages.length, proof.messages.length); assert.equal(checkpoint.events.length, proof.events.length);
    for (const message of checkpoint.messages) {
      const saved = proof.messages.find(row => row.id === message.id);
      assert.ok(saved); assert.equal(saved.content, message.content);
      assert.equal(millis(saved.createdAt), millis(message.createdAt));
      const metadata = Object.fromEntries(Object.entries(message).filter(([key]) => !['id', 'role', 'content', 'createdAt'].includes(key)));
      assert.deepEqual(saved.metadata, { ...metadata, legacyRole: message.role });
    }
    checkpoint.events.forEach((event, index) => {
      const saved = proof.events.find(row => row.idempotencyKey === 'code-ai:' + proof.participationId + ':' + identity.requestId + ':' + index);
      assert.equal(saved.content, event.content ?? ''); assert.equal(saved.eventType, event.eventType);
      assert.deepEqual(saved.payload.detail, event.payload ?? {});
    });
  } else assert.equal(proof.prepared.value, undefined, 'An unobserved checkpoint must not invent saved output');
}

/** Install before the unique real run. Responses may arrive while the original
 * output assertion is still pending; preserve their arrival clocks and bodies. */
export function observeCodeBackgroundAdmissions(page, { origin, courseId, studentId, kind, artifact }) {
  const entries = [], waiters = new Set();
  let closed = false, failure;
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const listener = response => {
    if (closed || response.request().method() !== 'POST' || new URL(response.url()).origin !== origin
      || new URL(response.url()).pathname !== endpoint) return;
    let request; try { request = response.request().postDataJSON(); } catch { return; }
    if (request?.courseId !== courseId || request.studentId !== studentId || (request.action || request.intent) !== kind
      || digest(request.artifact) !== digest(artifact)) return;
    if (entries.length >= 8) { failure = new Error('Target admission observation exceeded eight records'); wake(); return; }
    const entry = { request, observedAt: Date.now(), status: response.status(), settled: false };
    entries.push(entry);
    void response.json().then(body => {
      if (closed) return;
      entry.body = body; entry.settled = true; wake();
    }, error => {
      if (closed) return;
      entry.error = error; entry.settled = true; wake();
    });
  };
  page.on('response', listener);
  return {
    waitForRun(run, deadline) {
      return new Promise((resolve, reject) => {
        let timer;
        const finish = (error, value) => { clearTimeout(timer); waiters.delete(check); if (error) reject(error); else resolve(value); };
        const check = () => {
          if (closed || failure) return finish(failure ?? new Error('Admission observer closed'));
          const entry = entries.find(row => digest(row.request.run) === digest(run) && row.settled);
          if (!entry) return;
          if (entry.error) return finish(entry.error);
          finish(null, { request: entry.request, admission: { status: entry.status, body: entry.body }, observedAt: entry.observedAt });
        };
        timer = setTimeout(() => finish(new Error('No matching code background admission within existing 120-second gate')),
          Math.max(0, deadline - Date.now()));
        waiters.add(check); check();
      });
    },
    close() { closed = true; page.off('response', listener); wake(); },
  };
}

export function assertCodeBackgroundCoverage(rows) {
  assert.equal(rows.length, 4);
  for (const language of ['python', 'c']) for (const [brand, kind] of [
    ['google-chrome', 'proactive-review'], ['microsoft-edge', 'code-task-starters'],
  ]) {
    const selected = rows.filter(row => row.language === language && row.brand === brand && row.kind === kind);
    assert.equal(selected.length, 1); assert.equal(selected[0].passed, true); assertCodeBackgroundCloseProof(selected[0]);
  }
}

/** Four selected natural UI requests in existing artifact classrooms. No worker
 * imports, synthetic POST, task mutation, lease reset or model substitution. */
export async function runCodeBackgroundCloseProof({ student, instance, participationId, language, kind, artifact, triggerRun, origin, db, output, observePage }) {
  assert.equal(typeof observePage, 'function', 'Replacement page must retain ordinary error observation');
  assert.equal(typeof triggerRun, 'function', 'Observe before the original unique run');
  const caller = student.page, courseId = instance.id, studentId = student.user.id;
  const proof = { brand: student.label, language, kind, courseId, studentId, participationId,
    execution: 'production-next-automatic-worker', evidence: 'browser-real-provider',
    expectedArtifact: artifact, prepared: { state: 'not-observed' }, passed: false, listenerInstalledAt: Date.now(), polls: [] };
  const admissions = observeCodeBackgroundAdmissions(caller, { origin, courseId, studentId, kind, artifact });
  let replacement, deadline;
  async function savedRows() {
    const alias = await db.aiTaskRequestAlias.findUniqueOrThrow({ where: { participationId_clientRequestId: {
      participationId, clientRequestId: proof.request.requestId } } });
    const task = await db.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } });
    // Keep the already-read terminal metadata even if a later audit query or
    // receipt assertion fails. Do not copy the large immutable input/output.
    proof.lastSavedTask = asJson({ observedAt: Date.now(), alias: {
      participationId: alias.participationId, clientRequestId: alias.clientRequestId, taskId: alias.taskId,
    }, task: Object.fromEntries(['id', 'status', 'error', 'attemptCount', 'queueKey',
      'createdAt', 'startedAt', 'completedAt', 'availableAt', 'leaseUntil'].map(key => [key, task[key]])) });
    const threads = task.output?.response?.commentThreads ?? [];
    const messages = threads.length ? await db.aiMessage.findMany({ where: { conversationId: task.conversationId,
      OR: threads.map(thread => ({ metadata: { path: ['conversationId'], equals: thread.id } })) }, orderBy: { id: 'asc' } }) : [];
    const events = await db.aiInteractionEvent.findMany({ where: { taskId: task.id }, orderBy: { id: 'asc' } });
    const messageEvents = await db.aiInteractionEvent.findMany({ where: { idempotencyKey: { in: messages.map(row => 'companion-message:' + row.id) } }, orderBy: { id: 'asc' } });
    return asJson({ alias, task, messages, events, messageEvents });
  }
  async function receipt() {
    const timeout = Math.min(10000, deadline - Date.now());
    assert.ok(timeout > 0, 'Code receipt deadline elapsed');
    return replacement.evaluate(async ({ url, timeout }) => {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(timeout) });
      return { status: response.status, body: await response.json() };
    }, { url: new URL(endpoint + '?' + new URLSearchParams({ courseId, studentId, stageKey: 'make', language,
      requestId: proof.request.requestId }), origin).href, timeout });
  }
  try {
    // This callback retains the original one run, actual response and output
    // assertions. Observation is already installed even if those assertions lag.
    const run = await triggerRun();
    proof.actualRun = run;
    proof.expectedRun = asJson({ status: run.status, phase: run.phase, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr });
    proof.armedAt = Date.now(); deadline = proof.armedAt + 120000;
    if (kind === 'code-task-starters') await caller.getByRole('button', { name: 'AI 组员', exact: true }).click();
    const observed = await admissions.waitForRun(proof.expectedRun, deadline);
    proof.request = observed.request; proof.admission = observed.admission;
    proof.admissionObservedAt = observed.observedAt; // Never rewrite an early response's clock.
    assert.equal(proof.admission.status, 202, 'Target needs actual in-progress admission; do not create extra work to replace a completed reuse');
    proof.closeStartedAt = Date.now(); await caller.close();
    proof.callerClosedAt = Date.now(); proof.callerClosed = caller.isClosed();
    admissions.close();
    replacement = await student.context.newPage(); observePage(replacement); student.page = replacement;
    // A same-origin immutable image does not mount another AI component. All
    // receipt GETs still originate from the real browser and retain its observer.
    await replacement.goto(new URL('/favicon.ico', origin).href, { waitUntil: 'domcontentloaded', timeout: 10000 });
    for (let index = 0; Date.now() < deadline; index++) {
      const response = await receipt();
      // Retain the actual body before any DB read can throw. Normal completed
      // proofs already retain final/replay and discard these diagnostics below.
      proof.lastReceipt = { observedAt: Date.now(), response };
      delete proof.lastSavedTask;
      proof.polls.push({ observedAt: Date.now(), status: response.status, requestId: response.body.requestId, state: response.body.status });
      const rows = await savedRows();
      if (rows.task.output?.preparedResponse) proof.prepared = { state: 'observed', observedAt: Date.now(), value: rows.task.output.preparedResponse };
      if (response.status === 200 && response.body.status === 'completed') {
        proof.final = response; proof.completionObservedAt = Date.now(); Object.assign(proof, rows); break;
      }
      assert.equal(response.status, 202, 'Task failed, cancelled or lost its original receipt');
      assert.equal(response.body.requestId, proof.request.requestId);
      const wait = Math.min(15000, 5000 * 1.5 ** index + Math.random() * 1000);
      await delay(Math.max(0, Math.min(wait, deadline - Date.now())));
    }
    assert.ok(proof.final, 'Code background task exceeded the existing 120-second completion gate');
    const scope = await db.classroomParticipation.findUniqueOrThrow({ where: { id: participationId }, select: {
      id: true, instanceId: true, enrollment: { select: { userId: true, offeringId: true, status: true,
        user: { select: { role: true, status: true, sessionVersion: true } }, offering: { select: { status: true } } } },
      instance: { select: { status: true, templateVersionId: true, runtimeConfig: true, activity: { select: { archivedAt: true } } } },
    } });
    proof.scope = { participationId: scope.id, courseId: scope.instanceId, studentId: scope.enrollment.userId,
      offeringId: scope.enrollment.offeringId, enrollmentStatus: scope.enrollment.status, offeringStatus: scope.enrollment.offering.status,
      instanceStatus: scope.instance.status, archivedAt: scope.instance.activity.archivedAt,
      ...scope.enrollment.user, templateVersionId: scope.instance.templateVersionId,
      stageVersion: scope.instance.runtimeConfig.stageVersion, stageIndex: scope.instance.runtimeConfig.currentStageIndex,
      mode: scope.instance.runtimeConfig.makeArtifactMode };
    proof.replay = await receipt(); proof.afterReplay = await savedRows();
    assertCodeBackgroundCloseProof(proof); proof.passed = true;
  } catch (error) { proof.error = String(error.stack ?? error); }
  finally {
    admissions.close();
    // Keep the original artifact sequence usable even after failed evidence.
    if (caller.isClosed()) {
      try {
        if (!replacement) { replacement = await student.context.newPage(); observePage(replacement); }
        student.page = replacement;
        await replacement.goto(new URL('/student/ai-collaboration/' + courseId, origin).href,
          { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      catch (error) { proof.passed = false; proof.restoreError = String(error); }
    }
    if (proof.passed) { delete proof.lastReceipt; delete proof.lastSavedTask; }
    await writeFile(path.join(output, language + '-' + student.label + '-background-close.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  }
  return proof;
}
