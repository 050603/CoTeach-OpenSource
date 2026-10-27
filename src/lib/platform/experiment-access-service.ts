import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { requireTeacherUser, type PlatformDb } from "./access";
import { evaluationContractVersion, posttestAccess, type PosttestAccess } from "./experiment";
import { PlatformError } from "./repository";

async function teacherInstance(claims: AuthClaims, instanceId: string, db: PlatformDb) {
  const teacher = await requireTeacherUser(claims, db);
  const instance = await db.classroomInstance.findUnique({ where: { id: instanceId }, include: { activity: { include: { chapter: { include: { offering: true } } } } } });
  if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
  const offeringId = instance.activity.chapter.offeringId;
  if (!await db.courseTeacher.findFirst({ where: { offeringId, userId: teacher.id }, select: { id: true } })) throw new PlatformError("FORBIDDEN", "无权管理此课堂的实验拓展", 403);
  return { instance, teacher, offeringId };
}

export async function getClassroomPosttestAccess(claims: AuthClaims, instanceId: string) {
  const { instance } = await teacherInstance(claims, instanceId, prisma);
  return { contractVersion: evaluationContractVersion(instance.runtimeConfig), access: posttestAccess(instance.runtimeConfig) };
}

export async function getActivityExperimentRuns(claims: AuthClaims, activityId: string) {
  const teacher = await requireTeacherUser(claims);
  const activity = await prisma.activity.findUnique({ where: { id: activityId }, include: { chapter: true } });
  if (!activity || activity.type.toUpperCase() !== "CLASSROOM") throw new PlatformError("NOT_FOUND", "课堂活动不存在", 404);
  if (!await prisma.courseTeacher.findFirst({ where: { offeringId: activity.chapter.offeringId, userId: teacher.id }, select: { id: true } })) throw new PlatformError("FORBIDDEN", "无权查看此课堂的实验拓展", 403);
  return prisma.classroomInstance.findMany({ where: { activityId }, orderBy: { runNo: "desc" }, select: { id: true, runNo: true, status: true } });
}

export async function setClassroomPosttestAccess(claims: AuthClaims, instanceId: string, input: { status: PosttestAccess["status"]; version: number }) {
  const result = await runMutationTransaction(async (tx) => {
    // Student drafts/submissions take a shared guard on this same row.
    await tx.$queryRaw`SELECT "id" FROM "ClassroomInstance" WHERE "id" = ${instanceId} FOR UPDATE`;
    const { instance, teacher, offeringId } = await teacherInstance(claims, instanceId, tx);
    if (evaluationContractVersion(instance.runtimeConfig) !== 2) throw new PlatformError("LEGACY_EXPERIMENT_ACCESS", "历史场次保留原有后测开放方式，请为新的课堂场次配置实验拓展", 409);
    const current = posttestAccess(instance.runtimeConfig);
    if (input.version !== current.version) throw new PlatformError("ASSESSMENT_ACCESS_VERSION_CONFLICT", "后测开放状态已变化，请刷新后再试", 409);
    if (current.status === input.status) return { contractVersion: 2 as const, access: current };
    if (input.status === "open") {
      const { activity } = instance;
      const now = new Date();
      if (instance.status.toLowerCase() !== "finished" || activity.chapter.offering.status.toLowerCase() !== "open"
        || activity.archivedAt || activity.chapter.archivedAt || !activity.isOpen || !activity.chapter.isOpen
        || activity.opensAt && activity.opensAt > now || activity.chapter.opensAt && activity.chapter.opensAt > now) {
        throw new PlatformError("ASSESSMENT_UNAVAILABLE", "请先结束本场课堂，再开放后测；教学班、章节和课堂活动须保持开放", 409);
      }
      if (!await tx.experimentAssessmentAssignment.count({ where: { instanceId } })) throw new PlatformError("ASSESSMENT_ASSIGNMENT_REQUIRED", "本场尚无已分配的前后测题目，请先配置实验并由学生完成前测", 409);
    }
    const now = new Date().toISOString();
    const access: PosttestAccess = { ...current, status: input.status, version: current.version + 1, ...(input.status === "open" ? { openedAt: now } : { closedAt: now }) };
    const runtime = instance.runtimeConfig && typeof instance.runtimeConfig === "object" && !Array.isArray(instance.runtimeConfig) ? instance.runtimeConfig as Record<string, unknown> : {};
    await tx.classroomInstance.update({ where: { id: instanceId }, data: { runtimeConfig: { ...runtime, posttestAccess: access, version: Number(runtime.version ?? 1) + 1 } as Prisma.InputJsonValue } });
    await tx.domainEvent.create({ data: { id: randomUUID(), idempotencyKey: `posttest-access:${instanceId}:${access.version}`, actorId: teacher.id, offeringId, classroomInstanceId: instanceId, eventType: "experiment-posttest-access-changed", payload: { previousStatus: current.status, ...access } } });
    return { contractVersion: 2 as const, access };
  });
  try { await publishCourseEvent(instanceId, { type: "course-updated", courseId: instanceId, at: new Date().toISOString(), payload: { scope: "course" } }); }
  catch (error) { console.error("[experiment] access notification failed", error); }
  return result;
}
