// @vitest-environment node
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifySubmissionAiRevision } from "./submission-ai-revision";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const db = { classroomSubmission: { findUnique: vi.fn() }, aiInteractionEvent: { findFirst: vi.fn() } };
const tx = db as unknown as Prisma.TransactionClient;
const input = { participationId: "p", studentId: "student", stageKey: "make", submissionType: "code", beforeVersion: 4, afterVersion: 5, content: "after" };
const source = { requestId: "request", contributionId: "contribution", action: "adopted" as const, beforeContentHash: digest("before"), afterContentHash: digest("after") };
beforeEach(() => { vi.resetAllMocks(); db.classroomSubmission.findUnique.mockResolvedValue({ payload: { view: { content: "before" } } }); db.aiInteractionEvent.findFirst.mockResolvedValue({ id: "canonical-event", requestId: "request", payload: { detail: { contributionId: "contribution" } } }); });
describe("saved AI revision provenance", () => {
  it("keeps normal saves cheap and explicitly unknown", async () => {
    expect(await verifySubmissionAiRevision(tx, input)).toEqual({ status: "unknown", reason: "source-not-recorded", beforeVersion: 4, afterVersion: 5 });
    expect(db.classroomSubmission.findUnique).not.toHaveBeenCalled(); expect(db.aiInteractionEvent.findFirst).not.toHaveBeenCalled();
  });
  it("never treats a forged unchanged save as an AI revision", async () => {
    const result = await verifySubmissionAiRevision(tx, { ...input, source: { ...source, beforeContentHash: source.afterContentHash } });
    expect(result).toMatchObject({ status: "unknown", reason: "unchanged-content" });
    expect(result).not.toHaveProperty("eventId"); expect(db.classroomSubmission.findUnique).not.toHaveBeenCalled();
  });
  it("binds actual saved versions and both hashes to an authoritative event in the same student and stage", async () => {
    expect(await verifySubmissionAiRevision(tx, { ...input, source })).toMatchObject({ status: "verified", eventId: "canonical-event", beforeVersion: 4, afterVersion: 5, action: "adopted", requestId: "request" });
    expect(db.aiInteractionEvent.findFirst.mock.calls[0][0].where).toMatchObject({ participationId: "p", userId: "student", actor: { in: ["assistant", "ai"] }, requestId: "request", AND: [{ payload: { path: ["legacy", "stageKey"], equals: "make" } }, { payload: { path: ["detail", "contributionId"], equals: "contribution" } }] });
  });
  it.each(["afterContentHash", "beforeContentHash"] as const)("never attributes a mismatched %s", async key => {
    const result = await verifySubmissionAiRevision(tx, { ...input, source: { ...source, [key]: digest("other") } });
    expect(result.status).toBe("unknown"); expect(result).not.toHaveProperty("eventId"); expect(db.aiInteractionEvent.findFirst).not.toHaveBeenCalled();
  });
  it("cannot use an absent or out-of-scope source, even for a matching saved delta", async () => {
    db.aiInteractionEvent.findFirst.mockResolvedValue(null);
    expect(await verifySubmissionAiRevision(tx, { ...input, source })).toMatchObject({ status: "unknown", reason: "source-not-found" });
  });
  it("validates a supplied decision and never exposes a source event as reliable if that decision is missing", async () => {
    db.aiInteractionEvent.findFirst.mockResolvedValueOnce({ id: "canonical-event", requestId: "request", payload: { detail: { contributionId: "contribution" } } }).mockResolvedValueOnce(null);
    const result = await verifySubmissionAiRevision(tx, { ...input, source: { ...source, decisionEventId: "decision" } });
    expect(result).toMatchObject({ status: "unknown", reason: "decision-not-found" }); expect(result).not.toHaveProperty("eventId");
    expect(db.aiInteractionEvent.findFirst.mock.calls[1][0].where).toMatchObject({ participationId: "p", userId: "student", id: "decision", actor: "student" });
  });
});
