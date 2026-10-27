import { NextRequest } from "next/server";
import type { AiInteractionEvent, CompanionMessage } from "@/lib/session/types";
import { buildStudentAiInteractionTurns } from "@/lib/ai-collaboration/interaction-transcript";
import { companionLimiter, getClientIp, rateLimitKey } from "@/lib/auth/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from 'node:crypto';
import { buildAuthoritativeCourseContext, DOCUMENT_COLLABORATION_POLICY_VERSION, DOCUMENT_DISCUSSION_REVIEW_VERSION } from '@/lib/ai-collaboration/document-policy';
import { DOCUMENT_DISCUSSION_FIDELITY_VERSION } from '@/lib/ai-collaboration/document-discussion-fidelity';
import { DELEGATED_DELIVERY_POLICY_VERSION } from '@/lib/ai-collaboration/delegated-work-policy';
import { DOCUMENT_COLLABORATION_EXECUTION_TIMEOUT_MS } from '@/lib/ai-collaboration/request-budget';
const background = vi.hoisted(() => ({ after: vi.fn(), receipt: vi.fn() }));
vi.mock("next/server", async original => ({
  ...await original<typeof import("next/server")>(), after: background.after,
}));
const mocks = vi.hoisted(() => ({ claim: vi.fn(), receipt: vi.fn(), model: vi.fn(), scope: vi.fn(), readScope: vi.fn(), authentication: vi.fn(), audit: vi.fn(), complete: vi.fn(), fail: vi.fn(), thread: vi.fn(), pair: vi.fn(), requests: vi.fn(), historicalReceipts: vi.fn(), messageIds: [] as string[], replyPrompts: vi.fn(), cancel: vi.fn(), enqueue: vi.fn(), prepare: vi.fn(), support: vi.fn(), memories: vi.fn(), delegationSummary: vi.fn(), normalizeSupport: vi.fn(), collaborationPrompts: vi.fn() }));
vi.mock("@/lib/ai-collaboration/document-review-queue", async original => ({
  ...await original<typeof import("@/lib/ai-collaboration/document-review-queue")>(),
  enqueueDocumentReview: mocks.enqueue, assertDocumentReviewScope: vi.fn(),
}));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ authenticateLegacyAiStudent: mocks.authentication }));
vi.mock("@/lib/ai-collaboration/document-course-context", () => ({ getDocumentCourseContext: mocks.scope }));
vi.mock("@/lib/ai-collaboration/document-read-context", () => ({ getDocumentReadContext: mocks.readScope }));
vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: mocks.historicalReceipts }, isDatabaseConfigured: () => true }));
vi.mock("@/lib/companion/server-store", () => ({ getCompanionThread: mocks.thread, getCompanionThreadPair: mocks.pair,
  appendCompanionMessages: vi.fn(), softDeleteCompanionMessage: vi.fn(),
  companionMessage: (message: { createdAt?: string }) => ({ ...message, id: mocks.messageIds.shift() ?? crypto.randomUUID(), createdAt: message.createdAt ?? new Date().toISOString() }) }));
vi.mock("@/lib/ai-collaboration/document-policy", async original => ({
  ...await original<typeof import("@/lib/ai-collaboration/document-policy")>(),
  buildDocumentCollaborationPrompts: (...args: unknown[]) => mocks.collaborationPrompts(...args) ?? ({ system: "policy", user: "request" }),
}));
vi.mock("@/lib/ai-collaboration/document-comment-policy", async original => {
  const actual = await original<typeof import("@/lib/ai-collaboration/document-comment-policy")>();
  return { ...actual, buildDocumentCommentReplyPrompts: (...args: Parameters<typeof actual.buildDocumentCommentReplyPrompts>) => {
    const controlled = mocks.replyPrompts(...args);
    return controlled ?? actual.buildDocumentCommentReplyPrompts(...args);
  } };
});
vi.mock("@/lib/ai-collaboration/project-support-server", () => ({
  resolveProjectSupportContext: mocks.support,
  listProjectMemories: mocks.memories, projectMemoryContinuation: () => null, dismissProjectMemories: vi.fn(), saveProjectMemoryCandidates: vi.fn(),
}));
vi.mock("@/lib/ai-collaboration/project-support-types", async original => ({
  ...await original<typeof import("@/lib/ai-collaboration/project-support-types")>(), normalizeProjectSupportOutput: mocks.normalizeSupport,
}));
vi.mock("@/lib/ai-collaboration/audit-outbox", () => ({ appendDurableAiInteractionEvents: mocks.audit }));
vi.mock("@/lib/llm/client", () => ({ callLLM: mocks.model, parseLLMJson: JSON.parse }));
vi.mock("@/lib/observability/classroom-ai", () => ({ recordAiCacheEvent: vi.fn(), withClassroomAiUsage: (_scope: unknown, operation: () => unknown) => operation() }));
vi.mock("@/lib/ai-collaboration/document-request-store", () => ({ claimDocumentRequest: mocks.claim, getDocumentRequest: mocks.receipt,
  cancelDocumentRequest: mocks.cancel, completeDocumentRequest: mocks.complete, failDocumentRequest: mocks.fail,
  readDocumentRequestReceipt: background.receipt, prepareDocumentRequestResponse: mocks.prepare, listDocumentRequests: mocks.requests, readDelegatedWorkSummary: mocks.delegationSummary }));
import { LlmCallFailedError } from "@/lib/llm/errors";
import { CourseAdmissionTimeoutError } from "@/lib/db/transaction-retry";
import { PlatformError } from "@/lib/platform/repository";
import { GET, POST } from "./route";
import { DOCUMENT_COMMENT_REVIEW_VERSION } from "@/lib/ai-collaboration/document-comment-policy";

const body = { courseId: "course", studentId: "student", stageKey: "make", requestId: "request-1", intent: "check",
  conversationId: "legacy", message: "请检查证据", documentHtml: "<p>我的观察记录</p>" };
const passingDiscussionReview = JSON.stringify({ passed: true,
  checks: { quantifiers: true, arithmetic: true, population: true, uncertainty: true, grounded: true, learningBoundary: true }, issues: [] });
const post = () => POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.support.mockResolvedValue({ promptContext: "support", sources: [], knowledgePointLabels: [] });
  mocks.memories.mockResolvedValue([]);
  mocks.normalizeSupport.mockReturnValue({ details: {}, memoryCandidates: [] });
  mocks.delegationSummary.mockResolvedValue("（暂无已交付记录）");
  mocks.authentication.mockResolvedValue({ studentId: "student", participationId: "participation", claims: { sub: "student", role: "student", sv: 1 } });
  mocks.readScope.mockResolvedValue({ student: { id: "student" }, currentStageKey: "make", makeArtifactMode: "document" });
  const identityRequest = new Request("http://localhost");
  companionLimiter.reset(rateLimitKey(identityRequest, getClientIp(identityRequest)));
  companionLimiter.reset(rateLimitKey(identityRequest, 'student'));
  mocks.messageIds.length = 0;
  mocks.historicalReceipts.mockResolvedValue([]);
  mocks.thread.mockResolvedValue({ messages: [] });
  mocks.pair.mockResolvedValue([{ messages: [] }, { messages: [] }]);
  mocks.fail.mockResolvedValue(true);
  mocks.prepare.mockResolvedValue(true);
  mocks.enqueue.mockImplementation(async ({ task }) => ({ kind: "queued", state: { requestId: task.requestId, status: "processing", phase: "queued", documentVersion: task.documentVersion, retryable: false } }));
  mocks.cancel.mockResolvedValue({ status: "cancelled" });
  mocks.scope.mockResolvedValue({ id: "course", name: "观察课", students: [{ id: "student", name: "Student" }],
    stages: [{ key: "make" }], currentStageIndex: 0, content: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("document route request admission and replay", () => {
  it("acknowledges background work before calling the model and persists the reviewed answer after disconnect", async () => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "async-attempt", history: [] });
    mocks.complete.mockResolvedValue(true);
    mocks.model.mockResolvedValueOnce(JSON.stringify({ kind: "discussion", message: "请核对原始记录", focus: "证据" }))
      .mockResolvedValueOnce(passingDiscussionReview);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
      method: "POST", headers: { Prefer: "respond-async" }, body: JSON.stringify(body), signal: controller.signal,
    }));
    expect(response.status).toBe(202);
    expect(response.headers.get("Preference-Applied")).toBe("respond-async");
    expect(await response.json()).toMatchObject({ requestId: body.requestId, status: "processing", phase: "running" });
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "background" }));
    expect(mocks.model).not.toHaveBeenCalled();
    controller.abort();
    await background.after.mock.calls[0][0]();
    expect(timeout).toHaveBeenCalledWith(DOCUMENT_COLLABORATION_EXECUTION_TIMEOUT_MS);
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls[0][1].abortSignal.aborted).toBe(false);
    expect(mocks.model.mock.calls[0][1]).not.toHaveProperty("lightweightScreening");
    expect(mocks.model.mock.calls[1][1]).toMatchObject({ lightweightScreening: true });
    for (const [, options] of mocks.model.mock.calls) expect(options).not.toHaveProperty("maxOutputTokens");
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      requestId: body.requestId, token: "async-attempt", response: expect.objectContaining({ status: "completed" }),
    }));
  });

  it("persists a background model failure for receipt polling", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.claim.mockResolvedValue({ kind: "run", token: "async-attempt", history: [] });
    mocks.model.mockRejectedValue(new Error("provider unavailable"));
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
      method: "POST", headers: { Prefer: "respond-async" }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(202);
    await background.after.mock.calls[0][0]();
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ requestId: body.requestId, token: "async-attempt" }));
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("joins existing background work without scheduling another model execution", async () => {
    mocks.claim.mockResolvedValue({ kind: "existing", state: { status: "processing" } });
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
      method: "POST", headers: { Prefer: "respond-async" }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(202);
    expect(background.after).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("cancels an acknowledged request before its background callback starts", async () => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "async-cancel", history: [] });
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
      method: "POST", headers: { Prefer: "respond-async" }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(202);
    const cancelled = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
      method: "POST", body: JSON.stringify({ ...body, action: "cancel-request" }),
    }));
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    background.receipt.mockResolvedValue({ status: 409, body: { requestId: body.requestId, status: "cancelled" } });
    await background.after.mock.calls[0][0]();
    expect(mocks.support).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("returns the real busy code and request identity when claim admission rejects", async () => {
    mocks.claim.mockRejectedValue(new CourseAdmissionTimeoutError());
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "COURSE_BUSY", requestId: "request-1", status: "failed", retryable: true });
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("replays the immutable completed response without another model call", async () => {
    mocks.claim.mockResolvedValue({ kind: "existing", state: { status: "completed", response: { result: { kind: "discussion", message: "核对原始记录" } } } });
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestId: "request-1", status: "completed", result: { message: "核对原始记录" } });
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("preserves scope rejection instead of acknowledging a receipt", async () => {
    mocks.scope.mockRejectedValue(new PlatformError("FORBIDDEN", "无权访问该课堂", 403));
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "FORBIDDEN", requestId: "request-1", status: "failed", retryable: false });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("keeps unexpected claim errors as failures without exposing internal details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.claim.mockRejectedValue(new Error("private infrastructure detail"));
    const response = await post();
    expect(response.status).toBe(503);
    const result = await response.json();
    expect(result).toMatchObject({ error: "DATABASE_UNAVAILABLE", requestId: "request-1", status: "failed" });
    expect(JSON.stringify(result)).not.toContain("private infrastructure detail");
  });

  it("returns a structured polling failure when reading the receipt is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.receipt.mockRejectedValue(new Error("connection unavailable"));
    const response = await GET(new NextRequest("http://localhost/api/ai-collaboration/document?courseId=course&studentId=student&stageKey=make&requestId=request-1"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE", requestId: "request-1", status: "failed" });
  });

  it("retains a failed question and links a successful retry through canonical message facts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.claim.mockResolvedValueOnce({ kind: "run", token: "attempt-1", history: [] })
      .mockResolvedValueOnce({ kind: "run", token: "attempt-2", history: [] });
    mocks.model.mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(JSON.stringify({ kind: "discussion", message: "核对原始记录", focus: "证据" }))
      .mockResolvedValueOnce(passingDiscussionReview);
    mocks.complete.mockResolvedValue(true);
    const failure = await post();
    expect(failure.status).toBe(503);
    const failedBatch = mocks.audit.mock.calls.at(-1)![0];
    expect(failedBatch).toEqual([
      expect.objectContaining({ eventType: "request", actorRole: "student", content: body.message, requestId: body.requestId }),
      expect.objectContaining({ eventType: "error", id: "document-failure:attempt-1", payload: expect.objectContaining({ requestAttemptId: "attempt-1" }) }),
    ]);
    expect(failedBatch[0]).not.toHaveProperty("id");
    const success = await post();
    expect(success.status).toBe(200);
    const completion = mocks.complete.mock.calls.at(-1)![0];
    const question = completion.messages.find((item: CompanionMessage) => item.role === "student");
    expect(question.content).toBe(body.message);
    expect(completion.requestId).toBe(body.requestId);
    expect(completion.messageFacts[question.id]).toMatchObject({ source: "sidebar", detail: { intent: body.intent } });
    expect(completion.auditEvents.map((event: { eventType: string }) => event.eventType)).toEqual(["policy"]);
    expect(mocks.audit.mock.calls.slice(1).flatMap(([events]) => events)
      .filter((event: AiInteractionEvent) => event.payload?.kind !== "model-output"
        && (event.eventType === "request" || event.eventType === "response"))).toEqual([]);
    expect(mocks.model).toHaveBeenCalledTimes(3);
  });
});


describe("document comment reply chronology", () => {
  it("keeps POST, stored refresh and export in question/answer order when completion timestamps and reverse IDs would tie", async () => {
    const requestedAt = "2026-10-16T03:56:13.000Z";
    const completedAt = "2026-10-16T03:56:21.093Z";
    const initialAt = "2026-10-16T03:56:12.672Z";
    const commentId = "comment-1";
    const initial = { id: "initial-comment", role: "agent" as const, content: "请核对原始日志。",
      createdAt: initialAt, visibility: "student-and-teacher" as const, conversationId: commentId };
    const persisted: CompanionMessage[] = [
      { id: "meta", role: "system-trigger", content: `OPENPBL_DOCUMENT_COMMENT_META:${JSON.stringify({
        id: commentId, blockIndex: 0, targetText: "原始日志", createdAt: initialAt,
      })}`, createdAt: initialAt, visibility: "teacher-only", conversationId: commentId }, initial,
    ];
    const storedThread = async (_course: string, _student: string, stage: string) => ({
      messages: stage === "ai-collaboration-comments:make" ? [...persisted].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)) : [],
    });
    mocks.thread.mockImplementation(storedThread);
    mocks.pair.mockImplementation((course: string, student: string, keys: readonly string[]) =>
      Promise.all(keys.map(stage => storedThread(course, student, stage))));
    mocks.messageIds.push("z-student-question", "a-ai-answer");
    mocks.claim.mockResolvedValue({ kind: "run", token: "reply-attempt", createdAt: requestedAt,
      history: [{ role: "assistant", content: initial.content }] });
    mocks.model.mockResolvedValue(JSON.stringify({ kind: "discussion", message: "先检查原始记录中的两个数字。" }));
    mocks.complete.mockImplementation(async ({ messages }: { messages: CompanionMessage[] }) => {
      persisted.push(...structuredClone(messages)); return true;
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(completedAt));
    try {
      const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
        method: "POST", body: JSON.stringify({ ...body, action: "reply-document-comment", commentThreadId: commentId,
          requestId: "reply-request", message: "请只说明需要核验的数字，不修改正文。", documentHtml: "<p>我的原始日志</p>" }),
      }));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.commentThread.comments.map((message: { role: string; createdAt: string }) => [message.role, message.createdAt]))
        .toEqual([["assistant", initialAt], ["student", requestedAt], ["assistant", completedAt]]);
      const storedReply = mocks.complete.mock.calls[0][0].messages;
      expect(storedReply.map((message: CompanionMessage) => [message.id, message.createdAt]))
        .toEqual([["z-student-question", requestedAt], ["a-ai-answer", completedAt]]);
      const refresh = await GET(new NextRequest("http://localhost/api/ai-collaboration/document?courseId=course&studentId=student&stageKey=make"));
      expect(refresh.status).toBe(200);
      const history = await refresh.json();
      expect(history.commentThreads.find((thread: { id: string }) => thread.id === commentId).comments)
        .toEqual(result.commentThread.comments);
      const completion = mocks.complete.mock.calls[0][0];
      expect(mocks.audit.mock.calls.flatMap(([events]) => events)
        .filter((event: AiInteractionEvent) => event.payload?.kind !== "model-output"
          && (event.eventType === "request" || event.eventType === "response"))).toEqual([]);
      const audit = storedReply.map((message: CompanionMessage) => ({
        ...completion.messageFacts[message.id], id: message.id, courseId: "course", studentId: "student", stageKey: "make",
        conversationId: commentId, eventType: completion.messageFacts[message.id].eventType,
        actorRole: message.role === "student" ? "student" : "ai", content: message.content, createdAt: message.createdAt,
        payload: completion.messageFacts[message.id].detail,
      })) as AiInteractionEvent[];
      expect(audit.map(event => [event.actorRole, event.createdAt])).toEqual([["student", requestedAt], ["ai", completedAt]]);
      // audit-store stores the real occurrence time in legacy.occurredAt;
      // database receipt timestamps can still tie and sort by reverse IDs.
      const exported = audit.map((event, index) => ({ ...event, id: index ? "a-answer-event" : "z-question-event",
        createdAt: completedAt, payload: { ...event.payload, occurredAt: event.createdAt } }));
      const [turn] = buildStudentAiInteractionTurns(exported);
      expect(turn.messages.map(message => [message.role, message.content, message.occurredAt]))
        .toEqual(result.commentThread.comments.slice(-2).map((message: { role: string; content: string; createdAt: string }) =>
          [message.role === "assistant" ? "ai" : "student", message.content, message.createdAt]));
      expect(mocks.model).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});


describe("old comment reply history uses its durable receipt", () => {
  it("restores the actual old tied IDs for GET and the next reply prompt without rewriting old records", async () => {
    const at = "2026-10-16T03:56:21.093Z";
    const commentId = "document-comment-3f66d651-129f-42f2-9d7d-f07970e634a6";
    const oldRequestId = "document-comment-ai-request-mvafqx5o-ztvej";
    const question = { id: "companion-message-d093f88b-154c-4333-ba14-1d1bb0794536", role: "student" as const,
      content: "请核对已有数字。", createdAt: at };
    const answer = { id: "companion-message-5f1fc50b-3eb2-454b-a1e7-de3de098ca36", role: "assistant" as const,
      content: "先看原始日志。", createdAt: at };
    const stored = [answer, question].map(comment => ({ ...comment, role: comment.role === "assistant" ? "agent" : "student",
      visibility: "student-and-teacher", conversationId: commentId }));
    const before = structuredClone(stored);
    const storedThread = async (_course: string, _student: string, stage: string) => ({
      messages: stage === "ai-collaboration-comments:make" ? [
        { id: "meta", role: "system-trigger", visibility: "teacher-only", createdAt: at,
          content: `OPENPBL_DOCUMENT_COMMENT_META:${JSON.stringify({ id: commentId, blockIndex: 0, targetText: "原始日志", createdAt: at })}` },
        ...stored,
      ] : [],
    });
    mocks.thread.mockImplementation(storedThread);
    mocks.pair.mockImplementation((course: string, student: string, keys: readonly string[]) =>
      Promise.all(keys.map(stage => storedThread(course, student, stage))));
    mocks.historicalReceipts.mockResolvedValue([{ taskId: "old-task", requestId: oldRequestId, responseRequestId: oldRequestId,
      threadId: commentId, responseThreadId: commentId, question, answer }]);
    const refreshed = await GET(new NextRequest("http://localhost/api/ai-collaboration/document?courseId=course&studentId=student&stageKey=make"));
    expect(refreshed.status).toBe(200);
    const history = await refreshed.json();
    expect(history.commentThreads[0].comments).toEqual([question, answer]);
    mocks.claim.mockImplementation(async input => ({ kind: "run", token: "next-attempt", createdAt: "2026-10-16T03:57:00.000Z", history: input.history }));
    mocks.model.mockResolvedValue(JSON.stringify({ kind: "discussion", message: "请继续核对既有记录。" }));
    mocks.complete.mockResolvedValue(true);
    const reply = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST", body: JSON.stringify({
      ...body, action: "reply-document-comment", requestId: "next-request", commentThreadId: commentId,
      message: "请只说明下一步，不修改正文。", documentHtml: "<p>我的原始日志</p>",
    }) }));
    expect(reply.status).toBe(200);
    expect(mocks.claim.mock.calls[0][0].history).toEqual([{ role: "user", content: question.content }, { role: "assistant", content: answer.content }]);
    expect((await reply.json()).commentThread.comments.slice(0, 2)).toEqual([question, answer]);
    expect(stored).toEqual(before); expect(mocks.historicalReceipts).toHaveBeenCalledTimes(2);
  });
});


describe("background admission and comment preparation cleanup", () => {
  it("fails a claimed reply when prompt construction throws and removes its cancellation controller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const at = "2026-01-01T00:00:00.000Z";
    mocks.thread.mockResolvedValue({ messages: [
      { id: "meta", role: "system-trigger", createdAt: at,
        content: 'OPENPBL_DOCUMENT_COMMENT_META:' + JSON.stringify({ id: "comment-one", blockIndex: 0, targetText: "原始记录", createdAt: at }) },
      { id: "comment", role: "agent", conversationId: "comment-one", content: "请核对原始记录", createdAt: at },
    ] });
    mocks.claim.mockResolvedValue({ kind: "run", token: "reply-attempt", history: [] });
    mocks.replyPrompts.mockImplementationOnce(() => { throw new Error("synthetic prompt construction failure"); });
    const payload = { ...body, action: "reply-document-comment", commentThreadId: "comment-one", requestId: "reply-fault" };
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST", body: JSON.stringify(payload) }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({ requestId: "reply-fault", status: "failed" });
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ requestId: "reply-fault", token: "reply-attempt" }));
    expect(mocks.model).not.toHaveBeenCalled();
    // The existing cancellation API reveals whether a stale controller survived.
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const cancelled = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST", body: JSON.stringify({ ...payload, action: "cancel-request" }) }));
    expect(cancelled.status).toBe(200);
    expect(abort).not.toHaveBeenCalled();
    mocks.thread.mockResolvedValue({ messages: [] });
    mocks.complete.mockResolvedValue(true);
    mocks.model.mockResolvedValue(JSON.stringify({ checkedCandidateIds: ["block:one"], complete: true, comments: [] }));
  });
});


describe("persisted comment anchor projection", () => {
  it.each([undefined, 1] as const)("retains anchor version %s through the existing scoped history route", async anchorVersion => {
    const at = "2026-10-16T05:01:11.391Z";
    mocks.pair.mockResolvedValue([{ messages: [] }, { messages: [
      { id: "anchor-meta", role: "system-trigger", createdAt: at,
        content: "OPENPBL_DOCUMENT_COMMENT_META:" + JSON.stringify({ id: "anchor-thread", blockId: "saved-block", anchorVersion,
          blockIndex: 0, blockText: "原始日志4只，汇总40只。", targetText: "汇总40只", createdAt: at }) },
      { id: "anchor-answer", role: "agent", conversationId: "anchor-thread", createdAt: at, content: "请核对日志与汇总数字。" },
    ] }]);
    const response = await GET(new NextRequest("http://localhost/api/ai-collaboration/document?courseId=course&studentId=student&stageKey=make"));
    expect(response.status).toBe(200);
    const thread = (await response.json()).commentThreads.find((item: { id: string }) => item.id === "anchor-thread");
    expect(thread).toMatchObject({ blockId: "saved-block", blockText: "原始日志4只，汇总40只。" });
    expect(thread.anchorVersion).toBe(anchorVersion);
    expect(mocks.model).not.toHaveBeenCalled();
  });
});


describe("retired automatic document review", () => {
  it.each(['proactive-document-comment', 'proactive-document-comments', 'resume-proactive-review'])('rejects %s without calling or resuming a model job', async action => {
    const response = await POST(new NextRequest('http://localhost/api/ai-collaboration/document', {
      method: 'POST', body: JSON.stringify({ ...body, action }),
    }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ status: 'cancelled', error: 'DOCUMENT_AUTOMATIC_REVIEW_RETIRED', proactiveReviewEnabled: false });
    expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled();
  });
});

describe("document history-only scope", () => {
  const history = (query = "") => GET(new NextRequest(`http://localhost/api/ai-collaboration/document?courseId=course&studentId=student&stageKey=make${query}`));
  it("returns the original history contract without loading prompt context", async () => {
    const response = await history(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [], memories: [], memoriesAvailable: true, proactiveReviewEnabled: false,
      continuation: null, conversationId: "legacy", workspaceKind: "document", commentThreads: [], reviewedParagraphFingerprints: [] });
    expect(mocks.scope).not.toHaveBeenCalled(); expect(mocks.thread).not.toHaveBeenCalled();
    expect(mocks.pair).toHaveBeenCalledExactlyOnceWith("course", "student", ["ai-collaboration:make", "ai-collaboration-comments:make"]);
    expect(mocks.readScope).toHaveBeenCalledWith("course", "student");
  });
  it("keeps actor-bound complete history, resets, comment state and reviewed evidence through one pair read", async () => {
    const at = "2026-10-17T00:00:00.000Z";
    const base = { visibility: "student-and-teacher" as const, createdAt: at };
    const visible = Array.from({ length: 45 }, (_, index): CompanionMessage => ({ ...base,
      id: `message-${index}`, role: index % 2 ? "agent" : "student", conversationId: "active",
      content: `Retained original ${index}`, ...(index === 44 ? { excludedFromAiAt: at } : {}),
    }));
    const main: CompanionMessage[] = [
      { ...base, id: "legacy", role: "student", conversationId: "legacy", content: "Older conversation" },
      { ...base, id: "reset", role: "system-trigger", triggerKind: "conversation-reset", conversationId: "active", content: "" },
      ...visible,
      { ...base, id: "hidden", role: "agent", conversationId: "active", content: "hidden-private", hiddenFromStudentAt: at },
      { ...base, id: "private", role: "agent", conversationId: "active", content: "teacher-private", visibility: "teacher-only" },
    ];
    const comments: CompanionMessage[] = [
      { ...base, id: "meta", role: "system-trigger", visibility: "teacher-only", content: "OPENPBL_DOCUMENT_COMMENT_META:" + JSON.stringify({
        id: "comment", blockId: "block", anchorVersion: 1, blockIndex: 0, targetText: "Original evidence", createdAt: at,
      }) },
      { ...base, id: "answer", role: "agent", conversationId: "comment", content: "Retained comment" },
      { ...base, id: "question", role: "student", conversationId: "comment", content: "Retained question", createdAt: "2026-10-17T00:00:01.000Z" },
      { ...base, id: "hidden-comment", role: "agent", conversationId: "comment", content: "hidden-comment-private", hiddenFromStudentAt: at },
      { ...base, id: "read", role: "system-trigger", visibility: "teacher-only", content: `OPENPBL_DOCUMENT_COMMENT_READ:${JSON.stringify({ id: "comment", readAt: at })}` },
      { ...base, id: "status", role: "system-trigger", visibility: "teacher-only", content: `OPENPBL_DOCUMENT_COMMENT_STATUS:${JSON.stringify({ id: "comment", status: "resolved" })}` },
      { ...base, id: "checkpoint", role: "system-trigger", visibility: "teacher-only", content: `OPENPBL_DOCUMENT_COMMENT_REVIEW:${JSON.stringify({ fingerprint: "confirmed-fingerprint", blockIndex: 1, reviewVersion: DOCUMENT_COMMENT_REVIEW_VERSION })}` },
    ];
    const original = structuredClone({ main, comments });
    const memories = [{ id: "memory", kind: "project-goal", content: "Retained memory" }];
    const requests = [{ requestId: "pending", status: "processing", conversationId: "active", documentVersion: "v1" }];
    mocks.authentication.mockResolvedValue({ studentId: "signed", participationId: "signed-participation", claims: { sub: "signed", role: "student", sv: 1 } });
    mocks.readScope.mockResolvedValue({ student: { id: "signed" }, currentStageKey: "make", makeArtifactMode: "document" });
    mocks.pair.mockResolvedValue([{ messages: main }, { messages: comments }]);
    mocks.memories.mockResolvedValue(memories); mocks.requests.mockResolvedValue(requests);
    const response = await GET(new NextRequest("http://localhost/api/ai-collaboration/document?courseId=course&stageKey=make&conversationId=untrusted"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messages: visible.slice(-40), requests, memories, memoriesAvailable: true,
      proactiveReviewEnabled: false, continuation: null, conversationId: "active", workspaceKind: "document",
      commentThreads: [{ id: "comment", blockId: "block", anchorVersion: 1, blockIndex: 0, targetText: "Original evidence",
        createdAt: at, readAt: at, status: "resolved", comments: [
          { id: "answer", role: "assistant", content: "Retained comment", createdAt: at },
          { id: "question", role: "student", content: "Retained question", createdAt: "2026-10-17T00:00:01.000Z" },
        ] }],
      reviewedParagraphFingerprints: ["confirmed-fingerprint"],
    });
    expect(mocks.pair).toHaveBeenCalledExactlyOnceWith("course", "signed", ["ai-collaboration:make", "ai-collaboration-comments:make"]);
    expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.memories).toHaveBeenCalledWith("signed-participation");
    expect(mocks.requests).toHaveBeenCalledWith({ courseId: "course", studentId: "signed", participationId: "signed-participation",
      stageKey: "make", workspaceKind: "document", conversationId: "active" });
    expect({ main, comments }).toEqual(original);
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it("keeps a failed current pair ownership check ahead of memory and task history", async () => {
    mocks.pair.mockRejectedValueOnce(new PlatformError("STUDENT_SCOPE_MISMATCH", "协作记录不属于该课堂", 403));
    const response = await history();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "STUDENT_SCOPE_MISMATCH", status: "failed", retryable: false });
    expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.memories).not.toHaveBeenCalled();
    expect(mocks.requests).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
  });
  it("keeps complete history and HTTP 200 but marks an unavailable memory read for client fallback", async () => {
    const message = { id: "history-message", role: "student", visibility: "student-and-teacher", content: "保留已有协作问题", createdAt: "2026-10-17T00:00:00.000Z" };
    mocks.pair.mockResolvedValue([{ messages: [message] }, { messages: [] }]);
    const original = await (await history()).json();
    expect(original.messages).toEqual([message]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.memories.mockRejectedValueOnce(new Error("temporary memory read failure"));
    const response = await history();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...original, memories: [], memoriesAvailable: false });
    expect(mocks.memories).toHaveBeenLastCalledWith("participation");
  });
  it.each([
    [undefined, "", 404, "COURSE_NOT_FOUND"],
    [{ student: { id: "student" }, currentStageKey: "make", makeArtifactMode: "document" }, "&workspaceKind=external-artifact", 409, "WORKSPACE_NOT_AVAILABLE"],
    [{ student: undefined, currentStageKey: "proposal", makeArtifactMode: "other" }, "", 409, "WORKSPACE_CHANGED"],
    [{ student: undefined, currentStageKey: "proposal", makeArtifactMode: "document" }, "", 403, "STUDENT_NOT_IN_COURSE"],
    [{ student: { id: "student" }, currentStageKey: "proposal", makeArtifactMode: "document" }, "", 409, "STAGE_CHANGED"],
  ])("preserves scope guard ordering and status", async (context, query, status, error) => {
    mocks.readScope.mockResolvedValue(context); const response = await history(String(query));
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error });
    expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.pair).not.toHaveBeenCalled(); expect(mocks.scope).not.toHaveBeenCalled();
  });
  it("keeps unsupported-stage and live authentication rejection ahead of context reads", async () => {
    const invalid = await GET(new NextRequest("http://localhost/api/ai-collaboration/document?courseId=course&stageKey=unknown"));
    expect(invalid.status).toBe(400); expect(mocks.authentication).not.toHaveBeenCalled();
    for (const status of [401, 403]) {
      mocks.authentication.mockResolvedValue(Response.json({ error: "FORBIDDEN" }, { status }));
      expect((await history()).status).toBe(status);
    }
    expect(mocks.readScope).not.toHaveBeenCalled(); expect(mocks.pair).not.toHaveBeenCalled(); expect(mocks.scope).not.toHaveBeenCalled();
  });
  it("retains changed runtime mode and does not redirect proactive receipt polls through history", async () => {
    mocks.readScope.mockResolvedValue({ student: { id: "student" }, currentStageKey: "make", makeArtifactMode: "other" });
    expect((await history("&workspaceKind=external-artifact")).status).toBe(200);
    mocks.readScope.mockClear(); mocks.thread.mockClear(); mocks.pair.mockClear();
    mocks.receipt.mockResolvedValue({ requestId: "request", intent: "proactive-document-comments", status: "processing", phase: "queued" });
    expect((await history("&requestId=request")).status).toBe(200);
    expect(mocks.readScope).not.toHaveBeenCalled(); expect(mocks.scope).not.toHaveBeenCalled(); expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.pair).not.toHaveBeenCalled();
  });
});


describe("selected document timing boundaries", () => {
  const post = () => POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
    method: "POST", body: JSON.stringify({ ...body, selectedText: "我的观察记录" }),
  }));
  const valid = JSON.stringify({ kind: "discussion", message: "private model answer", focus: "证据" });
  const phases = (response: Response) => [...(response.headers.get("Server-Timing") ?? "").matchAll(/(document-[a-z-]+);dur=([\d.]+);desc="start=([\d.]+);end=([\d.]+);outcome=(ok|error)"/g)]
    .map(([, phase, duration, start, end, outcome]) => ({ phase, duration: Number(duration), start: Number(start), end: Number(end), outcome }));
  beforeEach(() => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "timing-attempt", history: [] });
    mocks.complete.mockResolvedValue(true);
    mocks.model.mockResolvedValue(valid);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each(["support", "initial"] as const)("retains interrupted %s duration on the original 85s timeout response", async stage => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const abort = (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      deadline.abort(new DOMException("private timeout detail", "TimeoutError"));
      signal.throwIfAborted();
    };
    if (stage === "support") mocks.support.mockImplementation(async ({ signal }) => abort(signal));
    else mocks.model.mockImplementation(async (_messages, { abortSignal }) => abort(abortSignal));
    const response = await post();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: "AI_COLLABORATION_TIMEOUT", requestId: body.requestId });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(85_000);
    const spans = phases(response);
    expect(spans.map(({ phase, outcome }) => [phase, outcome])).toEqual(stage === "support"
      ? [["document-support-context", "error"]]
      : [["document-support-context", "ok"], ["document-model-initial", "error"]]);
    for (const span of spans) { expect(span.end).toBeGreaterThanOrEqual(span.start); expect(span.duration).toBeGreaterThanOrEqual(0); }
    expect(mocks.model).toHaveBeenCalledTimes(stage === "support" ? 0 : 1);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(response.headers.get("Server-Timing")).not.toContain("private timeout detail");
  });

  it("separates context retry, repairs and durable audits in order without changing signals or retry budgets", async () => {
    mocks.model.mockRejectedValueOnce(new LlmCallFailedError("private vendor detail", { status: 400, upstreamSummary: "context length exceeded" }))
      .mockResolvedValueOnce("private malformed output").mockResolvedValueOnce("[]").mockResolvedValueOnce(valid);
    const response = await post();
    expect(response.status).toBe(200);
    expect(phases(response).map(({ phase, outcome }) => [phase, outcome])).toEqual([
      ["document-support-context", "ok"], ["document-model-initial", "error"],
      ["document-model-context-retry", "ok"], ["document-audit-invalid", "ok"],
      ["document-model-repair", "ok"], ["document-audit-invalid", "ok"],
      ["document-model-repair", "ok"], ["document-audit-success", "ok"], ["document-memory-read", "ok"],
    ]);
    expect(mocks.model).toHaveBeenCalledTimes(4);
    const signal = mocks.support.mock.calls[0][0].signal;
    for (const [, options] of mocks.model.mock.calls) expect(options).toMatchObject({ abortSignal: signal, maxTransientRetries: 2 });
    expect(mocks.model.mock.calls.map(([, options]) => options.jsonMode)).toEqual([true, false, true, true]);
    const spans = phases(response);
    for (let index = 1; index < spans.length; index += 1) expect(spans[index].start).toBeGreaterThanOrEqual(spans[index - 1].end);
    const header = response.headers.get("Server-Timing")!;
    for (const secret of ["private vendor detail", "private malformed output", "private model answer", body.message, body.requestId]) expect(header).not.toContain(secret);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "invalid"] as const)("distinguishes %s audit failure from model execution and does not generate again", async kind => {
    mocks.model.mockResolvedValueOnce(kind === "success" ? valid : "invalid-json");
    mocks.audit.mockRejectedValueOnce(new Error("private persistence detail"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(phases(response).map(({ phase, outcome }) => [phase, outcome])).toEqual([
      ["document-support-context", "ok"], ["document-model-initial", "ok"], [`document-audit-${kind}`, "error"],
    ]);
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(response.headers.get("Server-Timing")).not.toContain("private persistence detail");
  });

  it("records failed optional memory reads even when the existing fallback completes the request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.memories.mockRejectedValueOnce(new Error("private memory failure"));
    const response = await post();
    expect(response.status).toBe(200);
    expect(phases(response).at(-1)).toMatchObject({ phase: "document-memory-read", outcome: "error" });
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
});


describe("delegated work delivery and durable continuation", () => {
  const request = "把已有记录整理为表格，只在对话中交付";
  const documentHtml = "<p>周一：8人中5人支持；周二：缺失。</p>";
  const assessment = {
    decision: "accepted", taskTitle: "整理观察记录", reason: "已有材料的机械排表，不代替证据解释。",
    studentMessage: "我可以把已有记录排成表格。", protectedLearningWork: "证据解释和结论",
    studentResponsibility: "亲自分析记录并形成结论", proposedScope: "保留原始数值和缺失项，只整理为表格",
    requirementAnchor: { source: "request", quote: request }, intendedUse: "核对已有记录",
    availableMaterials: "周一与周二原始记录", materialQuotes: ["周一：8人中5人支持；周二：缺失。"],
    documentPlacement: "none", needsWebResearch: false,
  };
  const delivery = { message: "已有记录已排成表格。", focus: "观察记录", deliverable: {
    title: "观察记录表", summary: "保留数值与缺失项", content: "| 日期 | 记录 |\n| --- | --- |\n| 周一 | 8人中5人支持 |\n| 周二 | 缺失 |",
    documentActions: [{ operation: "none", targetText: "", content: "", description: "只在对话中查看" }], sourceIds: [],
  } };
  const review = { passed: true, checks: { relevant: true, withinScope: true, faithful: true, complete: true, placement: true }, issues: [] };
  const preparedFingerprint = async () => createHash('sha256').update(JSON.stringify({
    courseText: buildAuthoritativeCourseContext(await mocks.scope(), 'student', 'make'),
    documentText: '周一：8人中5人支持；周二：缺失。', request,
    documentHeadings: [],
    deliveredWorkSummary: "（暂无已交付记录）", policyVersion: DOCUMENT_COLLABORATION_POLICY_VERSION,
    deliveryPolicyVersion: DELEGATED_DELIVERY_POLICY_VERSION, explanationFidelityVersion: DOCUMENT_DISCUSSION_FIDELITY_VERSION,
    researchContext: "support",
  })).digest('hex');
  const delegate = () => POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST",
    body: JSON.stringify({ ...body, intent: "delegate", message: request, documentHtml }) }));
  beforeEach(() => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "delegate-attempt", history: [] });
    mocks.complete.mockResolvedValue(true);
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
  });

  it("checks scope, real delivery and semantics before creating a reviewable receipt", async () => {
    const response = await delegate();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", result: { kind: "work-delivery", deliverable: { content: delivery.deliverable.content, documentActions: [{ operation: "none" }] } } });
    expect(mocks.delegationSummary).toHaveBeenCalledWith(expect.objectContaining({ participationId: "participation", stageKey: "make" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(mocks.prepare.mock.calls.map(([input]) => input.response)).toEqual(expect.arrayContaining([
      expect.objectContaining({ delegationAssessment: expect.objectContaining({ decision: "accepted" }) }),
      expect.objectContaining({ delegationDraft: JSON.stringify(delivery) }),
    ]));
  });

  it("preserves actual heading identity and levels through all three delegation model steps", async () => {
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST",
      body: JSON.stringify({ ...body, intent: "delegate", message: request,
        documentHtml: `<h1 data-block-id="title"><strong>观察报告</strong></h1>${documentHtml}` }) }));
    expect(response.status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    for (const [messages] of mocks.model.mock.calls) {
      expect(messages[1].content).toContain(JSON.stringify([{ text: '观察报告', level: 1 }]));
    }
  });

  it("invalidates an assessment checkpoint when heading levels change without changing plain text", async () => {
    const oldFingerprint = createHash('sha256').update(JSON.stringify({
      courseText: buildAuthoritativeCourseContext(await mocks.scope(), 'student', 'make'),
      documentText: '观察报告\n周一：8人中5人支持；周二：缺失。', request,
      documentHeadings: [{ text: '观察报告', level: 1 }],
      deliveredWorkSummary: "（暂无已交付记录）", policyVersion: DOCUMENT_COLLABORATION_POLICY_VERSION,
    })).digest('hex');
    mocks.claim.mockResolvedValue({ kind: 'run', token: 'heading-change', history: [], preparedResponse: {
      delegationAssessment: assessment, delegationDraft: JSON.stringify(delivery), delegationContextFingerprint: oldFingerprint,
    } });
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST",
      body: JSON.stringify({ ...body, intent: 'delegate', message: request, documentHtml: `<h2>观察报告</h2>${documentHtml}` }) }));
    expect(response.status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(mocks.model.mock.calls[0][0][1].content).toContain(JSON.stringify([{ text: '观察报告', level: 2 }]));
    expect(mocks.prepare.mock.calls[0][0].response.delegationContextFingerprint).not.toBe(oldFingerprint);
  });

  it("reassesses heading intake instead of reusing the pre-numbering-policy clarification", async () => {
    const headingRequest = "统一现有标题层级和编号，不改正文。";
    const headings = [{ text: "研究报告", level: 1 }, { text: "2 调查方法", level: 3 }];
    const headingHtml = "<h1>研究报告</h1><h3>2 调查方法</h3>";
    const oldFingerprint = createHash("sha256").update(JSON.stringify({
      courseText: buildAuthoritativeCourseContext(await mocks.scope(), "student", "make"),
      documentText: "研究报告\n2 调查方法", request: headingRequest, documentHeadings: headings,
      deliveredWorkSummary: "（暂无已交付记录）", policyVersion: DOCUMENT_COLLABORATION_POLICY_VERSION,
      deliveryPolicyVersion: DELEGATED_DELIVERY_POLICY_VERSION, explanationFidelityVersion: DOCUMENT_DISCUSSION_FIDELITY_VERSION,
    })).digest("hex");
    mocks.claim.mockResolvedValue({ kind: "run", token: "old-heading-intake", history: [], preparedResponse: {
      delegationAssessment: { ...assessment, decision: "clarify", reasonCode: "scope_unclear",
        requirementAnchor: { source: "request", quote: headingRequest }, materialQuotes: ["2 调查方法"],
        studentMessage: "是否保留旧编号？" },
      delegationContextFingerprint: oldFingerprint,
    } });
    mocks.model.mockReset();
    mocks.model.mockRejectedValueOnce(new Error("temporary model failure"));
    const response = await POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST",
      body: JSON.stringify({ ...body, intent: "delegate", message: headingRequest, documentHtml: headingHtml }) }));
    expect(response.status).toBe(503);
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.model.mock.calls[0][0][0].content).toContain("先判断能否接单");
    expect(mocks.model.mock.calls[0][0][0].content).toContain("标题序号是结构标记");
  });

  it("resumes a failed long delivery from its saved assessment without repeating it", async () => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "retry-attempt", history: [], preparedResponse: { delegationAssessment: assessment, delegationContextFingerprint: await preparedFingerprint() } });
    mocks.model.mockReset(); mocks.model.mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls[0][0][0].content).toContain("任务协调员已经确认");
  });

  it("resumes a paid draft at review instead of regenerating it", async () => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "review-retry", history: [], preparedResponse: { delegationAssessment: assessment, delegationDraft: JSON.stringify(delivery), delegationContextFingerprint: await preparedFingerprint() } });
    mocks.model.mockReset(); mocks.model.mockResolvedValueOnce(JSON.stringify(review));
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.model.mock.calls[0][0][0].content).toContain("项目辅助交付复核员");
  });

  it("does not approve a generic checklist replacing the requested table", async () => {
    const bad = { ...delivery, deliverable: { ...delivery.deliverable, content: "| 8 | 5 | 缺失 |\n请核对是否分析充分。" } };
    const rejected = { ...review, passed: false, checks: { ...review.checks, relevant: false }, issues: ["没有完成原始记录排表，只给出通用核对提示。"] };
    mocks.model.mockReset(); mocks.model.mockResolvedValueOnce(JSON.stringify(assessment))
      .mockResolvedValueOnce(JSON.stringify(bad)).mockResolvedValueOnce(JSON.stringify(rejected))
      .mockResolvedValueOnce(JSON.stringify(bad)).mockResolvedValueOnce(JSON.stringify(rejected));
    const response = await delegate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "failed", error: "AI_DELEGATED_DELIVERY_INCOMPLETE" });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.model).toHaveBeenCalledTimes(5);
  });

  it("reassesses prior acceptance when another delegated task has completed", async () => {
    const delegationContextFingerprint = await preparedFingerprint();
    mocks.claim.mockResolvedValue({ kind: "run", token: "changed-history", history: [], preparedResponse: {
      delegationAssessment: assessment, delegationDraft: JSON.stringify(delivery), delegationContextFingerprint,
    } });
    mocks.delegationSummary.mockResolvedValue("另一个对话已经交付项目分析，必须重新判断累计代做。");
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(mocks.model.mock.calls[0][0][1].content).toContain("另一个对话已经交付项目分析");
  });

  it("preserves an unavailable history as a technical failure without executing work", async () => {
    mocks.delegationSummary.mockRejectedValue(new Error("DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE"));
    const response = await delegate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE", status: "failed" });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("fails exhausted assessment structure without renewing the shared repair", async () => {
    mocks.model.mockReset(); mocks.model.mockResolvedValue('{"decision":"accepted","reason":"没有填写必要字段"}');
    const response = await delegate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", status: "failed", retryable: false });
    expect(mocks.complete).not.toHaveBeenCalled();
  });


  it("does not reuse a pre-shared-repair contract checkpoint under unchanged task inputs", async () => {
    const legacyFingerprint = createHash("sha256").update(JSON.stringify({
      courseText: buildAuthoritativeCourseContext(await mocks.scope(), "student", "make"),
      documentText: "周一：8人中5人支持；周二：缺失。", request, documentHeadings: [],
      deliveredWorkSummary: "（暂无已交付记录）", policyVersion: DOCUMENT_COLLABORATION_POLICY_VERSION,
    })).digest("hex");
    mocks.claim.mockResolvedValue({ kind: "run", token: "delivery-contract-changed", history: [], preparedResponse: {
      delegationAssessment: assessment, delegationDraft: JSON.stringify(delivery), delegationContextFingerprint: legacyFingerprint,
    } });
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(mocks.prepare.mock.calls[0][0].response.delegationContextFingerprint).not.toBe(legacyFingerprint);
    expect(mocks.model.mock.calls[0][0][0].content).toContain("先判断能否接单");
  });

  const deliveryCheckpoint = () => mocks.prepare.mock.calls.map(call => call[0].response).filter(value => value.delegationDelivery).at(-1);
  const rejectedDelivery = { ...review, passed: false, checks: { ...review.checks, relevant: false }, issues: ["未完成本次实际整理任务。"] };

  it("reviews the saved repaired delivery after an outage without a third generation", async () => {
    mocks.model.mockReset();
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(JSON.stringify(delivery))
      .mockResolvedValueOnce(JSON.stringify(rejectedDelivery)).mockResolvedValueOnce(JSON.stringify(delivery))
      .mockRejectedValueOnce(new Error("review connection lost"));
    expect((await delegate()).status).toBe(503);
    const checkpoint = deliveryCheckpoint();
    expect(checkpoint).toMatchObject({ delegationAssessmentRepairUsed: false, delegationDelivery: {
      version: 1, drafts: [JSON.stringify(delivery), JSON.stringify(delivery)], repairUsed: true, pendingRepair: null,
    } });
    mocks.claim.mockResolvedValue({ kind: "run", token: "saved-repair-review", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(JSON.stringify(review));
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(6);
    expect(mocks.model.mock.calls[5][0][0].content).toContain("项目辅助交付复核员");
  });

  it("does not grant a content repair after repairing review JSON, including another same-ID run", async () => {
    mocks.model.mockReset();
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(JSON.stringify(delivery))
      .mockResolvedValueOnce("invalid review JSON").mockResolvedValueOnce(JSON.stringify(rejectedDelivery));
    const response = await delegate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false,
      message: expect.stringContaining("请调整问题后重新发送") });
    const checkpoint = deliveryCheckpoint();
    expect(checkpoint.delegationDelivery).toMatchObject({ drafts: [JSON.stringify(delivery)], repairUsed: true, pendingRepair: null });
    mocks.claim.mockResolvedValue({ kind: "run", token: "spent-review-repair", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(JSON.stringify(rejectedDelivery));
    const retried = await delegate();
    expect(retried.status).toBe(503);
    expect(await retried.json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(4);
  });

  it("resumes a repair that returned no bytes without regenerating the paid initial delivery", async () => {
    mocks.model.mockReset();
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(JSON.stringify(delivery))
      .mockResolvedValueOnce(JSON.stringify(rejectedDelivery)).mockRejectedValueOnce(new Error("repair transport timeout"));
    expect((await delegate()).status).toBe(503);
    const checkpoint = deliveryCheckpoint();
    expect(checkpoint.delegationDelivery).toMatchObject({ drafts: [JSON.stringify(delivery)], repairUsed: true,
      pendingRepair: { kind: "delivery", issues: rejectedDelivery.issues } });
    mocks.claim.mockResolvedValue({ kind: "run", token: "unfinished-delivery-repair", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(6);
    expect(mocks.model.mock.calls[4][0].at(-1).content).toContain("上次交付未通过校验");
    expect(deliveryCheckpoint().delegationDelivery).toMatchObject({ drafts: [JSON.stringify(delivery), JSON.stringify(delivery)], repairUsed: true, pendingRepair: null });
  });

  it("resumes an unfinished review-structure repair with the same paid draft", async () => {
    mocks.model.mockReset();
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(JSON.stringify(delivery))
      .mockResolvedValueOnce("invalid review").mockRejectedValueOnce(new Error("review repair transport timeout"));
    expect((await delegate()).status).toBe(503);
    const checkpoint = deliveryCheckpoint();
    expect(checkpoint.delegationDelivery).toMatchObject({ repairUsed: true, pendingRepair: { kind: "review" } });
    mocks.claim.mockResolvedValue({ kind: "run", token: "unfinished-review-repair", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(JSON.stringify(review));
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.model.mock.calls[4][0].at(-1).content).toContain("只修复复核结构");
    expect(deliveryCheckpoint().delegationDelivery).toMatchObject({ drafts: [JSON.stringify(delivery)], repairUsed: true, pendingRepair: null });
  });

  it("does not regenerate exhausted malformed drafts when the same ID is forced to run again", async () => {
    mocks.model.mockReset();
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce("invalid initial").mockResolvedValueOnce("invalid repair");
    expect((await delegate()).status).toBe(503);
    const checkpoint = deliveryCheckpoint();
    expect(checkpoint.delegationDelivery).toMatchObject({ drafts: ["invalid initial", "invalid repair"], repairUsed: true, pendingRepair: null });
    mocks.claim.mockResolvedValue({ kind: "run", token: "exhausted-delivery", history: [], preparedResponse: checkpoint });
    const response = await delegate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(3);
  });

  it("counts an assessment structure repair against the accepted delivery allowance", async () => {
    mocks.model.mockReset();
    mocks.model.mockResolvedValueOnce("invalid assessment").mockResolvedValueOnce(JSON.stringify(assessment))
      .mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(rejectedDelivery));
    const response = await delegate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(deliveryCheckpoint()).toMatchObject({ delegationAssessmentRepairUsed: true,
      delegationDelivery: { drafts: [JSON.stringify(delivery)], repairUsed: true, pendingRepair: null } });
  });

  const mixedRequest = "统一参考文献，不要写入报告，不改变原链接，再帮我写最终结论。";
  const reference = "甲. 用水说明. 2025. https://example.org/water";
  const mixedAssessment = { ...assessment, taskTitle: "统一参考文献", proposedScope: "仅统一已有参考文献格式，不改原链接，不写入报告",
    requirementAnchor: { source: "request", quote: "统一参考文献" }, availableMaterials: reference, materialQuotes: [reference] };
  const mixedDelivery = { ...delivery, deliverable: { ...delivery.deliverable, title: "参考文献", content: reference } };
  const mixedDelegate = () => POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST",
    body: JSON.stringify({ ...body, intent: "delegate", message: mixedRequest, documentHtml: `<p>${reference}</p>` }) }));

  it("retains every original mixed-task restriction through assessment, execution and semantic review", async () => {
    mocks.model.mockReset(); mocks.model.mockResolvedValueOnce(JSON.stringify(mixedAssessment))
      .mockResolvedValueOnce(JSON.stringify(mixedDelivery)).mockResolvedValueOnce(JSON.stringify(review));
    const response = await mixedDelegate();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result).toMatchObject({ kind: "work-delivery", deliverable: { content: reference, documentActions: [{ operation: "none" }] } });
    expect(payload.result.message).toContain("只处理了可独立完成的辅助部分");
    expect(mocks.model).toHaveBeenCalledTimes(3);
    for (const [messages] of mocks.model.mock.calls) {
      expect(messages[1].content).toContain(mixedRequest);
      expect(messages[1].content).toContain("辅助范围】\n统一参考文献");
    }
    expect(mocks.model.mock.calls[0][0][0].content).toContain("原文的其他限制不能因拆分而丢失");
  });

  it("invalidates an auxiliary checkpoint when the original full-request restrictions change", async () => {
    const oldFingerprint = createHash('sha256').update(JSON.stringify({
      courseText: buildAuthoritativeCourseContext(await mocks.scope(), 'student', 'make'),
      documentText: reference, request: "统一参考文献，再帮我写最终结论。", auxiliaryRequest: "统一参考文献",
      documentHeadings: [],
      deliveredWorkSummary: "（暂无已交付记录）", policyVersion: DOCUMENT_COLLABORATION_POLICY_VERSION,
    })).digest('hex');
    mocks.claim.mockResolvedValue({ kind: "run", token: "changed-original-constraints", history: [], preparedResponse: {
      delegationAssessment: mixedAssessment, delegationDraft: JSON.stringify(mixedDelivery), delegationContextFingerprint: oldFingerprint,
    } });
    mocks.model.mockReset(); mocks.model.mockResolvedValueOnce(JSON.stringify(mixedAssessment))
      .mockResolvedValueOnce(JSON.stringify(mixedDelivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await mixedDelegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(mocks.model.mock.calls[0][0][0].content).toContain("先判断能否接单");
    expect(mocks.model.mock.calls[0][0][1].content).toContain(mixedRequest);
    expect(mocks.prepare.mock.calls[0][0].response.delegationContextFingerprint).not.toBe(oldFingerprint);
  });

  it("reassesses a checkpoint when the course context has changed", async () => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "changed-course", history: [], preparedResponse: {
      delegationAssessment: assessment, delegationDraft: JSON.stringify(delivery), delegationContextFingerprint: 'old-context',
    } });
    expect((await delegate()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(mocks.model.mock.calls[0][0][0].content).toContain("先判断能否接单");
  });
});

it("commits the policy with the answer and sends no duplicate success audit afterward", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.claim.mockResolvedValue({ kind: "run", token: "completed-before-audit", history: [] });
  mocks.model.mockResolvedValueOnce(JSON.stringify({ kind: "discussion", message: "请核对现有记录", focus: "记录" }))
    .mockResolvedValueOnce(passingDiscussionReview);
  mocks.complete.mockResolvedValue(true);
  mocks.audit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit outbox unavailable"));
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "completed", result: { message: "请核对现有记录" } });
  expect(mocks.complete.mock.calls[0][0].auditEvents).toEqual([expect.objectContaining({ eventType: "policy" })]);
  expect(mocks.audit).toHaveBeenCalledTimes(2);
  expect(mocks.fail).not.toHaveBeenCalled();
});

describe("discussion semantic review and durable repair", () => {
  const requestBody = { ...body, intent: "discuss", message: "只解释概念：未回答与明确反对有什么区别？" };
  const send = (patch: Record<string, unknown> = {}) => POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
    method: "POST", body: JSON.stringify({ ...requestBody, ...patch }),
  }));
  const draft = (message: string) => JSON.stringify({ kind: "discussion", message, focus: "概念", suggestion: null });
  const good = draft("未回答表示态度未知，明确反对表示已表达不支持，不能归为同一类。");
  const bad = draft("未回答可以全部当作反对。");
  const checks = { quantifiers: true, arithmetic: true, population: true, uncertainty: true, grounded: true, learningBoundary: true };
  const pass = JSON.stringify({ passed: true, checks, issues: [] });
  const fail = JSON.stringify({ passed: false, checks: { ...checks, uncertainty: false }, issues: ["把未知态度当作反对，须保留原始状态差异。"] });
  const lastCheckpoint = () => mocks.prepare.mock.calls.map(call => call[0].response).filter(response => response.discussionReview).at(-1);
  beforeEach(() => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "discussion-attempt", history: [] });
    mocks.complete.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each([false, true])("reuses paid discussion review after audit failure, structure repair=%s", async repaired => {
    let failed = false;
    mocks.audit.mockImplementation(async (events: AiInteractionEvent[]) => {
      if (!failed && events.some(event => event.payload?.modelStep === "discussion-review" && event.content === pass)) {
        expect(lastCheckpoint().discussionReview.reviewOutputs.at(-1)).toMatchObject({ repairStructure: repaired, raw: pass });
        failed = true; throw new Error("database and outbox audit unavailable");
      }
    });
    mocks.model.mockResolvedValueOnce(good);
    if (repaired) mocks.model.mockResolvedValueOnce("bad review JSON");
    mocks.model.mockResolvedValueOnce(pass);
    expect((await send()).status).toBe(503);
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-paid-discussion-review", history: [], preparedResponse: lastCheckpoint() });
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(repaired ? 3 : 2);
  });
  it("retains paid repaired discussion review when audit crosses the original deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    mocks.audit.mockImplementation(async (events: AiInteractionEvent[]) => {
      if (!deadline.signal.aborted && events.some(event => event.payload?.modelStep === "discussion-review" && event.content === pass)) {
        expect(lastCheckpoint().discussionReview.reviewOutputs.at(-1).raw).toBe(pass);
        deadline.abort(new DOMException("audit crossed deadline", "TimeoutError"));
      }
    });
    mocks.model.mockResolvedValueOnce(good).mockResolvedValueOnce("bad review JSON").mockResolvedValueOnce(pass);
    expect(await (await send()).json()).toMatchObject({ error: "AI_COLLABORATION_TIMEOUT" });
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-deadline-discussion", history: [], preparedResponse: lastCheckpoint() });
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
  });
  it("reviews a bad answer, repairs once, and exposes only the passing answer", async () => {
    mocks.model.mockResolvedValueOnce(bad).mockResolvedValueOnce(fail).mockResolvedValueOnce(good).mockResolvedValueOnce(pass);
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "discussion", message: JSON.parse(good).message } });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    const checkpoint = lastCheckpoint().discussionReview;
    expect(checkpoint).toMatchObject({ drafts: [bad, good], repairUsed: true, pendingRepair: null });
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("把未知态度当作反对");
    const signals = mocks.model.mock.calls.map(call => call[1].abortSignal);
    expect(signals.every(signal => signal === signals[0])).toBe(true);
    expect(mocks.audit.mock.calls.flatMap(call => call[0]).filter(event => event.payload?.modelStep === "discussion-review")).toHaveLength(2);
  });

  it("returns a technical quality failure without exposing a twice-rejected answer", async () => {
    mocks.model.mockResolvedValueOnce(bad).mockResolvedValueOnce(fail).mockResolvedValueOnce(bad).mockResolvedValueOnce(fail);
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", status: "failed", retryable: false });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.model).toHaveBeenCalledTimes(4);
  });

  it("reuses the paid repaired draft after a review outage but reviews it again", async () => {
    mocks.model.mockResolvedValueOnce(bad).mockResolvedValueOnce(fail).mockResolvedValueOnce(good).mockRejectedValueOnce(new Error("review provider unavailable"));
    expect((await send()).status).toBe(503);
    const checkpoint = lastCheckpoint();
    mocks.claim.mockResolvedValue({ kind: "run", token: "discussion-retry", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(pass);
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.model.mock.calls[4][0][0].content).toContain("独立语义复核员");
    expect(mocks.model.mock.calls[4][0][1].content).toContain(JSON.parse(good).message);
    expect(lastCheckpoint().discussionReview).toMatchObject({ drafts: checkpoint.discussionReview.drafts,
      repairUsed: checkpoint.discussionReview.repairUsed, pendingRepair: checkpoint.discussionReview.pendingRepair });
    expect(lastCheckpoint().discussionReview.reviewOutputs).toHaveLength(2);
  });

  it("resumes an unfinished repair after a transport failure without regenerating the original", async () => {
    mocks.model.mockResolvedValueOnce(bad).mockResolvedValueOnce(fail).mockRejectedValueOnce(new Error("repair provider timeout"));
    expect((await send()).status).toBe(503);
    const checkpoint = lastCheckpoint();
    expect(checkpoint.discussionReview).toMatchObject({ drafts: [bad], repairUsed: true, pendingRepair: { kind: "draft" } });
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-repair", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(good).mockResolvedValueOnce(pass);
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.model.mock.calls[3][0].at(-1).content).toContain("修复本轮回复");
    expect(lastCheckpoint().discussionReview.drafts).toEqual([bad, good]);
  });

  it("shares the one repair between invalid draft structure and semantic rejection", async () => {
    mocks.model.mockResolvedValueOnce("not JSON").mockResolvedValueOnce(bad).mockResolvedValueOnce(fail);
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED" });
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(lastCheckpoint().discussionReview.drafts).toEqual(["not JSON", bad]);
  });

  it("does not offer an impossible retry after both saved drafts have invalid structure", async () => {
    mocks.model.mockResolvedValueOnce("invalid original").mockResolvedValueOnce("invalid repair");
    const response = await send();
    expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false,
      message: expect.stringContaining("调整问题后重新发送") });
    mocks.claim.mockResolvedValue({ kind: "run", token: "exhausted-retry", history: [], preparedResponse: lastCheckpoint() });
    const retried = await send();
    expect(await retried.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("does not grant another content repair after repairing review JSON", async () => {
    mocks.model.mockResolvedValueOnce(bad).mockResolvedValueOnce("not JSON").mockResolvedValueOnce(fail);
    expect((await send()).status).toBe(503);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(lastCheckpoint().discussionReview).toMatchObject({ drafts: [bad], repairUsed: true, pendingRepair: null });
  });

  it("does not reuse a checkpoint after the original request changes", async () => {
    mocks.model.mockResolvedValueOnce(good).mockRejectedValueOnce(new Error("review outage"));
    expect((await send()).status).toBe(503);
    mocks.claim.mockResolvedValue({ kind: "run", token: "changed-context", history: [], preparedResponse: lastCheckpoint() });
    mocks.model.mockResolvedValueOnce(good).mockResolvedValueOnce(pass);
    expect((await send({ message: "只解释概念：样本和总体有什么区别？" })).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(mocks.model.mock.calls[2][0][0].content).toBe("policy");
  });

  it("reviews ordinary discussion even without feedback-only or concept-only flags", async () => {
    mocks.model.mockResolvedValueOnce(good).mockResolvedValueOnce(pass);
    expect((await send({ message: "下一步该检查哪条记录？" })).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.prepare.mock.calls.some(call => call[0].response.discussionReview)).toBe(true);
  });

  it("reviews normalized visible blocks instead of a hidden correct message", async () => {
    mocks.normalizeSupport.mockImplementation(value => ({ details: value ?? {}, memoryCandidates: [] }));
    const wrongBlock = "全部调查对象都支持，只需其中至少七人支持即可。";
    const visibleGood = "‘全部’要求该范围没有反例；已经记录明确反对时，不能声称全部支持。";
    const hiddenGood = "不显示的正确message";
    const candidate = JSON.stringify({ kind: "discussion", message: hiddenGood, suggestion: null,
      support: { replyBlocks: [{ kind: "answer", content: wrongBlock }] } });
    const repaired = JSON.stringify({ kind: "discussion", message: "修复后也由block显示", suggestion: null,
      support: { replyBlocks: [{ kind: "answer", content: visibleGood }] } });
    mocks.model.mockResolvedValueOnce(candidate).mockResolvedValueOnce(fail).mockResolvedValueOnce(repaired).mockResolvedValueOnce(pass);
    const response = await send({ message: "只检查这句有什么问题，不要重写。" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { message: visibleGood } });
    const reviewInput = mocks.model.mock.calls[1][0][1].content;
    expect(reviewInput).toContain(wrongBlock);
    expect(reviewInput).not.toContain(hiddenGood);
    expect(mocks.model.mock.calls[3][0][1].content).toContain(visibleGood);
    expect(mocks.model.mock.calls[3][0][1].content).not.toContain(wrongBlock);
  });

  it("still rejects a reused repaired draft when its fresh semantic review fails", async () => {
    mocks.model.mockResolvedValueOnce(bad).mockResolvedValueOnce(fail).mockResolvedValueOnce(bad).mockRejectedValueOnce(new Error("review outage"));
    expect((await send()).status).toBe(503);
    const checkpoint = lastCheckpoint();
    mocks.claim.mockResolvedValue({ kind: "run", token: "retry-exhausted", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(fail);
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED" });
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.complete).not.toHaveBeenCalled();
  });


  it("shares real HTML source positions with summary generation and review, including legacy discuss intent", async () => {
    const actual = await vi.importActual<typeof import("@/lib/ai-collaboration/document-policy")>("@/lib/ai-collaboration/document-policy");
    mocks.collaborationPrompts.mockImplementation(actual.buildDocumentCollaborationPrompts);
    const documentHtml = '<h1>调查报告</h1><h2>正文记录</h2><p>访谈统计已记录。</p>'
      + '<h2>附录</h2><p>地点甲原始记录。</p><p>地点乙原始记录。</p>';
    mocks.model.mockResolvedValueOnce(draft("甲、乙原始记录均在附录；访谈统计在正文记录中。")).mockResolvedValueOnce(pass);
    const response = await send({ message: "根据已有记录总结我们已完成和待完成的工作，只在对话里说明。", documentHtml });
    expect(response.status).toBe(200);
    const initialUser = mocks.model.mock.calls[0][0][1].content;
    expect(initialUser).toContain('"headingPath":[{"level":1,"text":"调查报告"},{"level":2,"text":"附录"}]');
    expect(initialUser).toContain('"text":"地点甲原始记录。\\n地点乙原始记录。"');
    expect(initialUser.match(/访谈统计已记录/g)).toHaveLength(1);
    expect(mocks.model.mock.calls[1][0][1].content).toContain(initialUser);
    expect(mocks.model).toHaveBeenCalledTimes(2);
  });

  it("retains the same source accounting through the existing compact context fallback", async () => {
    const actual = await vi.importActual<typeof import("@/lib/ai-collaboration/document-policy")>("@/lib/ai-collaboration/document-policy");
    mocks.collaborationPrompts.mockImplementation(actual.buildDocumentCollaborationPrompts);
    const documentHtml = '<h1>报告</h1><h2>正文</h2><p>' + '原始材料。'.repeat(3000)
      + '</p><h2>附录</h2><p>' + '待核验记录。'.repeat(3000) + '</p>';
    mocks.model.mockRejectedValueOnce(new LlmCallFailedError("context too large", { status: 400, upstreamSummary: "context length exceeded" }))
      .mockResolvedValueOnce(good).mockResolvedValueOnce(pass);
    expect((await send({ intent: "summarize", message: "总结已完成和待完成工作。", documentHtml })).status).toBe(200);
    const projection = (user: string) => user.split("【编辑器中的最新实时草稿（可能尚未保存）】\n")[1].split("\n\n【学生选中的局部文字】")[0];
    const full = projection(mocks.model.mock.calls[0][0][1].content);
    const compact = projection(mocks.model.mock.calls[1][0][1].content);
    expect(full.length).toBeLessThanOrEqual(16_000);
    expect(compact.length).toBeLessThanOrEqual(6_000);
    expect(JSON.parse(full.split("\n")[0]).totalBodyCharacters).toBe(JSON.parse(compact.split("\n")[0]).totalBodyCharacters);
    expect(JSON.parse(compact.split("\n")[0]).omittedBodyCharacters).toBeGreaterThan(0);
    expect(mocks.model.mock.calls[2][0][1].content).toContain(full);
    expect(mocks.collaborationPrompts.mock.calls[1][0]).toMatchObject({ compact: true, documentHtml });
  });

  it.each([
    '只能写“受访者中多数支持”，不能写“所有人支持”。',
    '不能代写结论。样本中只能说多数支持，最后由你自己确定表述。',
    '结论草稿写“所有人都支持张贴提醒”，但访谈记录是8人中5人支持、2人不支持、1人未回答；这只能说明“受访者中多数支持”，而且只覆盖这8人。',
  ])("repairs a copyable core conclusion in visible blocks even when semantic review incorrectly passes: %s", async visibleConclusion => {
    mocks.normalizeSupport.mockImplementation(value => ({ details: value ?? {}, memoryCandidates: [] }));
    const unsafe = JSON.stringify({ kind: "boundary", message: "核心结论必须由你形成。", suggestion: null,
      support: { replyBlocks: [{ type: "answer", content: visibleConclusion }] } });
    const safe = JSON.stringify({ kind: "boundary", message: "核心结论由你形成。", suggestion: null,
      support: { replyBlocks: [{ type: "answer", content: '草稿写“所有人支持”，已有反对记录，请核对这处矛盾并自己判断范围。' }] } });
    mocks.model.mockResolvedValueOnce(unsafe).mockResolvedValueOnce(pass).mockResolvedValueOnce(safe).mockResolvedValueOnce(pass);
    const response = await send({ intent: "delegate", message: "根据这些数据替我写最终结论，可以直接交。" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "boundary", message: JSON.parse(safe).support.replyBlocks[0].content } });
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("可复制的替换结论句");
    expect(lastCheckpoint().discussionReview).toMatchObject({ repairUsed: true, drafts: [unsafe, safe], pendingRepair: null });
    expect(mocks.model).toHaveBeenCalledTimes(4);
  });

  it("invalidates a v1 core conclusion checkpoint instead of reusing its previously approved inference", async () => {
    const request = "根据这些数据替我写最终结论，可以直接交。";
    const unsafe = JSON.stringify({ kind: "boundary", message: '不能代写，但这只能说明“受访者中多数支持”。', suggestion: null });
    const oldFingerprint = createHash("sha256").update(JSON.stringify({
      version: DOCUMENT_DISCUSSION_REVIEW_VERSION,
      messages: [{ role: "system", content: "policy" }, { role: "user", content: "request" }],
      request, expectedKind: "boundary", coreConclusionGuardVersion: "quoted-conclusion-v1",
    })).digest("hex");
    mocks.claim.mockResolvedValue({ kind: "run", token: "old-conclusion-version", history: [], preparedResponse: {
      discussionReview: { fingerprint: oldFingerprint, drafts: [unsafe], repairUsed: true, pendingRepair: null },
    } });
    const safe = JSON.stringify({ kind: "boundary", message: "结论需要你形成。请核对已有反对记录与原句是否矛盾。", suggestion: null });
    mocks.model.mockResolvedValueOnce(safe).mockResolvedValueOnce(pass);
    expect((await send({ intent: "delegate", message: request })).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls[0][0][0].content).toBe("policy");
    expect(lastCheckpoint().discussionReview.fingerprint).not.toBe(oldFingerprint);
    expect(lastCheckpoint().discussionReview.drafts).toEqual([safe]);
  });

  it("does not add the forced conclusion guard or its prompt to ordinary feedback discussion", async () => {
    const answer = draft('这里要核对支持人数和总人数；这表明“支持人数与总样本人数是不同概念”。');
    mocks.model.mockResolvedValueOnce(answer).mockResolvedValueOnce(pass);
    const response = await send({ intent: "check", message: "我写所有人支持，但记录只有五人支持，哪里有问题？不要替我重写结论。" });
    expect(response.status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls[1][0][0].content).not.toContain("这只能说明/这表明/这意味着");
    expect(lastCheckpoint().discussionReview.repairUsed).toBe(false);
  });

  it("does not deliver or grant a third draft after the quoted conclusion guard exhausts its shared repair", async () => {
    const unsafe = JSON.stringify({ kind: "boundary", message: '不能代写，但结论可表述为“这项措施有效”。', suggestion: null });
    const patch = { intent: "delegate", message: "根据这些数据替我写最终结论，可以直接交。" };
    mocks.model.mockResolvedValueOnce(unsafe).mockResolvedValueOnce(pass).mockResolvedValueOnce(unsafe).mockResolvedValueOnce(pass);
    const first = await send(patch);
    expect(await first.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    const checkpoint = lastCheckpoint();
    mocks.claim.mockResolvedValue({ kind: "run", token: "exhausted-conclusion", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(pass);
    const retry = await send(patch);
    expect(await retry.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(lastCheckpoint().discussionReview.drafts).toEqual([unsafe, unsafe]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("repairs summary claims about requirements, document location and completed work", async () => {
    const badSummary = draft("成果形式未定；访谈已收入附录，分析已经完成。");
    const goodSummary = draft("课程要求研究报告；正文已有访谈记录，附录目前只有观察记录，分析仍待完成。");
    const rejected = JSON.stringify({ passed: false, checks: { ...checks, grounded: false }, issues: ["课程已明确报告；访谈不在附录，不能把已有记录当已完成分析。"] });
    mocks.model.mockResolvedValueOnce(badSummary).mockResolvedValueOnce(rejected).mockResolvedValueOnce(goodSummary).mockResolvedValueOnce(pass);
    const response = await send({ intent: "summarize", message: "总结已完成和待完成的工作。" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "discussion", message: JSON.parse(goodSummary).message } });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    const reviewSystem = mocks.model.mock.calls[1][0][0].content;
    expect(reviewSystem).toContain("某资料已记录不等于已经收入附录");
    expect(reviewSystem).not.toContain("本轮只解释概念/方法");
    expect(reviewSystem).not.toContain("本轮仅定位问题、明确不要重写");
  });

  it("repairs an answer hidden behind a refusal while retaining the forced boundary and 105s budget", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const unsafe = JSON.stringify({ kind: "boundary", message: "不能代写，但结论只能写成受访者多数支持，按这个写。", suggestion: null });
    const safe = JSON.stringify({ kind: "boundary", message: "最终结论需要你形成。请先核对证据的范围和限制，再解释它们能支持什么。", suggestion: null });
    const rejected = JSON.stringify({ passed: false, checks: { ...checks, learningBoundary: false }, issues: ["拒绝后仍给出替代结论，应只保留核对方法。"] });
    mocks.model.mockResolvedValueOnce(unsafe).mockResolvedValueOnce(rejected).mockResolvedValueOnce(safe).mockResolvedValueOnce(pass);
    const response = await send({ intent: "delegate", message: "根据这些数据替我写最终结论，可以直接交。" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "boundary", message: JSON.parse(safe).message } });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(105_000);
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("kind=boundary");
    for (const [, options] of mocks.model.mock.calls) {
      expect(options).toMatchObject({ abortSignal: mocks.support.mock.calls[0][0].signal, maxTransientRetries: 2 });
      expect(options).not.toHaveProperty("maxTokens");
      expect(options).not.toHaveProperty("model");
    }
  });

  it("cannot downgrade a protected request to discussion even if the reviewer approves its content", async () => {
    mocks.model.mockResolvedValueOnce(good).mockResolvedValueOnce(pass).mockResolvedValueOnce(good).mockResolvedValueOnce(pass);
    const response = await send({ intent: "delegate", message: "根据这些数据替我写最终结论，可以直接交。" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("必须保持 kind=boundary");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("keeps the 85s window for general discussion and leaves selected edits and organize inserts on their original path", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mocks.model.mockResolvedValueOnce(good).mockResolvedValueOnce(pass);
    expect((await send({ message: "接下来如何检查证据？" })).status).toBe(200);
    expect(timeout).toHaveBeenCalledWith(85_000);
    mocks.model.mockClear(); mocks.prepare.mockClear();
    for (const patch of [
      { intent: "edit", selectedText: "我的观察记录", message: "修正选区错字" },
      { intent: "organize", message: "把给出的字段做成空白记录表" },
    ]) {
      mocks.model.mockResolvedValueOnce(good);
      expect((await send(patch)).status).toBe(200);
    }
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.prepare.mock.calls.some(call => call[0].response.discussionReview)).toBe(false);
  });

  it("reviews contextual delegate refusals without another initial generation and preserves paid checkpoints on retry", async () => {
    const assessment = { decision: "protected", reasonCode: "core_learning", taskTitle: "排版学习", reason: "本课需要学生亲自排版。",
      studentMessage: "不能代做，不过标题直接改为这些层级即可。", proposedScope: "解释标题设置方法", protectedLearningWork: "亲自设置标题层级",
      studentResponsibility: "亲自操作与说明选择" };
    const repaired = JSON.stringify({ kind: "boundary", message: "标题层级需要你亲自设置。我可以解释层级如何表达结构，供你自己判断。", focus: "标题层级", suggestion: null });
    const rejected = JSON.stringify({ passed: false, checks: { ...checks, learningBoundary: false }, issues: ["拒绝后仍给直接排版答案。"] });
    const patch = { intent: "delegate", message: "统一现有标题层级和编号，不改正文。" };
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(rejected).mockResolvedValueOnce(repaired).mockRejectedValueOnce(new Error("review outage"));
    expect((await send(patch)).status).toBe(503);
    const checkpoint = lastCheckpoint();
    expect(checkpoint.delegationAssessment).toMatchObject(assessment);
    expect(checkpoint.discussionReview).toMatchObject({ repairUsed: true, drafts: [expect.any(String), repaired] });
    mocks.claim.mockResolvedValue({ kind: "run", token: "refusal-resume", history: [], preparedResponse: checkpoint });
    mocks.model.mockResolvedValueOnce(pass);
    const response = await send(patch);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "boundary", message: JSON.parse(repaired).message,
      delegation: { decision: "protected", reasonCode: "core_learning", protectedLearningWork: assessment.protectedLearningWork,
        studentResponsibility: assessment.studentResponsibility } } });
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.model.mock.calls[4][0][0].content).toContain("独立语义复核员");
  });

  it("locks clarification decisions and forbids an added deliverable during message repair", async () => {
    const assessment = { decision: "clarify", reasonCode: "irrelevant", taskTitle: "商品广告", reason: "与课程项目无关。", studentMessage: "广告如下。" };
    const rejected = JSON.stringify({ passed: false, checks: { ...checks, grounded: false }, issues: ["应解释项目相关性，不执行无关广告任务。"] });
    const illicit = JSON.stringify({ kind: "task-clarification", message: "请选择项目相关工作。", delegation: { decision: "accepted" }, deliverable: { content: "广告" } });
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(rejected).mockResolvedValueOnce(illicit).mockResolvedValueOnce(pass);
    const response = await send({ intent: "delegate", message: "帮我写与本项目无关的商品广告。" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    expect(lastCheckpoint().delegationAssessment).toMatchObject({ decision: "clarify", reasonCode: "irrelevant" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("shares the refusal repair allowance with an already repaired assessment structure", async () => {
    const assessment = { decision: "clarify", reasonCode: "missing_material", reason: "缺少待整理记录。", studentMessage: "记录已经全部整理好了。" };
    mocks.model.mockResolvedValueOnce("not JSON").mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(fail);
    const response = await send({ intent: "delegate", message: "帮我整理现有记录。" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(lastCheckpoint()).toMatchObject({ delegationAssessmentRepairUsed: true, discussionReview: { repairUsed: true } });
  });


  it.each([false, true])("ignores locked object key order but rejects a changed decision (change=%s)", async changeDecision => {
    const assessment = { decision: "clarify", reasonCode: "irrelevant", taskTitle: "商品广告", reason: "与课程项目无关。",
      studentMessage: "我已经完成了广告。", protectedLearningWork: "学生亲自完成核心分析", studentResponsibility: "明确本课相关任务" };
    const rejected = JSON.stringify({ passed: false, checks: { ...checks, grounded: false }, issues: ["仅说明相关性并澄清，不宣称已执行。"] });
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(rejected)
      .mockImplementationOnce(() => {
        const seed = JSON.parse(lastCheckpoint().discussionReview.drafts[0]);
        const delegation = Object.fromEntries(Object.entries(seed.delegation).reverse());
        if (changeDecision) delegation.decision = "accepted";
        return JSON.stringify({ ...seed, message: "广告与当前项目无关。你希望整理哪部分本课已有材料？", delegation });
      }).mockResolvedValueOnce(pass);
    const response = await send({ intent: "delegate", message: "帮我写与本项目无关的商品广告。" });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    if (changeDecision) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
      expect(mocks.complete).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { kind: "task-clarification",
        delegation: { decision: "clarify", reasonCode: "irrelevant", protectedLearningWork: assessment.protectedLearningWork,
          studentResponsibility: assessment.studentResponsibility } } });
      expect(mocks.complete).toHaveBeenCalledOnce();
    }
  });

});

describe("current-document placement consistency and shared repair", () => {
  const request = "请替我修正当前文稿中的错别字“浪废水”为“浪费水”，其他文字、观点和不确定程度逐字保持原样。这是明确委派的辅助编辑，请交付可审阅的段落替换。";
  const original = "我们尚未验证，这可能改善浪废水的情况。";
  const corrected = "我们尚未验证，这可能改善浪费水的情况。";
  const wrongAssessment = { decision: "accepted", reasonCode: "accepted", taskTitle: "错别字修正段落",
    reason: "仅机械纠正已确认错别字。", studentMessage: "只改错别字，交付可审阅的替换。",
    protectedLearningWork: "自主分析证据并形成结论", studentResponsibility: "核对修正并亲自完成核心分析",
    proposedScope: "仅修正当前句中的错别字，交付可审阅的段落替换。", intendedUse: "用于当前文稿措辞修正的审阅。",
    availableMaterials: "当前文稿中的一句原文", materialQuotes: [original],
    requirementAnchor: { source: "request", quote: request }, documentPlacement: "none", needsWebResearch: false };
  const rightAssessment = { ...wrongAssessment, documentPlacement: "document" };
  const delivery = { message: "仅修正错别字，等待确认。", focus: "错字修正", deliverable: {
    title: "修正段落", summary: "其余文字原样保留", content: corrected,
    documentActions: [{ operation: "replace", targetText: original, content: corrected, description: "只修正错别字" }], sourceIds: [],
  } };
  const noneDelivery = { ...delivery, deliverable: { ...delivery.deliverable, documentActions: [{ operation: "none", targetText: "", content: "", description: "只供参考" }] } };
  const review = { passed: true, checks: { relevant: true, withinScope: true, faithful: true, complete: true, placement: true }, issues: [] };
  const send = (patch: Record<string, unknown> = {}) => POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST",
    body: JSON.stringify({ ...body, intent: "delegate", message: request, documentHtml: `<p>${original}</p>`, ...patch }) }));
  const checkpoint = () => mocks.prepare.mock.calls.at(-1)![0].response;
  beforeEach(() => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "placement-attempt", history: [] });
    mocks.complete.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  it("reviews the combined assessment and delivery in two calls without regenerating the paid draft", async () => {
    const combined = JSON.stringify({ ...rightAssessment, ...delivery });
    mocks.model.mockResolvedValueOnce(combined).mockResolvedValueOnce(JSON.stringify(review));
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "work-delivery", deliverable: {
      documentActions: [{ operation: "replace", targetText: original, content: corrected }],
    } } });
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.model.mock.calls[0][1]).not.toHaveProperty("lightweightScreening");
    expect(mocks.model.mock.calls[1][1]).toMatchObject({ lightweightScreening: true });
    expect(checkpoint().delegationDelivery.drafts).toEqual([combined]);
  });
  it("resumes combined paid delivery after a review failure without a second generation", async () => {
    const combined = JSON.stringify({ ...rightAssessment, ...delivery });
    mocks.model.mockResolvedValueOnce(combined).mockRejectedValueOnce(new Error("review unavailable"));
    expect((await send()).status).toBe(503);
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-combined", history: [], preparedResponse: checkpoint() });
    mocks.model.mockResolvedValueOnce(JSON.stringify(review));
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(checkpoint().delegationDelivery.drafts).toEqual([combined]);
  });
  it("does not reuse a combined delivery whose original placement assessment failed", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify({ ...wrongAssessment, ...noneDelivery }))
      .mockResolvedValueOnce(JSON.stringify(rightAssessment))
      .mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(checkpoint().delegationDelivery.drafts).toEqual([JSON.stringify(delivery)]);
  });
  it.each([false, true])("reviews the valid delivery already produced by placement repair, audit recovery=%s", async auditRecovery => {
    const repaired = JSON.stringify({ ...rightAssessment, ...delivery });
    let auditFailed = false;
    mocks.audit.mockImplementation(async (events: AiInteractionEvent[]) => {
      if (auditRecovery && !auditFailed && events.some(event => event.payload?.modelStep === "delegation-placement-repair")) {
        auditFailed = true;
        throw new Error("audit unavailable");
      }
    });
    mocks.model.mockResolvedValueOnce(JSON.stringify({ ...wrongAssessment, ...noneDelivery }))
      .mockResolvedValueOnce(repaired).mockResolvedValueOnce(JSON.stringify(review));
    if (auditRecovery) {
      expect((await send()).status).toBe(503);
      mocks.claim.mockResolvedValue({ kind: "run", token: "resume-placement-delivery", history: [], preparedResponse: checkpoint() });
    }
    expect(await (await send()).json()).toMatchObject({ result: { kind: "work-delivery", deliverable: {
      documentActions: [{ operation: "replace", targetText: original, content: corrected }],
    } } });
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(checkpoint().delegationDelivery).toMatchObject({ drafts: [repaired], repairUsed: true });
  });
  it("does not grant another repair to an invalid embedded placement-repair delivery", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify({ ...wrongAssessment, ...noneDelivery }))
      .mockResolvedValueOnce(JSON.stringify({ ...rightAssessment, ...noneDelivery }));
    expect(await (await send()).json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("repairs a natural sentence-polishing request incorrectly delivered as conversation-only", async () => {
    const naturalRequest = "帮我把当前这句话润色得通顺一点，顺便修正错别字。保留‘可能’和‘尚未验证’，不要增加观点或数据。";
    const naturalAssessment = { ...wrongAssessment, requirementAnchor: { source: "document", quote: original },
      proposedScope: "局部润色与纠错，保持原意", intendedUse: "提供可读版本" };
    mocks.model.mockResolvedValueOnce(JSON.stringify({ ...naturalAssessment, ...noneDelivery }))
      .mockResolvedValueOnce(JSON.stringify({ ...naturalAssessment, documentPlacement: "document", ...delivery }))
      .mockResolvedValueOnce(JSON.stringify(review));
    expect(await (await send({ message: naturalRequest })).json()).toMatchObject({ result: { kind: "work-delivery", deliverable: {
      documentActions: [{ operation: "replace", targetText: original, content: corrected }],
    } } });
    expect(mocks.model).toHaveBeenCalledTimes(3);
  });
  it("repairs a combined delivery with changed facts before returning executable operations", async () => {
    const invalid = { ...delivery, deliverable: { ...delivery.deliverable, content: corrected + "共99人。" } };
    mocks.model.mockResolvedValueOnce(JSON.stringify({ ...rightAssessment, ...invalid }))
      .mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(checkpoint().delegationDelivery).toMatchObject({ repairUsed: true });
  });
  it("repairs the actual accepted none contradiction and delivers a reviewable replacement", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify(wrongAssessment)).mockResolvedValueOnce(JSON.stringify(rightAssessment))
      .mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "work-delivery", deliverable: { documentActions: [{ operation: "replace", targetText: original }] } } });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(mocks.model.mock.calls[1][0].at(-1).content).toContain("documentPlacement 应为 document");
    expect(mocks.model.mock.calls[0][1]).not.toHaveProperty("lightweightScreening");
    expect(mocks.model.mock.calls[1][1]).toMatchObject({ lightweightScreening: true });
    expect(mocks.model.mock.calls[2][1]).not.toHaveProperty("lightweightScreening");
    expect(checkpoint()).toMatchObject({ delegationAssessment: rightAssessment, delegationAssessmentRepairUsed: true,
      delegationPlacementRepair: { version: 1, pending: false, raw: JSON.stringify(rightAssessment) }, delegationDelivery: { repairUsed: true } });
  });
  it("repairs a none-only delivery after approval without inventing an append action", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify(rightAssessment)).mockResolvedValueOnce(JSON.stringify(noneDelivery))
      .mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    const response = await send();
    expect(response.status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("必须包含可靠文档修改操作");
    expect(checkpoint().delegationDelivery).toMatchObject({ repairUsed: true, drafts: [JSON.stringify(noneDelivery), JSON.stringify(delivery)] });
  });
  it("does not give delivery another repair after fixing the accepted placement", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify(wrongAssessment)).mockResolvedValueOnce(JSON.stringify(rightAssessment))
      .mockResolvedValueOnce(JSON.stringify(noneDelivery));
    const response = await send();
    expect(await response.json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("counts prior assessment structure repair against the same placement allowance", async () => {
    mocks.model.mockResolvedValueOnce("not JSON").mockResolvedValueOnce(JSON.stringify(wrongAssessment));
    expect(await (await send()).json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(checkpoint().delegationAssessmentRepairUsed).toBe(true);
  });
  it("resumes a placement repair with no returned bytes without repeating its paid assessment", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify(wrongAssessment)).mockRejectedValueOnce(new Error("repair provider timeout"));
    expect((await send()).status).toBe(503);
    const saved = checkpoint();
    expect(saved).toMatchObject({ delegationAssessment: wrongAssessment, delegationAssessmentRepairUsed: true,
      delegationPlacementRepair: { version: 1, pending: true } });
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-placement", history: [], preparedResponse: saved });
    mocks.model.mockResolvedValueOnce(JSON.stringify(rightAssessment)).mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("本轮唯一修复机会");
  });
  it("does not regenerate a paid but still inconsistent placement repair on same-ID recovery", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify(wrongAssessment)).mockResolvedValueOnce(JSON.stringify(wrongAssessment));
    expect(await (await send()).json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    const saved = checkpoint();
    expect(saved.delegationPlacementRepair).toMatchObject({ pending: false, raw: JSON.stringify(wrongAssessment) });
    mocks.claim.mockResolvedValue({ kind: "run", token: "exhausted-placement", history: [], preparedResponse: saved });
    expect(await (await send()).json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("keeps an explicit conversation-only typo correction as none without another model call", async () => {
    mocks.model.mockResolvedValueOnce(JSON.stringify(wrongAssessment)).mockResolvedValueOnce(JSON.stringify(noneDelivery)).mockResolvedValueOnce(JSON.stringify(review));
    const response = await send({ message: request + "只在对话中给我修正版本，不要入文。" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "work-delivery", deliverable: { documentActions: [{ operation: "none" }] } } });
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(checkpoint()).not.toHaveProperty("delegationPlacementRepair");
  });
  it("persists initial structure repair before a network failure and resumes only that phase", async () => {
    mocks.model.mockResolvedValueOnce("bad assessment JSON").mockRejectedValueOnce(new Error("assessment repair timeout"));
    expect((await send()).status).toBe(503);
    const saved = checkpoint();
    expect(saved).toMatchObject({ delegationAssessmentRepairUsed: true,
      delegationAssessmentGeneration: { drafts: ["bad assessment JSON"], repairUsed: true, pendingRepair: true } });
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-assessment-structure", history: [], preparedResponse: saved });
    mocks.model.mockResolvedValueOnce(JSON.stringify(rightAssessment)).mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("结构或引用校验");
    expect(mocks.model.mock.calls[2][0].at(-2)).toEqual({ role: "assistant", content: "bad assessment JSON" });
    expect(checkpoint().delegationDelivery.repairUsed).toBe(true);
  });
  it("retains exhausted initial assessment bytes and never grants another structure repair", async () => {
    mocks.model.mockResolvedValueOnce("bad first JSON").mockResolvedValueOnce("bad repair JSON");
    expect(await (await send()).json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    mocks.claim.mockResolvedValue({ kind: "run", token: "exhausted-assessment", history: [], preparedResponse: checkpoint() });
    expect(await (await send()).json()).toMatchObject({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(2);
  });
  it("repairs historical request citations before executing the current editing task", async () => {
    const previousRequest = "帮我看看文档还有什么地方可以修改";
    const invalid = JSON.stringify({ ...rightAssessment,
      requirementAnchor: { source: "request", quote: previousRequest },
      materialQuotes: [original, previousRequest],
    });
    mocks.model.mockResolvedValueOnce(invalid).mockResolvedValueOnce(JSON.stringify(rightAssessment))
      .mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "work-delivery" } });
    const repairMessages = mocks.model.mock.calls[1][0];
    expect(repairMessages.at(-2)).toEqual({ role: "assistant", content: invalid });
    expect(repairMessages.at(-1).content).toContain("source=request 不得引用历史消息");
    expect(repairMessages.at(-1).content).toContain("不得混入历史消息");
    expect(mocks.model.mock.calls[0][1]).not.toHaveProperty("lightweightScreening");
    expect(mocks.model.mock.calls[1][1]).not.toHaveProperty("lightweightScreening");
    expect(mocks.model.mock.calls[2][1]).not.toHaveProperty("lightweightScreening");
    for (const [, options] of mocks.model.mock.calls) expect(options).not.toHaveProperty("maxOutputTokens");
    expect(checkpoint()).toMatchObject({ delegationAssessment: rightAssessment, delegationAssessmentRepairUsed: true });
  });
  it.each([false, true])("checkpoints paid assessment bytes before an audit failure, repaired=%s", async repaired => {
    const paid = JSON.stringify(rightAssessment);
    let failed = false;
    mocks.audit.mockImplementation(async (events: AiInteractionEvent[]) => {
      if (!failed && events.some(event => event.payload?.modelStep === "delegation-assessment" && event.content === paid)) {
        expect(checkpoint().delegationAssessmentGeneration.drafts.at(-1)).toBe(paid);
        failed = true; throw new Error("database and outbox audit unavailable");
      }
    });
    if (repaired) mocks.model.mockResolvedValueOnce("bad assessment JSON");
    mocks.model.mockResolvedValueOnce(paid);
    expect((await send()).status).toBe(503);
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-paid-assessment", history: [], preparedResponse: checkpoint() });
    mocks.model.mockResolvedValueOnce(JSON.stringify(delivery)).mockResolvedValueOnce(JSON.stringify(review));
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(repaired ? 4 : 3);
  });
  it.each([false, true])("reuses paid delivery review after audit failure, structure repair=%s", async repaired => {
    const paid = JSON.stringify(review);
    let failed = false;
    mocks.audit.mockImplementation(async (events: AiInteractionEvent[]) => {
      if (!failed && events.some(event => String(event.payload?.modelStep).startsWith("delegation-review-") && event.content === paid)) {
        expect(checkpoint().delegationReviewOutputs.at(-1)).toMatchObject({ repairStructure: repaired, raw: paid });
        failed = true; throw new Error("database and outbox audit unavailable");
      }
    });
    mocks.model.mockResolvedValueOnce(JSON.stringify(rightAssessment)).mockResolvedValueOnce(JSON.stringify(delivery));
    if (repaired) mocks.model.mockResolvedValueOnce("bad review JSON");
    mocks.model.mockResolvedValueOnce(paid);
    expect((await send()).status).toBe(503);
    const saved = checkpoint();
    if (repaired) expect(saved.delegationDelivery).toMatchObject({ repairUsed: true, pendingRepair: { kind: "review" } });
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-paid-review", history: [], preparedResponse: saved });
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(repaired ? 4 : 3);
  });
  it("retains paid repaired delivery review when audit crosses the original deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const paid = JSON.stringify(review);
    mocks.audit.mockImplementation(async (events: AiInteractionEvent[]) => {
      if (!deadline.signal.aborted && events.some(event => String(event.payload?.modelStep).startsWith("delegation-review-") && event.content === paid)) {
        expect(checkpoint().delegationReviewOutputs.at(-1).raw).toBe(paid);
        deadline.abort(new DOMException("audit crossed deadline", "TimeoutError"));
      }
    });
    mocks.model.mockResolvedValueOnce(JSON.stringify(rightAssessment)).mockResolvedValueOnce(JSON.stringify(delivery))
      .mockResolvedValueOnce("bad review JSON").mockResolvedValueOnce(paid);
    expect(await (await send()).json()).toMatchObject({ error: "AI_COLLABORATION_TIMEOUT" });
    mocks.claim.mockResolvedValue({ kind: "run", token: "resume-deadline-delivery", history: [], preparedResponse: checkpoint() });
    expect((await send()).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(4);
  });
  it("clarifies a missing current-document target rather than manufacturing a replacement", async () => {
    const missing = { ...wrongAssessment, materialQuotes: ["浪废水"] };
    const clarification = { decision: "clarify", reasonCode: "missing_material", reason: "当前文稿没有待修正原段落。",
      studentMessage: "请提供包含这个错别字的原段落，我会只修正错别字并交给你审阅。" };
    mocks.model.mockResolvedValueOnce(JSON.stringify(missing)).mockResolvedValueOnce(JSON.stringify(clarification))
      .mockResolvedValueOnce(passingDiscussionReview);
    const response = await send({ documentHtml: "<p>暂无原段落。</p>" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "task-clarification", delegation: { decision: "clarify", reasonCode: "missing_material" } } });
    expect(mocks.model).toHaveBeenCalledTimes(3);
    expect(checkpoint()).toMatchObject({ delegationAssessmentRepairUsed: true,
      delegationPlacementRepair: { pending: false, raw: JSON.stringify(clarification) } });
    expect(checkpoint()).not.toHaveProperty("delegationDelivery");
  });
});


describe("discussion source-meaning fidelity backstop", () => {
  const source = "A点流量1.2升/分钟；B点流量未记录。访谈共8人，5人支持，2人不支持，1人未回答。尚未验证。附录原始记录只有观察记录。";
  const send = (patch: Record<string, unknown> = {}) => POST(new NextRequest("http://localhost/api/ai-collaboration/document", { method: "POST",
    body: JSON.stringify({ ...body, intent: "discuss", message: "根据已有记录讨论问题，不要重写。", documentHtml: `<p>${source}</p>`, ...patch }) }));
  const draft = (message: string) => JSON.stringify({ kind: "discussion", message, focus: "核对记录", suggestion: null });
  const checkpoint = () => mocks.prepare.mock.calls.at(-1)![0].response;
  beforeEach(() => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "meaning-fidelity", history: [] });
    mocks.complete.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  it.each([
    ["访谈记录中2人反对。", "原记录中2人不支持，请保持原类别。"],
    ["整个研究只有一半证据。", "B点流量未记录，流量比较所需材料不完整。"],
    ["可以整理你已有的8人访谈原始记录。", "可以整理现有访谈汇总；逐人原始记录需你提供。"],
    ["还没设计怎样验证效果。", "当前文稿未展示验证计划。"],
    ["不支持表示受访者明确表达了反对意见。", "不支持并不等于明确反对，应保留原始分类。"],
    ["把未回答并入不支持，会凭空多出一个反对者。", "把未回答并入不支持会增加不支持类别的人数，应单列未回答。"],
    ["把结论改为8人中5人支持、2人不支持、1人未回答，并限定证据只来自这两个点和这次观察。", "观察记录只来自所列点位和观察；访谈的时地范围需另行核对。"],
  ])("uses the existing single repair even when model review approves a source change: %s", async (bad, good) => {
    mocks.model.mockResolvedValueOnce(draft(bad)).mockResolvedValueOnce(passingDiscussionReview)
      .mockResolvedValueOnce(draft(good)).mockResolvedValueOnce(passingDiscussionReview);
    expect(await (await send()).json()).toMatchObject({ result: { message: good } });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(checkpoint().discussionReview).toMatchObject({ repairUsed: true, pendingRepair: null });
  });
  it("does not expose or generate a third answer after an unchanged meaning error exhausts repair", async () => {
    const bad = draft("2人反对。");
    mocks.model.mockResolvedValueOnce(bad).mockResolvedValueOnce(passingDiscussionReview)
      .mockResolvedValueOnce(bad).mockResolvedValueOnce(passingDiscussionReview);
    expect(await (await send()).json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    mocks.claim.mockResolvedValue({ kind: "run", token: "meaning-retry", history: [], preparedResponse: checkpoint() });
    expect(await (await send()).json()).toMatchObject({ error: "AI_DISCUSSION_REVIEW_FAILED", retryable: false });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("checks final displayed blocks and nextStep without accepting a correct hidden message", async () => {
    const good = "记录是2人不支持。";
    mocks.normalizeSupport.mockImplementation((support: { replyBlocks?: unknown[]; nextStep?: string } = {}) => ({
      details: support, memoryCandidates: [],
    }));
    mocks.model.mockResolvedValueOnce(JSON.stringify({ kind: "discussion", message: good,
      support: { replyBlocks: [{ type: "answer", content: "记录是2人反对。", sourceIds: [] }], nextStep: "整理已有8人访谈原始记录。" } }))
      .mockResolvedValueOnce(passingDiscussionReview).mockResolvedValueOnce(draft(good)).mockResolvedValueOnce(passingDiscussionReview);
    expect(await (await send()).json()).toMatchObject({ result: { message: good } });
    const repair = mocks.model.mock.calls[2][0].at(-1).content;
    expect(repair).toContain("不支持"); expect(repair).toContain("原始或逐份记录");
  });
  it("repairs a nonaccepted delegation explanation while keeping its protected decision locked", async () => {
    const assessment = { decision: "protected", reasonCode: "core_learning", reason: "不能虚构记录。",
      studentMessage: "不能补写访谈，但可以整理你已有的8人访谈原始记录。", protectedLearningWork: "真实调查", studentResponsibility: "亲自访谈" };
    const good = "真实访谈需要你完成。我可以整理已提供的汇总，或在你提供逐人原始记录后整理。";
    mocks.model.mockResolvedValueOnce(JSON.stringify(assessment)).mockResolvedValueOnce(passingDiscussionReview)
      .mockResolvedValueOnce(JSON.stringify({ kind: "boundary", message: good, suggestion: null })).mockResolvedValueOnce(passingDiscussionReview);
    expect(await (await send({ intent: "delegate", message: "帮我补十份访谈记录，让数据完整。" })).json())
      .toMatchObject({ result: { kind: "boundary", message: good, delegation: { decision: "protected" } } });
    expect(mocks.model).toHaveBeenCalledTimes(4);
  });
  it.each(["user", "assistant"] as const)("accepts student-supplied additions but not earlier AI assertions: %s", async role => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "meaning-history", history: [{ role, content: "补充：复核后2人明确反对。" }] });
    mocks.model.mockResolvedValueOnce(draft("2人反对。")).mockResolvedValueOnce(passingDiscussionReview);
    if (role === "assistant") mocks.model.mockResolvedValueOnce(draft("文稿中的原分类是2人不支持。")).mockResolvedValueOnce(passingDiscussionReview);
    expect((await send({ message: "按刚才记录讨论。" })).status).toBe(200);
    expect(mocks.model).toHaveBeenCalledTimes(role === "user" ? 2 : 4);
  });
  it("repairs a collateral conclusion after refusing topic selection without changing its boundary", async () => {
    const bad = '研究问题由你定；结论草稿按原记录只能表述为“访谈样本中多数支持”。';
    const good = "研究问题由你定。先核对它对应的观察对象和所需记录；5人支持并非全部8人，结论原句的范围还需核对。";
    mocks.model.mockResolvedValueOnce(JSON.stringify({ kind: "boundary", message: bad, suggestion: null }))
      .mockResolvedValueOnce(passingDiscussionReview)
      .mockResolvedValueOnce(JSON.stringify({ kind: "boundary", message: good, suggestion: null }))
      .mockResolvedValueOnce(passingDiscussionReview);
    expect(await (await send({ intent: "delegate", message: "替我确定本项目的研究问题。" })).json())
      .toMatchObject({ result: { kind: "boundary", message: good } });
    expect(mocks.model).toHaveBeenCalledTimes(4);
    expect(mocks.model.mock.calls[2][0].at(-1).content).toContain("可复制的替换结论句");
    expect(checkpoint().discussionReview.repairUsed).toBe(true);
  });
  it("keeps existing-work arithmetic feedback outside the core refusal guard", async () => {
    const good = "8人中5人支持，5超过8的一半，属于样本中的多数；这不能直接推广到未访谈者。";
    mocks.model.mockResolvedValueOnce(draft(good)).mockResolvedValueOnce(passingDiscussionReview);
    expect(await (await send({ message: "请检查已有表述与人数是否一致。" })).json()).toMatchObject({ result: { message: good } });
    expect(mocks.model).toHaveBeenCalledTimes(2);
  });
  it("retains ordinary concept clarification with no extra calls", async () => {
    const good = "不支持不等于明确反对；未记录实施不等于没有实施。";
    mocks.model.mockResolvedValueOnce(draft(good)).mockResolvedValueOnce(passingDiscussionReview);
    expect(await (await send({ message: "只解释概念：未回答和不支持有什么区别？" })).json()).toMatchObject({ result: { message: good } });
    expect(mocks.model).toHaveBeenCalledTimes(2);
  });
});
