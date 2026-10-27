// Actual durable-queue boundary proof. Imported only by the nonce-guarded
// disposable PostgreSQL verifier; child processes repeat the same guard.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { enqueueDocumentReview, QueuedBackgroundReview } from '../src/lib/ai-collaboration/document-review-queue';

type Input = Parameters<typeof enqueueDocumentReview>[0];
const childFlag = '--document-review-capacity-child';
async function isolatedDb() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? '', /^openpbl-research-check-[0-9a-f-]{36}$/);
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'postgres'); assert.equal(url.password, '');
  assert.equal(url.pathname, '/postgres'); assert.ok(url.port);
  const { prisma } = await import('../src/lib/db/client');
  assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
  return prisma;
}
async function send(message: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
}
async function childMain() {
  const prisma = await isolatedDb();
  try {
    const command = new Promise<{ input: Input; sessionVersion: number }>(resolve => process.once('message', message => resolve(message as { input: Input; sessionVersion: number })));
    await send({ kind: 'ready', pid: process.pid });
    const { input, sessionVersion } = await command;
    const { enqueueDocumentReview } = await import('../src/lib/ai-collaboration/document-review-queue');
    const result = await enqueueDocumentReview(input, sessionVersion);
    await send({ kind: 'result', result: result.kind, requestId: input.task.requestId, pid: process.pid });
  } finally { await prisma.$disconnect(); }
}
type Child = { process: ChildProcess; messages: Array<{ kind: string; result?: string; requestId?: string; pid: number }>;
  output: string; exit?: number | null; exited: boolean; error?: Error };
function spawn(): Child {
  const child = fork(fileURLToPath(import.meta.url), [childFlag], { execArgv: process.execArgv,
    env: { ...process.env, REDIS_URL: '', PROVIDER_CONFIG_DATABASE_URL: process.env.DATABASE_URL, PRISMA_CLIENT_ENGINE_TYPE: 'library' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state: Child = { process: child, messages: [], output: '', exited: false };
  child.on('message', message => state.messages.push(message as Child['messages'][number]));
  child.once('exit', code => { state.exit = code; state.exited = true; });
  child.once('error', error => { state.error = error; });
  const capture = (chunk: Buffer) => { state.output = (state.output + chunk.toString()).slice(-16_384); };
  child.stdout!.on('data', capture); child.stderr!.on('data', capture);
  return state;
}
async function waitFor<T>(read: () => T | undefined, label: string, child?: Child): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read(); if (value !== undefined) return value;
    if (child?.error) throw child.error;
    assert.ok(!child?.exited, `${label}: child exited ${child?.exit}\n${child?.output}`);
    await delay(10);
  }
  throw new Error(`Timeout: ${label}\n${child?.output ?? ''}`);
}

export async function verifyDocumentReviewCapacity(makeInput: (actor: number, requestId: string) => Input) {
  const prisma = await isolatedDb();
  const queue = await import('../src/lib/ai-collaboration/document-review-queue');
  const store = await import('../src/lib/ai-collaboration/document-request-store');
  const { readDocumentReviewQueueCounts } = await import('../src/lib/ai-collaboration/document-review-admission');
  const { readDocumentReviewBacklog } = await import('../src/lib/ai-collaboration/document-review-worker');
  const { NextRequest } = await import('next/server');
  const { signStudentToken } = await import('../src/lib/auth/session');
  const { GET } = await import('../src/app/api/ai-collaboration/document/route');
  const originalLimit = process.env.PROACTIVE_REVIEW_LLM_CONCURRENCY;
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID() + randomUUID();
  const inputs: Input[] = []; const children: Child[] = [];
  const actors = [...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => i + 15)];
  const fixture = (actor: number, label: string) => { const value = makeInput(actor, `capacity-${label}-${randomUUID()}`); inputs.push(value); return value; };
  const version = async (value: Input) => (await prisma.user.findUniqueOrThrow({ where: { id: value.task.studentId } })).sessionVersion;
  const enqueue = async (value: Input) => queue.enqueueDocumentReview(value, await version(value));
  const row = (value: Input) => prisma.aiTask.findUniqueOrThrow({ where: { id: store.documentTaskId(value.task.participationId, value.task.requestId) } });
  const counts = () => readDocumentReviewQueueCounts(prisma, queue.DOCUMENT_REVIEW_QUEUE);
  const expectCounts = async (waiting: number, outstanding: number) => {
    const value = await counts(); assert.equal(Number(value.waiting), waiting); assert.equal(Number(value.outstanding), outstanding);
    const backlog = await readDocumentReviewBacklog();
    assert.equal(backlog.queued, waiting); assert.equal(backlog.oldestQueuedAt, value.oldest?.getTime() ?? null);
    return value;
  };
  const cancel = async (value: Input) => { await store.cancelDocumentRequest(value.task); };
  let cleanupOffset = 0;
  const clear = async () => {
    for (const value of inputs.slice(cleanupOffset)) await cancel(value);
    cleanupOffset = inputs.length; await expectCounts(0, 0);
  };
  const claimed = async (actor: number, label: string) => {
    const value = fixture(actor, label); assert.equal((await enqueue(value)).kind, 'queued');
    const job = await queue.claimQueuedDocumentReview(); assert.ok(job); assert.equal(job.snapshot.task.requestId, value.task.requestId);
    return { value, job };
  };
  const pending = async (n: number, actor = 25) => {
    const values: Input[] = [];
    for (let i = 0; i < n; i++) { const value = fixture(actor, `waiting-${i}`); assert.equal((await enqueue(value)).kind, 'queued'); values.push(value); }
    return values;
  };
  const failed = async (job: QueuedBackgroundReview) => assert.equal(await store.failDocumentRequest({ ...job.snapshot.task, token: job.token, error: 'AI_RESPONSE_INVALID_STRUCTURE' }), true);
  const noStaleWrite = async (job: QueuedBackgroundReview) => {
    assert.equal(await queue.renewDocumentReviewLease(job), false);
    assert.equal(await store.prepareDocumentRequestResponse({ ...job.snapshot.task, token: job.token, response: { stale: true } }), false);
    assert.equal(await store.completeDocumentRequest({ ...job.snapshot.task, token: job.token, response: { stale: true }, messages: [] }), false);
    assert.equal(await store.failDocumentRequest({ ...job.snapshot.task, token: job.token, error: 'stale' }), false);
    assert.equal((await queue.rescheduleDocumentReview(job, { code: 'stale', capacity: true })).count, 0);
  };
  const get = async (value: Input, actorValue = value) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actorValue.task.studentId } });
    const token = await signStudentToken({ userId: user.id, studentName: user.displayName, sessionVersion: user.sessionVersion });
    const query = new URLSearchParams({ courseId: value.task.courseId, studentId: actorValue.task.studentId,
      stageKey: value.task.stageKey, workspaceKind: value.task.workspaceKind, requestId: value.task.requestId });
    return GET(new NextRequest(`http://localhost/api/ai-collaboration/document?${query}`, { headers: { Cookie: `${token.cookieName}=${token.token}` } }));
  };
  const receipt = async (value: Input, phase: 'running' | 'queued') => {
    const before = await row(value);
    assert.equal(before.status, 'FAILED');
    const expected = { requestId: value.task.requestId, status: 'processing', phase, error: 'AI_RESPONSE_INVALID_STRUCTURE', retryable: false };
    for (const result of [await store.getDocumentRequest(value.task), ...(await store.listDocumentRequests(value.task)).filter(r => r.requestId === value.task.requestId)]) {
      assert.ok(result); for (const [key, v] of Object.entries(expected)) assert.equal((result as unknown as Record<string, unknown>)[key], v);
    }
    const list = await store.listDocumentRequests(value.task); assert.ok(list.some(r => r.requestId === value.task.requestId), 'Fixture must be included in latest30 scoped list');
    const response = await store.readDocumentRequestReceipt(value.task); assert.equal(response.status, 202);
    for (const [key, v] of Object.entries(expected)) assert.equal(response.body[key], v);
    const http = await get(value); assert.equal(http.status, 200);
    const body = await http.json(); for (const [key, v] of Object.entries(expected)) assert.equal(body[key], v);
    assert.deepEqual(await row(value), before, 'All reads leave task/input/prepared result unchanged');
    const foreign = fixture(29, 'foreign-read'); assert.equal((await get(value, foreign)).status, 404);
    assert.equal(await store.getDocumentRequest({ ...value.task, studentId: foreign.task.studentId }), null);
  };
  const processRace = async (values: Input[]) => {
    const group = values.map(() => { const child = spawn(); children.push(child); return child; });
    await Promise.all(group.map(child => waitFor(() => child.messages.find(m => m.kind === 'ready'), 'child ready', child)));
    assert.equal(new Set(group.map(child => child.process.pid)).size, group.length);
    const versions = await Promise.all(values.map(version));
    await Promise.all(group.map((child, i) => new Promise<void>((resolve, reject) => child.process.send({ input: values[i], sessionVersion: versions[i] }, error => error ? reject(error) : resolve()))));
    const results = await Promise.all(group.map(child => waitFor(() => child.messages.find(m => m.kind === 'result'), 'child result', child)));
    for (let i = 0; i < group.length; i++) {
      assert.equal(results[i].pid, group[i].process.pid); assert.equal(results[i].requestId, values[i].task.requestId);
      await waitFor(() => group[i].exited ? true : undefined, 'child exit'); assert.equal(group[i].exit, 0, group[i].output);
    }
    return results.map(result => result.result);
  };
  try {
    process.env.PROACTIVE_REVIEW_LLM_CONCURRENCY = '8'; await expectCounts(0, 0);
    const terminal = await claimed(0, 'terminal');
    assert.equal((await queue.rescheduleDocumentReview(terminal.job, { code: 'TERMINAL_FIXTURE', terminal: true })).count, 1);
    await prisma.aiTask.update({ where: { id: terminal.job.id }, data: { createdAt: new Date('1970-01-01T00:00:00Z') } });
    await noStaleWrite(terminal.job); assert.equal((await store.getDocumentRequest(terminal.value.task))!.status, 'failed');
    const idle = await pending(80); await expectCounts(80, 80);
    const overflow = fixture(26, 'idle-overflow'); assert.equal((await enqueue(overflow)).kind, 'full'); assert.equal(await store.getDocumentRequest(overflow.task), null);
    assert.equal((await enqueue(idle[0])).kind, 'existing');
    assert.equal((await enqueue({ ...idle[0], task: { ...idle[0].task, fingerprint: 'changed-body' } })).kind, 'conflict');
    assert.equal((await queue.resumeDocumentReview(terminal.value.task)).kind, 'full');
    await clear();

    const active = [];
    for (let i = 0; i < 8; i++) active.push(await claimed(actors[i], `active-${i}`));
    assert.equal(await queue.claimQueuedDocumentReview(), null);
    const first = active[0]; const fixedOldest = new Date('2001-01-01T00:00:00Z');
    await prisma.aiTask.update({ where: { id: first.job.id }, data: { createdAt: fixedOldest } });
    const prepared = { preparedReview: { receipt: { requestId: first.value.task.requestId, status: 'completed', complete: true }, messages: [], auditEvents: [] } };
    assert.equal(await store.prepareDocumentRequestResponse({ ...first.job.snapshot.task, token: first.job.token, response: prepared }), true);
    const original = await row(first.value);
    await pending(79);
    const rivals = [fixture(26, 'cross-process-a'), fixture(27, 'cross-process-b')];
    assert.deepEqual((await processRace(rivals)).sort(), ['full', 'queued']);
    await expectCounts(80, 88);
    assert.deepEqual(await processRace([fixture(28, 'cross-process-full')]), ['full']);
    assert.equal((await enqueue(first.value)).kind, 'existing');
    await failed(first.job); await receipt(first.value, 'running');
    assert.equal((await expectCounts(80, 88)).oldest!.getTime(), fixedOldest.getTime());
    assert.equal(await queue.claimQueuedDocumentReview(), null);
    const failedBeforeResume = await row(first.value);
    assert.equal((await queue.resumeDocumentReview(first.value.task)).kind, 'existing');
    assert.deepEqual(await row(first.value), failedBeforeResume);
    assert.equal((await enqueue(fixture(28, 'fresh-failure-full'))).kind, 'full');
    await prisma.aiTask.update({ where: { id: first.job.id }, data: { leaseUntil: new Date(0) } });
    await receipt(first.value, 'queued'); await expectCounts(81, 88);
    assert.equal((await enqueue(fixture(28, 'expired-failure-full'))).kind, 'full');
    let replacement = await queue.claimQueuedDocumentReview(); assert.ok(replacement);
    // Fairness may choose a never-served student's head first. Release that
    // fixture explicitly, then the original actor remains eligible.
    for (let skipped = 0; replacement.id !== first.job.id && skipped < 8; skipped++) {
      await store.cancelDocumentRequest(replacement.snapshot.task);
      replacement = await queue.claimQueuedDocumentReview(); assert.ok(replacement);
    }
    assert.equal(replacement.id, first.job.id); assert.notEqual(replacement.token, first.job.token);
    assert.deepEqual(replacement.snapshot, first.job.snapshot);
    assert.deepEqual((await row(first.value)).output, original.output);
    assert.deepEqual({ ...(await row(first.value)).input as object, token: first.job.token }, original.input);
    await noStaleWrite(first.job);
    assert.equal(await store.completeDocumentRequest({ ...replacement.snapshot.task, token: replacement.token,
      response: prepared.preparedReview.receipt, messages: [],
      auditEvents: [{ idempotencyKey: `capacity-recovered-${replacement.id}`, eventType: 'policy', actor: 'system', content: 'Retained prepared receipt', payload: {} }],
      validate: tx => queue.assertDocumentReviewScope(tx, replacement!.snapshot) }), true);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: replacement.id } }), 1);
    assert.equal((await get(first.value)).status, 200);
    assert.equal((await (await get(first.value)).json()).status, 'completed');
    assert.equal((await row(terminal.value)).status, 'FAILED');

    const cancellation = active[1]; await failed(cancellation.job);
    const cancellationBefore = await row(cancellation.value);
    assert.equal((await store.cancelDocumentRequest(cancellation.value.task))!.status, 'cancelled');
    assert.equal((await row(cancellation.value)).leaseUntil, null);
    assert.deepEqual((await row(cancellation.value)).input, cancellationBefore.input);
    assert.deepEqual((await row(cancellation.value)).output, cancellationBefore.output);
    await noStaleWrite(cancellation.job);
    assert.equal((await store.readDocumentRequestReceipt(cancellation.value.task)).status, 409);
    await clear();
    console.log('PASS idle80 and8+80, actual cross-process last-slot arbitration, failure-audit reservation, expiry/prepared recovery, terminal and cancellation fencing, actual GET/list/receipt/backlog');

    const own = await claimed(0, 'own-failure');
    await prisma.aiTask.update({ where: { id: own.job.id }, data: { createdAt: new Date('2001-01-01T00:00:00Z') } });
    await failed(own.job);
    await pending(1, 0); await expectCounts(1, 2);
    assert.equal(await queue.claimQueuedDocumentReview(), null, 'Fresh retained failure excludes same-actor successor even with seven free execution slots');
    const beforeDeferral = await row(own.value);
    assert.equal((await queue.rescheduleDocumentReview(own.job, { code: 'AI_PROACTIVE_REVIEW_BUSY', capacity: true })).count, 1);
    assert.equal((await row(own.value)).attemptCount, 0);
    assert.deepEqual((await row(own.value)).input, beforeDeferral.input);
    assert.deepEqual((await row(own.value)).output, beforeDeferral.output);
    await expectCounts(2, 2);
    await prisma.aiTask.update({ where: { id: own.job.id }, data: { availableAt: new Date(0) } });
    const deferred = await queue.claimQueuedDocumentReview(); assert.ok(deferred); assert.equal(deferred.id, own.job.id);
    await failed(deferred);
    await prisma.aiTask.update({ where: { id: own.job.id }, data: { leaseUntil: new Date(0) } });
    await expectCounts(2, 2);
    const ownRecovery = await queue.claimQueuedDocumentReview(); assert.ok(ownRecovery); assert.equal(ownRecovery.id, own.job.id);
    await noStaleWrite(own.job); await noStaleWrite(deferred);
    await prisma.aiTask.update({ where: { id: ownRecovery.id }, data: { leaseUntil: null } });
    await expectCounts(2, 2);
    const missingLease = await queue.claimQueuedDocumentReview(); assert.ok(missingLease); assert.equal(missingLease.id, own.job.id);
    assert.notEqual(missingLease.token, ownRecovery.token);
    await noStaleWrite(ownRecovery); await clear();

    for (const concurrency of [2, 20]) {
      process.env.PROACTIVE_REVIEW_LLM_CONCURRENCY = String(concurrency);
      for (let i = 0; i < concurrency; i++) await claimed(actors[i], `configured-${concurrency}-${i}`);
      await pending(79); assert.equal((await enqueue(fixture(26, `configured-${concurrency}-last`))).kind, 'queued');
      await expectCounts(80, 80 + concurrency);
      assert.equal((await enqueue(fixture(27, `configured-${concurrency}-overflow`))).kind, 'full');
      assert.equal(await queue.claimQueuedDocumentReview(), null);
      if (concurrency === 20) {
        process.env.PROACTIVE_REVIEW_LLM_CONCURRENCY = '2';
        await expectCounts(80, 100); assert.equal((await enqueue(fixture(28, 'lowered-limit'))).kind, 'full');
        assert.equal(await queue.claimQueuedDocumentReview(), null);
      }
      await clear();
    }
    process.env.PROACTIVE_REVIEW_LLM_CONCURRENCY = '8';
    const expired = [];
    for (let i = 0; i < 8; i++) expired.push(await claimed(actors[i], `all-expire-${i}`));
    await pending(80);
    const originals = await prisma.aiTask.findMany({ where: { queueKey: queue.DOCUMENT_REVIEW_QUEUE, status: { in: ['PENDING', 'RUNNING'] } } });
    assert.equal(originals.length, 88);
    await prisma.aiTask.updateMany({ where: { id: { in: expired.map(x => x.job.id) } }, data: { leaseUntil: new Date(0) } });
    await expectCounts(88, 88);
    assert.equal((await enqueue(fixture(28, 'all-expired-overflow'))).kind, 'full');
    const recoveredClaims = [];
    for (let i = 0; i < 8; i++) { const job = await queue.claimQueuedDocumentReview(); assert.ok(job); recoveredClaims.push(job); }
    assert.equal(new Set(recoveredClaims.map(job => job.snapshot.task.studentId)).size, 8);
    assert.equal(await queue.claimQueuedDocumentReview(), null); await expectCounts(80, 88);
    for (const old of originals) {
      const current = await prisma.aiTask.findUniqueOrThrow({ where: { id: old.id } });
      const inputBefore = { ...(old.input as Record<string, unknown>) }; delete inputBefore.token;
      const inputAfter = { ...(current.input as Record<string, unknown>) }; delete inputAfter.token;
      assert.deepEqual(inputAfter, inputBefore); assert.deepEqual(current.output, old.output);
    }
    for (const x of expired) await noStaleWrite(x.job);
    await clear();

    // These are actual concurrent calls on the same PG row, not fabricated
    // outcomes. Cancellation must win over a nonterminal reschedule regardless
    // of which obtains the task lock first; evidence remains immutable.
    const raced = await claimed(0, 'cancel-reschedule-race'); await failed(raced.job);
    const racedBefore = await row(raced.value);
    await Promise.all([store.cancelDocumentRequest(raced.value.task), queue.rescheduleDocumentReview(raced.job, { code: 'BUSY', capacity: true })]);
    assert.equal((await row(raced.value)).status, 'CANCELLED'); assert.equal((await row(raced.value)).leaseUntil, null);
    assert.deepEqual((await row(raced.value)).input, racedBefore.input); assert.deepEqual((await row(raced.value)).output, racedBefore.output);
    await noStaleWrite(raced.job); await clear();
    const reclaimRace = await claimed(0, 'cancel-reclaim-race'); await failed(reclaimRace.job);
    await prisma.aiTask.update({ where: { id: reclaimRace.job.id }, data: { leaseUntil: new Date(0) } });
    const [, maybeClaimed] = await Promise.all([store.cancelDocumentRequest(reclaimRace.value.task), queue.claimQueuedDocumentReview()]);
    assert.equal((await row(reclaimRace.value)).status, 'CANCELLED'); await noStaleWrite(reclaimRace.job);
    if (maybeClaimed) await noStaleWrite(maybeClaimed);
    assert.equal(await queue.claimQueuedDocumentReview(), null); await clear();
    console.log('PASS same-actor failure reservation, missing-lease recovery, configuration2/20 and safe reduction, all8 expired preserve88 tasks, actual cancel/reschedule/reclaim races');
  } finally {
    for (const child of children) if (!child.exited) { child.process.kill('SIGKILL'); await waitFor(() => child.exited ? true : undefined, 'cleanup child exit'); }
    if (originalLimit === undefined) delete process.env.PROACTIVE_REVIEW_LLM_CONCURRENCY; else process.env.PROACTIVE_REVIEW_LLM_CONCURRENCY = originalLimit;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  }
}
if (process.argv[2] === childFlag) {
  childMain().then(() => { process.disconnect?.(); process.exit(0); }, error => { console.error(error); process.disconnect?.(); process.exit(1); });
}
