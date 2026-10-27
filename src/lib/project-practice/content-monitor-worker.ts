import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import { classroomAiCapacitySnapshot, isBackgroundAiCapacityError } from "@/lib/llm/classroom-capacity";
import { isProactiveReviewCapacityError, proactiveReviewCapacitySnapshot, resolveProactiveReviewConcurrency, withProactiveReviewCapacity } from "@/lib/ai-collaboration/proactive-review-capacity";
import { CONTENT_MONITOR_EVENT_TYPE, CONTENT_MONITOR_QUEUE, CONTENT_MONITOR_POLICY_VERSION, nonWhitespaceLength, type ContentMonitorEvent } from "./content-monitor-contract";
import { classifyDocumentPaste } from "./content-monitor-policy";
import { assertContentMonitorScope, clearedMonitorInput, ContentMonitorScopeClosed, monitorJson, notifyContentMonitorChange,
  readContentMonitorEvidence, type MonitorSnapshot } from "./content-monitor-service";

const LEASE_MS = 75_000;
const MAX_ATTEMPTS = 2;
export type ContentMonitorJob = { id: string; input: MonitorSnapshot; startedAt: Date; attemptCount: number };
type Classify = typeof classifyDocumentPaste;

/** Expired/revoked requests are terminal even when model capacity is saturated. */
export async function retireContentMonitorJobs() {
  await prisma.$executeRaw`UPDATE "AiTask" task SET status=CASE WHEN task."createdAt" < now()-interval '10 minutes' THEN 'FAILED' ELSE 'CANCELLED' END,
    error='CONTENT_MONITOR_UNAVAILABLE', "completedAt"=clock_timestamp(), "leaseUntil"=NULL,
    input=jsonb_build_object('requestId',input->'requestId','fingerprint',input->'fingerprint','courseId',input->'courseId',
      'studentId',input->'studentId','participationId',input->'participationId','submittedAt',input->'submittedAt'), "updatedAt"=clock_timestamp()
    WHERE task."queueKey"=${CONTENT_MONITOR_QUEUE} AND task.status IN ('PENDING','RUNNING') AND (
      task."createdAt" < now()-interval '10 minutes' OR NOT EXISTS (
        SELECT 1 FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id=p."enrollmentId"
        JOIN "User" u ON u.id=e."userId" JOIN "ClassroomInstance" ci ON ci.id=p."instanceId"
        JOIN "ClassroomTemplateVersion" tv ON tv.id=ci."templateVersionId"
        JOIN "Activity" a ON a.id=ci."activityId" JOIN "Chapter" ch ON ch.id=a."chapterId"
        JOIN "CourseOffering" o ON o.id=ch."offeringId"
        WHERE p.id=task.input->>'participationId' AND ci.id=task.input->>'courseId' AND u.id=task."createdById"
          AND e."offeringId"=o.id AND upper(ci.status)='TEACHING' AND upper(e.status)='ACTIVE' AND upper(o.status)='OPEN'
          AND upper(u.status)='ACTIVE' AND upper(u.role)='STUDENT' AND a."archivedAt" IS NULL
          AND u."sessionVersion"::text=task.input->>'sessionVersion'
          AND ci."templateVersionId"=task.input->>'templateVersionId'
          AND COALESCE(ci."runtimeConfig"->>'stageVersion','1')=task.input->>'stageVersion'
          AND ci."runtimeConfig"->'documentPasteMonitoringEnabled'='true'::jsonb
          AND COALESCE(ci."runtimeConfig"->>'makeArtifactMode',tv.snapshot->'design'->'pblConfig'->>'makeArtifactMode','document')='document'
      ))`;
  await prisma.$executeRaw`UPDATE "AiTask" SET status='FAILED', error='CONTENT_MONITOR_RETRIES_EXHAUSTED',
    "completedAt"=clock_timestamp(), "leaseUntil"=NULL, "updatedAt"=clock_timestamp(),
    input=jsonb_build_object('requestId',input->'requestId','fingerprint',input->'fingerprint','courseId',input->'courseId',
      'studentId',input->'studentId','participationId',input->'participationId','submittedAt',input->'submittedAt')
    WHERE "queueKey"=${CONTENT_MONITOR_QUEUE} AND status='RUNNING' AND "leaseUntil" < now() AND "attemptCount">=${MAX_ATTEMPTS}`;
}

export async function claimContentMonitorJob(): Promise<ContentMonitorJob | null> {
  const rows = await prisma.$queryRaw<ContentMonitorJob[]>`WITH candidate AS (
    SELECT id FROM "AiTask" WHERE "queueKey"=${CONTENT_MONITOR_QUEUE} AND "attemptCount"<${MAX_ATTEMPTS}
    AND ((status='PENDING' AND ("availableAt" IS NULL OR "availableAt" <= now())) OR (status='RUNNING' AND "leaseUntil" < now()))
    ORDER BY "availableAt", "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE "AiTask" task SET status='RUNNING', "startedAt"=date_trunc('milliseconds',clock_timestamp()),
    "leaseUntil"=clock_timestamp()+${LEASE_MS}*interval '1 millisecond', "attemptCount"="attemptCount"+1, "updatedAt"=clock_timestamp()
    FROM candidate WHERE task.id=candidate.id RETURNING task.id,task.input,task."startedAt",task."attemptCount"`;
  return rows[0] ?? null;
}

export async function runContentMonitorJob(job: ContentMonitorJob, stopSignal: AbortSignal, classify: Classify = classifyDocumentPaste) {
  const snapshot = job.input;
  const guard = { id: job.id, status: "RUNNING", startedAt: job.startedAt };
  const lease = new AbortController(), signal = AbortSignal.any([stopSignal, lease.signal]);
  let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = prisma.aiTask.updateMany({ where: guard, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } })
      .then(result => { if (!result.count) lease.abort(); }).catch(() => lease.abort()).finally(() => { renewing = undefined; });
  }, 15_000);
  timer.unref?.();
  let published = false;
  try {
    signal.throwIfAborted();
    const evidence = await readContentMonitorEvidence(snapshot);
    signal.throwIfAborted();
    const decision = evidence.sourceCoverageComplete === false ? { outcome: "incomplete" as const }
      : await withProactiveReviewCapacity(() => classify(evidence, { signal }), `paste-monitor:${job.id}`);
    signal.throwIfAborted();
    await prisma.$transaction(async tx => {
      await assertContentMonitorScope(tx, snapshot);
      signal.throwIfAborted();
      const id = `reminder:${job.id}`;
      const incomplete = decision.outcome === "incomplete";
      const flagged = decision.outcome === "flagged";
      const committed = await tx.aiTask.updateMany({ where: guard, data: { status: incomplete ? "FAILED" : "COMPLETED",
        completedAt: new Date(), leaseUntil: null, input: monitorJson(clearedMonitorInput(snapshot)),
        error: incomplete ? "CONTENT_MONITOR_INCOMPLETE" : null, output: monitorJson({ status: flagged ? "flagged" : incomplete ? "incomplete" : "clear", ...(flagged ? { eventId: id } : {}) }) } });
      if (!committed.count || !flagged) return;
      const now = new Date().toISOString();
      const event: ContentMonitorEvent = { id, studentId: snapshot.studentId, studentName: snapshot.studentName, createdAt: now,
        pastedCharacters: nonWhitespaceLength(evidence.pastedText), excerpt: decision.pasteExcerpt!, requirementQuote: decision.taskRequirement!,
        reason: decision.reason!, status: "pending", contentState: "unknown", history: [{ at: now, actor: "system", action: "created" }] };
      await tx.domainEvent.upsert({ where: { idempotencyKey: id }, create: { id, idempotencyKey: id, actorId: snapshot.studentId,
        offeringId: snapshot.offeringId, classroomInstanceId: snapshot.courseId, participationId: snapshot.participationId,
        researchKey: snapshot.researchKey, eventType: CONTENT_MONITOR_EVENT_TYPE,
        payload: monitorJson({ policyVersion: CONTENT_MONITOR_POLICY_VERSION, submittedAt: snapshot.submittedAt, event }) }, update: {} });
      published = true;
    });
    if (published) await notifyContentMonitorChange(snapshot.courseId, snapshot.studentId);
  } catch (error) {
    const closed = error instanceof ContentMonitorScopeClosed;
    const capacity = isBackgroundAiCapacityError(error) || isProactiveReviewCapacityError(error);
    const stopped = stopSignal.aborted || lease.signal.aborted;
    const terminal = closed || (!capacity && !stopped && job.attemptCount >= MAX_ATTEMPTS);
    await prisma.aiTask.updateMany({ where: guard, data: { status: closed ? "CANCELLED" : terminal ? "FAILED" : "PENDING", leaseUntil: null,
      error: closed ? "CONTENT_MONITOR_SCOPE_CLOSED" : capacity ? "CONTENT_MONITOR_CAPACITY_BUSY" : stopped ? "CONTENT_MONITOR_WORKER_STOPPED" : "CONTENT_MONITOR_INCOMPLETE",
      ...(terminal ? { input: monitorJson(clearedMonitorInput(snapshot)), completedAt: new Date() } : { availableAt: new Date(Date.now() + (capacity ? error.retryAfterMs : 2_000)), completedAt: null }),
      ...(capacity || stopped ? { attemptCount: { decrement: 1 } } : {}),
    } });
  } finally { clearInterval(timer); await renewing; }
}

type Worker = { controller?: AbortController; timer?: ReturnType<typeof setTimeout>; active?: Promise<void>; jobs: Set<Promise<void>> };
declare global { var __documentContentMonitorWorker: Worker | undefined; }
const worker = globalThis.__documentContentMonitorWorker ??= { jobs: new Set() };
export function startContentMonitorWorker() {
  if (!isDatabaseConfigured() || process.env.NEXT_PHASE === "phase-production-build" || worker.controller && !worker.controller.signal.aborted) return;
  const controller = worker.controller = new AbortController();
  const tick = async () => {
    try {
      await retireContentMonitorJobs();
      while (!controller.signal.aborted && worker.jobs.size < resolveProactiveReviewConcurrency()) {
        const foreground = classroomAiCapacitySnapshot(), background = proactiveReviewCapacitySnapshot();
        if (foreground.pending || foreground.active >= Math.max(1, foreground.limit - 2) || background.active >= background.limit) break;
        const job = await claimContentMonitorJob();
        if (!job) break;
        const work = runContentMonitorJob(job, controller.signal)
          .catch(() => { console.warn("[content-monitor] durable lease retained for recovery"); })
          .finally(() => { worker.jobs.delete(work); });
        worker.jobs.add(work);
      }
    } catch { console.warn("[content-monitor] queue unavailable; durable work will retry"); }
    finally { if (!controller.signal.aborted) { worker.timer = setTimeout(run, 2_000); worker.timer.unref?.(); } }
  };
  const run = () => { worker.active = tick(); };
  run();
}
export async function stopContentMonitorWorker() {
  worker.controller?.abort();
  if (worker.timer) clearTimeout(worker.timer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.allSettled([worker.active, ...worker.jobs]), new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
