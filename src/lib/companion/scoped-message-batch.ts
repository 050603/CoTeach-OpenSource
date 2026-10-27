import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PlatformError } from "@/lib/platform/platform-error";
import type { CompanionMessage } from "@/lib/session/types";

export const companionThreadId = (courseId: string, studentId: string, stageKey: string) =>
  `companion:${createHash("sha256").update(JSON.stringify([courseId, studentId, stageKey])).digest("hex")}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

type Identity = { courseId: string; studentId: string; participationId: string; conversationId: string; stageKey: string };
export type CompanionMessageScope = {
  conversationId: string; userId: string; offeringId: string | null; participationId: string | null;
  metadata: unknown; instanceId: string; enrollmentUserId: string; enrollmentOfferingId: string;
  researchKey: string; chapterOfferingId: string;
};
export type CompanionMessageFact = {
  eventType?: string;
  source?: string;
  detail?: Record<string, unknown>;
};

function assertScope(scope: CompanionMessageScope | undefined, input: Identity): asserts scope is CompanionMessageScope {
  if (!scope || scope.conversationId !== input.conversationId
    || input.conversationId !== companionThreadId(input.courseId, input.studentId, input.stageKey)
    || scope.userId !== input.studentId || scope.enrollmentUserId !== input.studentId
    || scope.participationId !== input.participationId || scope.instanceId !== input.courseId
    || scope.offeringId !== scope.enrollmentOfferingId || scope.enrollmentOfferingId !== scope.chapterOfferingId
    || object(scope.metadata).legacyStageKey !== input.stageKey) {
    throw new PlatformError("MESSAGE_SCOPE_MISMATCH", "消息归属不一致", 409);
  }
}

/** Read the existing claim's full ownership chain in one trip. Writers must
 * already hold the course admission and this participation's row lock. */
export async function readCompanionMessageScope(db: Pick<Prisma.TransactionClient, "$queryRaw">, input: Identity) {
  const [scope] = await db.$queryRaw<CompanionMessageScope[]>`
    SELECT c.id AS "conversationId", c."userId", c."offeringId", c."participationId", c.metadata,
      p."instanceId", e."userId" AS "enrollmentUserId", e."offeringId" AS "enrollmentOfferingId",
      e."researchKey", ch."offeringId" AS "chapterOfferingId"
    FROM "AiConversation" c
    JOIN "ClassroomParticipation" p ON p.id = c."participationId"
    JOIN "Enrollment" e ON e.id = p."enrollmentId"
    JOIN "ClassroomInstance" i ON i.id = p."instanceId"
    JOIN "Activity" a ON a.id = i."activityId"
    JOIN "Chapter" ch ON ch.id = a."chapterId"
    WHERE c.id = ${input.conversationId}`;
  assertScope(scope, input);
  return scope;
}

/** Append to a claimed conversation without re-creating its thread. All
 * message IDs are checked before any write. Uniqueness errors intentionally
 * roll back the caller's receipt transaction; no conflicting evidence is skipped. */
export async function appendScopedCompanionMessages(db: Prisma.TransactionClient,
  input: Identity & { scope: CompanionMessageScope; messages: CompanionMessage[];
    requestId?: string; taskId?: string; researchStageKey?: string; workspaceKind?: string;
    messageFacts?: Record<string, CompanionMessageFact> }) {
  assertScope(input.scope, input);
  if (!input.messages.length) return;
  const previous = await db.aiMessage.findMany({ where: { id: { in: [...new Set(input.messages.map(message => message.id))] } },
    select: { id: true, conversationId: true, metadata: true } });
  if (previous.some(message => message.conversationId !== input.conversationId)) {
    throw new PlatformError("MESSAGE_SCOPE_MISMATCH", "消息归属不一致", 409);
  }
  const existing = new Map(previous.map(message => [message.id, message]));
  const pending = new Map<string, { message: CompanionMessage; metadata: Prisma.InputJsonValue }>();
  for (const message of input.messages) {
    const { id, role } = message;
    const extension: Record<string, unknown> = { ...message };
    for (const key of ["id", "role", "content", "createdAt"]) delete extension[key];
    const prior = pending.get(id);
    pending.set(id, { message: prior?.message ?? message,
      metadata: json({ ...object(prior?.metadata ?? existing.get(id)?.metadata), ...extension, legacyRole: role,
        ...(input.requestId && !existing.has(id) ? { requestId: input.requestId, taskId: input.taskId } : {}) }) });
  }
  const fresh = [...pending.values()].filter(entry => !existing.has(entry.message.id));
  if (fresh.length) {
    await db.aiMessage.createMany({ data: fresh.map(({ message, metadata }) => ({
      id: message.id, conversationId: input.conversationId,
      userId: message.role === "student" ? input.studentId : null,
      role: message.role === "student" ? "user" : message.role === "agent" ? "assistant" : "system",
      content: message.content, createdAt: new Date(message.createdAt), metadata,
    })) });
    await db.aiInteractionEvent.createMany({ data: fresh.map(({ message }) => ({
      idempotencyKey: `companion-message:${message.id}`, userId: input.studentId,
      offeringId: input.scope.offeringId, participationId: input.participationId,
      conversationId: input.conversationId, researchKey: input.scope.researchKey,
      taskId: input.taskId, requestId: input.requestId,
      eventType: input.messageFacts?.[message.id]?.eventType ?? (message.role === "student" ? "request" : message.role === "agent" ? "response" : "comment"),
      actor: message.role === "student" ? "student" : message.role === "agent" ? "assistant" : "system",
      // Message text has one canonical home. The fact retains its operation
      // context and can be resolved without guessing from matching text/time.
      content: null, payload: json({ schemaVersion: 2,
        legacy: { stageKey: input.researchStageKey ?? input.stageKey,
          source: input.messageFacts?.[message.id]?.source ?? (message.role === "student" || message.role === "agent" ? "sidebar" : "system"), actorId: message.authorId,
          conversationId: message.conversationId, occurredAt: message.createdAt },
        detail: { ...input.messageFacts?.[message.id]?.detail, messageId: message.id,
          contentRef: "AiMessage", visibility: message.visibility, triggerKind: message.triggerKind,
          ...(input.workspaceKind ? { workspaceKind: input.workspaceKind } : {}) } }),
    })) });
  }
  for (const [id, entry] of pending) {
    // Original content/role/time and its research fact remain immutable.
    if (existing.has(id)) await db.aiMessage.update({ where: { id }, data: { metadata: entry.metadata } });
  }
  // The original thread upsert advanced its activity time when the answer was
  // committed. Retain that history/sorting contract without rewriting metadata.
  await db.aiConversation.update({ where: { id: input.conversationId }, data: { updatedAt: new Date() } });
}
