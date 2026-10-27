import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { canAccessLegacyCourse, getPlatformUser } from "@/lib/platform/access";
import { PlatformError } from "@/lib/platform/repository";
import { readProcessEvidence, processHash, processObject } from "./process-evidence";
import type { ProcessEvaluationSnapshot, RawPblProcessReport } from "./process-contract";

export const PROCESS_QUEUE = "pbl-process-evaluation";
export const PROCESS_REPORT_TYPE = "PBL_PROCESS_REPORT";
export const PROCESS_INTERVAL_MS = 5 * 60_000;
export const processJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function requireProcessTeacher(claims: AuthClaims, instanceId: string) {
  if (claims.role !== "teacher" || !claims.sub || !await canAccessLegacyCourse(claims, instanceId)) throw new PlatformError("FORBIDDEN", "只有本课堂教师可以读取过程评价", 403);
  const user = await getPlatformUser(claims);
  if (!user || (claims.sv !== undefined && user.sessionVersion !== claims.sv)) throw new PlatformError("FORBIDDEN", "登录状态已变化", 403);
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, select: { runtimeConfig: true, status: true } });
  if (!instance || processObject(instance.runtimeConfig).evaluationContractVersion !== 2) throw new PlatformError("EVALUATION_UNAVAILABLE", "该场次使用原有评价流程", 409);
  return instance;
}

export async function getProcessEvaluation(claims: AuthClaims, instanceId: string, participationId?: string): Promise<ProcessEvaluationSnapshot> {
  await requireProcessTeacher(claims, instanceId);
  const participants = await prisma.classroomParticipation.findMany({ where: { instanceId, ...(participationId ? { id: participationId } : {}) },
    select: { id: true, enrollment: { select: { userId: true, user: { select: { displayName: true } } } } } });
  if (participationId && !participants.length) throw new PlatformError("NOT_FOUND", "学生不属于本场课堂", 404);
  const ids = participants.map(p => p.id);
  const [reports, jobs] = await Promise.all([
    prisma.aiSupportRecord.findMany({ where: { participationId: { in: ids }, type: PROCESS_REPORT_TYPE, status: "READY" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    prisma.aiTask.findMany({ where: { queueKey: PROCESS_QUEUE, input: { path: ["instanceId"], equals: instanceId } }, orderBy: { updatedAt: "desc" }, take: 500 }),
  ]);
  const seen = new Set<string>();
  return { participants: participants.map(p => ({ participationId: p.id, studentId: p.enrollment.userId, name: p.enrollment.user.displayName })),
    reports: reports.flatMap(row => { if (!row.participationId || seen.has(row.participationId)) return []; seen.add(row.participationId); return [row.structuredPayload as unknown as RawPblProcessReport]; }),
    jobs: jobs.filter(job => ids.includes(String(processObject(job.input).participationId))).map(job => ({ id: job.id,
      participationId: String(processObject(job.input).participationId), status: job.status, ...(job.error ? { error: job.error } : {}), updatedAt: job.updatedAt.toISOString() })) };
}

/** Only committed records are loaded. No client-provided Course or evidence can reach a model. */
export async function enqueueProcessEvaluation(instanceId: string, options: { participationId?: string; studentId?: string; immediate?: boolean; retryFailed?: boolean } = {}) {
  const instance = await prisma.classroomInstance.findUnique({ where: { id: instanceId }, select: { status: true, runtimeConfig: true } });
  if (!instance || processObject(instance.runtimeConfig).evaluationContractVersion !== 2 || !["TEACHING", "FINISHED"].includes(instance.status.toUpperCase())) return 0;
  const participants = await prisma.classroomParticipation.findMany({ where: { instanceId,
    ...(options.participationId ? { id: options.participationId } : {}), ...(options.studentId ? { enrollment: { userId: options.studentId } } : {}) }, select: { id: true } });
  if (options.participationId && !participants.length) throw new PlatformError("NOT_FOUND", "学生不属于本场课堂", 404);
  let queued = 0;
  for (const p of participants) {
    const snapshot = await readProcessEvidence(p.id);
    if (snapshot.contractVersion !== 2) continue;
    const id = `pbl-process:${processHash([p.id, snapshot.fingerprint])}`;
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`process-evaluation:${p.id}`}, 0))`;
      const newerTask = await tx.aiTask.findFirst({ where: { queueKey: PROCESS_QUEUE, status: { in: ["PENDING", "RUNNING", "COMPLETED"] },
        AND: [{ input: { path: ["participationId"], equals: p.id } }, { input: { path: ["snapshotAt"], gt: snapshot.snapshotAt } }] }, select: { id: true } });
      if (newerTask) return;
      const existing = await tx.aiTask.findUnique({ where: { id } });
      if (existing && existing.status !== "CANCELLED" && !(existing.status === "FAILED" && options.retryFailed)) {
        if (options.immediate && existing.status === "PENDING") await tx.aiTask.update({ where: { id }, data: { availableAt: new Date() } });
        return;
      }
      const latest = await tx.aiTask.findFirst({ where: { queueKey: PROCESS_QUEUE, createdById: snapshot.studentId,
        input: { path: ["participationId"], equals: p.id }, startedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
      const availableAt = new Date(options.immediate ? Date.now() : Math.max(Date.now(), (latest?.startedAt?.getTime() ?? 0) + PROCESS_INTERVAL_MS));
      await tx.aiTask.updateMany({ where: { queueKey: PROCESS_QUEUE, status: "PENDING", input: { path: ["participationId"], equals: p.id }, id: { not: id } },
        data: { status: "CANCELLED", error: "PROCESS_SUPERSEDED", completedAt: new Date() } });
      await tx.aiTask.upsert({ where: { id }, create: { id, createdById: snapshot.studentId, offeringId: snapshot.offeringId,
        taskType: "PBL_PROCESS_EVALUATION", queueKey: PROCESS_QUEUE, status: "PENDING", availableAt, input: processJson(snapshot) },
        update: { status: "PENDING", availableAt, completedAt: null, error: null, ...(options.retryFailed ? { attemptCount: 0 } : {}) } });
      queued++;
    });
  }
  return queued;
}
