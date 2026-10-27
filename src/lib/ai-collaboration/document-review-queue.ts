import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type AiTask } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { documentReviewLeaseRecoveriesTotal, recordDocumentReviewLifecycle } from '@/lib/observability/metrics';
import { runMutationTransaction } from '@/lib/db/transaction-retry';
import { ensureCompanionThreadWithinTransaction } from '@/lib/companion/server-store';
import { type Course } from '@/lib/session/types';
import { normalizePblCourseConfig } from '@/lib/pbl-course-config';
import { documentTaskId, projectDocumentTask, projectDocumentTaskReceipt, type DocumentRequestIdentity, type DocumentRequestInput, type DocumentRequestState } from './document-request-store';
import { COLLABORATION_REQUEST_LEASE_MS } from './request-budget';
import { resolveProactiveReviewConcurrency } from './proactive-review-capacity';
import { hasDocumentReviewAdmissionCapacity } from './document-review-admission';
import { codeBackgroundBodyDigest, stableCodeDigest, findCodeBackgroundAlias, type CodeRequestAlias } from './code-background-alias';
import type { resolveProjectSupportContext } from './project-support-server';
import { parseCodeArtifact } from './code-artifact';

export const DOCUMENT_REVIEW_QUEUE = 'document-review-v1';
// New waiting work is bounded separately from execution reservations.
// Recovery preserves every previously admitted task, even if pending temporarily
// exceeds this bound after active leases return to the queue.
export const DOCUMENT_REVIEW_MAX_PENDING = 80;
export const DOCUMENT_REVIEW_MAX_ATTEMPTS = 3;
export const DOCUMENT_REVIEW_MAX_COMMIT_ATTEMPTS = 9;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type DocumentReviewSnapshot = {
  version: 1;
  task: DocumentRequestInput;
  documentHtml: string;
  course: Course;
  paragraphs: Array<{ candidateId: string; blockId?: string; blockIndex: number; targetText: string }>;
  guard: { templateVersionId: string; stageVersion: number; stageIndex: number; offeringId: string;
    identity: { role: 'STUDENT'; status: 'ACTIVE'; sessionVersion: number } };
};
export type QueuedDocumentReview = {
  id: string; token: string; attemptCount: number; snapshot: DocumentReviewSnapshot;
  preparedResponse?: Record<string, unknown>;
};
export type CodeReviewSnapshot = {
  version: 2; kind: 'code-background'; task: DocumentRequestInput; course: Course;
  body: Record<string, unknown>; prompts: { system: string; user: string }; context: Record<string, unknown>;
  fingerprintSource: string;
  baseRequestId?: string;
  support?: Awaited<ReturnType<typeof resolveProjectSupportContext>>;
  guard: DocumentReviewSnapshot['guard'];
};
export type SharedReviewSnapshot = DocumentReviewSnapshot | CodeReviewSnapshot;
export type QueuedBackgroundReview = Omit<QueuedDocumentReview, 'snapshot'> & { snapshot: SharedReviewSnapshot };
export type QueuedCodeReview = Omit<QueuedDocumentReview, 'snapshot'> & { snapshot: CodeReviewSnapshot };
export function codeReviewGenerationRequestId(baseRequestId: string, guard: DocumentReviewSnapshot['guard'], language: unknown): string {
  return `${baseRequestId}:scope:${digest([guard.offeringId, guard.templateVersionId, guard.stageIndex,
    guard.stageVersion, guard.identity.sessionVersion, language])}`;
}
export function codeReviewFingerprint(input: Pick<CodeReviewSnapshot, 'prompts' | 'context' | 'body'>): string {
  return createHash('sha256').update(codeReviewFingerprintSource(input)).digest('hex');
}
function codeReviewFingerprintSource(input: Pick<CodeReviewSnapshot, 'prompts' | 'context' | 'body'>): string {
  const { action, intent, language } = input.body;
  return JSON.stringify({ prompts: input.prompts, action: typeof action === 'string' ? action : '', intent, language, context: input.context });
}
const scopeFailureCodes = ['REVIEW_SCOPE_CHANGED', 'REVIEW_INPUT_CHANGED', 'REVIEW_STAGE_CHANGED', 'REVIEW_IDENTITY_CHANGED', 'REVIEW_IDENTITY_SNAPSHOT_MISSING'] as const;
export class DocumentReviewScopeChanged extends Error {
  constructor(readonly code: typeof scopeFailureCodes[number]) { super(code); this.name = 'DocumentReviewScopeChanged'; }
}
export function isDocumentReviewScopeChanged(error: unknown): error is DocumentReviewScopeChanged {
  return error instanceof Error && 'code' in error && scopeFailureCodes.some(code => code === error.code)
    && error.message === error.code;
}
export type EnqueueReviewResult = { kind: 'existing' | 'queued'; state: DocumentRequestState }
  | { kind: 'conflict' } | { kind: 'full' };

type ReviewScopeRow = {
  instanceId: string; userId: string; offeringId: string; enrollmentStatus: string;
  instanceStatus: string; offeringStatus: string; archivedAt: Date | null;
  templateVersionId: string; runtimeConfig: unknown;
  userRole: string; userStatus: string; userSessionVersion: number;
};
async function readReviewScope(db: Pick<Prisma.TransactionClient, '$queryRaw'>, task: DocumentRequestInput) {
  const [scope] = await db.$queryRaw<ReviewScopeRow[]>`
    SELECT p."instanceId", e."userId", e."offeringId", e.status AS "enrollmentStatus",
      i.status AS "instanceStatus", o.status AS "offeringStatus", a."archivedAt",
      i."templateVersionId", i."runtimeConfig", u.role AS "userRole", u.status AS "userStatus", u."sessionVersion" AS "userSessionVersion"
    FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id = p."enrollmentId"
    JOIN "User" u ON u.id = e."userId"
    JOIN "ClassroomInstance" i ON i.id = p."instanceId" JOIN "Activity" a ON a.id = i."activityId"
    JOIN "Chapter" ch ON ch.id = a."chapterId" JOIN "CourseOffering" o ON o.id = ch."offeringId"
    WHERE p.id = ${task.participationId} AND e."offeringId" = ch."offeringId" FOR SHARE OF u`;
  if (!scope || scope.instanceId !== task.courseId || scope.userId !== task.studentId
    || scope.enrollmentStatus.toUpperCase() !== 'ACTIVE' || scope.instanceStatus.toUpperCase() !== 'TEACHING'
    || scope.offeringStatus.toUpperCase() !== 'OPEN' || scope.archivedAt) {
    throw new DocumentReviewScopeChanged('REVIEW_SCOPE_CHANGED');
  }
  if (scope.userRole.toUpperCase() !== 'STUDENT' || scope.userStatus.toUpperCase() !== 'ACTIVE'
    || !Number.isInteger(scope.userSessionVersion) || scope.userSessionVersion < 1) {
    throw new DocumentReviewScopeChanged('REVIEW_IDENTITY_CHANGED');
  }
  return scope;
}

/** Rechecked before model work and inside the same course-admitted commit transaction. */
export async function assertDocumentReviewScope(db: Pick<Prisma.TransactionClient, '$queryRaw'>, snapshot: SharedReviewSnapshot) {
  const identity = snapshot.guard?.identity;
  if (!identity || identity.role !== 'STUDENT' || identity.status !== 'ACTIVE'
    || !Number.isInteger(identity.sessionVersion) || identity.sessionVersion < 1) {
    throw new DocumentReviewScopeChanged('REVIEW_IDENTITY_SNAPSHOT_MISSING');
  }
  if (snapshot.version === 2) {
    const language = snapshot.body.language;
    const artifact = language === 'c' || language === 'python' ? parseCodeArtifact(typeof snapshot.body.artifact === 'string'
      ? snapshot.body.artifact : JSON.stringify(snapshot.body.artifact), language) : null;
    let projection: unknown;
    try { projection = JSON.parse(snapshot.fingerprintSource); } catch { throw new DocumentReviewScopeChanged('REVIEW_INPUT_CHANGED'); }
    if (snapshot.kind !== 'code-background' || (language !== 'c' && language !== 'python')
      || !['proactive-review', 'code-task-starters'].includes(snapshot.task.intent)
      || snapshot.task.workspaceKind !== `code:${language}`
      || snapshot.body.courseId !== snapshot.task.courseId || snapshot.body.studentId !== snapshot.task.studentId
      || snapshot.body.stageKey !== snapshot.task.stageKey
      || (snapshot.body.action || snapshot.body.intent) !== snapshot.task.intent
      || (snapshot.baseRequestId !== undefined && (!/^code-background:[a-f0-9]{64}$/.test(snapshot.baseRequestId)
        || snapshot.task.requestId !== codeReviewGenerationRequestId(snapshot.baseRequestId, snapshot.guard, language)))
      || !artifact || digest(object(object(projection).context).artifact) !== snapshot.task.documentVersion
      || stableCodeDigest(snapshot.body.run ?? null) !== stableCodeDigest(snapshot.context.run)
      || stableCodeDigest(snapshot.body.selection ?? null) !== stableCodeDigest(snapshot.context.selection)
      || (snapshot.body.mode === 'task' ? 'task' : 'discuss') !== snapshot.context.mode
      || stableCodeDigest(artifact) !== stableCodeDigest(snapshot.context.artifact)
      || stableCodeDigest(projection) !== stableCodeDigest(JSON.parse(codeReviewFingerprintSource(snapshot)))
      || createHash('sha256').update(snapshot.fingerprintSource).digest('hex') !== snapshot.task.fingerprint) throw new DocumentReviewScopeChanged('REVIEW_INPUT_CHANGED');
  } else if (snapshot.version !== 1 || digest(snapshot.documentHtml) !== snapshot.task.documentVersion
    || digest({ action: snapshot.task.intent, courseId: snapshot.task.courseId, stageKey: snapshot.task.stageKey,
      workspaceKind: snapshot.task.workspaceKind, documentHtml: snapshot.documentHtml, proactiveParagraphs: snapshot.paragraphs.map(({ candidateId, blockId, blockIndex, targetText }) => ({ candidateId, blockId, blockIndex, targetText })) }) !== snapshot.task.fingerprint) {
    throw new DocumentReviewScopeChanged('REVIEW_INPUT_CHANGED');
  }
  const scope = await readReviewScope(db, snapshot.task);
  if (scope.userSessionVersion !== identity.sessionVersion) throw new DocumentReviewScopeChanged('REVIEW_IDENTITY_CHANGED');
  const runtime = object(scope.runtimeConfig);
  const mode = runtime.makeArtifactMode ?? normalizePblCourseConfig(snapshot.course.pblConfig).makeArtifactMode;
  if (scope.offeringId !== snapshot.guard.offeringId || scope.templateVersionId !== snapshot.guard.templateVersionId
    || (snapshot.course.platformContext?.templateVersionId !== undefined
      && snapshot.course.platformContext.templateVersionId !== snapshot.guard.templateVersionId)
    || (snapshot.course.stageVersion !== undefined && snapshot.course.stageVersion !== snapshot.guard.stageVersion)
    || Number(runtime.stageVersion ?? 1) !== snapshot.guard.stageVersion
    || Number(runtime.currentStageIndex ?? 0) !== snapshot.guard.stageIndex
    || snapshot.course.stages[snapshot.guard.stageIndex]?.key !== snapshot.task.stageKey
    || (snapshot.task.stageKey === 'make' && (snapshot.version === 2 ? mode !== snapshot.body.language
      : (mode === 'other') !== (snapshot.task.workspaceKind === 'external-artifact')))) {
    throw new DocumentReviewScopeChanged('REVIEW_STAGE_CHANGED');
  }
}

export async function enqueueDocumentReview(input: Omit<DocumentReviewSnapshot, 'version' | 'guard'>, authenticatedSessionVersion: number): Promise<EnqueueReviewResult> {
  return enqueueReview({ ...input, version: 1 }, authenticatedSessionVersion);
}
export async function enqueueCodeReview(input: Omit<CodeReviewSnapshot, 'version' | 'guard' | 'kind' | 'fingerprintSource' | 'baseRequestId'>, authenticatedSessionVersion: number, alias: CodeRequestAlias): Promise<EnqueueReviewResult> {
  return enqueueReview({ ...input, fingerprintSource: codeReviewFingerprintSource(input), version: 2, kind: 'code-background' }, authenticatedSessionVersion, alias);
}
async function enqueueReview(originalInput: Omit<DocumentReviewSnapshot, 'guard'> | Omit<CodeReviewSnapshot, 'guard'>, authenticatedSessionVersion: number, alias?: CodeRequestAlias): Promise<EnqueueReviewResult> {
  const result = await runMutationTransaction<EnqueueReviewResult>(async tx => {
    let input = originalInput;
    await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${input.task.participationId} FOR UPDATE`;
    if (alias) {
      const found = await findCodeBackgroundAlias(tx, { ...input.task, requestId: alias.requestId });
      if (found) return 'conflict' in found || found.row.bodyDigest !== codeBackgroundBodyDigest(alias.body)
        ? { kind: 'conflict' } : { kind: 'existing', state: found.state };
    }
    let id = documentTaskId(input.task.participationId, input.task.requestId);
    let existing = await tx.aiTask.findUnique({ where: { id } });
    // Existing aliases always keep their original task. Only a new alias may
    // fork unchanged code into a new live authorization generation. Completed
    // paid results remain reusable; legacy tasks without a guard are not guessed.
    if (input.version === 2 && existing && existing.status !== 'COMPLETED') {
      const oldSnapshot = object(existing.input).reviewSnapshot as SharedReviewSnapshot | undefined;
      if (oldSnapshot?.version === 2 && oldSnapshot.guard?.identity) {
        const scope = await readReviewScope(tx, input.task);
        if (scope.userSessionVersion !== authenticatedSessionVersion) throw new DocumentReviewScopeChanged('REVIEW_IDENTITY_CHANGED');
        const runtime = object(scope.runtimeConfig);
        const guard: DocumentReviewSnapshot['guard'] = { templateVersionId: scope.templateVersionId, offeringId: scope.offeringId,
          stageIndex: Number(runtime.currentStageIndex ?? 0), stageVersion: Number(runtime.stageVersion ?? 1),
          identity: { role: 'STUDENT', status: 'ACTIVE', sessionVersion: scope.userSessionVersion } };
        if (codeReviewGenerationRequestId(input.task.requestId, oldSnapshot.guard, oldSnapshot.body.language)
          !== codeReviewGenerationRequestId(input.task.requestId, guard, input.body.language)) {
          const baseRequestId = input.task.requestId;
          input = { ...input, baseRequestId, task: { ...input.task, requestId: codeReviewGenerationRequestId(baseRequestId, guard, input.body.language) } };
          id = documentTaskId(input.task.participationId, input.task.requestId);
          existing = await tx.aiTask.findUnique({ where: { id } });
        }
      }
    }
    const saveAlias = async () => {
      if (alias) await tx.$executeRaw`INSERT INTO "AiTaskRequestAlias" ("participationId", "clientRequestId", "taskId", "bodyDigest", "requestBody")
        VALUES (${input.task.participationId}, ${alias.requestId}, ${id}, ${codeBackgroundBodyDigest(alias.body)}, ${JSON.stringify(alias.body)}::jsonb)`;
    };
    if (existing) {
      const saved = object(existing.input);
      if (existing.taskType !== 'DOCUMENT_COLLABORATION' || existing.createdById !== input.task.studentId
        || saved.fingerprint !== input.task.fingerprint || saved.participationId !== input.task.participationId
        || saved.stageKey !== input.task.stageKey || saved.workspaceKind !== input.task.workspaceKind
        || saved.conversationId !== input.task.conversationId || saved.documentVersion !== input.task.documentVersion) return { kind: 'conflict' };
      // New queued failures are terminal after the worker's bounded retries. Legacy
      // failed/interrupted rows may be adopted only with the identical original body.
      const staleLegacy = !existing.queueKey && existing.status === 'RUNNING'
        && (!existing.startedAt || existing.startedAt.getTime() <= Date.now() - COLLABORATION_REQUEST_LEASE_MS);
      if (existing.queueKey || (existing.status !== 'FAILED' && !staleLegacy)) {
        await saveAlias();
        return { kind: 'existing', state: await projectDocumentTaskReceipt(existing, input.task, tx) };
      }
    }
    const scope = await readReviewScope(tx, input.task);
    if (scope.userSessionVersion !== authenticatedSessionVersion) throw new DocumentReviewScopeChanged('REVIEW_IDENTITY_CHANGED');
    const runtime = object(scope.runtimeConfig);
    const snapshot: SharedReviewSnapshot = { ...input, guard: {
      templateVersionId: scope.templateVersionId, offeringId: scope.offeringId,
      stageVersion: Number(runtime.stageVersion ?? 1), stageIndex: Number(runtime.currentStageIndex ?? 0),
      identity: { role: 'STUDENT', status: 'ACTIVE', sessionVersion: scope.userSessionVersion },
    } };
    await assertDocumentReviewScope(tx, snapshot);
    // Serializes only admission/claim metadata; no model call or course write
    // waits while holding this lock. The bound applies across server restarts.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DOCUMENT_REVIEW_QUEUE}, 0))::text`;
    if (!await hasDocumentReviewAdmissionCapacity(tx, DOCUMENT_REVIEW_QUEUE, DOCUMENT_REVIEW_MAX_PENDING, resolveProactiveReviewConcurrency())) return { kind: 'full' };
    const { row } = await ensureCompanionThreadWithinTransaction(tx, input.task.courseId, input.task.studentId, input.task.threadStageKey);
    const data = { queueKey: DOCUMENT_REVIEW_QUEUE, status: 'PENDING', availableAt: new Date(), leaseUntil: null,
      attemptCount: 0, error: null, startedAt: null, completedAt: null,
      input: json({ ...input.task, schemaVersion: 2, reviewSnapshot: snapshot }),
    };
    const task = existing ? await tx.aiTask.update({ where: { id }, data }) : await tx.aiTask.create({ data: {
      ...data, id, taskType: 'DOCUMENT_COLLABORATION', createdById: input.task.studentId,
      offeringId: scope.offeringId, conversationId: row.id,
    } });
    await saveAlias();
    return { kind: 'queued', state: projectDocumentTask(task) };
  }, { lowPriorityCourseId: originalInput.task.courseId });
  if (result.kind === 'queued') recordDocumentReviewLifecycle('enqueued');
  return result;
}

/** FIFO heads, one running request per student, with least-recently-served
 * students first. Database admission also prevents duplicate process claims. */
let recoveredLeases = 0;
export const documentReviewRecoveredLeases = () => recoveredLeases;
export async function claimQueuedDocumentReview(): Promise<QueuedBackgroundReview | null> {
  let recovered = 0;
  const claimed = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DOCUMENT_REVIEW_QUEUE}, 0))::text`;
    const now = new Date();
    // FAILED with a retained lease is the executor's failure/audit transition,
    // not a terminal receipt. Reclaim that same immutable task after expiry.
    recovered = (await tx.aiTask.updateMany({ where: { queueKey: DOCUMENT_REVIEW_QUEUE, OR: [
      { status: 'RUNNING', OR: [{ leaseUntil: { lte: now } }, { leaseUntil: null }] },
      { status: 'FAILED', leaseUntil: { lte: now } },
    ] }, data: { status: 'PENDING', availableAt: now, leaseUntil: null, completedAt: null, error: 'REVIEW_WORKER_INTERRUPTED' } })).count;
    // A crashed execution consumes a real attempt. Prepared receipts remain
    // independently recoverable, even after the model attempt budget is spent.
    await tx.$executeRaw`UPDATE "AiTask" SET status = 'FAILED', error = 'REVIEW_ATTEMPTS_EXHAUSTED', "completedAt" = NOW()
      WHERE "queueKey" = ${DOCUMENT_REVIEW_QUEUE} AND status = 'PENDING' AND "attemptCount" >= ${DOCUMENT_REVIEW_MAX_ATTEMPTS}
      AND ((output->'preparedResponse') IS NULL OR "attemptCount" >= ${DOCUMENT_REVIEW_MAX_COMMIT_ATTEMPTS})`;
    const active = await tx.aiTask.count({ where: { queueKey: DOCUMENT_REVIEW_QUEUE, OR: [
      { status: 'RUNNING' }, { status: 'FAILED', leaseUntil: { not: null } },
    ] } });
    if (active >= resolveProactiveReviewConcurrency()) return null;
    const [task] = await tx.$queryRaw<AiTask[]>`SELECT q.* FROM "AiTask" q
      WHERE q."queueKey" = ${DOCUMENT_REVIEW_QUEUE} AND q.status = 'PENDING' AND q."availableAt" <= ${now}
      AND NOT EXISTS (SELECT 1 FROM "AiTask" running WHERE running."queueKey" = q."queueKey"
        AND running."createdById" = q."createdById"
        AND (running.status = 'RUNNING' OR (running.status = 'FAILED' AND running."leaseUntil" IS NOT NULL)))
      AND NOT EXISTS (SELECT 1 FROM "AiTask" older WHERE older."queueKey" = q."queueKey"
        AND older."createdById" = q."createdById" AND older.status = 'PENDING'
        AND (older."createdAt", older.id) < (q."createdAt", q.id))
      ORDER BY (SELECT MAX(previous."startedAt") FROM "AiTask" previous
        WHERE previous."queueKey" = q."queueKey" AND previous."createdById" = q."createdById") ASC NULLS FIRST,
        q."createdAt", q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED`;
    if (!task) return null;
    const saved = object(task.input); const snapshot = saved.reviewSnapshot as SharedReviewSnapshot | undefined;
    if (!snapshot || (snapshot.version !== 1 && (snapshot.version !== 2 || snapshot.kind !== 'code-background')) || snapshot.task?.requestId !== saved.requestId) {
      await tx.aiTask.update({ where: { id: task.id }, data: { status: 'FAILED', error: 'REVIEW_SNAPSHOT_MISSING', completedAt: now } });
      return null;
    }
    const token = randomUUID();
    await tx.aiTask.update({ where: { id: task.id }, data: { status: 'RUNNING', startedAt: now,
      leaseUntil: new Date(Date.now() + COLLABORATION_REQUEST_LEASE_MS), input: json({ ...saved, token }),
      attemptCount: { increment: 1 }, error: null } });
    const prepared = object(task.output).preparedResponse;
    return { id: task.id, token, attemptCount: task.attemptCount + 1, snapshot,
      ...(prepared && typeof prepared === 'object' ? { preparedResponse: prepared as Record<string, unknown> } : {}) };
  }, { timeout: 5_000 });
  recoveredLeases += recovered;
  if (recovered) documentReviewLeaseRecoveriesTotal.inc(recovered);
  return claimed;
}

/** Retire document-only work while preserving immutable inputs, output and code jobs. */
export async function cancelRetiredDocumentReviews(job?: QueuedDocumentReview) {
  return prisma.aiTask.updateMany({ where: { queueKey: DOCUMENT_REVIEW_QUEUE,
    ...(job ? { id: job.id, input: { path: ['token'], equals: job.token } } : {}),
    OR: [{ input: { path: ['intent'], equals: 'proactive-document-comments' } },
      { input: { path: ['intent'], equals: 'proactive-document-comment' } }],
    AND: [{ OR: [{ status: { in: ['PENDING', 'RUNNING'] } }, { status: 'FAILED', leaseUntil: { not: null } }] }],
  }, data: { status: 'CANCELLED', error: 'DOCUMENT_AUTOMATIC_REVIEW_RETIRED',
    leaseUntil: null, availableAt: null, completedAt: new Date() } });
}

export async function renewDocumentReviewLease(job: QueuedBackgroundReview): Promise<boolean> {
  const result = await prisma.aiTask.updateMany({ where: { id: job.id, status: 'RUNNING', queueKey: DOCUMENT_REVIEW_QUEUE,
    input: { path: ['token'], equals: job.token } }, data: { leaseUntil: new Date(Date.now() + COLLABORATION_REQUEST_LEASE_MS) } });
  return result.count === 1;
}

export async function rescheduleDocumentReview(job: QueuedBackgroundReview,
  outcome: { code: string; capacity?: boolean; stopped?: boolean; terminal?: boolean; retryAfterMs?: number }) {
  const preserveAttempt = outcome.capacity || outcome.stopped;
  const prepared = await prisma.aiTask.findUnique({ where: { id: job.id }, select: { output: true } });
  const hasPrepared = Boolean(object(prepared?.output).preparedResponse);
  const terminal = outcome.terminal || (!preserveAttempt && (hasPrepared ? job.attemptCount >= DOCUMENT_REVIEW_MAX_COMMIT_ATTEMPTS : job.attemptCount >= DOCUMENT_REVIEW_MAX_ATTEMPTS));
  const delay = Math.max(outcome.retryAfterMs ?? 0, preserveAttempt ? 5_000 : Math.min(60_000, 10_000 * 2 ** (job.attemptCount - 1)));
  return prisma.aiTask.updateMany({ where: { id: job.id, queueKey: DOCUMENT_REVIEW_QUEUE,
    OR: [{ status: 'RUNNING' }, { status: 'FAILED', leaseUntil: { not: null } }],
    input: { path: ['token'], equals: job.token } }, data: {
    status: terminal ? 'FAILED' : 'PENDING', error: outcome.code, leaseUntil: null,
    availableAt: terminal ? null : new Date(Date.now() + delay), completedAt: terminal ? new Date() : null,
    ...(preserveAttempt ? { attemptCount: { decrement: 1 } } : {}),
  } });
}

/** Explicit user retry starts a new bounded execution budget for the SAME
 * immutable task. It never silently replaces failed input or prepared evidence. */
export async function resumeDocumentReview(identity: DocumentRequestIdentity, command?: CodeRequestAlias): Promise<EnqueueReviewResult> {
  const result = await runMutationTransaction<EnqueueReviewResult>(async tx => {
    await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${identity.participationId} FOR UPDATE`;
    if (command) {
      const previous = await findCodeBackgroundAlias(tx, { ...identity, requestId: command.requestId });
      if (previous) return 'conflict' in previous || previous.row.id !== documentTaskId(identity.participationId, identity.requestId)
        || previous.row.bodyDigest !== codeBackgroundBodyDigest(command.body) ? { kind: 'conflict' }
        : { kind: 'existing', state: previous.state };
    }
    const task = await tx.aiTask.findUnique({ where: { id: documentTaskId(identity.participationId, identity.requestId) } });
    const saved = object(task?.input);
    if (!task || task.queueKey !== DOCUMENT_REVIEW_QUEUE || task.createdById !== identity.studentId
      || saved.participationId !== identity.participationId || saved.stageKey !== identity.stageKey
      || saved.workspaceKind !== identity.workspaceKind || saved.conversationId !== identity.conversationId) return { kind: 'conflict' };
    // A retained lease still belongs to the original executor/recovery path.
    // Manual retry must not restart that task's budget or supersede its token.
    const saveCommand = async () => {
      if (command) await tx.$executeRaw`INSERT INTO "AiTaskRequestAlias" ("participationId", "clientRequestId", "taskId", "bodyDigest", "requestBody")
        VALUES (${identity.participationId}, ${command.requestId}, ${task.id}, ${codeBackgroundBodyDigest(command.body)}, ${JSON.stringify(command.body)}::jsonb)`;
    };
    if (task.status !== 'FAILED' || task.leaseUntil !== null) {
      await saveCommand();
      return { kind: 'existing', state: await projectDocumentTaskReceipt(task, identity, tx) };
    }
    const snapshot = saved.reviewSnapshot as SharedReviewSnapshot | undefined;
    if (!snapshot) return { kind: 'conflict' };
    await assertDocumentReviewScope(tx, snapshot);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DOCUMENT_REVIEW_QUEUE}, 0))::text`;
    if (!await hasDocumentReviewAdmissionCapacity(tx, DOCUMENT_REVIEW_QUEUE, DOCUMENT_REVIEW_MAX_PENDING, resolveProactiveReviewConcurrency())) return { kind: 'full' };
    const updated = await tx.aiTask.update({ where: { id: task.id }, data: {
      status: 'PENDING', availableAt: new Date(), completedAt: null, leaseUntil: null, attemptCount: 0, error: null,
    } });
    await saveCommand();
    return { kind: 'queued', state: projectDocumentTask(updated) };
  }, { lowPriorityCourseId: identity.courseId });
  if (result.kind === 'queued') recordDocumentReviewLifecycle('resumed');
  return result;
}
