import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import type { SessionAction } from "@/lib/session/actions";
import type { AiContribution, CompanionProcessRecord, Course, LearningEvidence } from "@/lib/session/types";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { PlatformError } from "@/lib/platform/repository";
import { projectGroupStorageId, projectGroupViewId } from "@/lib/platform/group-identity";
import { persistCompanionProcessRecord, projectCompanionProcessRecord } from "@/lib/companion/process-record-store";
import type { ActionAck, ActionEnvelope } from "./contracts";
import { assertStudentActionScope } from "./v2-action-scope";

type StudentAiAction = Extract<SessionAction, { type: "UPSERT_AI_CONTRIBUTION" | "ADD_COMPANION_PROCESS_RECORD" }>;
export function isStudentAiRecordAction(action: SessionAction): action is StudentAiAction {
  return action.type === "UPSERT_AI_CONTRIBUTION" || action.type === "ADD_COMPANION_PROCESS_RECORD";
}
type Scope = {
  participationId: string; offeringId: string; researchKey: string;
  userStatus: string; userRole: string; sessionVersion: number; enrollmentStatus: string;
  instanceStatus: string; offeringStatus: string; archivedAt: Date | null;
  runtimeVersion: unknown; receipt: unknown | null;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const forbidden = () => new PlatformError("FORBIDDEN_ACTION_SCOPE", "只能操作本人或所在小组的课堂记录", 403);

/** Only these two personal actions use this small authoritative projection.
 * It is for authorization, never passed to aggregate course persistence. The
 * caller retains course advisory + instance row locks through record + receipt. */
export async function saveStudentAiRecord(
  tx: Prisma.TransactionClient, courseId: string, envelope: ActionEnvelope, claims: AuthClaims,
  key: string, fingerprint: string,
): Promise<ActionAck> {
  const action = envelope.action;
  if (!isStudentAiRecordAction(action) || claims.role !== "student" || !claims.sub) throw forbidden();
  const [scope] = await tx.$queryRaw<Scope[]>`SELECT p.id AS "participationId", e."offeringId", e."researchKey",
      u.status AS "userStatus", u.role AS "userRole", u."sessionVersion", e.status AS "enrollmentStatus",
      ci.status AS "instanceStatus", o.status AS "offeringStatus", a."archivedAt",
      ci."runtimeConfig" -> 'version' AS "runtimeVersion",
      (SELECT jsonb_build_object('fingerprint', d.payload -> 'fingerprint', 'ack', d.payload -> 'ack')
        FROM "DomainEvent" d WHERE d."idempotencyKey" = ${key}) AS receipt
    FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id = p."enrollmentId"
    JOIN "User" u ON u.id = e."userId" JOIN "ClassroomInstance" ci ON ci.id = p."instanceId"
    JOIN "Activity" a ON a.id = ci."activityId" JOIN "Chapter" c ON c.id = a."chapterId"
    JOIN "CourseOffering" o ON o.id = c."offeringId"
    WHERE p."instanceId" = ${courseId} AND e."userId" = ${claims.sub} AND e."offeringId" = o.id`;
  if (!scope) throw forbidden();
  if (scope.userStatus.toUpperCase() !== "ACTIVE" || scope.userRole.toUpperCase() !== "STUDENT"
    || scope.sessionVersion !== claims.sv || !["ACTIVE", "COMPLETED"].includes(scope.enrollmentStatus.toUpperCase())) {
    throw new PlatformError("FORBIDDEN", "账户或选课状态已变化，请重新登录或检查课堂权限", 403);
  }
  // As with personal drafts, an existing receipt can be read after class ends,
  // but only by the currently authorized owner and only for the identical body.
  if (scope.receipt) {
    const receipt = object(scope.receipt);
    if (receipt.fingerprint !== fingerprint || !receipt.ack) {
      throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他内容", 409);
    }
    return receipt.ack as ActionAck;
  }
  if (scope.instanceStatus.toUpperCase() !== "TEACHING" || scope.enrollmentStatus.toUpperCase() !== "ACTIVE"
    || scope.offeringStatus.toUpperCase() !== "OPEN" || scope.archivedAt) {
    throw new PlatformError("CLASSROOM_READ_ONLY", "课堂或选课状态已改变，当前仅可查看记录", 409);
  }
  const incoming = action.type === "UPSERT_AI_CONTRIBUTION" ? action.payload.contribution : action.payload.record;
  if (!incoming || typeof incoming.id !== "string" || !incoming.id || incoming.courseId !== courseId
    || incoming.studentId !== claims.sub) throw forbidden();
  const storageId = action.type === "UPSERT_AI_CONTRIBUTION" ? `${courseId}:aiContributions:${incoming.id}` : incoming.id;
  // Do not prefilter this lookup by the owner: a foreign record with the same
  // ID must be rejected, not treated as a new personal record.
  const candidates = action.type === "UPSERT_AI_CONTRIBUTION"
    ? await tx.aiSupportRecord.findMany({ where: { OR: [{ id: storageId }, {
      offeringId: scope.offeringId,
      AND: [{ OR: [{ participation: { instanceId: courseId } }, { structuredPayload: { path: ["instanceId"], equals: courseId } }] },
        { structuredPayload: { path: ["collection"], equals: "aiContributions" } },
        { structuredPayload: { path: ["view", "id"], equals: incoming.id } }],
    }] } })
    : [await tx.aiSupportRecord.findUnique({ where: { id: storageId } })].filter(row => row !== null);
  for (const candidate of candidates) {
    if (candidate.participationId !== scope.participationId || candidate.offeringId !== scope.offeringId
      || candidate.createdById !== claims.sub || candidate.type !== (action.type === "UPSERT_AI_CONTRIBUTION" ? "AICONTRIBUTIONS" : "COMPANION_PROCESS")) throw forbidden();
  }
  const previous = candidates.find(row => row.id === storageId) ?? candidates[0] ?? null;
  const course = createPblTemplateCourse(courseId);
  const previousView = previous ? action.type === "UPSERT_AI_CONTRIBUTION"
    ? object(previous.structuredPayload).view as AiContribution
    : projectCompanionProcessRecord(courseId, previous) : undefined;
  if (previous && (!previousView || previousView.id !== incoming.id)) throw forbidden();
  if (action.type === "UPSERT_AI_CONTRIBUTION") course.aiContributions = previousView ? [previousView as AiContribution] : [];
  else course.companionProcessRecords = previousView ? [previousView as CompanionProcessRecord] : [];
  const evidenceIds = action.type === "UPSERT_AI_CONTRIBUTION" ? action.payload.contribution.sourceEvidenceIds : action.payload.record.evidenceIds ?? [];
  if (!Array.isArray(evidenceIds) || evidenceIds.some(id => typeof id !== "string" || !id)) throw forbidden();
  const uniqueIds = [...new Set(evidenceIds)];
  if (uniqueIds.length) {
    // Read the specified identifiers across the class so the existing scope
    // validator sees foreign owners rather than silently filtering them away.
    const evidence = await tx.classroomSubmission.findMany({ where: {
      participation: { instanceId: courseId },
      AND: [{ payload: { path: ["collection"], equals: "learningEvidence" } },
        { OR: uniqueIds.map(id => ({ payload: { path: ["view", "id"], equals: id } })) }],
    }, select: { payload: true } });
    course.learningEvidence = evidence.map(row => object(row.payload).view as LearningEvidence).filter(Boolean);
  }
  if (action.type === "ADD_COMPANION_PROCESS_RECORD" && action.payload.record.taskId) {
    const task = await tx.aiTask.findFirst({ where: { id: action.payload.record.taskId,
      conversation: { participation: { instanceId: courseId } } }, select: { id: true, createdById: true, input: true } });
    // Match loadCompanionState: only legacy companion tasks are valid refs.
    const legacy = object(object(task?.input).legacy);
    if (task && typeof legacy.stageKey === "string") course.companionTasks = [{ ...legacy,
      id: task.id, courseId, studentId: task.createdById } as NonNullable<Course["companionTasks"]>[number]];
  }
  const groupIds = [...new Set([incoming, previousView, ...(course.learningEvidence ?? []), ...(course.companionTasks ?? [])]
    .map(item => object(item).groupId).filter((id): id is string => typeof id === "string" && Boolean(id)))];
  if (groupIds.length) {
    const groups = await tx.projectGroup.findMany({ where: { offeringId: scope.offeringId,
      id: { in: [...new Set(groupIds.flatMap(id => [projectGroupStorageId(scope.offeringId, id), id]))] } },
      select: { id: true, members: { where: { leftAt: null }, select: { userId: true } } } });
    course.groups = groups.map(group => ({ id: projectGroupViewId(scope.offeringId, group.id),
      members: group.members.map(member => ({ studentId: member.userId })) } as NonNullable<Course["groups"]>[number]));
  }
  assertStudentActionScope(course, action, claims.sub);
  if (JSON.stringify(previousView) !== JSON.stringify(incoming)) {
    if (action.type === "UPSERT_AI_CONTRIBUTION") {
      const contribution = action.payload.contribution;
      const data = { offeringId: scope.offeringId, participationId: scope.participationId, createdById: claims.sub,
        type: "AICONTRIBUTIONS", status: String(contribution.status ?? "OPEN"),
        summary: String(object(contribution).diagnosis ?? object(contribution).summary ?? ""),
        structuredPayload: json({ instanceId: courseId, collection: "aiContributions",
          provenance: { actorId: claims.sub, actorRole: claims.role }, view: contribution }) };
      const persistedId = previous?.id ?? storageId;
      await tx.aiSupportRecord.upsert({ where: { id: persistedId }, create: { id: persistedId, ...data },
        update: { ...data, createdById: undefined } });
    } else {
      await persistCompanionProcessRecord(tx, { courseId, studentId: claims.sub, ...scope }, action.payload.record, previous);
    }
  }
  const now = new Date(); const id = randomUUID();
  const ack: ActionAck = { requestId: envelope.requestId, courseVersion: Number(scope.runtimeVersion ?? 1) + 1,
    eventCursor: `${now.toISOString()}~${id}` };
  // Change only the version, preserving concurrent teacher state and all other
  // runtime fields. Both writes and the personal fact stay in this transaction.
  await tx.$executeRaw`UPDATE "ClassroomInstance" SET "runtimeConfig" = jsonb_set(
    CASE WHEN jsonb_typeof("runtimeConfig") = 'object' THEN "runtimeConfig" ELSE '{}'::jsonb END,
    '{version}', ${JSON.stringify(ack.courseVersion)}::jsonb, true), "updatedAt" = ${now} WHERE id = ${courseId}`;
  await tx.domainEvent.create({ data: { id, createdAt: now, idempotencyKey: key, actorId: claims.sub,
    offeringId: scope.offeringId, classroomInstanceId: courseId, participationId: scope.participationId,
    researchKey: scope.researchKey, eventType: "COURSE_ACTION",
    payload: json({ fingerprint, ack, action, scope: "student", studentId: claims.sub }) } });
  return ack;
}
