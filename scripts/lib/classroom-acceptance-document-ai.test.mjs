import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DOCUMENT_AI_FEATURES, assertDocumentModelEvidence, documentAiParagraphs, waitForNaturalDocumentReviewRecovery,
  observeDocumentAiTraffic, findDocumentAiCompletion, waitForDocumentAiCompletion, assertDocumentBrowserReceipt } from './classroom-acceptance-document-ai.mjs';
import { CLASSROOM_REQUIRED_EVIDENCE } from './classroom-acceptance-contract.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(expectedIntent = 'proactive-document-comments') {
  const body = { requestId: 'actual-ui-request', documentHtml: '<p>Saved student text.</p>' };
  const documentVersion = sha(JSON.stringify(body.documentHtml));
  const raw = '{"message":"Check the two recorded counts."}';
  const structured = ['proactive-document-comments', 'comment-reply'].includes(expectedIntent);
  return { body, expectedIntent, participationId: 'participation-1', studentId: 'student-1',
    task: { taskType: 'DOCUMENT_COLLABORATION', status: 'COMPLETED', createdById: 'student-1',
      input: { participationId: 'participation-1', requestId: body.requestId, intent: expectedIntent,
        workspaceKind: 'document', documentVersion },
      startedAt: new Date('2026-10-16T01:00:00Z'), completedAt: new Date('2026-10-16T01:00:01Z') },
    events: [{ id: 'raw-1', participationId: 'participation-1', userId: 'student-1', requestId: body.requestId,
      content: raw, payload: { detail: { kind: 'model-output', rawSha256: sha(raw), rawLength: raw.length,
        modelAttempt: 1, documentVersion, ...(structured ? { validation: 'valid' } : { effectiveIntent: expectedIntent }) } } }] };
}

test('all document AI UI features have distinct mandatory real-provider gates', () => {
  assert.equal(DOCUMENT_AI_FEATURES.length, 3);
  for (const feature of DOCUMENT_AI_FEATURES) assert.equal(CLASSROOM_REQUIRED_EVIDENCE[feature], 'browser-real-provider');
});

test('actual structured and ordinary edit audit contracts both prove a completed provider task', () => {
  for (const intent of ['proactive-document-comments', 'comment-reply', 'edit']) {
    const value = fixture(intent);
    assert.equal(assertDocumentModelEvidence(value)[0].id, 'raw-1');
  }
});

test('a completed or empty response cannot stand in for valid retained raw provider evidence', () => {
  for (const mutate of [
    value => { value.events = []; },
    value => { value.events[0].content = ''; },
    value => { value.events[0].payload.detail.validation = 'invalid-json'; },
    value => { delete value.events[0].payload.detail.validation; },
    value => { value.events[0].payload.detail.kind = 'invalid-model-response'; },
    value => { value.events[0].payload.detail.rawSha256 = 'another-output'; },
    value => { value.events[0].payload.detail.rawLength++; },
    value => { value.events[0].payload.detail.modelAttempt = 0; },
    value => { value.events[0].payload.detail.documentVersion = 'another-document'; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => assertDocumentModelEvidence(value));
  }
  const ordinary = fixture('edit'); ordinary.events[0].payload.detail.effectiveIntent = 'discuss';
  assert.throws(() => assertDocumentModelEvidence(ordinary), /requested edit intent/);
});

test('raw output, request, document, participation and student identity must all agree', () => {
  for (const mutate of [
    value => { value.task.createdById = 'other-student'; },
    value => { value.task.input.participationId = 'another-classroom-participation'; },
    value => { value.task.input.requestId = 'another-request'; },
    value => { value.task.input.intent = 'discuss'; },
    value => { value.task.input.workspaceKind = 'code'; },
    value => { value.body.documentHtml += '<p>Changed draft.</p>'; },
    value => { value.events[0].userId = 'other-student'; },
    value => { value.events[0].participationId = 'another-classroom-participation'; },
    value => { value.events[0].requestId = 'another-request'; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => assertDocumentModelEvidence(value));
  }
});

test('failed, running, unmeasured and overdue model tasks cannot pass', () => {
  for (const mutate of [
    value => { value.task.status = 'FAILED'; },
    value => { value.task.status = 'RUNNING'; },
    value => { value.task.startedAt = null; },
    value => { value.task.completedAt = null; },
    value => { value.task.completedAt = new Date('2026-10-16T01:02:00Z'); },
    value => { value.task.completedAt = new Date('2026-10-16T00:59:59Z'); },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => assertDocumentModelEvidence(value));
  }
});

test('review stimulus retains the conflicting source facts and separates the auxiliary edit', () => {
  const first = documentAiParagraphs(1); const second = documentAiParagraphs(16);
  for (const fact of ['4只麻雀', '7只麻雀', '东侧40只', '总计44只', '原始日志']) assert.ok(first.review.includes(fact));
  assert.ok(first.review.length >= 180); assert.notEqual(first.review, second.review);
  assert.ok(first.auxiliary.includes('周一')); assert.equal(first.review.includes(first.auxiliary), false);
});

function recoveryFixture({ clearAt = 2500, completeAt = 2000, missingTask = false, corruptReceipt = false } = {}) {
  let elapsed = 0; const evidence = {}; const requests = [];
  const student = { user: { id: 'student-1' }, participation: { id: 'participation-1' } };
  const requestId = 'old-review'; const body = { action: 'proactive-document-comments', requestId,
    courseId: 'course-1', studentId: 'student-1', stageKey: 'make', workspaceKind: 'document',
    paragraphs: [{ candidateId: 'block:p1', blockId: 'p1', blockIndex: 0, targetText: 'Prior saved paragraph.' }],
    documentHtml: '<p>Prior saved paragraph.</p>' };
  const local = { requestId, createdAt: 1, body };
  const version = sha(JSON.stringify(body.documentHtml));
  const config = { student, instanceId: 'course-1', evidence, entries: requests, timeoutMs: 10000,
    now: () => elapsed, wait: async ms => { elapsed += ms; },
    page: { evaluate: async () => elapsed < clearAt ? [local] : [] },
    db: {
      aiTask: { findMany: async () => missingTask ? [] : [{ id: 'task-1',
        status: elapsed >= completeAt ? 'COMPLETED' : elapsed >= 1000 ? 'RUNNING' : 'FAILED',
        error: elapsed < 1000 ? 'AI_PROACTIVE_REVIEW_BUSY' : null,
        input: { requestId, participationId: student.participation.id, intent: body.action,
          workspaceKind: 'document', stageKey: 'make', documentVersion: version, token: elapsed < 1000 ? 'old-lease' : 'new-lease' },
        createdAt: new Date(0), startedAt: new Date(elapsed < 1000 ? 0 : 1000),
        completedAt: elapsed >= completeAt ? new Date(completeAt) : null,
        output: elapsed >= completeAt ? { response: { requestId, status: 'completed', documentVersion: version,
          reviewDecision: { action: body.action, documentVersion: corruptReceipt ? 'wrong-version' : version } } } : null,
      }] },
      aiInteractionEvent: { findMany: async () => [{ id: 'busy-1', requestId, eventType: 'error', createdAt: new Date(0),
        content: 'AI_PROACTIVE_REVIEW_BUSY', payload: { detail: { requestAttemptId: 'old-lease', failureKind: 'capacity', elapsedMs: 15 } } }] },
    },
  };
  return { config, local, evidence, requests, elapsed: () => elapsed };
}

test('recovery waits for natural receipt plus local removal and records capacity/lease transitions separately', async () => {
  const state = recoveryFixture();
  state.requests.push({ body: { requestId: 'old-review' }, at: '2026-10-16T00:00:00Z', status: 503,
    retryAfter: '30', response: { error: 'AI_PROACTIVE_REVIEW_BUSY' }, elapsedMs: 20 });
  const result = await waitForNaturalDocumentReviewRecovery(state.config);
  assert.equal(result.priorRequests, 1); assert.equal(result.capacityRejections, 1);
  assert.ok(result.elapsedMs >= 6000, 'A completed task must not pass before local ACK removal and quiet observation');
  assert.deepEqual(state.evidence.taskTransitions.map(row => row.status), ['FAILED', 'RUNNING', 'COMPLETED']);
  assert.notEqual(state.evidence.taskTransitions[0].attemptHash, state.evidence.taskTransitions[1].attemptHash);
  assert.equal(state.evidence.browserAttempts[0].retryAfter, '30');
  assert.equal(state.evidence.status, 'completed');
  assert.equal(JSON.stringify(state.evidence).includes('old-lease'), false);
  assert.equal(JSON.stringify(state.evidence).includes('new-lease'), false);
});

test('recovery cannot pass for a terminal task whose real browser outbox is still pending', async () => {
  const state = recoveryFixture({ clearAt: Infinity });
  await assert.rejects(waitForNaturalDocumentReviewRecovery(state.config), /did not naturally/);
  assert.equal(state.elapsed(), state.config.timeoutMs);
  assert.equal(state.evidence.status, 'failed'); assert.equal(state.evidence.taskTransitions.at(-1).status, 'COMPLETED');
});

test('local disappearance cannot substitute for a missing or unfinished durable receipt', async () => {
  for (const options of [{ missingTask: true }, { completeAt: Infinity }]) {
    const state = recoveryFixture(options);
    await assert.rejects(waitForNaturalDocumentReviewRecovery(state.config), /did not naturally/);
    assert.equal(state.elapsed(), state.config.timeoutMs); assert.equal(state.evidence.status, 'failed');
  }
});

test('recovery rejects wrong-document receipts and changed immutable request bodies', async () => {
  const wrong = recoveryFixture({ corruptReceipt: true });
  await assert.rejects(waitForNaturalDocumentReviewRecovery(wrong.config), /wrong-version/);
  const changed = recoveryFixture(); const original = changed.config.page.evaluate;
  changed.config.page.evaluate = async () => {
    const rows = await original();
    return changed.elapsed() > 0 ? rows.map(row => ({ ...row, body: { ...row.body, documentHtml: '<p>Changed</p>' } })) : rows;
  };
  await assert.rejects(waitForNaturalDocumentReviewRecovery(changed.config), /immutable content/);
});

test('an empty existing queue does not manufacture a recovery task or wait for a new stimulus', async () => {
  const state = recoveryFixture({ clearAt: 0 });
  state.config.db.aiTask.findMany = async () => { throw new Error('Unexpected DB task query'); };
  const result = await waitForNaturalDocumentReviewRecovery(state.config);
  assert.equal(result.priorRequests, 0); assert.equal(result.elapsedMs, 0);
  assert.deepEqual(state.evidence.taskTransitions, []);
});

test('a stalled read-only observation cannot exceed the recovery deadline indefinitely', async () => {
  const state = recoveryFixture(); state.config.timeoutMs = 20;
  state.config.page.evaluate = () => new Promise(() => {});
  await assert.rejects(waitForNaturalDocumentReviewRecovery(state.config), /observation exceeded/);
  assert.equal(state.evidence.status, 'failed');
});

test('the real local-outbox reader rejects corrupt scope instead of dropping its pending record', async () => {
  const state = recoveryFixture(); const scope = 'course-1:student-1:make:document';
  const key = `openpbl:document-review:v1:${encodeURIComponent(scope)}:old-review`;
  const row = { ...state.local, key, scope, body: JSON.stringify({ ...state.local.body, studentId: 'other-student' }) };
  const storage = { [key]: JSON.stringify(row) };
  Object.defineProperty(storage, 'getItem', { value: name => storage[name] }); Object.freeze(storage);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  state.config.page.evaluate = async (fn, arg) => fn(arg);
  try {
    await assert.rejects(waitForNaturalDocumentReviewRecovery(state.config), /corrupt or belongs to another scope/);
    assert.equal(storage[key], JSON.stringify(row));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('whole-class observation cannot pass an empty outbox before the real initial review timer and final proof', async () => {
  const state = recoveryFixture({ clearAt: 0 });
  const calls = [];
  const result = await waitForNaturalDocumentReviewRecovery({ ...state.config, timeoutMs: 50000,
    minimumObservationMs: 30000, pollMs: 5000, auditEveryPoll: false,
    finalProof: async () => { calls.push(state.elapsed()); return state.elapsed() >= 40000; } });
  assert.deepEqual(calls, [30000, 35000, 40000, 45000]); assert.equal(result.elapsedMs, 45000);
});

test('whole-class missing actual receipt proof fails at the unchanged deadline', async () => {
  const state = recoveryFixture({ clearAt: 0 });
  await assert.rejects(waitForNaturalDocumentReviewRecovery({ ...state.config, pollMs: 2000,
    finalProof: async () => false }), /final coverage/);
  assert.equal(state.elapsed(), state.config.timeoutMs);
});

test('whole-class observation does not poll raw audit or count cancellation as a successful review', async () => {
  const state = recoveryFixture();
  const read = state.config.db.aiTask.findMany;
  state.config.db.aiTask.findMany = async () => (await read()).map(task => ({ ...task, status: 'CANCELLED' }));
  state.config.db.aiInteractionEvent.findMany = async () => { throw new Error('Raw output was polled'); };
  await assert.rejects(waitForNaturalDocumentReviewRecovery({ ...state.config, allowCancelled: false,
    pollMs: 2000, auditEveryPoll: false }), /did not naturally/);
  assert.equal(state.evidence.taskTransitions.at(-1).status, 'CANCELLED');
});


function browserTrafficFixture() {
  let clock = 0;
  const page = new EventEmitter(); page.url = () => 'http://classroom.test/student/ai-collaboration/course-1';
  const observer = observeDocumentAiTraffic(page, 'course-1', 'student-1', { now: () => clock });
  const body = { action: 'proactive-document-comments', requestId: 'review-1', courseId: 'course-1',
    studentId: 'student-1', stageKey: 'make', workspaceKind: 'document', documentHtml: '<p>Evidence</p>', paragraphs: [] };
  const scope = Object.fromEntries(['requestId', 'courseId', 'studentId', 'stageKey', 'workspaceKind'].map(key => [key, body[key]]));
  const send = (method, data = method === 'POST' ? body : scope, origin = 'http://classroom.test') => {
    const req = { method: () => method, postDataJSON: () => data,
      url: () => `${origin}/api/ai-collaboration/document${method === 'GET' ? `?${new URLSearchParams(data)}` : ''}` };
    page.emit('request', req); return req;
  };
  const respond = async (req, status, response) => {
    page.emit('response', { request: () => req, status: () => status, headers: () => ({}), json: async () => response });
    await Promise.resolve(); await Promise.resolve();
  };
  return { page, observer, body, scope, send, respond, setClock: value => { clock = value; },
    matches: input => input.requestId === body.requestId };
}

test('actual same-page POST202 plus GET200 completed is one logical result timed from POST, retaining raw attempts', async () => {
  const state = browserTrafficFixture();
  try {
    const post = state.send('POST'); state.setClock(20);
    await state.respond(post, 202, { requestId: 'review-1', status: 'processing', phase: 'queued' });
    assert.equal(findDocumentAiCompletion(state.observer.entries, state.matches), undefined);
    const processing = state.send('GET'); state.setClock(5000);
    await state.respond(processing, 200, { requestId: 'review-1', status: 'processing', phase: 'running' });
    assert.equal(findDocumentAiCompletion(state.observer.entries, state.matches), undefined);
    const poll = state.send('GET'); state.setClock(110000);
    const receipt = { requestId: 'review-1', status: 'completed', complete: true };
    await state.respond(poll, 200, receipt);
    const result = findDocumentAiCompletion(state.observer.entries, state.matches);
    assert.deepEqual(result.body, state.body); assert.equal(result.response, receipt);
    assert.equal(result.completedElapsedMs, 110000); assert.equal(result.completionTransport.method, 'GET');
    assert.equal(result.acceptedStatus, 202); assert.equal(state.observer.entries[0].status, 202);
    assert.equal(state.observer.entries[0].response.status, 'processing');
    assert.equal(state.observer.entries.length, 3, 'Observation must not issue a request or invent a successful POST');
  } finally { await state.observer.close(); }
});

test('completed receipts from another browser, scope, request, origin or before the POST cannot satisfy the request', async () => {
  const first = browserTrafficFixture(); const other = browserTrafficFixture();
  try {
    first.setClock(50); first.send('POST');
    const foreign = other.send('GET'); other.setClock(100);
    await other.respond(foreign, 200, { requestId: 'review-1', status: 'completed' });
    assert.equal(findDocumentAiCompletion([...first.observer.entries, ...other.observer.entries], first.matches), undefined);
    for (const changed of [{ courseId: 'another' }, { studentId: 'another' }, { stageKey: 'launch' },
      { workspaceKind: 'external-artifact' }, { requestId: 'another' }, { requestId: '' }]) {
      const poll = first.send('GET', { ...first.scope, ...changed });
      await first.respond(poll, 200, { requestId: changed.requestId ?? 'review-1', status: 'completed' });
    }
    const offsite = first.send('GET', first.scope, 'http://other.test');
    await first.respond(offsite, 200, { requestId: 'review-1', status: 'completed' });
    const wrongBody = first.send('GET'); await first.respond(wrongBody, 200, { requestId: 'wrong-response', status: 'completed' });
    first.setClock(1); const old = first.send('GET'); first.setClock(100);
    await first.respond(old, 200, { requestId: 'review-1', status: 'completed' });
    assert.equal(findDocumentAiCompletion(first.observer.entries, first.matches), undefined);
  } finally { await first.observer.close(); await other.observer.close(); }
});

test('synchronous POST200 remains supported, but a retry never restarts the 120s browser budget', async () => {
  const immediate = browserTrafficFixture(); const delayed = browserTrafficFixture();
  try {
    const post = immediate.send('POST'); immediate.setClock(100);
    await immediate.respond(post, 200, { requestId: 'review-1', status: 'completed' });
    assert.equal(findDocumentAiCompletion(immediate.observer.entries, immediate.matches).completedElapsedMs, 100);
    delayed.send('POST'); delayed.setClock(119000); delayed.send('POST');
    const poll = delayed.send('GET'); delayed.setClock(120001);
    await delayed.respond(poll, 200, { requestId: 'review-1', status: 'completed' });
    assert.throws(() => findDocumentAiCompletion(delayed.observer.entries, delayed.matches), /browser deadline/);
  } finally { await immediate.observer.close(); await delayed.observer.close(); }
});

test('waiting for an already accepted request uses only its remaining original deadline', async () => {
  const state = browserTrafficFixture(); let now = 119000; const waits = [];
  try {
    state.send('POST');
    await assert.rejects(waitForDocumentAiCompletion({ entries: state.observer.entries, matches: state.matches,
      now: () => now, wait: async ms => { waits.push(ms); now += ms; } }), /no completed response/);
    assert.equal(now, 120000); assert.equal(waits.reduce((total, ms) => total + ms, 0), 1000);
  } finally { await state.observer.close(); }
});

test('GET receipt projection compares every retained result field and all added identity fields exactly', () => {
  const task = { input: { requestId: 'review-1', conversationId: 'proactive-document-comments', documentVersion: 'version-1' },
    output: { response: { requestId: 'review-1', status: 'completed', complete: true, commentThreads: [{ id: 'comment-1' }] } } };
  const response = { ...task.output.response, conversationId: task.input.conversationId, documentVersion: task.input.documentVersion };
  const entry = { response, completionTransport: { method: 'GET' } };
  assertDocumentBrowserReceipt(task, entry);
  for (const changed of [{ requestId: 'other' }, { conversationId: 'other' }, { documentVersion: 'other' },
    { complete: false }, { commentThreads: [] }, { unexpected: true }]) {
    assert.throws(() => assertDocumentBrowserReceipt(task, { ...entry, response: { ...response, ...changed } }));
  }
  assertDocumentBrowserReceipt(task, { response: task.output.response, completionTransport: { method: 'POST' } });
});


test('an unreadable completed response cannot acknowledge a task and retries must keep the original immutable body', async () => {
  const state = browserTrafficFixture();
  try {
    state.send('POST');
    const poll = state.send('GET');
    state.page.emit('response', { request: () => poll, status: () => 200, headers: () => ({}),
      json: async () => { throw new Error('response body truncated'); } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(state.observer.entries[1].bodyError, 'response body truncated');
    assert.equal(findDocumentAiCompletion(state.observer.entries, state.matches), undefined);
    state.send('POST', { ...state.body, documentHtml: '<p>Changed under the same request ID</p>' });
    assert.throws(() => findDocumentAiCompletion(state.observer.entries, state.matches), /immutable body/);
  } finally { await state.observer.close(); }
});
