import type { AiInteractionEvent as EventRow, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AiInteractionEvent } from "@/lib/session/types";
import { PlatformError } from "@/lib/platform/platform-error";

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function projectEvent(row: EventRow, courseId: string): AiInteractionEvent {
  const envelope = object(row.payload); const legacy = object(envelope.legacy);
  return { id: row.id, courseId, studentId: row.userId, stageKey: String(legacy.stageKey ?? "make"), conversationId: typeof legacy.conversationId === "string" ? legacy.conversationId : row.conversationId ?? undefined, source: (legacy.source ?? "system") as AiInteractionEvent["source"], eventType: row.eventType as AiInteractionEvent["eventType"], actorRole: (row.actor === "assistant" ? "ai" : row.actor) as AiInteractionEvent["actorRole"], actorId: typeof legacy.actorId === "string" ? legacy.actorId : undefined, content: row.content ?? undefined, payload: { ...object(envelope.detail), ...(typeof legacy.occurredAt === "string" ? { occurredAt: legacy.occurredAt } : {}) }, requestId: row.requestId ?? undefined, createdAt: row.createdAt.toISOString() };
}

/** Resolve only explicit canonical references, and only in the event's owned
 * conversation. Old inline events remain readable without a message lookup. */
async function projectEvents(rows: EventRow[], courseId: string, db: Prisma.TransactionClient) {
  const referenced = rows.filter(row => row.content === null && object(row.payload).schemaVersion === 2
    && object(object(row.payload).detail).contentRef === "AiMessage");
  if (!referenced.length) return rows.map(row => projectEvent(row, courseId));
  // Group only identical authorization scopes. Repeating the same relation
  // predicates for every message creates a very large OR query as history grows.
  const referenceGroups = new Map<string, { ids: Set<string>; where: Prisma.AiMessageWhereInput }>();
  for (const row of referenced) {
    const id = object(object(row.payload).detail).messageId;
    if (typeof id !== "string" || !row.conversationId) continue;
    const key = JSON.stringify([row.conversationId, row.userId, row.participationId, row.offeringId, courseId]);
    let group = referenceGroups.get(key);
    if (!group) {
      group = { ids: new Set(), where: { conversationId: row.conversationId,
        conversation: { userId: row.userId, participationId: row.participationId, offeringId: row.offeringId,
          participation: { instanceId: courseId } } } };
      referenceGroups.set(key, group);
    }
    group.ids.add(id);
  }
  const messages = await db.aiMessage.findMany({ where: { OR: [...referenceGroups.values()]
    .map(group => ({ ...group.where, id: { in: [...group.ids] } })) },
    select: { id: true, conversationId: true, userId: true, content: true,
      conversation: { select: { userId: true, participationId: true, offeringId: true } } } });
  const byId = new Map(messages.map(message => [message.id, message]));
  return rows.map(row => {
    const event = projectEvent(row, courseId);
    const detail = object(object(row.payload).detail);
    if (row.content !== null || object(row.payload).schemaVersion !== 2 || detail.contentRef !== "AiMessage") return event;
    const message = byId.get(String(detail.messageId));
    if (message && (message.userId === null || message.userId === row.userId)
      && message.conversationId === row.conversationId && message.conversation.userId === row.userId
      && message.conversation.participationId === row.participationId && message.conversation.offeringId === row.offeringId) {
      return { ...event, content: message.content };
    }
    return { ...event, payload: { ...event.payload, contentReferenceMissing: true } };
  });
}

function decodeCursor(cursor: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof raw.createdAt !== "string" || typeof raw.id !== "string") throw new Error("invalid");
    const createdAt = new Date(raw.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !raw.id) throw new Error("invalid");
    return { createdAt, id: raw.id };
  } catch { throw new PlatformError("INVALID_CURSOR", "分页游标无效", 400); }
}
export function encodeAiInteractionCursor(event: Pick<AiInteractionEvent, "id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt, id: event.id }), "utf8").toString("base64url");
}

/** Classroom projections need the complete practice history, with canonical
 * message references resolved just as in the paged reader below. */
export async function loadCourseAiInteractionEvents(
  courseId: string,
  db: Prisma.TransactionClient = prisma,
  studentId?: string,
): Promise<AiInteractionEvent[]> {
  const rows = await db.aiInteractionEvent.findMany({
    where: {
      participation: { instanceId: courseId },
      ...(studentId ? { userId: studentId } : {}),
      payload: { path: ["legacy", "stageKey"], equals: "make" },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return projectEvents(rows, courseId, db);
}

export async function listAiInteractionEvents(input: { courseId: string; studentId?: string; stageKey?: string; limit?: number; cursor?: string | null }): Promise<{ events: AiInteractionEvent[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const cursor = decodeCursor(input.cursor ?? null);
  const rows = await prisma.aiInteractionEvent.findMany({ where: {
    participation: { instanceId: input.courseId }, ...(input.studentId ? { userId: input.studentId } : {}),
    ...(input.stageKey ? { payload: { path: ["legacy", "stageKey"], equals: input.stageKey } } : {}),
    ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = await projectEvents(page, input.courseId, prisma);
  return { events, ...(hasMore && events.length ? { nextCursor: encodeAiInteractionCursor(events[events.length - 1]) } : {}) };
}

export function aiInteractionEventsToCsv(events: AiInteractionEvent[]): string {
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = ["createdAt", "studentId", "stageKey", "source", "eventType", "actorRole", "content", "payload"];
  return [
    header.join(","),
    ...events.map((event) => [
      event.createdAt,
      event.studentId,
      event.stageKey,
      event.source,
      event.eventType,
      event.actorRole,
      event.content,
      JSON.stringify(event.payload ?? {}),
    ].map(escape).join(",")),
  ].join("\n");
}
