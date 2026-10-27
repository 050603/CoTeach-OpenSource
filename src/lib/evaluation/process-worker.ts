import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import { isBackgroundAiCapacityError } from "@/lib/llm/classroom-capacity";
import { analyzeProcessEvidence, type ProcessEvidenceSnapshot } from "./process-analysis";
import { PROCESS_QUEUE, PROCESS_REPORT_TYPE, enqueueProcessEvaluation, processJson } from "./process-service";
import { processObject } from "./process-evidence";
import { takeProcessNotices } from "./process-notifications";
import type { RawPblProcessReport } from "./process-contract";

const LEASE_MS = 180_000;
const MAX_ATTEMPTS = 3;
type Job = { id: string; input: unknown; startedAt: Date; attemptCount: number };
export async function claimProcessJob(): Promise<Job | null> {
  await prisma.aiTask.updateMany({ where: { queueKey: PROCESS_QUEUE, status: "RUNNING", leaseUntil: { lt: new Date() }, attemptCount: { gte: MAX_ATTEMPTS } },
    data: { status: "FAILED", error: "PROCESS_RETRIES_EXHAUSTED", leaseUntil: null, completedAt: new Date() } });
  const rows = await prisma.$queryRaw<Job[]>`WITH candidate AS (
    SELECT id FROM "AiTask" WHERE "queueKey" = ${PROCESS_QUEUE} AND "attemptCount" < ${MAX_ATTEMPTS}
    AND ((status='PENDING' AND ("availableAt" IS NULL OR "availableAt" <= now())) OR (status='RUNNING' AND "leaseUntil" < now()))
    ORDER BY "availableAt", "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE "AiTask" task SET status='RUNNING', "startedAt"=date_trunc('milliseconds', clock_timestamp()),
    "leaseUntil"=clock_timestamp()+${LEASE_MS}*interval '1 millisecond', "attemptCount"="attemptCount"+1, "updatedAt"=clock_timestamp()
    FROM candidate WHERE task.id=candidate.id RETURNING task.id, task.input, task."startedAt", task."attemptCount"`;
  return rows[0] ?? null;
}

export async function runProcessJob(job: Job, stopSignal: AbortSignal,
  analyze: (snapshot: ProcessEvidenceSnapshot, id: string, signal: AbortSignal) => Promise<RawPblProcessReport> = analyzeProcessEvidence) {
  const snapshot = job.input as ProcessEvidenceSnapshot;
  const guard = { id: job.id, status: "RUNNING", startedAt: job.startedAt };
  const lease = new AbortController();
  const signal = AbortSignal.any([stopSignal, lease.signal]);
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => { if (renewal) return; renewal = prisma.aiTask.updateMany({ where: guard,
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).then(r => { if (!r.count) lease.abort(); }).catch(() => lease.abort()).finally(() => { renewal = undefined; }); }, 30_000);
  timer.unref?.();
  try {
    const instance = await prisma.classroomInstance.findUnique({ where: { id: snapshot.instanceId }, select: { runtimeConfig: true, status: true } });
    if (!instance || processObject(instance.runtimeConfig).evaluationContractVersion !== 2 || !["TEACHING", "FINISHED"].includes(instance.status.toUpperCase())) throw new Error("PROCESS_SCOPE_CLOSED");
    signal.throwIfAborted();
    const report = await analyze(snapshot, job.id, signal);
    signal.throwIfAborted();
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`process-evaluation:${snapshot.participationId}`}, 0))`;
      // Keep the live classroom scope stable until the report commits. A class can be
      // withdrawn or switched to a legacy contract while the model is still running.
      const [current] = await tx.$queryRaw<Array<{ runtimeConfig: unknown; status: string }>>`SELECT "runtimeConfig", status FROM "ClassroomInstance" WHERE id=${snapshot.instanceId} FOR SHARE`;
      if (!current || processObject(current.runtimeConfig).evaluationContractVersion !== 2 || !["TEACHING", "FINISHED"].includes(current.status.toUpperCase())) throw new Error("PROCESS_SCOPE_CLOSED");
      const latest = await tx.aiSupportRecord.findFirst({ where: { participationId: snapshot.participationId, type: PROCESS_REPORT_TYPE, status: "READY" }, orderBy: { createdAt: "desc" } });
      const newerExists = String(processObject(latest?.structuredPayload).snapshotAt ?? "") > snapshot.snapshotAt;
      // Claim and report commit atomically; a worker whose lease was replaced cannot publish.
      const saved = await tx.aiTask.updateMany({ where: guard, data: { status: "COMPLETED", output: processJson({ reportId: report.id }), error: null, completedAt: new Date(), leaseUntil: null } });
      if (!saved.count) return;
      await tx.aiSupportRecord.upsert({ where: { id: report.id }, create: { id: report.id, offeringId: snapshot.offeringId,
        participationId: snapshot.participationId, createdById: snapshot.studentId, type: PROCESS_REPORT_TYPE,
        status: newerExists ? "SUPERSEDED" : "READY", summary: report.summary, structuredPayload: processJson(report) }, update: {} });
      if (!newerExists) await tx.aiSupportRecord.updateMany({ where: { participationId: snapshot.participationId, type: PROCESS_REPORT_TYPE,
        status: "READY", id: { not: report.id } }, data: { status: "SUPERSEDED" } });
    });
  } catch (error) {
    const capacity = isBackgroundAiCapacityError(error);
    const stopped = stopSignal.aborted;
    const terminal = error instanceof Error && error.message === "PROCESS_SCOPE_CLOSED" || (!capacity && !stopped && job.attemptCount >= MAX_ATTEMPTS);
    await prisma.aiTask.updateMany({ where: guard, data: { status: terminal ? "FAILED" : "PENDING", leaseUntil: null,
      error: stopped ? "PROCESS_WORKER_STOPPED" : capacity ? "PROCESS_CAPACITY_BUSY" : error instanceof Error ? error.message.slice(0, 160) : "PROCESS_ANALYSIS_FAILED",
      ...(capacity || stopped ? { attemptCount: { decrement: 1 } } : {}),
      availableAt: new Date(Date.now() + (capacity ? error.retryAfterMs : 30_000 * job.attemptCount)), completedAt: terminal ? new Date() : null } });
  } finally { clearInterval(timer); await renewal; }
}

type Worker = { controller?: AbortController; timer?: ReturnType<typeof setTimeout>; active?: Promise<void>; reconciledAt: number; scans: Map<string, number> };
declare global { var __pblProcessWorker: Worker | undefined; }
const worker: Worker = globalThis.__pblProcessWorker ??= { reconciledAt: 0, scans: new Map() };
export function startProcessEvaluationWorker() {
  if (!isDatabaseConfigured() || process.env.NEXT_PHASE === "phase-production-build" || worker.controller && !worker.controller.signal.aborted) return;
  const controller = worker.controller = new AbortController();
  const tick = async () => {
    try {
      const notices = takeProcessNotices();
      for (const notice of notices) {
        const key = `${notice.instanceId}:${notice.studentId ?? "*"}`;
        if (!notice.immediate && Date.now() - (worker.scans.get(key) ?? 0) < 60_000) continue;
        worker.scans.set(key, Date.now());
        await enqueueProcessEvaluation(notice.instanceId, notice);
      }
      if (Date.now() - worker.reconciledAt > 60_000) {
        worker.reconciledAt = Date.now();
        // Reconcile only recently active V2 sessions, never a historical migration backlog.
        const rows = await prisma.classroomInstance.findMany({ where: { status: { in: ["TEACHING", "FINISHED"] }, runtimeConfig: { path: ["evaluationContractVersion"], equals: 2 },
          updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } }, select: { id: true }, take: 50 });
        for (const row of rows) await enqueueProcessEvaluation(row.id);
        for (const [key, at] of worker.scans) if (Date.now() - at > 24 * 60 * 60_000) worker.scans.delete(key);
      }
      const job = await claimProcessJob();
      if (job) await runProcessJob(job, controller.signal);
    } catch { console.error("[pbl-process-evaluation] durable queue unavailable; retrying"); }
    finally { if (!controller.signal.aborted) { worker.timer = setTimeout(run, 2_000); worker.timer.unref?.(); } }
  };
  const run = () => { worker.active = tick(); };
  run();
}
export async function stopProcessEvaluationWorker() {
  worker.controller?.abort(); if (worker.timer) clearTimeout(worker.timer); await worker.active;
}
