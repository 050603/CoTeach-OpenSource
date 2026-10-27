import { beforeEach, describe, expect, it, vi } from "vitest";
import { companionThreadId } from "@/lib/companion/scoped-message-batch";
import type { DocumentAiComment, DocumentAiCommentThread } from "./document-comment-types";
import { restoreDocumentCommentReplyOrder } from "./document-comment-history";
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
const db = { $queryRaw: vi.fn() };
const identity = { courseId: "course", studentId: "student", participationId: "participation",
  stageKey: "make", workspaceKind: "document", threadStageKey: "ai-collaboration-comments:make" };
const at = "2026-10-16T03:56:21.093Z";
const question: DocumentAiComment = { id: "companion-message-d093f88b-154c-4333-ba14-1d1bb0794536",
  role: "student", content: "请核对已有数字。", createdAt: at };
const answer: DocumentAiComment = { id: "companion-message-5f1fc50b-3eb2-454b-a1e7-de3de098ca36",
  role: "assistant", content: "先看原始日志。", createdAt: at };
const thread: DocumentAiCommentThread = { id: "document-comment-3f66d651-129f-42f2-9d7d-f07970e634a6",
  blockIndex: 0, targetText: "原始日志", createdAt: "2026-10-16T03:56:12.672Z", comments: [answer, question] };
const receipt = { taskId: "task", requestId: "document-comment-ai-request-mvafqx5o-ztvej",
  responseRequestId: "document-comment-ai-request-mvafqx5o-ztvej", threadId: thread.id, responseThreadId: thread.id, question, answer };
beforeEach(() => { vi.resetAllMocks(); db.$queryRaw.mockResolvedValue([receipt]); });

describe("receipt-backed historical document comment order", () => {
  it("recovers the actual old same-time/reverse-ID case from one fully scoped receipt projection", async () => {
    const original = structuredClone(thread);
    const [restored] = await restoreDocumentCommentReplyOrder(identity, [thread], db);
    expect(restored.comments).toEqual([question, answer]); expect(thread).toEqual(original);
    expect(restored.comments.map(comment => comment.createdAt)).toEqual([at, at]);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const [query, ...values] = db.$queryRaw.mock.calls[0];
    expect(query.join("")).toContain("t.status = 'COMPLETED'");
    expect(query.join("")).toContain("t.input->>'intent' = 'comment-reply'");
    expect(values).toEqual(expect.arrayContaining([identity.courseId, identity.studentId, identity.participationId,
      identity.stageKey, identity.workspaceKind, identity.threadStageKey,
      companionThreadId(identity.courseId, identity.studentId, identity.threadStageKey)]));
  });

  it("performs no receipt query for new distinct request times or an already correct same-time order", async () => {
    const fresh = { ...thread, comments: [{ ...question, createdAt: "2026-10-16T03:56:13.000Z" }, answer] };
    const ordered = { ...thread, comments: [question, answer] };
    expect(await restoreDocumentCommentReplyOrder(identity, [fresh, ordered], db)).toEqual([fresh, ordered]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("retains original order when proof is missing, mismatched or not unique", async () => {
    for (const rows of [[], [{ ...receipt, responseRequestId: "other" }], [{ ...receipt, answer: { ...answer, content: "不同原文" } }],
      [{ ...receipt, question: { ...question, role: "assistant" } }], [receipt, { ...receipt, taskId: "duplicate" }]]) {
      db.$queryRaw.mockResolvedValue(rows);
      expect((await restoreDocumentCommentReplyOrder(identity, [thread], db))[0].comments).toEqual([answer, question]);
    }
  });

  it("does not choose between conflicting receipts and batches separate old threads in one query", async () => {
    const secondAnswer = { ...answer, id: "second-answer" };
    db.$queryRaw.mockResolvedValue([receipt, { ...receipt, taskId: "conflict", answer: secondAnswer }]);
    const ambiguous = { ...thread, comments: [answer, secondAnswer, question] };
    expect((await restoreDocumentCommentReplyOrder(identity, [ambiguous], db))[0].comments).toEqual(ambiguous.comments);
    db.$queryRaw.mockClear();
    const second = { ...thread, id: "another-thread", comments: [{ ...answer, id: "a2" }, { ...question, id: "q2" }] };
    db.$queryRaw.mockResolvedValue([receipt, { ...receipt, taskId: "second", requestId: "second-request", responseRequestId: "second-request",
      threadId: second.id, responseThreadId: second.id, answer: second.comments[0], question: second.comments[1] }]);
    const restored = await restoreDocumentCommentReplyOrder(identity, [thread, second], db);
    expect(restored.map(item => item.comments.map(comment => comment.role))).toEqual([["student", "assistant"], ["student", "assistant"]]);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });
});
