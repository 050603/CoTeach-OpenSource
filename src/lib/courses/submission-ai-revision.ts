import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AiRevisionSource } from "@/lib/session/types";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function verifySubmissionAiRevision(tx: Prisma.TransactionClient, input: {
  participationId: string; studentId: string; stageKey: string; submissionType: string;
  beforeVersion: number; afterVersion: number; content: string; source?: AiRevisionSource;
}) {
  const versions = { beforeVersion: input.beforeVersion, afterVersion: input.afterVersion };
  const unknown = (reason: string) => ({ status: "unknown" as const, reason, ...versions });
  const source = input.source;
  if (!source || !["document", "artifact-brief", "code"].includes(input.submissionType)) return unknown("source-not-recorded");
  if (source.beforeContentHash === source.afterContentHash) return unknown("unchanged-content");
  if (source.afterContentHash !== digest(input.content)) return unknown("saved-content-mismatch");
  const previous = await tx.classroomSubmission.findUnique({ where: { participationId_stageKey: { participationId: input.participationId, stageKey: `${input.stageKey}:${input.submissionType}` } }, select: { payload: true } });
  const payload = object(previous?.payload);
  const current = object(payload.view ?? payload);
  if (source.beforeContentHash !== digest(typeof current.content === "string" ? current.content : "")) return unknown("previous-content-mismatch");
  const scope = { participationId: input.participationId, userId: input.studentId };
  const event = await tx.aiInteractionEvent.findFirst({ where: {
    ...scope, actor: { in: ["assistant", "ai"] }, eventType: { in: ["response", "proposal", "comment"] },
    ...(source.eventId ? { id: source.eventId } : {}), ...(source.requestId ? { requestId: source.requestId } : {}),
    AND: [{ payload: { path: ["legacy", "stageKey"], equals: input.stageKey } }, ...(source.contributionId ? [{ payload: { path: ["detail", "contributionId"], equals: source.contributionId } }] : [])],
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, requestId: true, payload: true } });
  if (!event) return unknown("source-not-found");
  const contributionId = object(object(event.payload).detail).contributionId;
  if (source.decisionEventId) {
    const decision = await tx.aiInteractionEvent.findFirst({ where: { ...scope, id: source.decisionEventId, actor: "student", eventType: { in: ["decision", "undo"] }, AND: [
      { payload: { path: ["legacy", "stageKey"], equals: input.stageKey } },
      ...(typeof contributionId === "string" ? [{ payload: { path: ["detail", "contributionId"], equals: contributionId } }] : [{ requestId: event.requestId ?? "" }]),
    ] }, select: { id: true } });
    if (!decision) return unknown("decision-not-found");
  }
  return { status: "verified" as const, verificationScope: "request-and-saved-versions" as const, ...versions, eventId: event.id, ...(event.requestId ? { requestId: event.requestId } : {}), ...(typeof contributionId === "string" ? { contributionId } : {}), ...(source.decisionEventId ? { decisionEventId: source.decisionEventId } : {}), action: source.action, beforeContentHash: source.beforeContentHash, afterContentHash: source.afterContentHash };
}
