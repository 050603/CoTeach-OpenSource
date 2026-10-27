import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { appendScopedCompanionMessages, companionThreadId, readCompanionMessageScope, type CompanionMessageScope } from "./scoped-message-batch";

const identity = { courseId: "course", studentId: "student", participationId: "participation", stageKey: "make",
  conversationId: companionThreadId("course", "student", "make") };
const scope: CompanionMessageScope = { ...identity, userId: "student", offeringId: "offering", metadata: { legacyStageKey: "make" },
  instanceId: "course", enrollmentUserId: "student", enrollmentOfferingId: "offering", chapterOfferingId: "offering", researchKey: "research" };
const message = { id: "question", role: "student" as const, content: "原始问题", createdAt: "2026-10-16T00:00:00.000Z",
  visibility: "student-and-teacher" as const, conversationId: "logical", authorId: "student" };
const db = {
  $queryRaw: vi.fn(), aiMessage: { findMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
  aiInteractionEvent: { createMany: vi.fn() }, aiConversation: { update: vi.fn() },
};
const tx = db as unknown as Prisma.TransactionClient;
beforeEach(() => { vi.resetAllMocks(); db.$queryRaw.mockResolvedValue([scope]); db.aiMessage.findMany.mockResolvedValue([]); });

describe("claimed companion message batches", () => {
  it("reads all ownership relations in one parameterized query", async () => {
    expect(await readCompanionMessageScope(tx, identity)).toEqual(scope);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual([identity.conversationId]);
  });

  it.each([
    { userId: "another" }, { enrollmentUserId: "another" }, { instanceId: "another" },
    { participationId: "another" }, { offeringId: "another" }, { chapterOfferingId: "another" },
    { metadata: { legacyStageKey: "another" } }, { conversationId: "another" },
  ])("rejects inconsistent persisted scope before writes: %j", async mismatch => {
    db.$queryRaw.mockResolvedValue([{ ...scope, ...mismatch }]);
    await expect(readCompanionMessageScope(tx, identity)).rejects.toMatchObject({ code: "MESSAGE_SCOPE_MISMATCH" });
    await expect(appendScopedCompanionMessages(tx, { ...identity, scope: { ...scope, ...mismatch }, messages: [message] }))
      .rejects.toMatchObject({ code: "MESSAGE_SCOPE_MISMATCH" });
    expect(db.aiMessage.findMany).not.toHaveBeenCalled();
  });

  it("batches two new messages and their research facts without skipping collisions", async () => {
    const answer = { ...message, id: "answer", role: "agent" as const, content: "核对原始表。" };
    await appendScopedCompanionMessages(tx, { ...identity, scope, messages: [message, answer] });
    expect(db.aiMessage.findMany).toHaveBeenCalledOnce();
    expect(db.aiMessage.createMany).toHaveBeenCalledWith({ data: [
      expect.objectContaining({ id: "question", role: "user", userId: "student", content: "原始问题", conversationId: identity.conversationId }),
      expect.objectContaining({ id: "answer", role: "assistant", userId: null, content: "核对原始表。" }),
    ] });
    expect(db.aiInteractionEvent.createMany).toHaveBeenCalledWith({ data: [
      expect.objectContaining({ idempotencyKey: "companion-message:question", actor: "student", researchKey: "research", content: null,
        payload: expect.objectContaining({ detail: expect.objectContaining({ contentRef: "AiMessage", messageId: "question" }) }) }),
      expect.objectContaining({ idempotencyKey: "companion-message:answer", actor: "assistant", content: null,
        payload: expect.objectContaining({ detail: expect.objectContaining({ contentRef: "AiMessage", messageId: "answer" }) }) }),
    ] });
    expect(db.aiMessage.update).not.toHaveBeenCalled();
    expect(db.aiConversation.update).toHaveBeenCalledWith({ where: { id: identity.conversationId }, data: { updatedAt: expect.any(Date) } });
  });

  it("checks the entire batch before writing when a later message belongs to another conversation", async () => {
    db.aiMessage.findMany.mockResolvedValue([{ id: "answer", conversationId: "other", metadata: {} }]);
    await expect(appendScopedCompanionMessages(tx, { ...identity, scope, messages: [message, { ...message, id: "answer" }] }))
      .rejects.toMatchObject({ code: "MESSAGE_SCOPE_MISMATCH" });
    expect(db.aiMessage.createMany).not.toHaveBeenCalled();
    expect(db.aiMessage.update).not.toHaveBeenCalled();
    expect(db.aiInteractionEvent.createMany).not.toHaveBeenCalled();
    expect(db.aiConversation.update).not.toHaveBeenCalled();
  });

  it("merges only metadata for existing messages, preserving their original evidence", async () => {
    db.aiMessage.findMany.mockResolvedValue([{ id: message.id, conversationId: identity.conversationId, metadata: { existing: true,
      hiddenFromStudentAt: "before", requestId: "original-request", taskId: "original-task" } }]);
    await appendScopedCompanionMessages(tx, { ...identity, scope, requestId: "later-request", taskId: "later-task",
      messages: [{ ...message, content: "不能覆写", role: "agent", hiddenFromStudentAt: "after" }] });
    expect(db.aiMessage.update).toHaveBeenCalledWith({ where: { id: message.id }, data: { metadata: expect.objectContaining({ existing: true,
      hiddenFromStudentAt: "after", legacyRole: "agent", requestId: "original-request", taskId: "original-task" }) } });
    expect(Object.keys(db.aiMessage.update.mock.calls[0][0].data)).toEqual(["metadata"]);
    expect(db.aiMessage.createMany).not.toHaveBeenCalled();
    expect(db.aiInteractionEvent.createMany).not.toHaveBeenCalled();
  });

  it("preserves first evidence and final metadata for repeated IDs within one batch", async () => {
    await appendScopedCompanionMessages(tx, { ...identity, scope, messages: [message, { ...message, content: "later", role: "agent", hiddenFromStudentAt: "later" }] });
    expect(db.aiMessage.createMany.mock.calls[0][0].data).toEqual([expect.objectContaining({ content: "原始问题", role: "user", metadata: expect.objectContaining({ legacyRole: "agent", hiddenFromStudentAt: "later" }) })]);
    expect(db.aiInteractionEvent.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(db.aiInteractionEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({ content: null, actor: "student",
      payload: { detail: { contentRef: "AiMessage", messageId: message.id } } });
  });

  it("retains request ownership and proposal details on the single canonical message fact", async () => {
    const answer = { ...message, id: "answer", role: "agent" as const, content: "建议正文" };
    await appendScopedCompanionMessages(tx, { ...identity, scope, messages: [answer], requestId: "request", taskId: "task",
      researchStageKey: "make", workspaceKind: "document", messageFacts: { answer: { eventType: "proposal", source: "selection",
        detail: { contributionId: "contribution", suggestion: { replacement: "建议替换" } } } } });
    expect(db.aiInteractionEvent.createMany.mock.calls[0][0].data).toEqual([expect.objectContaining({
      requestId: "request", taskId: "task", eventType: "proposal", content: null,
      payload: { schemaVersion: 2, legacy: expect.objectContaining({ source: "selection", stageKey: "make" }),
        detail: expect.objectContaining({ contributionId: "contribution", messageId: "answer", contentRef: "AiMessage", workspaceKind: "document" }) },
    })]);
    expect(db.aiMessage.createMany.mock.calls[0][0].data[0].metadata).toMatchObject({ requestId: "request", taskId: "task" });
  });

  it("propagates uniqueness and audit failures so the receipt transaction must roll back", async () => {
    db.aiMessage.createMany.mockRejectedValueOnce(new Error("message collision"));
    await expect(appendScopedCompanionMessages(tx, { ...identity, scope, messages: [message] })).rejects.toThrow("message collision");
    expect(db.aiInteractionEvent.createMany).not.toHaveBeenCalled();
    db.aiInteractionEvent.createMany.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(appendScopedCompanionMessages(tx, { ...identity, scope, messages: [message] })).rejects.toThrow("audit unavailable");
  });
});
