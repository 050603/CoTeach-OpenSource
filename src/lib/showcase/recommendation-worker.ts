import "server-only";
import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import { isBackgroundAiCapacityError } from "@/lib/llm/classroom-capacity";
import { LlmJsonModeUnsupportedError } from "@/lib/llm/errors";
import { executeShowcaseRecommendationAnalysis, ShowcaseRecommendationScopeChanged, ShowcaseUnreadableArtifact } from "./recommendation-analysis";
import { prepareShowcaseRecommendation, enqueueShowcaseRecommendationForStudent, showcasePreparationId, showcaseAnalysisContext, showcaseJson,
  SHOWCASE_PREPARATION_QUEUE, SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS, SHOWCASE_RECOMMENDATION_QUEUE,
  type ShowcaseRecommendationTask, type ShowcasePreparedState, type ShowcaseRecommendationJob } from "./recommendation-service";
import { SHOWCASE_COOLDOWN_MS } from "./recommendation-preparation";
import { refreshShowcaseFacts } from "./recommendation-facts";
import { showcaseStore, createShowcaseStore } from "./persistence";

type Job = ShowcaseRecommendationJob;
const LEASE_MS = 120_000;
const stageKey = (course: { stages: unknown; currentStageIndex: number }) => {
  const stage = Array.isArray(course.stages) ? course.stages[course.currentStageIndex] as { key?: string } | undefined : undefined;
  return stage?.key ?? "";
};
class ShowcaseAnalysisDeferred extends Error { constructor(public availableAt: Date) { super("QUALITY_COOLDOWN"); } }

export async function claimShowcaseRecommendation(queue?: string): Promise<Job | null> {
  await prisma.aiTask.updateMany({ where: { queueKey: SHOWCASE_RECOMMENDATION_QUEUE, status: "RUNNING", leaseUntil: { lt: new Date() }, attemptCount: { gte: SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS } },
    data: { status: "FAILED", error: "QUALITY_RETRIES_EXHAUSTED", completedAt: new Date(), leaseUntil: null } });
  const rows = await prisma.$queryRaw<Job[]>`WITH next AS (
    SELECT id FROM "AiTask" WHERE "queueKey" IN (${SHOWCASE_PREPARATION_QUEUE}, ${SHOWCASE_RECOMMENDATION_QUEUE})
      AND (${queue ?? null}::text IS NULL OR "queueKey" = ${queue ?? null})
      AND ("queueKey" = ${SHOWCASE_PREPARATION_QUEUE} OR "attemptCount" < ${SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS})
      AND ((status = 'PENDING' AND ("availableAt" IS NULL OR "availableAt" <= now())) OR (status = 'RUNNING' AND "leaseUntil" < now()))
    ORDER BY CASE WHEN "queueKey" = ${SHOWCASE_PREPARATION_QUEUE} THEN -1 ELSE COALESCE((input->>'priority')::int, 0) END, "createdAt", id
    LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE "AiTask" t SET status = 'RUNNING', "startedAt" = date_trunc('milliseconds', clock_timestamp()),
      "leaseUntil" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond', "updatedAt" = clock_timestamp()
    FROM next WHERE t.id = next.id RETURNING t.id, t.input, t.output, t."queueKey", t."attemptCount", t."startedAt"`;
  return rows[0] ?? null;
}

/** Reserve each real HTTP request, including a format fallback, under the student's shared lock. */
export async function reserveShowcaseModelRequest(job: Job): Promise<void> {
  const task = job.input as ShowcaseRecommendationTask;
  await prisma.$transaction(async db => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`showcase:${task.courseId}:${task.studentId}`}))`;
    const [current, prepared, course, latest] = await Promise.all([
      db.aiTask.findFirst({ where: { id: job.id, status: "RUNNING", startedAt: job.startedAt } }),
      db.aiTask.findUnique({ where: { id: showcasePreparationId(task.courseId, task.studentId) } }),
      createShowcaseStore(db).loadCourse({ where: { id: task.courseId }, select: { status: true, content: true, stages: true, currentStageIndex: true } }),
      db.artifactVersion.findFirst({ where: { status: "SUBMITTED", artifact: { type: { in: ["DOCUMENT_ARCHIVE", "PDF_ARCHIVE"] }, participation: { instanceId: task.courseId, enrollment: { userId: task.studentId } } } },
        orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], select: { id: true } }),
    ]);
    if (!current || course?.status !== "teaching" || !["make", "showcase"].includes(stageKey(course))) throw new ShowcaseRecommendationScopeChanged("QUALITY_SCOPE_CLOSED");
    if (showcaseAnalysisContext(course.content).contextFingerprint !== task.contextFingerprint) throw new ShowcaseRecommendationScopeChanged("QUALITY_CONTEXT_CHANGED");
    const state = prepared?.output as ShowcasePreparedState | null;
    if (prepared?.status !== "READY" || state?.artifactVersionId !== latest?.id) throw new ShowcaseAnalysisDeferred(new Date(Date.now() + 5_000));
    if (state?.taskId !== job.id) throw new ShowcaseRecommendationScopeChanged("QUALITY_SUPERSEDED");
    if (current.attemptCount >= SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS) throw new ShowcaseRecommendationScopeChanged("QUALITY_REQUEST_BUDGET_EXHAUSTED");
    const others = await db.aiTask.findMany({ where: { queueKey: SHOWCASE_RECOMMENDATION_QUEUE, createdById: task.studentId,
      input: { path: ["courseId"], equals: task.courseId }, attemptCount: { gt: 0 } }, select: { input: true } });
    const times = others.flatMap(r => ((r.input as ShowcaseRecommendationTask).requests ?? []).map(r => Date.parse(r.at)));
    const last = times.length ? Math.max(...times) : 0;
    if (Date.now() < last + SHOWCASE_COOLDOWN_MS) throw new ShowcaseAnalysisDeferred(new Date(last + SHOWCASE_COOLDOWN_MS));
    const input = current.input as ShowcaseRecommendationTask;
    const next = { ...input, requests: [...(input.requests ?? []), { at: new Date().toISOString() }] };
    const reserved = await db.aiTask.updateMany({ where: { id: current.id, status: "RUNNING", startedAt: job.startedAt, attemptCount: { lt: SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS } },
      data: { attemptCount: { increment: 1 }, input: showcaseJson(next) } });
    if (!reserved.count) throw new ShowcaseRecommendationScopeChanged("QUALITY_LEASE_LOST");
  });
}

export async function runShowcaseRecommendationJob(job: Job, stopSignal: AbortSignal, execute = executeShowcaseRecommendationAnalysis): Promise<void> {
  const lease = new AbortController(), signal = AbortSignal.any([stopSignal, lease.signal]);
  const guard = { id: job.id, status: "RUNNING", startedAt: job.startedAt };
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => { if (renewal) return;
    renewal = prisma.aiTask.updateMany({ where: guard, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } })
      .then(r => { if (!r.count) lease.abort(new Error("QUALITY_LEASE_LOST")); }).catch(e => lease.abort(e)).finally(() => { renewal = undefined; });
  }, 30_000); timer.unref?.();
  try {
    signal.throwIfAborted();
    if (job.queueKey === SHOWCASE_PREPARATION_QUEUE) { await prepareShowcaseRecommendation(job); return; }
    const task = job.input as ShowcaseRecommendationTask;
    if (task?.schemaVersion !== 2 || !task.snapshot) throw new ShowcaseRecommendationScopeChanged("QUALITY_TASK_INVALID");
    // Recheck rubric before reserving provider capacity and again just before sending.
    const course = await showcaseStore.loadCourse({ where: { id: task.courseId }, select: { content: true } });
    if (!course || showcaseAnalysisContext(course.content).contextFingerprint !== task.contextFingerprint) throw new ShowcaseRecommendationScopeChanged("QUALITY_CONTEXT_CHANGED");
    const result = await execute(task, signal, () => reserveShowcaseModelRequest(job));
    signal.throwIfAborted();
    const saved = await prisma.aiTask.updateMany({ where: guard, data: { status: "COMPLETED", output: showcaseJson(result), error: null, completedAt: new Date(), leaseUntil: null } });
    // A newer submission may now be only a minor edit of this newly completed baseline.
    if (saved.count) {
      try { await enqueueShowcaseRecommendationForStudent(task.courseId, task.studentId); }
      catch { console.error("[showcase-recommendation] baseline refresh deferred to reconciliation"); }
    }
  } catch (error) {
    const stopped = stopSignal.aborted, capacity = isBackgroundAiCapacityError(error), deferred = error instanceof ShowcaseAnalysisDeferred;
    const unreadable = error instanceof ShowcaseUnreadableArtifact, stale = error instanceof ShowcaseRecommendationScopeChanged;
    const current = await prisma.aiTask.findUnique({ where: { id: job.id }, select: { attemptCount: true, input: true } });
    const preparation = job.queueKey === SHOWCASE_PREPARATION_QUEUE;
    const terminal = unreadable || stale || (!preparation && (current?.attemptCount ?? 0) >= SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS);
    const input = current?.input as ShowcaseRecommendationTask | undefined;
    const last = input?.requests?.at(-1)?.at;
    await prisma.aiTask.updateMany({ where: guard, data: {
      status: unreadable ? "UNREADABLE" : stale ? "CANCELLED" : terminal ? "FAILED" : "PENDING",
      error: unreadable || stale ? (error as Error).message : stopped ? "QUALITY_WORKER_STOPPED" : deferred ? error.message : capacity ? "QUALITY_CAPACITY_BUSY" : error instanceof Error && /^QUALITY_[A-Z_]+$/.test(error.message) ? error.message : "QUALITY_ANALYSIS_FAILED",
      leaseUntil: null, completedAt: terminal ? new Date() : null,
      availableAt: terminal ? null : deferred ? error.availableAt : new Date(Math.max(Date.now() + (capacity ? error.retryAfterMs : 5_000), last ? Date.parse(last) + SHOWCASE_COOLDOWN_MS : 0)),
      ...(error instanceof LlmJsonModeUnsupportedError && input ? { input: showcaseJson({ ...input, jsonMode: false }) } : {}),
    } });
    if (preparation && !stopped) console.error("[showcase-recommendation] preparation deferred", error instanceof Error ? error.message : "unavailable");
  } finally { clearInterval(timer); await renewal; }
}

/** Incremental repair only for live make/showcase classrooms. Finished classes never generate new model jobs. */
export async function reconcileShowcaseRecommendations(): Promise<void> {
  // Old abandoned teaching sessions must not become a migration-sized model backlog on deployment.
  // Submission notifications are always accepted; repair resumes when a class advances, a student
  // returns, or a new artifact is submitted.
  const recentSince = new Date(Date.now() - 24 * 60 * 60_000);
  const instances = await prisma.classroomInstance.findMany({ where: { status: "TEACHING", OR: [
    { updatedAt: { gte: recentSince } },
    { participations: { some: { lastEnteredAt: { gte: recentSince } } } },
    { participations: { some: { artifacts: { some: { versions: { some: { status: "SUBMITTED", submittedAt: { gte: recentSince } } } } } } } },
  ] }, select: { id: true } });
  for (const instance of instances) {
    const course = await showcaseStore.loadCourse({ where: { id: instance.id }, select: { content: true, stages: true, currentStageIndex: true } });
    if (!course || !["make", "showcase"].includes(stageKey(course))) continue;
    const participants = await prisma.classroomParticipation.findMany({ where: { instanceId: instance.id }, select: { enrollment: { select: { userId: true } },
      artifacts: { where: { type: { in: ["DOCUMENT_ARCHIVE", "PDF_ARCHIVE"] } }, select: { versions: { where: { status: "SUBMITTED" }, orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, submittedAt: true, createdAt: true } } } } } });
    const context = showcaseAnalysisContext(course.content).contextFingerprint;
    for (const p of participants) {
      const userId = p.enrollment.userId;
      const latest = p.artifacts.flatMap(a => a.versions).sort((a, b) => (b.submittedAt ?? b.createdAt).getTime() - (a.submittedAt ?? a.createdAt).getTime() || b.id.localeCompare(a.id))[0];
      if (!latest) continue;
      const cached = await prisma.aiTask.findUnique({ where: { id: showcasePreparationId(instance.id, userId) } });
      const state = cached?.output as ShowcasePreparedState | null;
      if (!cached || (cached.status === "READY" && (state?.artifactVersionId !== latest.id || state?.contextFingerprint !== context))) await enqueueShowcaseRecommendationForStudent(instance.id, userId);
    }
    if (participants[0]) await refreshShowcaseFacts(instance.id, participants[0].enrollment.userId);
  }
}

type Runtime = { controller?: AbortController; timers: Array<ReturnType<typeof setTimeout>>; active: Set<Promise<void>>; repairedAt?: number };
declare global { var __openPblShowcaseRecommendationWorker: Runtime | undefined; }
const state = globalThis.__openPblShowcaseRecommendationWorker ??= { timers: [], active: new Set() };
export function startShowcaseRecommendationWorker(): void {
  if (state.controller && !state.controller.signal.aborted) return;
  if (!isDatabaseConfigured() || process.env.NEXT_PHASE === "phase-production-build") return;
  const controller = state.controller = new AbortController();
  state.timers = []; state.active = new Set();
  const startLane = (queue: string, index: number) => {
    const tick = async () => {
      try {
        if (queue === SHOWCASE_PREPARATION_QUEUE && Date.now() - (state.repairedAt ?? 0) > 60_000) {
          state.repairedAt = Date.now(); await reconcileShowcaseRecommendations();
        }
        const job = await claimShowcaseRecommendation(queue); if (job) await runShowcaseRecommendationJob(job, controller.signal);
      } catch { console.error("[showcase-recommendation] durable queue unavailable; retrying"); }
      finally { if (!controller.signal.aborted) { state.timers[index] = setTimeout(run, 1_000); state.timers[index].unref?.(); } }
    };
    const run = () => { const active = tick(); state.active.add(active); void active.finally(() => state.active.delete(active)); };
    run();
  };
  // Local preparation/recovery keeps running even while a provider response is slow.
  startLane(SHOWCASE_PREPARATION_QUEUE, 0); startLane(SHOWCASE_RECOMMENDATION_QUEUE, 1);
}
export async function stopShowcaseRecommendationWorker(): Promise<void> {
  state.controller?.abort(); state.timers.forEach(clearTimeout);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.allSettled([...state.active]), new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
