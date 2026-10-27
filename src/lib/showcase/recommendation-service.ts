import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthClaims } from "@/lib/auth/session";
import type { CourseContent } from "@/lib/session/types";
import { recordAiCacheEvent } from "@/lib/observability/classroom-ai";
import { inferResourcePackageShowcasePlan } from "@/lib/resource-package/types";
import { showcaseStore } from "./persistence";
import { getShowcaseData, ShowcasePresentationError } from "./presentation-service";
import { loadShowcaseRecommendationSnapshot, ShowcaseUnreadableArtifact } from "./recommendation-analysis";
import type { ShowcaseData } from "./types";
import type { ShowcaseQualityAnalysis, ShowcaseQualityDimension, ShowcaseRecommendationCandidate, ShowcaseRecommendations } from "./recommendation-types";
import { rankShowcaseCandidates, SHOWCASE_ANALYSIS_VERSION, showcaseArtifactDimensions, showcaseRecommendationTarget } from "./recommendations";
import { digestShowcaseContent, remapShowcaseReasons, showcaseAnalysisAvailableAt, showcaseContentChange, type ShowcaseContentSnapshot } from "./recommendation-preparation";
import { readShowcaseFactCounts } from "./recommendation-facts";

export const SHOWCASE_RECOMMENDATION_QUEUE = "showcase-recommendation-v2";
export const SHOWCASE_PREPARATION_QUEUE = "showcase-preparation-v2";
export const SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS = 2;
export const showcaseRecommendationDigest = digestShowcaseContent;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const showcaseJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export type ShowcaseRecommendationTask = {
  schemaVersion: 1 | 2; analysisVersion: number; courseId: string; studentId: string;
  artifactVersionId: string; artifactKind: "document" | "pdf"; contextFingerprint: string;
  requirements: string; dimensions: ShowcaseQualityDimension[]; snapshot?: ShowcaseContentSnapshot;
  priority?: number; jsonMode?: boolean; requests?: Array<{ at: string }>;
};
export type ShowcasePreparedState = {
  artifactVersionId: string; artifactKind: "document" | "pdf"; contextFingerprint: string;
  snapshot: ShowcaseContentSnapshot; taskId?: string; baselineTaskId?: string; pendingSince?: number;
  freshness: "exact" | "reused" | "minor-change" | "outdated" | "none";
  unreadable?: boolean; firstSubmittedAt?: string;
};
export const showcasePreparationId = (courseId: string, studentId: string) => `showcase-prepared:${digestShowcaseContent([courseId, studentId])}`;
export function showcaseRecommendationTaskId(task: ShowcaseRecommendationTask): string {
  return `showcase:${digestShowcaseContent(task.schemaVersion === 2 && task.snapshot
    ? [task.analysisVersion, task.courseId, task.studentId, task.snapshot.fingerprint, task.contextFingerprint]
    : task)}`;
}
export function showcaseAnalysisContext(content: CourseContent) {
  const stage = content.stagePlan?.stages.find(s => s.key === "make");
  const requirements = JSON.stringify({ projectTask: content.stagePlan?.projectTask, drivingQuestion: content.stagePlan?.drivingQuestion,
    requirements: stage?.requirements, outputs: stage?.outputs, finalDeliverables: content.stagePlan?.finalDeliverables,
    pblOutline: content.stagePlan ? undefined : content.pblOutline });
  const dimensions = showcaseArtifactDimensions(content.stagePlan?.evaluationRubric?.dimensions ?? content.evaluationPlan?.dimensions);
  return { requirements, dimensions, contextFingerprint: digestShowcaseContent({ requirements, dimensions, rubric: content.stagePlan?.evaluationRubric }) };
}

/** Only durable local preparation is scheduled on the submission path. No extraction or model call here. */
export async function enqueueShowcaseRecommendationForStudent(courseId: string, studentId: string): Promise<void> {
  const identity = { courseId, studentId, queuedAt: new Date().toISOString() };
  // Preserve the first notification in a burst, including while a local preparation lease is running.
  await prisma.aiTask.updateMany({ where: { id: showcasePreparationId(courseId, studentId), status: "READY" },
    data: { status: "PENDING", input: identity, availableAt: new Date(), error: null, leaseUntil: null } });
  await prisma.aiTask.upsert({ where: { id: showcasePreparationId(courseId, studentId) }, create: {
    id: showcasePreparationId(courseId, studentId), createdById: studentId, taskType: "SHOWCASE_RECOMMENDATION_PREPARATION",
    queueKey: SHOWCASE_PREPARATION_QUEUE, status: "PENDING", input: identity, availableAt: new Date(),
  }, update: { status: "PENDING", availableAt: new Date(), error: null, leaseUntil: null } });
}

const previousFirstSubmission = (value: unknown) => (value as ShowcasePreparedState | null)?.firstSubmittedAt;
export type ShowcaseRecommendationJob = { id: string; input: unknown; output?: unknown; attemptCount: number; startedAt: Date; queueKey?: string };
export async function prepareShowcaseRecommendation(job: ShowcaseRecommendationJob): Promise<void> {
  const identity = object(job.input), courseId = String(identity.courseId), studentId = String(identity.studentId);
  const course = await showcaseStore.loadCourse({ where: { id: courseId }, select: { content: true, status: true } });
  const guard = { id: job.id, status: "RUNNING", startedAt: job.startedAt };
  if (!course || course.status !== "teaching") {
    await prisma.aiTask.updateMany({ where: guard, data: { status: "READY", leaseUntil: null } }); return;
  }
  const latest = await prisma.artifactVersion.findFirst({ where: { status: "SUBMITTED", artifact: {
    type: { in: ["DOCUMENT_ARCHIVE", "PDF_ARCHIVE"] }, participation: { instanceId: courseId, enrollment: { userId: studentId } },
  } }, orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], select: { id: true, artifact: { select: { type: true } } } });
  if (!latest) { await prisma.aiTask.updateMany({ where: guard, data: { status: "READY", leaseUntil: null } }); return; }
  const earliest = previousFirstSubmission(job.output) ?? (await prisma.artifactVersion.findFirst({ where: { status: "SUBMITTED", artifact: { type: { in: ["DOCUMENT_ARCHIVE", "PDF_ARCHIVE"] }, participation: { instanceId: courseId, enrollment: { userId: studentId } } } }, orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }], select: { submittedAt: true, createdAt: true } }));
  const firstSubmittedAt = typeof earliest === "string" ? earliest : earliest ? (earliest.submittedAt ?? earliest.createdAt).toISOString() : undefined;
  const artifactKind = latest.artifact.type === "PDF_ARCHIVE" ? "pdf" as const : "document" as const;
  const context = showcaseAnalysisContext(course.content);
  const task: ShowcaseRecommendationTask = { schemaVersion: 2, analysisVersion: SHOWCASE_ANALYSIS_VERSION, courseId, studentId, artifactVersionId: latest.id, artifactKind, ...context };
  const previous = job.output as ShowcasePreparedState | null;
  let snapshot: ShowcaseContentSnapshot;
  try { snapshot = previous?.artifactVersionId === latest.id && previous.snapshot ? previous.snapshot : await loadShowcaseRecommendationSnapshot(task); }
  catch (e) {
    if (!(e instanceof ShowcaseUnreadableArtifact)) throw e;
    await prisma.aiTask.updateMany({ where: guard, data: { status: "READY", leaseUntil: null, error: e.message,
      output: showcaseJson({ artifactVersionId: latest.id, artifactKind, contextFingerprint: context.contextFingerprint, freshness: "none", unreadable: true, firstSubmittedAt }) } }); return;
  }
  await prisma.$transaction(async db => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`showcase:${courseId}:${studentId}`}))`;
    if (!await db.aiTask.findFirst({ where: guard, select: { id: true } })) return;
    const records = await db.aiTask.findMany({ where: { taskType: "SHOWCASE_RECOMMENDATION", createdById: studentId,
      input: { path: ["courseId"], equals: courseId } }, orderBy: { completedAt: "desc" } });
    const successes = records.filter(r => r.status === "COMPLETED" && (r.input as ShowcaseRecommendationTask)?.contextFingerprint === context.contextFingerprint);
    // Previously completed exact-version analyses remain valid; no mass re-analysis on upgrade.
    const baseline = successes.find(r => (r.input as ShowcaseRecommendationTask).snapshot?.fingerprint === snapshot.fingerprint
      || (r.input as ShowcaseRecommendationTask).artifactVersionId === latest.id) ?? successes[0];
    const baselineInput = baseline?.input as ShowcaseRecommendationTask | undefined;
    const baselineSnapshot = baselineInput?.snapshot ?? (baselineInput?.artifactVersionId === latest.id ? snapshot : undefined);
    const change = baselineSnapshot ? showcaseContentChange(baselineSnapshot, snapshot) : "significant";
    const enough = snapshot.text.length >= 20;
    const target = { ...task, snapshot, priority: baseline ? 1 : 0 };
    const id = showcaseRecommendationTaskId(target);
    const now = Date.now();
    const priorPending = records.find(r => r.id === previous?.taskId && ["PENDING", "RUNNING"].includes(r.status));
    const queuedAt = typeof identity.queuedAt === "string" ? Date.parse(identity.queuedAt) : now;
    const pendingSince = priorPending && previous?.contextFingerprint === context.contextFingerprint && previous.pendingSince ? previous.pendingSince : Number.isFinite(queuedAt) ? queuedAt : now;
    const requested = records.flatMap(r => ((r.input as ShowcaseRecommendationTask)?.requests ?? []).map(x => Date.parse(x.at)));
    let taskId: string | undefined;
    if (enough && baseline && change !== "significant") { taskId = baseline.id; recordAiCacheEvent("showcase-recommendation", "hit"); }
    else if (enough) {
      const availableAt = showcaseAnalysisAvailableAt(now, pendingSince, requested.length ? Math.max(...requested) : undefined);
      await db.aiTask.upsert({ where: { id }, create: { id, createdById: studentId, taskType: "SHOWCASE_RECOMMENDATION", queueKey: SHOWCASE_RECOMMENDATION_QUEUE,
        status: "PENDING", input: showcaseJson(target), availableAt }, update: {} });
      if (previous?.artifactVersionId !== latest.id) await db.aiTask.updateMany({ where: { id, status: "PENDING", attemptCount: 0 }, data: { availableAt } });
      // A canceled obsolete target may become current again. Its existing request budget is retained.
      await db.aiTask.updateMany({ where: { id, status: "CANCELLED", attemptCount: { lt: SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS } }, data: { status: "PENDING", availableAt } });
      taskId = id;
      recordAiCacheEvent("showcase-recommendation", records.some(r => r.id === id) ? "joined" : "miss");
    }
    await db.aiTask.updateMany({ where: { queueKey: SHOWCASE_RECOMMENDATION_QUEUE, createdById: studentId,
      input: { path: ["courseId"], equals: courseId }, status: "PENDING", ...(taskId ? { id: { not: taskId } } : {}) }, data: { status: "CANCELLED", error: "QUALITY_SUPERSEDED", completedAt: new Date(), leaseUntil: null } });
    const state: ShowcasePreparedState = { firstSubmittedAt, artifactVersionId: latest.id, artifactKind, contextFingerprint: context.contextFingerprint, snapshot,
      taskId, baselineTaskId: baseline?.id, pendingSince: change === "significant" && enough ? pendingSince : undefined,
      freshness: baseline && change !== "significant" ? change === "minor" ? "minor-change" : baselineInput?.artifactVersionId === latest.id ? "exact" : "reused" : baseline ? "outdated" : "none", unreadable: !enough };
    await db.aiTask.updateMany({ where: guard, data: { status: "READY", output: showcaseJson(state), completedAt: new Date(), leaseUntil: null, error: null } });
  });
}

export async function getShowcaseRecommendations(courseId: string, claims: AuthClaims, _ensureAnalysis = false): Promise<ShowcaseRecommendations> {
  // Compatibility POST is read-only; background repair owns all scheduling.
  void _ensureAnalysis;
  if (claims.role !== "teacher") throw new ShowcasePresentationError("FORBIDDEN", "只有教师可以查看汇报推荐。", 403);
  const showcase = await getShowcaseData(courseId, claims);
  const course = await showcaseStore.loadCourse({ where: { id: courseId }, select: { content: true, uiState: true } });
  if (!course) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
  const rawQueue = object(object(course.uiState).showcaseReporting);
  const plan = course.content.stagePlan?.showcasePlan ?? inferResourcePackageShowcasePlan(course.content.stagePlan?.stages.find(s => s.key === "showcase"));
  const target = showcaseRecommendationTarget(rawQueue.presenterCount, plan?.presenterCount);
  const context = showcaseAnalysisContext(course.content);
  const completed = new Set(showcase.queue.filter(q => q.status === "completed" || q.status === "evaluating").map(q => q.studentId));
  const candidates: ShowcaseRecommendationCandidate[] = showcase.students.filter(s => !completed.has(s.studentId)).flatMap(s => {
    const artifact = s.artifacts.filter(a => a.kind === "document" || a.kind === "pdf").sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.versionId.localeCompare(a.versionId))[0];
    return artifact ? [{ studentId: s.studentId, studentName: s.name, artifactVersionId: artifact.versionId, artifactKind: artifact.kind as "document" | "pdf",
      analysisStatus: "pending", analysisFreshness: "none", reasons: [], firstSubmittedAt: s.firstPresentableSubmissionAt, aiRequestCount: 0 }] : [];
  });
  const [prepared, counts] = await Promise.all([
    prisma.aiTask.findMany({ where: { id: { in: candidates.map(c => showcasePreparationId(courseId, c.studentId)) } } }), readShowcaseFactCounts(courseId),
  ]);
  const states = new Map(prepared.map(r => [r.createdById, r.output as ShowcasePreparedState | null]));
  const ids = candidates.flatMap(c => { const state = states.get(c.studentId); return [state?.taskId, state?.baselineTaskId].filter((id): id is string => !!id); });
  // Legacy exact-version cache remains readable, including finished classrooms that are never backfilled.
  const legacyIds = candidates.map(c => showcaseRecommendationTaskId({ schemaVersion: 1, analysisVersion: 1, courseId, studentId: c.studentId, artifactVersionId: c.artifactVersionId, artifactKind: c.artifactKind, ...context }));
  const records = await prisma.aiTask.findMany({ where: { id: { in: [...ids, ...legacyIds] } } });
  const byId = new Map(records.map(r => [r.id, r]));
  for (const [i, c] of candidates.entries()) {
    c.aiRequestCount = counts.get(c.studentId) ?? 0;
    const s = states.get(c.studentId);
    if (s?.firstSubmittedAt) c.firstSubmittedAt = s.firstSubmittedAt;
    const current = s?.artifactVersionId === c.artifactVersionId && s.contextFingerprint === context.contextFingerprint;
    const row = current && s.taskId ? byId.get(s.taskId) : byId.get(legacyIds[i]);
    c.analysisStatus = current && s.unreadable ? "unreadable" : row?.status === "COMPLETED" ? "complete" : row?.status === "RUNNING" ? "running" : row?.status === "FAILED" ? "failed" : "pending";
    if (row?.status === "COMPLETED") {
      const analysis = row.output as ShowcaseQualityAnalysis | null;
      const input = row.input as ShowcaseRecommendationTask;
      if (analysis && typeof analysis.qualityScore === "number" && Array.isArray(analysis.reasons)) {
        const reasons = current && input.artifactVersionId !== c.artifactVersionId ? remapShowcaseReasons(analysis.reasons, s.snapshot.blocks) : analysis.reasons;
        c.qualityScore = reasons.length ? analysis.qualityScore : undefined;
        c.reasons = reasons; c.coverage = analysis.coverage;
        c.analyzedArtifactVersionId = input.artifactVersionId; c.analyzedAt = row.completedAt?.toISOString();
        c.analysisFreshness = current ? input.snapshot?.fingerprint === s.snapshot.fingerprint ? input.artifactVersionId === c.artifactVersionId ? "exact" : "reused" : s.freshness : "exact";
      } else c.analysisStatus = "failed";
    } else if (current && s.baselineTaskId) {
      const prior = byId.get(s.baselineTaskId);
      c.analysisFreshness = "outdated"; c.analyzedArtifactVersionId = (prior?.input as ShowcaseRecommendationTask | undefined)?.artifactVersionId;
      c.analyzedAt = prior?.completedAt?.toISOString();
    }
  }
  return buildShowcaseRecommendationResult(courseId, target, candidates, showcase, records.map(r => r.updatedAt.toISOString()),
    showcase.students.map(s => ({ firstSubmittedAt: s.firstPresentableSubmissionAt, aiRequestCount: counts.get(s.studentId) ?? 0 })));
}
export function buildShowcaseRecommendationResult(courseId: string, target: Pick<ShowcaseRecommendations, "targetCount" | "targetSource">,
  candidates: ShowcaseRecommendationCandidate[], showcase: Pick<ShowcaseData, "queue" | "queueConfig">, updates: string[] = [],
  population?: Array<{ firstSubmittedAt?: string; aiRequestCount: number }>): ShowcaseRecommendations {
  const used = new Set([
    ...(showcase.queueConfig?.selectedStudentIds ?? []),
    ...showcase.queue.filter(item => ["completed", "evaluating", "presenting"].includes(item.status)).map(item => item.studentId),
  ]);
  const ranked = rankShowcaseCandidates(candidates, [...used], population);
  const recommendedStudentIds = ranked.filter(item => !used.has(item.studentId)).slice(0, Math.max(0, target.targetCount - used.size)).map(item => item.studentId);
  const result = { courseId, ...target, recommendedStudentIds, candidates: ranked,
    pendingCount: candidates.filter(item => item.analysisStatus === "pending" || item.analysisStatus === "running").length,
    updatedAt: updates.sort().at(-1) ?? "", revision: "" };
  // Lease renewals update storage timestamps without changing the recommendation.
  result.revision = showcaseRecommendationDigest({ courseId, ...target, recommendedStudentIds, candidates: ranked, pendingCount: result.pendingCount });
  return result;
}
