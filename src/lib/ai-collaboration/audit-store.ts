import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import type { AiInteractionEvent } from "@/lib/session/types";
import { PlatformError } from "@/lib/platform/platform-error";

export type AiInteractionEventInput = Omit<AiInteractionEvent, "id" | "createdAt"> & { id?: string; createdAt?: string; participationId?: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
import { projectEvent } from "./audit-read";
export { encodeAiInteractionCursor, loadCourseAiInteractionEvents, listAiInteractionEvents, aiInteractionEventsToCsv } from "./audit-read";

/** Persist legacy producer events as V2 facts. All IDs are resolved through participation. */
export async function appendAiInteractionEvents(events: AiInteractionEventInput[]): Promise<AiInteractionEvent[]> {
  if (!events.length) return [];
  const created = await runMutationTransaction(async tx => {
    const rows: AiInteractionEvent[] = [];
    for (const event of events) {
      const participation = await tx.classroomParticipation.findFirst({ where: { ...(event.participationId ? { id: event.participationId } : {}), instanceId: event.courseId, enrollment: { userId: event.studentId } }, include: { enrollment: true, instance: { include: { activity: { include: { chapter: true } } } } } });
      if (!participation || participation.enrollment.offeringId !== participation.instance.activity.chapter.offeringId) throw new PlatformError("EVENT_SCOPE_MISMATCH", "AI 事件归属无效", 403);
      await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${participation.id} FOR UPDATE`;
      const eventKey = event.id ?? (event.requestId ? hash([event.requestId, event.stageKey, event.source, event.eventType, event.actorRole, event.content, event.payload]) : randomUUID());
      const idempotencyKey = `legacy-ai:${hash([participation.id, event.studentId, eventKey])}`;
      const previous = await tx.aiInteractionEvent.findUnique({ where: { idempotencyKey } });
      if (previous) { rows.push(projectEvent(previous, event.courseId)); continue; }
      let conversationId: string | undefined;
      if (event.conversationId) {
        // Logical editor conversation IDs are not database foreign keys.
        const actual = await tx.aiConversation.findFirst({ where: { id: event.conversationId, participationId: participation.id, userId: event.studentId } });
        const id = actual?.id ?? `legacy-ai-conversation:${hash([participation.id, event.stageKey, event.conversationId])}`;
        const conversation = await tx.aiConversation.upsert({ where: { id }, create: { id, userId: event.studentId, offeringId: participation.enrollment.offeringId, participationId: participation.id, title: event.stageKey, metadata: { legacyAuditConversation: event.conversationId, stageKey: event.stageKey } }, update: {} });
        conversationId = conversation.id;
      }
      const row = await tx.aiInteractionEvent.create({ data: {
        idempotencyKey, userId: event.studentId, offeringId: participation.enrollment.offeringId, participationId: participation.id, researchKey: participation.enrollment.researchKey,
        conversationId, eventType: event.eventType, actor: event.actorRole === "ai" ? "assistant" : event.actorRole, content: event.content,
        requestId: event.requestId, payload: { schemaVersion: 1, legacy: { stageKey: event.stageKey, source: event.source, actorId: event.actorId ?? null, conversationId: event.conversationId ?? null, occurredAt: event.createdAt ?? null }, detail: event.payload ?? {} } as Prisma.InputJsonValue,
      } });
      rows.push(projectEvent(row, event.courseId));
    }
    return rows;
  });
  for (const courseId of new Set(created.map(event => event.courseId))) {
    const courseEvents = created.filter(event => event.courseId === courseId);
    try { await publishCourseEvent(courseId, { type: "companion-message", courseId, at: new Date().toISOString(), payload: { source: "ai-interaction-event", scope: "student", studentId: courseEvents[0].studentId, stageKey: courseEvents[0].stageKey, eventIds: courseEvents.map(event => event.id) } }); }
    catch (error) { console.error("[ai-audit] realtime publish failed after event save", error); }
  }
  return created;
}
