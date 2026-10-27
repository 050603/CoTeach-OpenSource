import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { loadCourseAiInteractionEvents, projectEvent } from "@/lib/ai-collaboration/audit-read";
import { companionPracticeEvents } from "@/lib/ai-collaboration/interaction-transcript";
import type { AiInteractionEvent, CompanionThread } from "@/lib/session/types";
import { digestShowcaseContent } from "./recommendation-preparation";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const showcaseFactsId = (courseId: string) => `showcase-facts:${digestShowcaseContent(courseId)}`;
type RequestFact = { studentId: string; signature?: string };
type Facts = { refreshedAt: string; cursorAt: string; messagesSince?: string; audited: Record<string, RequestFact>; historical: Record<string, RequestFact>; counts: Record<string, number> };
const eligible = (e: AiInteractionEvent) => e.stageKey === "make" && e.actorRole === "student" && e.eventType === "request" && e.source !== "system";
function fact(e: AiInteractionEvent): RequestFact {
  return { studentId: e.studentId, ...(e.content ? { signature: digestShowcaseContent([e.studentId, e.conversationId, e.actorRole, e.content]) } : {}) };
}
export function mergeShowcaseRequestFacts(previous: Pick<Facts, "audited" | "historical">, events: AiInteractionEvent[], historical: AiInteractionEvent[] = []) {
  const audited = { ...previous.audited }, old = { ...previous.historical };
  events.filter(eligible).forEach(e => { audited[`${e.studentId}:${e.requestId ?? `event:${e.id}`}`] = fact(e); });
  historical.filter(eligible).forEach(e => { old[e.id] = fact(e); });
  const covered = new Map<string, number>(), counts: Record<string, number> = {};
  Object.values(audited).forEach(f => { counts[f.studentId] = (counts[f.studentId] ?? 0) + 1; if (f.signature) covered.set(f.signature, (covered.get(f.signature) ?? 0) + 1); });
  Object.values(old).forEach(f => { const n = f.signature ? covered.get(f.signature) ?? 0 : 0;
    if (n) covered.set(f.signature!, n - 1); else counts[f.studentId] = (counts[f.studentId] ?? 0) + 1;
  });
  return { audited, historical: old, counts };
}
async function historicalPracticeThreads(courseId: string, since?: string): Promise<CompanionThread[]> {
  const rows = await prisma.aiConversation.findMany({ where: { participation: { instanceId: courseId }, metadata: { path: ["legacyStageKey"], string_contains: "make" }, ...(since ? { updatedAt: { gte: new Date(Date.parse(since) - 60_000) } } : {}) },
    select: { id: true, userId: true, metadata: true, createdAt: true, updatedAt: true, messages: { where: { role: { in: ["user", "student"] }, ...(since ? { createdAt: { gte: new Date(Date.parse(since) - 60_000) } } : {}) }, select: { id: true, content: true, metadata: true, createdAt: true } } } });
  return rows.map(r => ({ id: r.id, courseId, studentId: r.userId, stageKey: String(object(r.metadata).legacyStageKey ?? ""), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    messages: r.messages.filter(m => !object(m.metadata).legacyRole || object(m.metadata).legacyRole === "student").map(m => ({ ...object(m.metadata), id: m.id, role: "student" as const, content: m.content, createdAt: m.createdAt.toISOString(), visibility: "student-and-teacher" as const })) }));
}

/** Called by reconciliation, never by a teacher GET. Hashes retain dedup evidence without storing dialogue text. */
export async function refreshShowcaseFacts(courseId: string, ownerId: string): Promise<void> {
  const id = showcaseFactsId(courseId);
  const cached = await prisma.aiTask.findUnique({ where: { id }, select: { output: true } });
  const prior = cached?.output as Facts | null;
  const refreshedAt = new Date().toISOString();
  let events: AiInteractionEvent[], historical: AiInteractionEvent[] = [];
  if (!prior) {
    const [audited, threads] = await Promise.all([loadCourseAiInteractionEvents(courseId), historicalPracticeThreads(courseId)]);
    events = audited; historical = companionPracticeEvents(threads);
  } else {
    // Overlap handles simultaneous commits and equal timestamps; request identities remove duplicates.
    const rows = await prisma.aiInteractionEvent.findMany({ where: { participation: { instanceId: courseId }, eventType: "request", actor: "student",
      createdAt: { gte: new Date(Date.parse(prior.cursorAt) - 60_000) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const refs = rows.flatMap(r => { const d = object(object(r.payload).detail); return r.content === null && typeof d.messageId === "string" && r.conversationId
      ? [{ id: d.messageId, conversationId: r.conversationId, conversation: { userId: r.userId, participationId: r.participationId, offeringId: r.offeringId, participation: { instanceId: courseId } } }] : []; });
    const messages = refs.length ? await prisma.aiMessage.findMany({ where: { OR: refs }, select: { id: true, conversationId: true, content: true } }) : [];
    historical = companionPracticeEvents(await historicalPracticeThreads(courseId, prior.messagesSince ?? prior.refreshedAt));
    events = rows.map(r => { const e = projectEvent(r, courseId), m = messages.find(m => m.id === object(object(r.payload).detail).messageId && m.conversationId === r.conversationId); return m ? { ...e, content: m.content } : e; });
  }
  const merged = mergeShowcaseRequestFacts(prior ?? { audited: {}, historical: {} }, events, historical);
  const output: Facts = { ...merged, refreshedAt, messagesSince: refreshedAt, cursorAt: events.reduce((last, e) => e.createdAt > last ? e.createdAt : last, prior?.cursorAt ?? "1970-01-01T00:00:00.000Z") };
  await prisma.aiTask.upsert({ where: { id }, create: { id, createdById: ownerId, taskType: "SHOWCASE_RECOMMENDATION_FACTS", status: "READY", output: output as unknown as Prisma.InputJsonValue }, update: { output: output as unknown as Prisma.InputJsonValue } });
}
export async function readShowcaseFactCounts(courseId: string): Promise<Map<string, number>> {
  const row = await prisma.aiTask.findUnique({ where: { id: showcaseFactsId(courseId) }, select: { output: true } });
  return new Map(Object.entries((row?.output as Facts | null)?.counts ?? {}));
}
