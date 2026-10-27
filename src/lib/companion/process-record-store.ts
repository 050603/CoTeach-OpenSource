import { createHash } from "node:crypto";
import type { AiSupportRecord, Prisma } from "@prisma/client";
import { PlatformError } from "@/lib/platform/platform-error";
import type { CompanionProcessRecord } from "@/lib/session/types";

export type CompanionProcessScope = {
  courseId: string;
  participationId: string;
  studentId: string;
  offeringId: string;
  researchKey: string;
};
export type StoredProcessRecord = Pick<AiSupportRecord,
  "id" | "participationId" | "offeringId" | "createdById" | "type" | "summary" | "structuredPayload" | "createdAt">;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export function projectCompanionProcessRecord(courseId: string, row: StoredProcessRecord): CompanionProcessRecord {
  const data = object(row.structuredPayload);
  return { ...data, id: row.id, courseId, studentId: row.createdById,
    stageKey: String(data.stageKey ?? ""), title: String(data.title ?? ""), summary: row.summary ?? "",
    source: (data.source ?? "system") as CompanionProcessRecord["source"], createdAt: row.createdAt.toISOString() };
}

/** The caller holds the course mutation lock and has authorized the supplied
 * participation. A process record is immutable; its research fact uses the
 * established identity even when an acknowledged action is replayed. */
export async function persistCompanionProcessRecord(
  tx: Prisma.TransactionClient,
  scope: CompanionProcessScope,
  record: CompanionProcessRecord,
  existing?: StoredProcessRecord | null,
): Promise<void> {
  if (record.courseId !== scope.courseId || record.studentId !== scope.studentId) {
    throw new PlatformError("RECORD_SCOPE_MISMATCH", "过程记录归属不一致", 409);
  }
  const old = existing === undefined ? await tx.aiSupportRecord.findUnique({ where: { id: record.id } }) : existing;
  if (old && (old.participationId !== scope.participationId || old.offeringId !== scope.offeringId
    || old.createdById !== scope.studentId || old.type !== "COMPANION_PROCESS")) {
    throw new PlatformError("RECORD_SCOPE_MISMATCH", "过程记录归属不一致", 409);
  }
  if (!old) {
    await tx.aiSupportRecord.create({ data: { id: record.id, participationId: scope.participationId,
      offeringId: scope.offeringId, createdById: scope.studentId, type: "COMPANION_PROCESS", summary: record.summary,
      structuredPayload: json({ stageKey: record.stageKey, title: record.title, source: record.source,
        companionId: record.companionId, taskId: record.taskId, evidenceIds: record.evidenceIds }),
      createdAt: new Date(record.createdAt) } });
  }
  const persisted = old ? projectCompanionProcessRecord(scope.courseId, old)
    : { ...record, createdAt: new Date(record.createdAt).toISOString() };
  const eventType = "companion_process_recorded";
  const status = "RECORDED";
  const idempotencyKey = `companion-fact:${createHash("sha256").update(JSON.stringify([eventType, persisted.id, persisted.createdAt, status])).digest("hex")}`;
  await tx.domainEvent.upsert({ where: { idempotencyKey }, create: { idempotencyKey,
    offeringId: scope.offeringId, classroomInstanceId: scope.courseId, participationId: scope.participationId,
    researchKey: scope.researchKey, eventType, payload: { entityId: persisted.id, stageKey: persisted.stageKey,
      status, source: "session_dispatch", schemaVersion: 1 } }, update: {} });
}
