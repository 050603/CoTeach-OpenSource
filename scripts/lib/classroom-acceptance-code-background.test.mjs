import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertCodeBackgroundCloseProof, assertCodeBackgroundCoverage, observeCodeBackgroundAdmissions, runCodeBackgroundCloseProof } from './classroom-acceptance-code-background.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)])) : value;
const syncAfter = p => { p.afterReplay = structuredClone({ task: p.task, alias: p.alias, messages: p.messages, events: p.events, messageEvents: p.messageEvents }); };
function proof(language = 'python', kind = 'proactive-review') {
  const artifact = { version: 1, language, activeFileId: 'main', files: [{ id: 'main', path: language === 'python' ? 'main.py' : 'main.c', content: 'fixture source' }] };
  const run = { status: 'success', phase: 'run', exitCode: 0, stdout: '7', stderr: '' };
  const request = { courseId: 'course', studentId: 'student', stageKey: 'make', language, artifact, run,
    ...(kind === 'proactive-review' ? { intent: kind } : { action: kind, mode: 'discuss' }), requestId: 'client-id' };
  const prompts = { system: 'fixture system', user: 'fixture user' }, context = { artifact, run };
  const fingerprintSource = JSON.stringify({ prompts, action: request.action ?? '', intent: request.intent, language, context });
  const identity = { requestId: 'canonical-id', courseId: 'course', studentId: 'student', participationId: 'participation',
    stageKey: 'make', intent: kind, workspaceKind: 'code:' + language, fingerprint: sha(fingerprintSource),
    documentVersion: sha(JSON.stringify(artifact)) };
  const response = { requestId: 'canonical-id', status: 'completed', artifactVersion: identity.documentVersion,
    ...(kind === 'proactive-review' ? { result: { findings: [] }, commentThreads: [] } : { starters: [] }) };
  const p = { brand: kind === 'proactive-review' ? 'google-chrome' : 'microsoft-edge', language, kind,
    execution: 'production-next-automatic-worker', evidence: 'browser-real-provider', callerClosed: true,
    listenerInstalledAt: 900, armedAt: 1000, admissionObservedAt: 1100, closeStartedAt: 1150, callerClosedAt: 1200, completionObservedAt: 2000,
    courseId: 'course', studentId: 'student', participationId: 'participation', expectedArtifact: artifact, expectedRun: run, request,
    admission: { status: 202, body: { requestId: 'client-id', canonicalRequestId: 'canonical-id' } },
    final: { status: 200, body: { ...response, requestId: 'client-id', canonicalRequestId: 'canonical-id' } },
    task: { id: 'task', createdById: 'student', status: 'COMPLETED', taskType: 'DOCUMENT_COLLABORATION', queueKey: 'document-review-v1',
      leaseUntil: null, completedAt: new Date(1800).toISOString(), conversationId: 'conversation',
      input: { requestId: 'canonical-id', reviewSnapshot: { version: 2, kind: 'code-background', task: identity,
        body: { ...request, action: request.action ?? '', mode: request.mode === 'task' ? 'task' : 'discuss', message: '' },
        fingerprintSource, prompts, context, guard: { identity: { role: 'STUDENT', status: 'ACTIVE', sessionVersion: 1 },
          templateVersionId: 'template', offeringId: 'offering', stageIndex: 2, stageVersion: 3 },
        course: { stageVersion: 3, platformContext: { templateVersionId: 'template' }, stages: [{ key: 'launch' }, { key: 'ai-learning' }, { key: 'make' }] } } },
      output: { response } },
    alias: { participationId: 'participation', clientRequestId: 'client-id', taskId: 'task', requestBody: request,
      bodyDigest: sha(JSON.stringify(stable(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'requestId'))))) },
    scope: { participationId: 'participation', courseId: 'course', studentId: 'student', enrollmentStatus: 'ACTIVE',
      instanceStatus: 'TEACHING', offeringStatus: 'OPEN', archivedAt: null, role: 'STUDENT', status: 'ACTIVE', sessionVersion: 1,
      templateVersionId: 'template', offeringId: 'offering', stageIndex: 2, stageVersion: 3, mode: language },
    messages: [], events: [], messageEvents: [], prepared: { state: 'not-observed' }, passed: true };
  p.replay = structuredClone(p.final); syncAfter(p); return p;
}
test('empty review and starters remain legitimate complete receipts without invented audits or checkpoint', () => {
  assertCodeBackgroundCloseProof(proof());
  assertCodeBackgroundCloseProof(proof('c', 'code-task-starters'));
});
test('202, caller still open, late close, wrong alias and drain/mock evidence cannot pass', () => {
  for (const mutate of [
    p => { p.final.status = 202; }, p => { p.final.body.status = 'processing'; },
    p => { p.callerClosed = false; }, p => { p.callerClosedAt = 1900; },
    p => { p.admission.status = 200; }, p => { p.execution = 'manual-drain'; },
    p => { p.evidence = 'mock'; }, p => { p.final.body.requestId = 'other'; },
    p => { p.final.body.canonicalRequestId = 'other'; }, p => { p.completionObservedAt = 122000; },
    p => { delete p.closeStartedAt; }, p => { p.alias.requestBody = { ...p.request, requestId: 'other' }; },
  ]) { const p = proof(); mutate(p); assert.throws(() => assertCodeBackgroundCloseProof(p)); }
});
test('ownership, immutable input, live version and exact saved output are checked independently', () => {
  for (const mutate of [
    p => { p.task.createdById = 'other'; }, p => { p.alias.taskId = 'other'; },
    p => { p.task.input.reviewSnapshot.body = { ...p.request, run: { status: 'idle' } }; },
    p => { p.task.input.reviewSnapshot.fingerprintSource = '{}'; },
    p => { p.scope.stageVersion = 4; }, p => { p.scope.templateVersionId = 'other'; },
    p => { p.scope.sessionVersion = 2; }, p => { p.scope.enrollmentStatus = 'WITHDRAWN'; },
    p => { p.task.output.response.status = 'failed'; }, p => { p.events.push({ id: 'invented' }); },
    p => { p.afterReplay.task.status = 'RUNNING'; },
  ]) { const p = proof(); mutate(p); assert.throws(() => assertCodeBackgroundCloseProof(p)); }
});
test('observed prepared output must equal final output; unknown must not invent a checkpoint', () => {
  const p = proof('python', 'code-task-starters');
  p.prepared = { state: 'observed', value: { body: { starters: [] }, messages: [], events: [] } };
  assertCodeBackgroundCloseProof(p);
  p.prepared.value.body.starters.push('changed'); assert.throws(() => assertCodeBackgroundCloseProof(p));
  const missing = proof(); missing.prepared.value = {}; assert.throws(() => assertCodeBackgroundCloseProof(missing));
});
test('persisted proactive comment and both research audit paths must match actual returned content', () => {
  const p = proof(), meta = { id: 'thread', filePath: 'main.py', startLine: 1, endLine: 1, severity: 'notice',
    title: 'Review', quotedCode: 'fixture source', createdAt: new Date(1700).toISOString(), reviewVersion: 1 };
  const comment = { id: 'agent-message', role: 'assistant', content: 'Explain this step', createdAt: meta.createdAt };
  const thread = { ...meta, comments: [comment] };
  p.task.output.response.commentThreads = [thread];
  p.final.body.commentThreads = [thread]; p.replay = structuredClone(p.final);
  p.messages = [
    { id: 'meta-message', role: 'system', content: 'OPENPBL_CODE_COMMENT_META:' + JSON.stringify(meta),
      createdAt: meta.createdAt, conversationId: 'conversation', metadata: { conversationId: 'thread' } },
    { id: comment.id, role: 'assistant', content: comment.content, createdAt: comment.createdAt,
      conversationId: 'conversation', metadata: { conversationId: 'thread' } },
  ];
  p.messageEvents = p.messages.map(message => ({ idempotencyKey: 'companion-message:' + message.id,
    participationId: 'participation', userId: 'student', content: message.content, payload: { detail: { messageId: message.id } } }));
  p.events = [{ idempotencyKey: 'code-ai:participation:canonical-id:0', taskId: 'task', requestId: 'canonical-id',
    participationId: 'participation', userId: 'student', conversationId: 'conversation', actor: 'assistant',
    eventType: 'comment', content: comment.content, payload: { schemaVersion: 1,
      legacy: { stageKey: 'make', source: 'proactive-comment', conversationId: 'thread', actorId: null },
      detail: { commentThreadId: 'thread', filePath: 'main.py', startLine: 1, endLine: 1,
        issueType: 'Review', targetText: 'fixture source', initialComment: true } } }];
  syncAfter(p); assertCodeBackgroundCloseProof(p);
  for (const mutate of [
    row => { row.messages[1].content = 'changed'; },
    row => { row.events[0].payload.detail.targetText = 'changed'; },
    row => { row.messageEvents[0].userId = 'other'; },
    row => { row.events = []; },
  ]) { const damaged = structuredClone(p); mutate(damaged); syncAfter(damaged); assert.throws(() => assertCodeBackgroundCloseProof(damaged)); }
});
test('coverage requires all four language/browser/action targets, never partial or duplicate rows', () => {
  const rows = ['python', 'c'].flatMap(language => ['proactive-review', 'code-task-starters'].map(kind => proof(language, kind)));
  assertCodeBackgroundCoverage(rows);
  assert.throws(() => assertCodeBackgroundCoverage(rows.slice(1)));
  assert.throws(() => assertCodeBackgroundCoverage([rows[0], rows[0], rows[2], rows[3]]));
  rows[0].passed = false; assert.throws(() => assertCodeBackgroundCoverage(rows));
});
function emitAdmission(page, p, body = p.request, responseBody = p.admission.body) {
  page.emit('response', { request: () => ({ method: () => 'POST', postDataJSON: () => body }),
    url: () => 'http://127.0.0.1:3199/api/ai-collaboration/code', status: () => 202,
    json: async () => responseBody });
}
function observe(page, p) {
  return observeCodeBackgroundAdmissions(page, { origin: 'http://127.0.0.1:3199', courseId: p.courseId,
    studentId: p.studentId, kind: p.kind, artifact: p.expectedArtifact });
}
test('202 arriving before run output assertions finish is retained with its original clock and exact run', async () => {
  const page = new EventEmitter(), p = proof(), observer = observe(page, p);
  try {
    // The actual run has returned to the component, but the harness output
    // assertion has not finished and expectedRun is not bound yet.
    emitAdmission(page, p, { ...p.request, run: { status: 'idle' } }, { ...p.admission.body, requestId: 'old-run' });
    const earliest = Date.now(); emitAdmission(page, p); const latest = Date.now();
    await Promise.resolve();
    const row = await observer.waitForRun(p.expectedRun, Date.now() + 1000);
    assert.deepEqual(row.request, p.request); assert.deepEqual(row.admission, p.admission);
    assert.ok(row.observedAt >= earliest && row.observedAt <= latest);
    p.admissionObservedAt = 950; // Arrival may precede the post-run gate clock.
    assertCodeBackgroundCloseProof(p);
  } finally { observer.close(); }
  assert.equal(page.listenerCount('response'), 0);
});
test('early observation never substitutes another run and closure rejects outstanding waiters', async () => {
  const page = new EventEmitter(), p = proof(), observer = observe(page, p);
  emitAdmission(page, p, { ...p.request, run: { status: 'idle' } });
  const waiting = observer.waitForRun(p.expectedRun, Date.now() + 1000);
  const rejected = assert.rejects(waiting, /observer closed/);
  observer.close(); await rejected;
  assert.equal(page.listenerCount('response'), 0);
});

async function failedRun(t, state, failRead) {
  const output = await mkdtemp(path.join(tmpdir(), 'code-background-failure-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const p = proof(), caller = new EventEmitter(), calls = [];
  const terminal = { status: 200, body: { requestId: p.request.requestId, canonicalRequestId: 'canonical-id',
    status: state, error: state === 'cancelled' ? 'REVIEW_CANCELLED' : 'REVIEW_INPUT_CHANGED', retryable: false } };
  const task = { ...p.task, status: state.toUpperCase(), error: terminal.body.error, attemptCount: 1,
    createdAt: new Date(1000), startedAt: new Date(1100), completedAt: new Date(1200), availableAt: null, leaseUntil: null };
  let closed = false;
  caller.close = async () => { calls.push('close'); closed = true; };
  caller.isClosed = () => closed;
  const replacement = {
    goto: async url => { calls.push(new URL(url).pathname); },
    evaluate: async (_fn, args) => {
      calls.push('GET'); assert.equal(new URL(args.url).searchParams.get('requestId'), p.request.requestId);
      assert.ok(args.timeout > 0 && args.timeout <= 10000);
      return structuredClone(terminal);
    },
  };
  const db = {
    aiTaskRequestAlias: { findUniqueOrThrow: async () => {
      calls.push('alias'); if (failRead === 'alias') throw new Error('alias read unavailable'); return p.alias;
    } },
    aiTask: { findUniqueOrThrow: async () => { calls.push('task'); return task; } },
    aiInteractionEvent: { findMany: async () => {
      calls.push('audit'); if (failRead === 'audit') throw new Error('audit read unavailable'); return [];
    } },
  };
  const result = await runCodeBackgroundCloseProof({
    student: { page: caller, label: 'google-chrome', user: { id: p.studentId }, context: {
      newPage: async () => { calls.push('new-page'); return replacement; },
    } }, instance: { id: p.courseId }, participationId: p.participationId, language: p.language, kind: p.kind,
    artifact: p.expectedArtifact, origin: 'http://127.0.0.1:3199', db, output,
    observePage: () => calls.push('observe'),
    triggerRun: async () => { calls.push('run'); emitAdmission(caller, p); return p.expectedRun; },
  });
  const file = path.join(output, 'python-google-chrome-background-close.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(saved, result);
  assert.equal(saved.passed, false); assert.equal(saved.final, undefined);
  assert.deepEqual(saved.lastReceipt.response, terminal);
  assert.equal(caller.listenerCount('response'), 0);
  // Original single trigger/admission, one immediate GET, existing reads and
  // restoration only: no replay, polling delay, extra DB read or rescue POST.
  assert.deepEqual(calls, ['run', 'close', 'new-page', 'observe', '/favicon.ico', 'GET', 'alias',
    ...(failRead === 'alias' ? [] : ['task', 'audit', ...(failRead === 'audit' ? [] : ['audit'])]),
    '/student/ai-collaboration/course']);
  assert.equal(saved.polls.length, 1);
  assert.ok(saved.lastReceipt.observedAt >= saved.armedAt && saved.lastReceipt.observedAt <= saved.armedAt + 120000);
  return { saved, task, p };
}

for (const state of ['failed', 'cancelled']) test(`actual ${state} GET receipt and existing task metadata survive the original failing gate`, async t => {
  const { saved, task, p } = await failedRun(t, state);
  assert.match(saved.error, /Task failed, cancelled or lost its original receipt/);
  assert.deepEqual(saved.lastSavedTask.alias, { participationId: p.alias.participationId,
    clientRequestId: p.alias.clientRequestId, taskId: p.alias.taskId });
  assert.equal(saved.lastSavedTask.task.status, task.status);
  assert.equal(saved.lastSavedTask.task.error, task.error);
  assert.equal(saved.lastSavedTask.task.attemptCount, 1);
  assert.equal(saved.lastSavedTask.task.startedAt, task.startedAt.toISOString());
  assert.equal(saved.lastSavedTask.task.leaseUntil, null);
  assert.equal(saved.lastSavedTask.task.input, undefined);
  assert.equal(saved.lastSavedTask.task.output, undefined);
});

test('the actual terminal GET body is saved before a failed first DB read', async t => {
  const { saved } = await failedRun(t, 'failed', 'alias');
  assert.match(saved.error, /alias read unavailable/);
  assert.equal(saved.lastSavedTask, undefined);
});

test('already-read task metadata remains when the subsequent existing audit read fails', async t => {
  const { saved, task } = await failedRun(t, 'failed', 'audit');
  assert.match(saved.error, /audit read unavailable/);
  assert.equal(saved.lastSavedTask.task.id, task.id);
  assert.equal(saved.lastSavedTask.task.error, task.error);
});
