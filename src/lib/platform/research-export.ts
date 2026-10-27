import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { AuthClaims } from "@/lib/auth/session";
import { requireTeacherUser } from "./access";
import { PlatformError } from "./repository";

const timestamp = z.string().datetime({ offset: true });
const exportType = z.enum(["events", "submissions", "experiments", "outcomes", "ai", "ai_messages", "domain"]);
const querySchema = z.object({
  type: exportType.default("events"),
  take: z.coerce.number().int().min(1).max(500).default(200),
  since: timestamp.optional(),
  until: timestamp.optional(),
  includeContent: z.enum(["true", "false"]).default("false"),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1),
  offeringId: z.string().min(1).max(200),
  type: exportType,
  includeContent: z.boolean().optional(),
  since: timestamp,
  until: timestamp,
  at: timestamp,
  id: z.string().min(1).max(200),
}).strict();

function invalidInput(): never {
  throw new PlatformError("INVALID_INPUT", "请检查导出类型、分页游标和时间范围", 400);
}

function decodeCursor(value: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return invalidInput();
  }
}

function referencedMessageId(content: string | null | undefined, payload: Prisma.JsonValue | undefined): string | null {
  if (content !== null || !payload || typeof payload !== "object" || Array.isArray(payload) || payload.schemaVersion !== 2) return null;
  const detail = payload.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  return detail.contentRef === "AiMessage" && typeof detail.messageId === "string" ? detail.messageId : null;
}

function messageStage(sourceStageKey: string | null) {
  // These are the exact thread formats emitted by document-handlers. Keep
  // unfamiliar compound keys as evidence without inventing a teaching stage.
  const thread = sourceStageKey?.match(/^(?:ai-collaboration|ai-collaboration-comments):(?:(external-artifact):)?(proposal|make)$/);
  return {
    sourceStageKey,
    stageKey: thread ? thread[2] : sourceStageKey?.includes(":") ? null : sourceStageKey,
    workspaceKind: thread ? thread[1] ?? "document" : null,
  };
}

/** A cursor carries a fixed window; every page independently checks course authorization. */
export async function exportOfferingResearch(
  claims: AuthClaims,
  offeringId: string,
  query: Record<string, string>,
) {
  if (claims.role !== "teacher") throw new PlatformError("FORBIDDEN", "仅教学班教师可导出研究数据", 403);
  const teacher = await requireTeacherUser(claims);
  const link = await prisma.courseTeacher.findFirst({ where: { offeringId, userId: teacher.id }, select: { id: true } });
  if (!link) throw new PlatformError("FORBIDDEN", "无权导出该教学班", 403);
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) return invalidInput();
  const options = parsed.data;
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const since = new Date(options.since ?? cursor?.since ?? 0);
  const until = new Date(options.until ?? cursor?.until ?? Date.now());
  if (since > until || (cursor && (
    cursor.offeringId !== offeringId || cursor.type !== options.type ||
    (cursor.includeContent !== undefined && cursor.includeContent !== (options.includeContent === "true")) ||
    new Date(cursor.since).getTime() !== since.getTime() ||
    new Date(cursor.until).getTime() !== until.getTime() ||
    new Date(cursor.at) < since || new Date(cursor.at) > until
  ))) return invalidInput();
  const window = { since: since.toISOString(), until: until.toISOString() };
  const includeContent = options.includeContent === "true";

  function page<T extends { id: string }>(records: T[], dateOf: (row: T) => Date) {
    const rows = records.slice(0, options.take);
    const last = rows.at(-1);
    return {
      exportVersion: 1,
      type: options.type,
      window,
      rows,
      nextCursor: records.length > options.take && last
        ? Buffer.from(JSON.stringify({ version: 1, offeringId, type: options.type, includeContent, ...window, at: dateOf(last).toISOString(), id: last.id })).toString("base64url")
        : null,
    };
  }

  if (options.type === "events") {
    const records = await prisma.learningEvent.findMany({
      where: {
        offeringId,
        receivedAt: { gte: since, lte: until },
        ...(cursor ? { OR: [
          { receivedAt: { gt: new Date(cursor.at) } },
          { receivedAt: new Date(cursor.at), id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: options.take + 1,
      select: {
        id: true, researchKey: true, chapterId: true, activityId: true,
        classroomInstanceId: true, eventType: true, eventVersion: true,
        occurredAt: true, receivedAt: true, source: true, durationMs: true,
        ...(includeContent ? { metadata: true } : {}),
      },
    });
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey,
      quality: row.researchKey ? "complete" : "missing_research_key",
      chapterId: row.chapterId, activityId: row.activityId,
      classroomInstanceId: row.classroomInstanceId,
      eventType: row.eventType, eventVersion: row.eventVersion,
      occurredAt: row.occurredAt, receivedAt: row.receivedAt,
      source: row.source, durationMs: row.durationMs,
      ...(includeContent ? { metadata: row.metadata } : {}),
    })), (row) => row.receivedAt);
  }

  if (options.type === "ai") {
    const records = await prisma.aiInteractionEvent.findMany({
      where: {
        offeringId,
        createdAt: { gte: since, lte: until },
        ...(cursor ? { OR: [
          { createdAt: { gt: new Date(cursor.at) } },
          { createdAt: new Date(cursor.at), id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.take + 1,
      select: {
        id: true, researchKey: true, eventType: true, actor: true, createdAt: true,
        participation: { select: { instanceId: true } },
        ...(includeContent ? { content: true, payload: true, userId: true, conversationId: true, participationId: true } : {}),
      },
    });
    const references = includeContent ? records.slice(0, options.take).flatMap(row => {
      const messageId = referencedMessageId(row.content, row.payload);
      return messageId && row.conversationId && row.userId && row.participationId ? [{ row, messageId }] : [];
    }) : [];
    const messages = references.length ? await prisma.aiMessage.findMany({
      where: {
        OR: references.map(({ row, messageId }) => ({ id: messageId, conversationId: row.conversationId!, conversation: { userId: row.userId!, participationId: row.participationId! } })),
        conversation: {
          offeringId,
          participation: { enrollment: { offeringId }, instance: { activity: { chapter: { offeringId } } } },
        },
      },
      select: {
        id: true, conversationId: true, userId: true, content: true,
        conversation: { select: { userId: true, participationId: true, participation: { select: { enrollment: { select: { userId: true } } } } } },
      },
    }) : [];
    const referenceContent = new Map(messages.filter(row =>
      row.conversation.userId === row.conversation.participation?.enrollment.userId &&
      (row.userId === null || row.userId === row.conversation.userId),
    ).map(row => [JSON.stringify([row.conversationId, row.id, row.conversation.userId, row.conversation.participationId]), row.content]));
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey,
      quality: row.researchKey ? "complete" : "missing_research_key",
      classroomInstanceId: row.participation?.instanceId ?? null,
      eventType: row.eventType, actor: row.actor, createdAt: row.createdAt,
      ...(includeContent ? (() => {
        const messageId = referencedMessageId(row.content, row.payload);
        const content = messageId ? referenceContent.get(JSON.stringify([row.conversationId, messageId, row.userId, row.participationId])) : undefined;
        return {
          content: content ?? row.content, payload: row.payload,
          ...(messageId && content === undefined ? { contentResolution: "message_reference_unresolved" } : {}),
        };
      })() : {}),
    })), (row) => row.createdAt);
  }

  if (options.type === "ai_messages") {
    // A conversation's owner must match its enrollment. Relation filters alone
    // cannot compare these columns; do the comparison inside this paged query.
    // Legacy offering-only conversations have no defensible classroom context.
    const records = await prisma.$queryRaw<Array<{
      id: string; researchKey: string; conversationId: string; role: string; createdAt: Date;
      classroomInstanceId: string | null; activityId: string | null; chapterId: string | null;
      stageKey: string | null; feature: string | null;
      content?: string; metadata?: Prisma.JsonValue; conversationMetadata?: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT m.id, e."researchKey", c.id AS "conversationId", m.role, m."createdAt",
        p."instanceId" AS "classroomInstanceId", i."activityId", a."chapterId",
        COALESCE(c.metadata->>'legacyStageKey', c.metadata->>'stageKey') AS "stageKey",
        c.metadata->>'feature' AS feature
        ${includeContent ? Prisma.sql`, m.content, m.metadata, c.metadata AS "conversationMetadata"` : Prisma.empty}
      FROM "AiMessage" m
      JOIN "AiConversation" c ON c.id = m."conversationId"
      LEFT JOIN "ClassroomParticipation" p ON p.id = c."participationId"
      JOIN "Enrollment" e ON e."userId" = c."userId" AND e."offeringId" = ${offeringId}
        AND (c."participationId" IS NULL OR p."enrollmentId" = e.id)
      LEFT JOIN "ClassroomInstance" i ON i.id = p."instanceId"
      LEFT JOIN "Activity" a ON a.id = i."activityId"
      LEFT JOIN "Chapter" ch ON ch.id = a."chapterId"
      WHERE (c."offeringId" = ${offeringId} OR (c."offeringId" IS NULL AND p.id IS NOT NULL))
        AND (c."participationId" IS NULL OR ch."offeringId" = ${offeringId})
        AND (m."userId" IS NULL OR m."userId" = c."userId")
        AND m."createdAt" >= ${since} AND m."createdAt" <= ${until}
        ${cursor ? Prisma.sql`AND (m."createdAt" > ${new Date(cursor.at)}
          OR (m."createdAt" = ${new Date(cursor.at)} AND m.id > ${cursor.id}))` : Prisma.empty}
      ORDER BY m."createdAt" ASC, m.id ASC
      LIMIT ${options.take + 1}
    `);
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey, quality: "complete",
      researchConversationKey: createHash("sha256").update(JSON.stringify(["ai-conversation-v1", offeringId, row.conversationId])).digest("hex"),
      association: row.classroomInstanceId ? "classroom" : "offering_only",
      classroomInstanceId: row.classroomInstanceId, activityId: row.activityId, chapterId: row.chapterId,
      role: row.role, ...messageStage(row.stageKey), feature: row.feature, createdAt: row.createdAt,
      ...(includeContent ? { content: row.content, metadata: row.metadata, conversationMetadata: row.conversationMetadata } : {}),
    })), (row) => row.createdAt);
  }

  if (options.type === "outcomes" || options.type === "domain") {
    const records = await prisma.domainEvent.findMany({
      where: {
        offeringId,
        ...(options.type === "outcomes" ? { eventType: { startsWith: "CLASSROOM_" } } : {}),
        createdAt: { gte: since, lte: until },
        ...(cursor ? { OR: [
          { createdAt: { gt: new Date(cursor.at) } },
          { createdAt: new Date(cursor.at), id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.take + 1,
      select: {
        id: true, researchKey: true, classroomInstanceId: true,
        eventType: true, createdAt: true,
        ...(includeContent ? { payload: true } : {}),
      },
    });
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey,
      quality: row.researchKey ? "complete" : "missing_research_key",
      classroomInstanceId: row.classroomInstanceId,
      eventType: row.eventType, createdAt: row.createdAt,
      ...(includeContent ? { payload: row.payload } : {}),
    })), (row) => row.createdAt);
  }

  if (options.type === "experiments") {
    const records = await prisma.experimentAssessmentSubmission.findMany({
      where: {
        enrollment: { offeringId },
        instance: { activity: { chapter: { offeringId } } },
        submittedAt: { gte: since, lte: until },
        ...(cursor ? { OR: [
          { submittedAt: { gt: new Date(cursor.at) } },
          { submittedAt: new Date(cursor.at), id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: options.take + 1,
      select: {
        id: true, researchKey: true, instanceId: true, phase: true,
        objectiveScore: true, objectiveTotal: true, submittedAt: true,
        instance: { select: { activityId: true, runNo: true } },
        assignment: { select: { variant: true } },
        ...(includeContent ? { questionnaire: true, answers: true } : {}),
      },
    });
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey, quality: row.researchKey ? "complete" : "missing_research_key",
      classroomInstanceId: row.instanceId, activityId: row.instance.activityId, runNo: row.instance.runNo,
      phase: row.phase, variant: row.assignment.variant, objectiveScore: row.objectiveScore, objectiveTotal: row.objectiveTotal,
      submittedAt: row.submittedAt,
      ...(includeContent ? { questionnaire: row.questionnaire, answers: row.answers } : {}),
    })), (row) => row.submittedAt);
  }

  const records = await prisma.activitySubmission.findMany({
    where: {
      // Require both sides to belong to this offering, including for historical rows.
      enrollment: { offeringId },
      activity: { chapter: { offeringId } },
      submittedAt: { gte: since, lte: until },
      ...(cursor ? { OR: [
        { submittedAt: { gt: new Date(cursor.at) } },
        { submittedAt: new Date(cursor.at), id: { gt: cursor.id } },
      ] } : {}),
    },
    orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    take: options.take + 1,
    select: {
      id: true, researchKey: true, activityId: true, activityVersion: true, submittedAt: true,
      ...(includeContent ? { activitySnapshot: true, payload: true } : {}),
    },
  });
  return page(records.map((row) => ({
    id: row.id, researchKey: row.researchKey,
    quality: row.researchKey ? "complete" : "missing_research_key",
    activityId: row.activityId, activityVersion: row.activityVersion, submittedAt: row.submittedAt,
    ...(includeContent ? { activitySnapshot: row.activitySnapshot, payload: row.payload } : {}),
  })), (row) => row.submittedAt);
}
