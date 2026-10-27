// Called by verify-document-review-queue-worker.ts against its disposable PG only.
// This is a process/DB recovery proof with a deterministic model fixture, not a
// provider-quality or browser/HTTP smoke. No runtime fault hooks are installed.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CompanionMessage } from '../src/lib/session/types';
import type { QueuedBackgroundReview, QueuedCodeReview, enqueueDocumentReview, enqueueCodeReview } from '../src/lib/ai-collaboration/document-review-queue';
import type { completeDocumentRequest } from '../src/lib/ai-collaboration/document-request-store';
import type { AiInteractionEventInput } from '../src/lib/ai-collaboration/audit-store';

type ReviewInput = Parameters<typeof enqueueDocumentReview>[0] | Parameters<typeof enqueueCodeReview>[0];
type Phase = 'before-claim' | 'model' | 'prepared' | 'transaction';
type Prepared = { receipt: Record<string, unknown>; messages: CompanionMessage[];
  auditEvents: NonNullable<Parameters<typeof completeDocumentRequest>[0]['auditEvents']> };
type PreparedCode = { body: Record<string, unknown>; messages: CompanionMessage[]; events: AiInteractionEventInput[] };
type Notice = { kind: string; pid: number; startTicks: string; nonce: string; job?: QueuedBackgroundReview };
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type ProcessIdentity = { pid: number; parentPid: number; startTicks: string };
type Child = { process: ChildProcess; identity: ProcessIdentity; nonce: string; notices: Notice[]; output: string; exit?: Exit; error?: Error };
const childFlag = '--review-crash-child';
const lockClass = 190752006;

export function parseVerificationProcessIdentity(stat: string): ProcessIdentity {
  const close = stat.lastIndexOf(')');
  assert.ok(close > stat.indexOf('('), 'Malformed verification process stat');
  const pid = Number(stat.slice(0, stat.indexOf('(')).trim());
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parentPid) && parentPid > 0);
  assert.match(startTicks ?? '', /^[1-9][0-9]*$/);
  return { pid, parentPid, startTicks };
}

export function assertVerificationChildIdentity(expected: ProcessIdentity, actual: ProcessIdentity, parentPid: number): void {
  assert.deepEqual(actual, expected, 'Verification child PID/start/parent changed; refusing to signal');
  assert.equal(actual.parentPid, parentPid, 'Refusing to signal a process owned by another parent');
}

function readProcessIdentity(pid: number): ProcessIdentity {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const identity = parseVerificationProcessIdentity(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  assert.equal(identity.pid, pid);
  return identity;
}

export async function isolatedReviewDatabase() {
  // Every parent and freshly spawned child validates BEFORE importing the DB
  // client/runtime. Do not accept remote hosts, passwords, implicit ports or an
  // unmarked local database, even when this module is called directly.
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? '', /^openpbl-research-check-[0-9a-f-]{36}$/);
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'postgres');
  assert.equal(url.password, ''); assert.equal(url.pathname, '/postgres'); assert.ok(url.port);
  const { prisma } = await import('../src/lib/db/client');
  try {
    assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`
      SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    return prisma;
  } catch (error) { await prisma.$disconnect(); throw error; }
}

function fixture(job: QueuedBackgroundReview): Prepared {
  return {
    receipt: { requestId: job.snapshot.task.requestId, status: 'completed',
      documentVersion: job.snapshot.task.documentVersion, complete: true,
      reviewDecision: { action: 'proactive-document-comments', documentVersion: job.snapshot.task.documentVersion } },
    messages: [{ id: `crash-checkpoint-${job.id}`, role: 'system-trigger',
      content: 'OPENPBL_DOCUMENT_COMMENT_REVIEW:deterministic-process-crash-fixture',
      createdAt: '2026-01-01T00:00:00.000Z', visibility: 'teacher-only' }],
    auditEvents: [{ idempotencyKey: `crash-review-${job.id}`, eventType: 'policy', actor: 'system',
      content: 'Deterministic fixture: no comment after complete review.',
      payload: { documentVersion: job.snapshot.task.documentVersion } }],
  };
}

function codeFixture(job: QueuedCodeReview): PreparedCode {
  const task = job.snapshot.task;
  return {
    body: { kind: 'review', findings: [], message: 'Deterministic crash fixture only; no code changes.',
      intent: task.intent, originalArtifactVersion: task.documentVersion },
    messages: [{ id: `crash-checkpoint-${job.id}`, role: 'system-trigger',
      content: 'OPENPBL_CODE_COMMENT_REVIEW:deterministic-process-crash-fixture',
      createdAt: '2026-01-01T00:00:00.000Z', visibility: 'teacher-only' }],
    events: [{ courseId: task.courseId, studentId: task.studentId, stageKey: task.stageKey,
      source: 'system', eventType: 'policy', actorRole: 'system',
      requestId: task.requestId, content: 'Deterministic fixture: no code changes.',
      payload: { artifactVersion: task.documentVersion } }],
  };
}

function finalResponse(job: QueuedBackgroundReview): Record<string, unknown> {
  return job.snapshot.version === 2
    ? { ...codeFixture({ ...job, snapshot: job.snapshot }).body, requestId: job.snapshot.task.requestId,
      status: 'completed', artifactVersion: job.snapshot.task.documentVersion }
    : fixture(job).receipt;
}

async function checkpoint(kind: string, job?: QueuedBackgroundReview) {
  assert.ok(process.send, 'Crash child requires an IPC parent');
  const nonce = process.env.OPENPBL_REVIEW_CRASH_NONCE;
  assert.match(nonce ?? '', /^[0-9a-f-]{36}$/);
  const identity = readProcessIdentity(process.pid);
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message && typeof message === 'object' && 'continue' in message && message.continue === kind
        && 'nonce' in message && message.nonce === nonce) {
        process.off('message', onMessage); resolve();
      }
    };
    process.on('message', onMessage);
    process.send!({ kind, pid: process.pid, startTicks: identity.startTicks, nonce, ...(job ? { job } : {}) }, error => {
      if (error) { process.off('message', onMessage); reject(error); }
    });
  });
}

async function childMain(phase: Phase | 'recover', expectedTaskId: string) {
  assert.ok(process.send && process.connected, 'Crash child requires its owning IPC parent');
  assert.match(process.env.OPENPBL_REVIEW_CRASH_NONCE ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(['before-claim', 'model', 'prepared', 'transaction', 'recover'].includes(phase));
  assert.match(expectedTaskId, /^document-ai-[0-9a-f]{64}$/);
  globalThis.fetch = async () => { throw new Error('Crash fixture forbids outbound/model HTTP'); };
  const prisma = await isolatedReviewDatabase();
  try {
    const { claimQueuedDocumentReview, assertDocumentReviewScope } = await import('../src/lib/ai-collaboration/document-review-queue');
    const { prepareDocumentRequestResponse, completeDocumentRequest } = await import('../src/lib/ai-collaboration/document-request-store');
    const { runQueuedDocumentReview } = await import('../src/lib/ai-collaboration/document-review-worker');
    if (phase === 'before-claim') await checkpoint('before-claim');
    const job = await claimQueuedDocumentReview();
    assert.ok(job, 'Restart must claim from PostgreSQL, not receive a job from its parent');
    assert.equal(job.id, expectedTaskId, 'No unrelated pending work may be consumed');
    await checkpoint('claimed', job);
    await runQueuedDocumentReview(job, new AbortController().signal, async current => {
      if (current.snapshot.version === 2) {
        const codeJob: QueuedCodeReview = { ...current, snapshot: current.snapshot };
        let prepared = current.preparedResponse as PreparedCode | undefined;
        if (!prepared?.body) {
          await prisma.$executeRaw`INSERT INTO "_OpenpblReviewCrashModelCalls" ("taskId", "workerPid")
            VALUES (${current.id}, ${process.pid})`;
          if (phase === 'model') await checkpoint('model');
          prepared = codeFixture(codeJob);
          assert.equal(await prepareDocumentRequestResponse({ ...current.snapshot.task, token: current.token,
            response: prepared }), true);
          if (phase === 'prepared') await checkpoint('prepared');
        }
        const { executeQueuedCodeReview } = await import('../src/lib/ai-collaboration/code-handlers');
        return executeQueuedCodeReview({ ...codeJob, preparedResponse: prepared }, new AbortController().signal);
      }
      let prepared = current.preparedResponse?.preparedReview as Prepared | undefined;
      if (!prepared) {
        // A durable counter survives SIGKILL, unlike a process-local mock count.
        await prisma.$executeRaw`INSERT INTO "_OpenpblReviewCrashModelCalls" ("taskId", "workerPid")
          VALUES (${current.id}, ${process.pid})`;
        if (phase === 'model') await checkpoint('model');
        prepared = fixture(current);
        assert.equal(await prepareDocumentRequestResponse({ ...current.snapshot.task, token: current.token,
          response: { preparedReview: prepared } }), true);
        if (phase === 'prepared') await checkpoint('prepared');
      }
      const committed = await completeDocumentRequest({ ...current.snapshot.task, token: current.token,
        response: prepared.receipt, messages: prepared.messages, auditEvents: prepared.auditEvents,
        validate: tx => assertDocumentReviewScope(tx, current.snapshot) });
      assert.equal(committed, true);
      return Response.json(prepared.receipt);
    });
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: job.id } })).status, 'COMPLETED');
  } finally { await prisma.$disconnect(); }
}

function spawnChild(phase: Phase | 'recover', taskId: string): Child {
  // fork inherits the current Node binary and tsx loaders, plus TSX_TSCONFIG_PATH
  // set by the isolated runner. No shell, web server or browser owns this work.
  const nonce = randomUUID();
  const processChild = fork(fileURLToPath(import.meta.url), [childFlag, phase, taskId], {
    execArgv: process.execArgv, env: { ...process.env, REDIS_URL: '',
      PROVIDER_CONFIG_DATABASE_URL: process.env.DATABASE_URL, PRISMA_CLIENT_ENGINE_TYPE: 'library',
      OPENPBL_REVIEW_CRASH_NONCE: nonce },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  assert.ok(processChild.pid);
  const identity = readProcessIdentity(processChild.pid);
  assertVerificationChildIdentity(identity, identity, process.pid);
  const state: Child = { process: processChild, identity, nonce, notices: [], output: '' };
  processChild.once('exit', (code, signal) => { state.exit = { code, signal }; });
  processChild.once('error', error => { state.error = error; });
  processChild.on('message', message => { state.notices.push(message as Notice); });
  const capture = (chunk: Buffer) => { state.output = (state.output + chunk.toString()).slice(-16_384); };
  processChild.stdout!.on('data', capture); processChild.stderr!.on('data', capture);
  return state;
}

async function until<T>(read: () => Promise<T | undefined>, label: string, child?: Child): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    if (child?.error) throw child.error;
    assert.ok(!child?.exit, `${label}: child exited ${JSON.stringify(child?.exit)}\n${child?.output}`);
    await delay(20);
  }
  throw new Error(`Timed out: ${label}\n${child?.output ?? ''}`);
}

async function notice(child: Child, kind: string) {
  const message = await until(async () => child.notices.find(item => item.kind === kind), kind, child);
  assert.equal(message.pid, child.identity.pid);
  assert.equal(message.startTicks, child.identity.startTicks);
  assert.equal(message.nonce, child.nonce);
  assertVerificationChildIdentity(child.identity, readProcessIdentity(message.pid), process.pid);
  return message;
}
async function proceed(child: Child, kind: string) {
  assertVerificationChildIdentity(child.identity, readProcessIdentity(child.identity.pid), process.pid);
  await new Promise<void>((resolve, reject) => child.process.send({ continue: kind, nonce: child.nonce }, error => error ? reject(error) : resolve()));
}
async function kill(child: Child) {
  assert.equal(child.exit, undefined, `Expected a live child at fault point: ${child.output}`);
  assertVerificationChildIdentity(child.identity, readProcessIdentity(child.identity.pid), process.pid);
  assert.equal(child.process.kill('SIGKILL'), true);
  const exit = await until(async () => child.exit, 'SIGKILL exit');
  assert.equal(exit.code, null); assert.equal(exit.signal, 'SIGKILL');
}

export async function verifyDocumentReviewProcessCrashes(
  input: (requestId: string) => ReviewInput, authenticatedSessionVersion: number,
) {
  const prisma = await isolatedReviewDatabase(); // Shared parent's client; caller disconnects it.
  const { enqueueDocumentReview, enqueueCodeReview, renewDocumentReviewLease, rescheduleDocumentReview, DOCUMENT_REVIEW_QUEUE } = await import('../src/lib/ai-collaboration/document-review-queue');
  const { documentTaskId, prepareDocumentRequestResponse, completeDocumentRequest, getDocumentRequest } = await import('../src/lib/ai-collaboration/document-request-store');
  const children: Child[] = [];
  let tableCreated = false; let functionCreated = false; let triggerCreated = false;
  try {
    // Fail closed rather than draining/deleting another fixture's queue.
    assert.equal(await prisma.aiTask.count({ where: { queueKey: DOCUMENT_REVIEW_QUEUE,
      status: { in: ['PENDING', 'RUNNING'] } } }), 0);
    await prisma.$executeRawUnsafe('CREATE TABLE "_OpenpblReviewCrashModelCalls" ("taskId" text NOT NULL REFERENCES "AiTask"(id), "workerPid" integer NOT NULL, "at" timestamptz NOT NULL DEFAULT now())');
    tableCreated = true;
    for (const phase of ['before-claim', 'model', 'prepared', 'transaction'] as const) {
      const source = input(`process-crash-${phase}-${randomUUID()}`);
      const id = documentTaskId(source.task.participationId, source.task.requestId);
      const enqueue = () => 'body' in source
        ? enqueueCodeReview(source, authenticatedSessionVersion, { requestId: String(source.body.requestId), body: source.body })
        : enqueueDocumentReview(source, authenticatedSessionVersion);
      assert.equal((await enqueue()).kind, 'queued');
      const initial = await prisma.aiTask.findUniqueOrThrow({ where: { id } });
      const initialInput = initial.input as Record<string, unknown>;
      const originalSnapshot = initialInput.reviewSnapshot;
      const threadCounts = async () => ({
        messages: await prisma.aiMessage.count({ where: { conversationId: initial.conversationId! } }),
        audits: await prisma.aiInteractionEvent.count({ where: { conversationId: initial.conversationId! } }),
      });
      const baseline = await threadCounts();
      const artifactCounts = async () => {
        const current = await threadCounts();
        return { messages: current.messages - baseline.messages, audits: current.audits - baseline.audits };
      };
      const callCount = async () => Number((await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM "_OpenpblReviewCrashModelCalls" WHERE "taskId" = ${id}`)[0].count);
      let original: Child; let oldJob: QueuedBackgroundReview | undefined; let backendPid: number | undefined;
      const launch = async () => {
        original = spawnChild(phase, id); children.push(original);
        if (phase === 'before-claim') { await notice(original, phase); return; }
        oldJob = (await notice(original, 'claimed')).job!;
        assert.equal(oldJob.id, id); assert.deepEqual(oldJob.snapshot, originalSnapshot);
        await proceed(original, 'claimed');
      };
      if (phase === 'transaction') {
        const lockKey = randomInt(1, 2_147_483_647);
        const label = `review-crash-${randomUUID()}`;
        assert.match(id, /^document-ai-[0-9a-f]{64}$/);
        const auditKey = 'body' in source ? `code-ai:${source.task.participationId}:${source.task.requestId}:0` : `crash-review-${id}`;
        assert.match(auditKey, /^[a-zA-Z0-9:_-]+$/, 'Trigger literal is generated fixture metadata, never body content');
        // All interpolated SQL identifiers/values here are fixed or generated
        // above; no user SQL enters this disposable-only trigger.
        await prisma.$executeRawUnsafe(`CREATE FUNCTION "_OpenpblReviewCrashBarrier"() RETURNS trigger LANGUAGE plpgsql AS $barrier$
          BEGIN
            IF NEW.output->'response' IS NULL
              OR NEW.output->'response'->>'requestId' IS DISTINCT FROM NEW.input->>'requestId'
              OR NOT EXISTS (SELECT 1 FROM "AiMessage" WHERE id = 'crash-checkpoint-${id}')
              OR NOT EXISTS (SELECT 1 FROM "AiInteractionEvent" WHERE "taskId" = '${id}' AND "idempotencyKey" = '${auditKey}')
              OR NOT EXISTS (SELECT 1 FROM "AiInteractionEvent" WHERE "idempotencyKey" = 'companion-message:crash-checkpoint-${id}') THEN
              RAISE EXCEPTION 'Crash barrier reached before all final transaction writes';
            END IF;
            PERFORM set_config('application_name', '${label}', true);
            PERFORM pg_advisory_xact_lock(${lockClass}, ${lockKey});
            RETURN NEW;
          END $barrier$`);
        functionCreated = true;
        await prisma.$executeRawUnsafe(`CREATE TRIGGER "_OpenpblReviewCrashBarrier" AFTER UPDATE OF status ON "AiTask"
          FOR EACH ROW WHEN (NEW.id = '${id}' AND NEW.status = 'COMPLETED')
          EXECUTE FUNCTION "_OpenpblReviewCrashBarrier"()`);
        triggerCreated = true;
        await prisma.$transaction(async gate => {
          await gate.$queryRaw`SELECT pg_advisory_xact_lock(${lockClass}::int, ${lockKey}::int)::text`;
          await launch();
          backendPid = await until(async () => {
            const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`
              SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
              WHERE a.datname = current_database() AND a.application_name = ${label}
                AND l.locktype = 'advisory' AND NOT l.granted
                AND l.classid::bigint = ${lockClass} AND l.objid::bigint = ${lockKey} AND l.objsubid = 2`;
            return waiting[0]?.pid;
          }, 'actual final transaction blocked after receipt + message + both audits', original!);
          assert.deepEqual(await artifactCounts(), { messages: 0, audits: 0 }, 'Uncommitted writes must be invisible');
          const hiddenReceipt = await prisma.aiTask.findUniqueOrThrow({ where: { id } });
          assert.equal(hiddenReceipt.status, 'RUNNING');
          assert.equal((hiddenReceipt.output as Record<string, unknown>).response, undefined);
          await kill(original!);
        }, { maxWait: 5_000, timeout: 30_000 }); // Releases lock only AFTER actual process death.
        await until(async () => (await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE pid = ${backendPid}`).length === 0 ? true : undefined,
        'killed worker DB backend closed and transaction rolled back');
        await prisma.$executeRawUnsafe('DROP TRIGGER "_OpenpblReviewCrashBarrier" ON "AiTask"'); triggerCreated = false;
        await prisma.$executeRawUnsafe('DROP FUNCTION "_OpenpblReviewCrashBarrier"()'); functionCreated = false;
      } else {
        await launch();
        if (phase !== 'before-claim') await notice(original!, phase);
        await kill(original!);
      }
      const interrupted = await prisma.aiTask.findUniqueOrThrow({ where: { id } });
      assert.equal(interrupted.status, phase === 'before-claim' ? 'PENDING' : 'RUNNING');
      assert.equal(interrupted.attemptCount, phase === 'before-claim' ? 0 : 1);
      assert.deepEqual((interrupted.input as Record<string, unknown>).reviewSnapshot, originalSnapshot);
      assert.deepEqual(await artifactCounts(), { messages: 0, audits: 0 });
      assert.equal((interrupted.output as Record<string, unknown> | null)?.response, undefined, 'No completed receipt after crash');
      const rawPrepared = (interrupted.output as { preparedResponse?: Record<string, unknown> } | null)?.preparedResponse;
      const durable = 'body' in source ? rawPrepared?.body : rawPrepared?.preparedReview;
      assert.equal(Boolean(durable), phase === 'prepared' || phase === 'transaction');
      if (durable) {
        if (oldJob!.snapshot.version === 2) assert.deepEqual(rawPrepared, codeFixture({ ...oldJob!, snapshot: oldJob!.snapshot }));
        else assert.deepEqual(durable, fixture(oldJob!));
      }
      assert.equal(await callCount(), phase === 'before-claim' ? 0 : 1);
      if (oldJob) {
        // Advance ONLY this dead process's lease clock, after confirmed SIGKILL.
        // Real recovery waits 125s; this proof checks the actual expired-lease
        // claim path, not production wall-clock timer accuracy. No status/token,
        // availableAt, attempt count, input or prepared result is rewritten.
        assert.equal((await prisma.aiTask.updateMany({ where: { id, status: 'RUNNING',
          input: { path: ['token'], equals: oldJob.token } }, data: { leaseUntil: new Date(Date.now() - 1) } })).count, 1);
      }
      const restarted = spawnChild('recover', id); children.push(restarted);
      const newJob = (await notice(restarted, 'claimed')).job!;
      assert.notEqual(restarted.process.pid, original!.process.pid);
      assert.equal(newJob.id, id); assert.deepEqual(newJob.snapshot, originalSnapshot);
      assert.equal(newJob.attemptCount, phase === 'before-claim' ? 1 : 2);
      const reclaimed = await prisma.aiTask.findUniqueOrThrow({ where: { id } });
      const { token: newToken, ...reclaimedInput } = reclaimed.input as Record<string, unknown>;
      assert.equal(newToken, newJob.token); assert.deepEqual(reclaimedInput, initialInput);
      if (oldJob) {
        assert.notEqual(oldJob.token, newJob.token);
        assert.equal(await renewDocumentReviewLease(oldJob), false);
        assert.equal(await prepareDocumentRequestResponse({ ...source.task, token: oldJob.token, response: { stale: true } }), false);
        assert.equal(await completeDocumentRequest({ ...source.task, token: oldJob.token, messages: [], response: { stale: true } }), false);
        assert.equal((await rescheduleDocumentReview(oldJob, { code: 'STALE_PROCESS_MUST_NOT_WRITE' })).count, 0);
        assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id } }), reclaimed,
          'Old lease cannot alter the new owner or its prepared evidence');
      }
      await proceed(restarted, 'claimed');
      const exit = await until(async () => restarted.exit, 'restart completes');
      assert.deepEqual(exit, { code: 0, signal: null }, restarted.output);
      const completed = await prisma.aiTask.findUniqueOrThrow({ where: { id } });
      assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.leaseUntil, null);
      assert.deepEqual((completed.output as Record<string, unknown>).response, finalResponse(newJob));
      assert.equal((await getDocumentRequest(source.task))?.status, 'completed');
      assert.deepEqual(await artifactCounts(), { messages: 1, audits: 2 });
      assert.equal(await callCount(), phase === 'model' ? 2 : 1);
      assert.equal((await enqueue()).kind, 'existing');
      assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id } }), completed);
      assert.deepEqual(await artifactCounts(), { messages: 1, audits: 2 });
      console.log('PASS real child SIGKILL/restart', JSON.stringify({ phase, workspace: 'body' in source ? 'code' : 'document', taskId: id,
        originalPid: original!.process.pid, restartedPid: restarted.process.pid, backendPid,
        originalStartTicks: original!.identity.startTicks, restartedStartTicks: restarted.identity.startTicks,
        immutableSnapshotSha256: createHash('sha256').update(JSON.stringify(originalSnapshot)).digest('hex'),
        model: 'deterministic-local-fixture', modelCalls: await callCount(), messages: 1, audits: 2,
        leaseClock: oldJob ? 'advanced-only-after-SIGKILL' : 'unclaimed',
        leaseTokenChanged: oldJob ? oldJob.token !== newJob.token : null }));
    }
  } finally {
    // Cleanup never deletes domain tasks, receipts or research evidence.
    // SIGKILL outstanding children before removing a blocking trigger/table.
    for (const child of children) {
      if (!child.exit && !child.error) await kill(child);
    }
    if (triggerCreated) await prisma.$executeRawUnsafe('DROP TRIGGER "_OpenpblReviewCrashBarrier" ON "AiTask"');
    if (functionCreated) await prisma.$executeRawUnsafe('DROP FUNCTION "_OpenpblReviewCrashBarrier"()');
    if (tableCreated) await prisma.$executeRawUnsafe('DROP TABLE "_OpenpblReviewCrashModelCalls"');
  }
}

if (process.argv[2] === childFlag) {
  childMain(process.argv[3] as Phase | 'recover', process.argv[4]).then(
    () => { process.disconnect?.(); process.exit(0); },
    error => { console.error(error); process.disconnect?.(); process.exit(1); },
  );
}
