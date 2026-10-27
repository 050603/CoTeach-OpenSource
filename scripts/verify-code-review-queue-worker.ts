// Added to the existing 60-document proof, never a replacement for it.
// Real isolated PostgreSQL/HTTP/process lifecycles; deterministic output only.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Course, CompanionMessage } from '../src/lib/session/types';
import type { enqueueDocumentReview, enqueueCodeReview, QueuedBackgroundReview, CodeReviewSnapshot } from '../src/lib/ai-collaboration/document-review-queue';
import { isolatedReviewDatabase, parseVerificationProcessIdentity, assertVerificationChildIdentity,
  verifyDocumentReviewProcessCrashes } from './verify-document-review-process-crash';

type DocumentInput = Parameters<typeof enqueueDocumentReview>[0];
type CodeInput = Parameters<typeof enqueueCodeReview>[0];
type Notice = { kind: string; pid: number; startTicks: string; nonce: string; data: Record<string, unknown> };
type OwnedChild = { process: ChildProcess; identity: ReturnType<typeof parseVerificationProcessIdentity>; nonce: string;
  notices: Notice[]; output: string; exit?: { code: number | null; signal: NodeJS.Signals | null }; error?: Error };
const childFlag = '--native-code-queue-child';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let fixtureModelCalls = 0;
type Command = { kind: string; data: Record<string, unknown> };
const childCommands: Command[] = [];
let pendingCommand: ((value: Command) => void) | undefined;

async function until<T>(read: () => T | undefined, label: string, child?: OwnedChild): Promise<T> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const value = read(); if (value !== undefined) return value;
    if (child?.error) throw child.error;
    assert.ok(!child?.exit, `${label}: child exited ${JSON.stringify(child?.exit)}\n${child?.output}`);
    await delay(10);
  }
  throw new Error(`Timed out: ${label}\n${child?.output ?? ''}`);
}

function currentChild(child: OwnedChild) {
  const actual = parseVerificationProcessIdentity(readFileSync(`/proc/${child.identity.pid}/stat`, 'utf8'));
  assertVerificationChildIdentity(child.identity, actual, process.pid);
}

function spawnOwned(kind: 'service' | 'caller', cwd: string, environment: Partial<NodeJS.ProcessEnv> = {}): OwnedChild {
  const nonce = randomUUID();
  const child = fork(fileURLToPath(import.meta.url), [childFlag, kind], { cwd, execArgv: process.execArgv,
    env: { ...process.env, ...environment, OPENPBL_REVIEW_HTTP_NONCE: nonce, REDIS_URL: '',
      PROVIDER_CONFIG_DATABASE_URL: process.env.DATABASE_URL, OPENPBL_COURSE_READ_WORKERS: '0',
      OPENPBL_COURSE_READ_DATABASE_URL: '', OPENPBL_LLM_ENDPOINT: 'http://127.0.0.1:1/v1',
      OPENPBL_LLM_API_KEY: 'isolated-fixture-not-a-real-key', OPENPBL_LLM_MODEL: 'native-queue-fixture' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  assert.ok(child.pid);
  const identity = parseVerificationProcessIdentity(readFileSync(`/proc/${child.pid}/stat`, 'utf8'));
  assertVerificationChildIdentity(identity, identity, process.pid);
  const result: OwnedChild = { process: child, nonce, identity, notices: [], output: '' };
  child.on('message', message => result.notices.push(message as Notice));
  child.once('exit', (code, signal) => { result.exit = { code, signal }; });
  child.once('error', error => { result.error = error; });
  const capture = (chunk: Buffer) => { result.output = (result.output + chunk.toString()).slice(-16_384); };
  child.stdout!.on('data', capture); child.stderr!.on('data', capture);
  return result;
}

async function notice(child: OwnedChild, kind: string): Promise<Notice> {
  const result = await until(() => child.notices.find(item => item.kind === kind), kind, child);
  assert.equal(result.pid, child.identity.pid); assert.equal(result.startTicks, child.identity.startTicks);
  assert.equal(result.nonce, child.nonce);
  if (!child.exit) currentChild(child);
  return result;
}

async function send(child: OwnedChild, kind: string, data: Record<string, unknown> = {}) {
  currentChild(child);
  await new Promise<void>((resolve, reject) => child.process.send({ kind, data, nonce: child.nonce }, error => error ? reject(error) : resolve()));
}

async function sendNotice(kind: string, data: Record<string, unknown> = {}) {
  assert.ok(process.send && process.connected);
  const nonce = process.env.OPENPBL_REVIEW_HTTP_NONCE;
  assert.match(nonce ?? '', /^[0-9a-f-]{36}$/);
  const identity = parseVerificationProcessIdentity(readFileSync(`/proc/${process.pid}/stat`, 'utf8'));
  await new Promise<void>((resolve, reject) => process.send!({ kind, data, pid: process.pid,
    startTicks: identity.startTicks, nonce }, error => error ? reject(error) : resolve()));
}

function command(): Promise<Command> {
  const waiting = childCommands.shift();
  if (waiting) return Promise.resolve(waiting);
  assert.equal(pendingCommand, undefined, 'One command consumer per owned child');
  return new Promise(resolve => { pendingCommand = resolve; });
}

function receiveCommand(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const message = value as Record<string, unknown>;
  if (message.nonce !== process.env.OPENPBL_REVIEW_HTTP_NONCE || typeof message.kind !== 'string'
    || !message.data || typeof message.data !== 'object') return;
  const next = { kind: message.kind, data: message.data as Record<string, unknown> };
  if (pendingCommand) { const resolve = pendingCommand; pendingCommand = undefined; resolve(next); }
  else { assert.ok(childCommands.length < 16, 'Bounded verification IPC inbox'); childCommands.push(next); }
}

async function executeFixture(job: QueuedBackgroundReview): Promise<Response> {
  const queue = await import('../src/lib/ai-collaboration/document-review-queue');
  const store = await import('../src/lib/ai-collaboration/document-request-store');
  const task = job.snapshot.task;
  if (job.snapshot.version === 2) {
    const { resumeCodeRequest } = await import('../src/lib/ai-collaboration/code-request');
    const resumed = await resumeCodeRequest(task, { token: job.token, preparedResponse: job.preparedResponse },
      tx => queue.assertDocumentReviewScope(tx, job.snapshot));
    if (resumed.response) return resumed.response;
    fixtureModelCalls++;
    return resumed.finish!({ kind: 'review', findings: [], message: 'Native structural fixture; no code changes.',
      originalArtifactVersion: task.documentVersion }, [{ id: `mixed-checkpoint-${job.id}`, role: 'system-trigger',
      visibility: 'teacher-only', content: 'OPENPBL_CODE_COMMENT_REVIEW:native-structural-fixture', createdAt: '2026-01-01T00:00:00.000Z' }],
    [{ courseId: task.courseId, studentId: task.studentId, stageKey: task.stageKey, source: 'system',
      requestId: task.requestId, eventType: 'policy', actorRole: 'system', content: 'Deterministic code fixture.' }]);
  }
  fixtureModelCalls++;
  const receipt = { requestId: task.requestId, status: 'completed', documentVersion: task.documentVersion,
    reviewDecision: { action: task.intent, documentVersion: task.documentVersion }, complete: true };
  const messages: CompanionMessage[] = [{ id: `mixed-checkpoint-${job.id}`, role: 'system-trigger', visibility: 'teacher-only',
    content: 'OPENPBL_DOCUMENT_COMMENT_REVIEW:native-structural-fixture', createdAt: '2026-01-01T00:00:00.000Z' }];
  const auditEvents: NonNullable<Parameters<typeof store.completeDocumentRequest>[0]['auditEvents']> = [{
    idempotencyKey: `mixed-review-${job.id}`, eventType: 'policy', actor: 'system', content: 'Deterministic document fixture.',
    payload: { documentVersion: task.documentVersion } }];
  assert.equal(await store.prepareDocumentRequestResponse({ ...task, token: job.token,
    response: { preparedReview: { receipt, messages, auditEvents } } }), true);
  assert.equal(await store.completeDocumentRequest({ ...task, token: job.token, response: receipt, messages, auditEvents,
    validate: tx => queue.assertDocumentReviewScope(tx, job.snapshot) }), true);
  return Response.json(receipt);
}

async function serviceChild() {
  await sendNotice('service-booted');
  const prisma = await isolatedReviewDatabase();
  let deniedOutbound = 0;
  globalThis.fetch = async () => { deniedOutbound++; throw new Error('Native proof forbids outbound/model HTTP'); };
  const first = await command(); assert.equal(first.kind, 'start');
  const { signStudentToken } = await import('../src/lib/auth/session');
  const { NextRequest } = await import('next/server');
  const { POST, GET } = await import('../src/app/api/ai-collaboration/code/route');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: String(first.data.studentId) } });
  const signed = await signStudentToken({ userId: user.id, studentName: user.displayName, sessionVersion: user.sessionVersion });
  const sockets = new Set<import('node:net').Socket>();
  let handlerFailure: unknown;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      assert.equal(incoming.socket.remoteAddress, '127.0.0.1');
      assert.equal(incoming.headers['x-openpbl-native-proof'], first.data.httpNonce);
      const parsed = new URL(incoming.url ?? '', 'http://127.0.0.1');
      assert.equal(parsed.pathname, '/api/ai-collaboration/code');
      assert.ok(incoming.method === 'POST' || incoming.method === 'GET');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of incoming) { const data = Buffer.from(chunk); bytes += data.length; assert.ok(bytes <= 200_000); chunks.push(data); }
      const abort = new AbortController();
      outgoing.on('close', () => { if (!outgoing.writableFinished) abort.abort(); });
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const request = new NextRequest(`http://127.0.0.1:${address.port}${incoming.url}`, { method: incoming.method,
        headers, signal: abort.signal, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const response = await (incoming.method === 'POST' ? POST(request) : GET(request));
      const responseBody = Buffer.from(await response.arrayBuffer());
      await sendNotice('accepted', { status: response.status, method: incoming.method,
        clientRequestId: incoming.headers['x-openpbl-case'] });
      if (incoming.headers['x-openpbl-drop-ack'] === '1' && response.status === 202) { outgoing.destroy(); return; }
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.end(responseBody);
    })().catch(error => { handlerFailure = error; outgoing.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  assert.ok(![3000, 3002].includes(address.port));
  await sendNotice('ready', { origin: `http://127.0.0.1:${address.port}`, cookie: `${signed.cookieName}=${signed.token}` });
  try {
    while (true) {
      const next = await command();
      if (next.kind === 'stop') break;
      assert.equal(next.kind, 'drain');
      const queue = await import('../src/lib/ai-collaboration/document-review-queue');
      const { runQueuedDocumentReview } = await import('../src/lib/ai-collaboration/document-review-worker');
      const job = await queue.claimQueuedDocumentReview(); assert.ok(job);
      assert.equal(job.id, next.data.taskId);
      await runQueuedDocumentReview(job, new AbortController().signal, executeFixture);
      assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: job.id } })).status, 'COMPLETED');
      assert.ifError(handlerFailure); assert.equal(deniedOutbound, 0);
      await sendNotice('drained', { taskId: job.id, fixtureModelCalls, outboundModelCalls: deniedOutbound });
    }
    assert.ifError(handlerFailure); assert.equal(deniedOutbound, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
}

async function callerChild() {
  await sendNotice('ready');
  const next = await command(); assert.equal(next.kind, 'request');
  const target = new URL(String(next.data.url));
  assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
  assert.ok(target.port && !['3000', '3002'].includes(target.port));
  assert.equal(target.pathname, '/api/ai-collaboration/code');
  const payload = next.data.method === 'GET' ? undefined : JSON.stringify(next.data.body);
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = httpRequest(target, { method: String(next.data.method), agent: false, headers: {
      Cookie: String(next.data.cookie), Origin: target.origin, 'Content-Type': 'application/json',
      'X-OpenPBL-Role': 'student', 'X-OpenPBL-Native-Proof': String(next.data.httpNonce),
      'X-OpenPBL-Case': String(next.data.caseId), ...(next.data.dropAck ? { 'X-OpenPBL-Drop-Ack': '1' } : {}),
    } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 64_000) request.destroy(new Error('Unexpected large receipt')); else chunks.push(chunk); });
      response.once('end', () => { response.destroy(); request.destroy(); resolve({ status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString()), clientConnectionClosed: true }); });
      response.once('error', reject);
    });
    request.setTimeout(15_000, () => request.destroy(new Error('Native proof HTTP timeout')));
    request.once('error', error => {
      if (next.data.dropAck && 'code' in error && error.code === 'ECONNRESET') resolve({ acknowledgementLost: true, clientConnectionClosed: true });
      else reject(error);
    });
    request.end(payload);
  });
  await sendNotice('result', result);
}

async function stopOwned(child: OwnedChild) {
  if (!child.exit) { currentChild(child); assert.equal(child.process.kill('SIGKILL'), true); }
  await until(() => child.exit, 'owned child cleanup');
  assert.equal(child.process.connected, false);
}

async function readAlias(prisma: Awaited<ReturnType<typeof isolatedReviewDatabase>>, participationId: string, clientRequestId: string) {
  const [alias] = await prisma.$queryRaw<Array<{ taskId: string; requestBody: Record<string, unknown> }>>`
    SELECT "taskId", "requestBody" FROM "AiTaskRequestAlias"
    WHERE "participationId" = ${participationId} AND "clientRequestId" = ${clientRequestId}`;
  assert.ok(alias, 'Actual caller alias must be committed with its task');
  return alias;
}

async function verifyHttpCallerLifecycle(makeInput: (requestId: string) => CodeInput, foreignStudentId: string) {
  const prisma = await isolatedReviewDatabase();
  const queue = await import('../src/lib/ai-collaboration/document-review-queue');
  const { runQueuedDocumentReview } = await import('../src/lib/ai-collaboration/document-review-worker');
  const temporary = mkdtempSync(path.join(tmpdir(), 'openpbl-code-queue-http-'));
  const children: OwnedChild[] = [];
  const initial = makeInput(`http-fixture-${randomUUID()}`);
  const httpNonce = randomUUID();
  const service = spawnOwned('service', temporary, { JWT_SECRET: randomUUID() + randomUUID(),
    DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED: 'false' }); children.push(service);
  try {
    await notice(service, 'service-booted');
    await send(service, 'start', { studentId: initial.task.studentId, httpNonce });
    const ready = (await notice(service, 'ready')).data;
    const perform = async (body: Record<string, unknown>, options: { dropAck?: boolean; get?: boolean } = {}) => {
      const caller = spawnOwned('caller', temporary); children.push(caller);
      await notice(caller, 'ready');
      const caseId = randomUUID();
      const params = new URLSearchParams({ courseId: String(body.courseId), studentId: String(body.studentId),
        stageKey: String(body.stageKey), language: String(body.language), requestId: String(body.requestId) });
      await send(caller, 'request', { url: `${ready.origin}/api/ai-collaboration/code${options.get ? `?${params}` : ''}`,
        cookie: ready.cookie, httpNonce, caseId, body, method: options.get ? 'GET' : 'POST', dropAck: options.dropAck });
      const result = (await notice(caller, 'result')).data;
      const exit = await until(() => caller.exit, 'caller exits after closing its socket');
      assert.deepEqual(exit, { code: 0, signal: null }, caller.output);
      const accepted = await until(() => service.notices.find(item => item.kind === 'accepted' && item.data.clientRequestId === caseId), 'actual handler accepted');
      assert.equal(accepted.data.status, options.dropAck ? 202 : result.status);
      return result;
    };
    for (const dropAck of [false, true]) {
      const input = makeInput(`http-${dropAck ? 'lost-ack' : 'caller-exit'}-${randomUUID()}`);
      const body = input.body;
      const result = await perform(body, { dropAck });
      if (dropAck) assert.equal(result.acknowledgementLost, true);
      else assert.equal(result.status, 202);
      const alias = await readAlias(prisma, input.task.participationId, String(body.requestId));
      assert.deepEqual(alias.requestBody, body, 'Alias stores the complete original body, including the original client ID');
      const pending = await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } });
      assert.equal(pending.status, 'PENDING', 'The detached worker has not yet been allowed to run');
      const replay = await perform(body); assert.equal(replay.status, 202);
      assert.equal((await readAlias(prisma, input.task.participationId, String(body.requestId))).taskId, alias.taskId);
      assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } }), pending);
      const conflict = await perform({ ...body, message: 'Changed original payload, same caller ID' });
      assert.equal(conflict.status, 409);
      const beforeWrongAction = { messages: await prisma.aiMessage.count(), audits: await prisma.aiInteractionEvent.count() };
      const wrongAction = await perform({ ...body, action: 'reset-conversation' });
      assert.equal(wrongAction.status, 409, 'An existing client ID binds the entire original operation before reset side effects');
      assert.deepEqual({ messages: await prisma.aiMessage.count(), audits: await prisma.aiInteractionEvent.count() }, beforeWrongAction);
      assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } }), pending);
      const foreign = await perform({ ...body, studentId: foreignStudentId });
      assert.equal(foreign.status, 403, 'A real JWT cannot replay another student body');
      if (dropAck) {
        const failTerminal = async () => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1) await prisma.aiTask.update({ where: { id: alias.taskId }, data: { availableAt: new Date(0) } });
            const job = await queue.claimQueuedDocumentReview(); assert.ok(job); assert.equal(job.id, alias.taskId);
            assert.equal(job.attemptCount, attempt);
            await runQueuedDocumentReview(job, new AbortController().signal,
              async () => Response.json({ error: 'NATIVE_LOCAL_FAILURE_FIXTURE' }, { status: 503 }));
          }
          const failed = await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } });
          assert.equal(failed.status, 'FAILED'); assert.equal(failed.attemptCount, 3); assert.equal(failed.leaseUntil, null);
          return failed;
        };
        const failed = await failTerminal();
        const retryCommand = { courseId: body.courseId, studentId: body.studentId, stageKey: body.stageKey, language: body.language,
          action: 'retry-code-background', requestId: randomUUID(), targetRequestId: body.requestId };
        const aliasCount = async () => (await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM "AiTaskRequestAlias" WHERE "participationId" = ${input.task.participationId}`)[0].count;
        const aliasesBeforeMissingId = await aliasCount();
        const missingCommandId: Record<string, unknown> = { ...retryCommand }; delete missingCommandId.requestId;
        const missingId = await perform(missingCommandId); assert.equal(missingId.status, 400);
        assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } }), failed);
        assert.equal(await aliasCount(), aliasesBeforeMissingId, 'A missing stable command ID cannot create aliases or replenish attempts');
        const retry = await perform(retryCommand); assert.equal(retry.status, 202);
        assert.equal((retry.body as Record<string, unknown>).requestId, body.requestId);
        const resumed = await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } });
        assert.equal(resumed.status, 'PENDING'); assert.equal(resumed.attemptCount, 0); assert.deepEqual(resumed.input, failed.input);
        assert.equal((await readAlias(prisma, input.task.participationId, retryCommand.requestId)).taskId, alias.taskId);
        const failedAgain = await failTerminal();
        const sameCommand = await perform(retryCommand); assert.equal(sameCommand.status, 200);
        assert.equal((sameCommand.body as Record<string, unknown>).status, 'failed');
        assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } }), failedAgain,
          'Replaying an already accepted retry command cannot replenish attempts after a later failure');
        const newCommand = await perform({ ...retryCommand, requestId: randomUUID() }); assert.equal(newCommand.status, 202);
        assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } })).attemptCount, 0);
        console.log('PASS real HTTP retry-command persistence', JSON.stringify({ taskReused: true, firstBudget: 3, secondBudget: 3,
          sameCommandReplenishesAttempts: false, explicitNewCommandAccepted: true,
          availabilityClock: 'only this fixture backoff advanced between actual worker failures; no production timing assertion',
          model: 'six local 503 fixtures; no provider calls' }));
      }
      await send(service, 'drain', { taskId: alias.taskId });
      const drained = await until(() => service.notices.find(item => item.kind === 'drained' && item.data.taskId === alias.taskId), 'detached worker completes', service);
      assert.equal(drained.data.outboundModelCalls, 0);
      const completed = await perform(body, { get: true }); assert.equal(completed.status, 200);
      const receipt = completed.body as Record<string, unknown>;
      assert.equal(receipt.requestId, body.requestId); assert.equal(receipt.status, 'completed');
      const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: alias.taskId } });
      assert.equal(receipt.canonicalRequestId, (row.input as Record<string, unknown>).requestId);
      assert.notEqual(receipt.requestId, receipt.canonicalRequestId);
      console.log('PASS actual loopback code POST/caller exit', JSON.stringify({ acknowledgement: dropAck ? 'socket-destroyed-after-durable-202-before-delivery' : '202-read-before-caller-exit',
        servicePid: service.identity.pid, serviceStartTicks: service.identity.startTicks, originalBodyPreserved: true,
        idempotentReplay: true, changedBodyStatus: 409, crossActionStatus: 409, crossActionFactsAdded: 0,
        foreignStudentStatus: 403, pollingStatus: 200,
        documentAdmissionEnabled: false, model: 'deterministic-local-fixture', outboundModelCalls: 0 }));
    }
    await send(service, 'stop');
    assert.deepEqual(await until(() => service.exit, 'HTTP service exits'), { code: 0, signal: null }, service.output);
  } finally {
    const stopped = await Promise.allSettled(children.map(stopOwned));
    assert.ok(stopped.every(result => result.status === 'fulfilled'), 'Every owned HTTP/caller child must exit before fixture directory cleanup');
    console.log('PASS code HTTP owned child cleanup', JSON.stringify({ children: children.map(child => ({
      pid: child.identity.pid, startTicks: child.identity.startTicks, exit: child.exit, ipcDisconnected: !child.process.connected })),
    source: 'own loopback HTTP wrapper; no full Next application or browser launched' }));
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function verifyMixedCodeReviewQueue(makeDocumentInput: (actor: number, requestId: string) => DocumentInput) {
  const prisma = await isolatedReviewDatabase();
  const queue = await import('../src/lib/ai-collaboration/document-review-queue');
  const store = await import('../src/lib/ai-collaboration/document-request-store');
  const { runQueuedDocumentReview } = await import('../src/lib/ai-collaboration/document-review-worker');
  const { createPblTemplateCourse, encodePblTemplate } = await import('../src/lib/platform/pbl-template');
  const { createCodeArtifact } = await import('../src/lib/ai-collaboration/code-artifact');
  const { readCodeBackgroundAlias } = await import('../src/lib/ai-collaboration/code-background-alias');
  assert.equal(await prisma.aiTask.count({ where: { queueKey: queue.DOCUMENT_REVIEW_QUEUE, status: { in: ['PENDING', 'RUNNING'] } } }), 0);
  const source = makeDocumentInput(0, 'native-code-fixture-anchor');
  const originalInstance = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: source.task.courseId },
    include: { activity: { include: { chapter: true } }, templateVersion: { include: { template: true } } } });
  const activity = await prisma.activity.create({ data: { chapterId: originalInstance.activity.chapterId, title: 'Native code queue', position: 1, type: 'CLASSROOM' } });
  const template = await prisma.classroomTemplate.create({ data: { ownerId: originalInstance.templateVersion.template.ownerId, title: 'Native code queue' } });
  const design = createPblTemplateCourse('native-design', { name: 'Native code queue', stages: source.course.stages,
    pblConfig: { ...source.course.pblConfig!, makeArtifactMode: 'python' } });
  const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: 'PUBLISHED',
    snapshot: JSON.parse(JSON.stringify(encodePblTemplate(design))) } });
  const runtime = { version: 1, stageVersion: 1, currentStageIndex: 0, makeArtifactMode: 'python' };
  const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id,
    status: 'TEACHING', runtimeConfig: runtime } });
  const participations = await Promise.all(Array.from({ length: 30 }, async (_, actor) => {
    const input = makeDocumentInput(actor, 'native-participation');
    const existing = await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: input.task.participationId } });
    return prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: existing.enrollmentId } });
  }));
  const course: Course = { ...design, id: instance.id, status: 'teaching', students: source.course.students,
    currentStageIndex: 0, stageVersion: runtime.stageVersion, stages: source.course.stages,
    platformContext: { offeringId: originalInstance.activity.chapter.offeringId, activityId: activity.id,
      templateId: template.id, templateVersionId: version.id } };
  const makeCodeInput = (actor: number, requestId: string, intent: 'proactive-review' | 'code-task-starters' = actor % 2 ? 'code-task-starters' : 'proactive-review'): CodeInput => {
    const original = makeDocumentInput(actor, 'identity');
    const artifact = createCodeArtifact('python');
    artifact.files[0].content = `# Native fixture ${requestId}\n# 东侧40只，西侧7只\nprint(40 + 7)\n`;
    const body = { courseId: instance.id, studentId: original.task.studentId, stageKey: 'make', language: 'python',
      ...(intent === 'proactive-review' ? { intent } : { action: intent }), artifact, mode: 'discuss', requestId,
      selection: null, run: null, fixtureMetadata: { preserved: ['原始正文', 40, 7], nested: { all: true } } };
    const context = { artifact, selection: null, run: null, mode: 'discuss', requirements: { title: course.name, raw: '原始课程条件' } };
    const prompts = { system: 'Deterministic queue structural fixture only.', user: `Review the exact immutable code: ${artifact.files[0].content}` };
    return { course, body, prompts, context, task: { ...original.task,
      courseId: instance.id, participationId: participations[actor].id, requestId: `code-background:${digest({ prompts, context, intent })}`,
      workspaceKind: 'code:python', threadStageKey: `ai-code-${intent === 'proactive-review' ? 'comments' : 'collaboration'}:make:python`,
      conversationId: 'native-code-conversation', documentVersion: digest(artifact), intent, message: '', history: [],
      fingerprint: queue.codeReviewFingerprint({ body, prompts, context }) } };
  };
  const sessionVersion = async (input: DocumentInput | CodeInput) => (await prisma.user.findUniqueOrThrow({ where: { id: input.task.studentId } })).sessionVersion;
  const enqueue = async (input: DocumentInput | CodeInput) => 'body' in input
    ? queue.enqueueCodeReview(input, await sessionVersion(input), { requestId: String(input.body.requestId), body: input.body })
    : queue.enqueueDocumentReview(input, await sessionVersion(input));
  const queued: Array<{ input: DocumentInput | CodeInput; batch: number; actor: number; id: string }> = [];
  for (const batch of [0, 1]) for (let actor = 0; actor < 30; actor++) {
    const label = `mixed-${batch}-${actor}-${randomUUID()}`;
    const input = (actor + batch) % 2 ? makeCodeInput(actor, label) : makeDocumentInput(actor, label);
    assert.equal((await enqueue(input)).kind, 'queued');
    queued.push({ input, batch, actor, id: store.documentTaskId(input.task.participationId, input.task.requestId) });
  }
  assert.equal(queued.filter(item => 'body' in item.input).length, 30);
  const byId = new Map(queued.map(item => [item.id, item]));
  const order: typeof queued = [];
  const callsBefore = fixtureModelCalls;
  while (order.length < queued.length) {
    const claims = (await Promise.all(Array.from({ length: 30 }, () => queue.claimQueuedDocumentReview())))
      .filter((job): job is QueuedBackgroundReview => job !== null);
    assert.ok(claims.length > 0 && claims.length <= 8);
    assert.equal(new Set(claims.map(job => job.snapshot.task.studentId)).size, claims.length);
    for (const job of claims) { assert.ok(byId.has(job.id)); order.push(byId.get(job.id)!); await queue.assertDocumentReviewScope(prisma, job.snapshot); }
    await Promise.all(claims.map(job => runQueuedDocumentReview(job, new AbortController().signal, executeFixture)));
  }
  assert.ok(order.slice(0, 30).every(item => item.batch === 0));
  assert.equal(new Set(order.slice(0, 30).map(item => item.actor)).size, 30);
  assert.equal(fixtureModelCalls - callsBefore, 60);
  assert.equal(await prisma.aiTask.count({ where: { id: { in: queued.map(item => item.id) }, status: 'COMPLETED' } }), 60);
  for (const item of queued) {
    assert.equal((await enqueue(item.input)).kind, 'existing');
    if ('body' in item.input) {
      const body = item.input.body;
      const immutable = await prisma.aiTask.findUniqueOrThrow({ where: { id: item.id } });
      const snapshot = (immutable.input as { reviewSnapshot: { body: unknown; prompts: unknown; context: unknown } }).reviewSnapshot;
      assert.deepEqual(snapshot.body, body, 'Complete executable body survives the PostgreSQL JSONB roundtrip');
      assert.deepEqual(snapshot.prompts, item.input.prompts);
      assert.deepEqual(snapshot.context, item.input.context);
      const identity = { ...item.input.task, requestId: String(body.requestId) };
      const alias = await readAlias(prisma, identity.participationId, identity.requestId);
      assert.equal(alias.taskId, item.id); assert.deepEqual(alias.requestBody, body);
      const receipt = await readCodeBackgroundAlias(identity, body); assert.ok(receipt); assert.equal(receipt.status, 200);
      const response = await receipt.json(); assert.equal(response.requestId, body.requestId);
      assert.equal(response.canonicalRequestId, item.input.task.requestId);
      assert.equal((await readCodeBackgroundAlias(identity, { ...body, message: 'different' }))!.status, 409);
      assert.equal(await readCodeBackgroundAlias({ ...identity, studentId: makeDocumentInput((item.actor + 1) % 30, 'foreign').task.studentId }), null);
    }
  }
  console.log('PASS additional mixed queue: 30 document + 30 code tasks / 30 students; shared <=8 slots and one active per student; every first batch before repeats; original body/alias replay/foreign scope preserved');

  for (const change of ['session', 'status', 'role', 'stage', 'mode'] as const) {
    const input = makeCodeInput(29, `code-revocation-${change}-${randomUUID()}`);
    assert.equal((await enqueue(input)).kind, 'queued'); const job = await queue.claimQueuedDocumentReview(); assert.ok(job);
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: input.task.studentId } });
    const before = fixtureModelCalls;
    try {
      if (change === 'session') await prisma.user.update({ where: { id: owner.id }, data: { sessionVersion: { increment: 1 } } });
      if (change === 'status') await prisma.user.update({ where: { id: owner.id }, data: { status: 'DISABLED' } });
      if (change === 'role') await prisma.user.update({ where: { id: owner.id }, data: { role: 'TEACHER' } });
      if (change === 'stage') await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { ...runtime, stageVersion: 2 } } });
      if (change === 'mode') await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { ...runtime, makeArtifactMode: 'c' } } });
      await runQueuedDocumentReview(job, new AbortController().signal, executeFixture);
      assert.equal(fixtureModelCalls, before);
      const final = await prisma.aiTask.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(final.status, 'FAILED');
      assert.equal(final.error, change === 'stage' || change === 'mode' ? 'REVIEW_STAGE_CHANGED' : 'REVIEW_IDENTITY_CHANGED');
      assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: job.id } }), 0);
      assert.equal(final.output, null);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { sessionVersion: owner.sessionVersion, status: owner.status, role: owner.role } });
      await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: runtime } });
    }
  }
  console.log('PASS code live identity/session/role/stage/mode revocation rejects before fixture model calls or facts');

  for (const change of ['session', 'stage'] as const) {
    const original = makeCodeInput(29, `code-generation-${change}-${randomUUID()}`);
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: original.task.studentId } });
    const baseId = store.documentTaskId(original.task.participationId, original.task.requestId);
    assert.equal((await enqueue(original)).kind, 'queued');
    const base = await prisma.aiTask.findUniqueOrThrow({ where: { id: baseId } });
    const savedSnapshot = (base.input as unknown as { reviewSnapshot: CodeReviewSnapshot }).reviewSnapshot;
    const callsBeforeGeneration = fixtureModelCalls;
    try {
      if (change === 'session') await prisma.user.update({ where: { id: owner.id }, data: { sessionVersion: { increment: 1 } } });
      else await prisma.classroomInstance.update({ where: { id: instance.id }, data: {
        runtimeConfig: { ...runtime, currentStageIndex: 1, stageVersion: 2 },
      } });
      const obsolete = await queue.claimQueuedDocumentReview(); assert.ok(obsolete); assert.equal(obsolete.id, baseId);
      await runQueuedDocumentReview(obsolete, new AbortController().signal, executeFixture);
      const rejected = await prisma.aiTask.findUniqueOrThrow({ where: { id: baseId } });
      assert.equal(rejected.status, 'FAILED');
      assert.equal(rejected.error, change === 'session' ? 'REVIEW_IDENTITY_CHANGED' : 'REVIEW_STAGE_CHANGED');
      assert.equal(fixtureModelCalls, callsBeforeGeneration);
      assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: baseId } }), 0);
      if (change === 'stage') await prisma.classroomInstance.update({ where: { id: instance.id }, data: {
        runtimeConfig: { ...runtime, stageVersion: 3 },
      } });
      // A client request ID changes; all original model input stays byte-for-byte
      // equivalent. The database, not the caller, supplies the new live guard.
      const freshCourse = { ...original.course, stageVersion: change === 'stage' ? 3 : runtime.stageVersion };
      if (change === 'stage') {
        const stale = { ...original, body: { ...original.body, requestId: randomUUID() } };
        const countBefore = await prisma.aiTask.count();
        await assert.rejects(enqueue(stale), { code: 'REVIEW_STAGE_CHANGED' },
          'A stale projected course must not bind original prompts to a newer live guard');
        assert.equal(await prisma.aiTask.count(), countBefore);
        assert.equal((await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM "AiTaskRequestAlias"
          WHERE "participationId" = ${original.task.participationId} AND "clientRequestId" = ${stale.body.requestId}`)[0].count, 0);
      }
      const next = { ...original, course: freshCourse, body: { ...original.body, requestId: randomUUID() } };
      const queuedGeneration = await enqueue(next);
      assert.equal(queuedGeneration.kind, 'queued');
      if (queuedGeneration.kind !== 'queued') throw new Error('Expected a new live generation');
      const generationId = store.documentTaskId(original.task.participationId, queuedGeneration.state.requestId);
      assert.notEqual(generationId, baseId);
      const generation = await prisma.aiTask.findUniqueOrThrow({ where: { id: generationId } });
      const snapshot = (generation.input as unknown as { reviewSnapshot: CodeReviewSnapshot }).reviewSnapshot;
      assert.equal(snapshot.baseRequestId, original.task.requestId);
      assert.equal(snapshot.task.requestId, queue.codeReviewGenerationRequestId(original.task.requestId, snapshot.guard, 'python'));
      assert.equal(snapshot.guard.identity.sessionVersion, owner.sessionVersion + (change === 'session' ? 1 : 0));
      assert.equal(snapshot.guard.stageVersion, change === 'stage' ? 3 : 1);
      assert.equal(snapshot.course.stageVersion, snapshot.guard.stageVersion);
      assert.equal(snapshot.course.platformContext?.templateVersionId, snapshot.guard.templateVersionId);
      assert.deepEqual(snapshot.context, original.context); assert.deepEqual(snapshot.prompts, original.prompts);
      assert.equal(snapshot.fingerprintSource, savedSnapshot.fingerprintSource);
      assert.deepEqual(snapshot.body, next.body);
      const duplicate = { ...original, course: freshCourse, body: { ...original.body, requestId: randomUUID() } };
      const sameGeneration = await enqueue(duplicate); assert.equal(sameGeneration.kind, 'existing');
      if (sameGeneration.kind !== 'existing') throw new Error('Expected the same live generation');
      assert.equal(sameGeneration.state.requestId, snapshot.task.requestId);
      assert.equal((await readAlias(prisma, original.task.participationId, String(next.body.requestId))).taskId, generationId);
      assert.equal((await readAlias(prisma, original.task.participationId, String(duplicate.body.requestId))).taskId, generationId);
      const replay = await enqueue(original); assert.equal(replay.kind, 'existing');
      if (replay.kind !== 'existing') throw new Error('Expected original alias to remain bound');
      assert.equal(replay.state.requestId, original.task.requestId); assert.equal(replay.state.status, 'failed');
      assert.equal((await readAlias(prisma, original.task.participationId, String(original.body.requestId))).taskId, baseId);
      const oldAfterReplay = await prisma.aiTask.findUniqueOrThrow({ where: { id: baseId } });
      assert.deepEqual(oldAfterReplay, rejected, 'New aliases must never rewrite the old task, token, result or execution budget');
      const nextJob = await queue.claimQueuedDocumentReview(); assert.ok(nextJob); assert.equal(nextJob.id, generationId);
      await runQueuedDocumentReview(nextJob, new AbortController().signal, executeFixture);
      assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: generationId } })).status, 'COMPLETED');
      assert.equal(fixtureModelCalls, callsBeforeGeneration + 1);
      assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: baseId } })).input, rejected.input);
    } finally {
      // Exact restoration applies only to this disposable fixture. It lets the
      // original 60-document proof retain its original authenticated identities.
      await prisma.user.update({ where: { id: owner.id }, data: { sessionVersion: owner.sessionVersion } });
      await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: runtime } });
    }
  }
  console.log('PASS live session/stage-return generations: stale projection rejects with no task/alias, fresh projection forks only new aliases, same generation deduplicates, old aliases/tasks stay bound; revoked work invokes no model');

  const paid = makeCodeInput(29, `completed-base-${randomUUID()}`);
  assert.equal((await enqueue(paid)).kind, 'queued');
  const paidJob = await queue.claimQueuedDocumentReview(); assert.ok(paidJob);
  await runQueuedDocumentReview(paidJob, new AbortController().signal, executeFixture);
  const paidTask = await prisma.aiTask.findUniqueOrThrow({ where: { id: paidJob.id } }); assert.equal(paidTask.status, 'COMPLETED');
  try {
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { ...runtime, stageVersion: 2 } } });
    const reused = { ...paid, course: { ...paid.course, stageVersion: 2 }, body: { ...paid.body, requestId: randomUUID() } };
    assert.equal((await enqueue(reused)).kind, 'existing');
    assert.equal((await readAlias(prisma, paid.task.participationId, String(reused.body.requestId))).taskId, paidJob.id);
    assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id: paidJob.id } }), paidTask);
    assert.equal(await queue.claimQueuedDocumentReview(), null);
  } finally {
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: runtime } });
  }
  console.log('PASS completed base receipt remains reusable without new task/model execution after live generation changes');
  await verifyDocumentReviewProcessCrashes(id => makeCodeInput(0, id), await sessionVersion(makeCodeInput(0, 'crash-identity')));
  await verifyHttpCallerLifecycle(id => makeCodeInput(0, id), makeDocumentInput(1, 'foreign-http').task.studentId);
}

if (process.argv[2] === childFlag) {
  assert.ok(process.send && process.connected, 'Owned IPC parent required before any database or HTTP');
  assert.match(process.env.OPENPBL_REVIEW_HTTP_NONCE ?? '', /^[0-9a-f-]{36}$/);
  process.on('message', receiveCommand);
  (process.argv[3] === 'service' ? serviceChild() : process.argv[3] === 'caller' ? callerChild()
    : Promise.reject(new Error('Invalid code verification child mode'))).then(
    () => { process.disconnect?.(); process.exit(0); },
    error => { console.error(error); process.disconnect?.(); process.exit(1); },
  );
}
