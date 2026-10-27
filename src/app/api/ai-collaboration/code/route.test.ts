import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_EXECUTION_TIMEOUT_MS, COLLABORATION_REQUEST_LEASE_MS } from "@/lib/ai-collaboration/request-budget";
const mocks = vi.hoisted(() => ({
  llm: vi.fn(), background: vi.fn(), append: vi.fn(), claim: vi.fn(), complete: vi.fn(), prepare: vi.fn(), receipt: vi.fn(),
  tasks: new Map<string, Record<string, unknown>>(), auth: vi.fn(), context: vi.fn(), course: vi.fn(), thread: vi.fn(), pair: vi.fn(), memories: vi.fn(),
  enqueue: vi.fn(), alias: vi.fn(), assertScope: vi.fn(), findAlias: vi.fn(), resume: vi.fn(),
}));
vi.mock('@/lib/ai-collaboration/document-review-queue', async original => ({
  ...await original<typeof import('@/lib/ai-collaboration/document-review-queue')>(),
  enqueueCodeReview: mocks.enqueue, assertDocumentReviewScope: mocks.assertScope, resumeDocumentReview: mocks.resume,
}));
vi.mock('@/lib/ai-collaboration/code-background-alias', async original => ({
  ...await original<typeof import('@/lib/ai-collaboration/code-background-alias')>(), readCodeBackgroundAlias: mocks.alias, findCodeBackgroundAlias: mocks.findAlias,
}));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ authenticateLegacyAiStudent: mocks.auth }));
vi.mock("@/lib/ai-collaboration/code-read-context", () => ({ getCodeReadContext: mocks.context }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.course }));
vi.mock("@/lib/companion/server-store", () => ({ getCompanionThread: mocks.thread, getCompanionThreadPair: mocks.pair, appendCompanionMessages: mocks.append,
  softDeleteCompanionMessage: vi.fn(), companionMessage: (message: object) => ({ ...message, id: crypto.randomUUID(), createdAt: new Date().toISOString() }) }));
vi.mock("@/lib/ai-collaboration/code-policy", () => ({
  buildCodeCollaborationPrompts: (input: { artifact: unknown }) => ({ system: "same policy", user: JSON.stringify(input.artifact) }),
  buildCodeTaskStarterPrompts: (input: { artifact: unknown }) => ({ system: "starter policy", user: JSON.stringify(input.artifact) }),
  detectProtectedCodeWorkRequest: () => undefined, isCodeCollaborationIntent: () => true,
  normalizeCodeCollaborationResponse: ({ raw }: { raw: unknown }) => raw,
  normalizeCodeTaskStarters: (raw: { starters: string[] }) => raw.starters,
}));
vi.mock("@/lib/llm/client", () => ({ callLLM: mocks.llm, parseLLMJson: JSON.parse }));
vi.mock("@/lib/llm/settings", () => ({ getActiveAiSettings: async () => ({ model: "model", endpoint: "provider" }) }));
vi.mock("@/lib/observability/classroom-ai", () => ({ recordAiCacheEvent: vi.fn(), withClassroomAiUsage: (_scope: unknown, operation: () => unknown) => operation() }));
vi.mock("@/lib/ai-collaboration/proactive-review-capacity", async original => ({
  ...await original<typeof import("@/lib/ai-collaboration/proactive-review-capacity")>(),
  withProactiveReviewCapacity: mocks.background,
}));
vi.mock("@/lib/ai-collaboration/project-support-types", () => ({ normalizeProjectSupportOutput: () => ({ details: {}, memoryCandidates: [] }) }));
vi.mock("@/lib/ai-collaboration/project-support-server", () => ({
  resolveProjectSupportContext: async () => ({ promptContext: "support", sources: [], knowledgePointLabels: [] }),
  listProjectMemories: mocks.memories, projectMemoryContinuation: () => null, dismissProjectMemories: vi.fn(), saveProjectMemoryCandidates: vi.fn(),
}));
vi.mock("@/lib/ai-collaboration/document-request-store", () => ({
  claimDocumentRequest: mocks.claim, completeDocumentRequest: mocks.complete, prepareDocumentRequestResponse: mocks.prepare,
  failDocumentRequest: vi.fn(), readDocumentRequestReceipt: mocks.receipt,
}));
import { GET, POST } from "./route";
import { executeQueuedCodeReview } from '@/lib/ai-collaboration/code-handlers';
import type { CodeReviewSnapshot } from '@/lib/ai-collaboration/document-review-queue';
import { BackgroundAiCapacityError } from '@/lib/llm/classroom-capacity';
async function executeEnqueued(signal = new AbortController().signal, persisted = (snapshot: CodeReviewSnapshot) => snapshot) {
  const input = mocks.enqueue.mock.calls.at(-1)![0];
  const snapshot = { ...input, version: 2, kind: 'code-background',
    fingerprintSource: JSON.stringify({ prompts: input.prompts, action: input.body.action, intent: input.body.intent,
      language: input.body.language, context: input.context }), guard: { identity: { sessionVersion: 1 } } } as CodeReviewSnapshot;
  return executeQueuedCodeReview({ id: 'queued', token: 'lease', attemptCount: 1, snapshot: persisted(snapshot) }, signal);
}
const artifact = { version: 1, language: "python", activeFileId: "main", files: [{ id: "main", path: "main.py", content: "print(1)" }] };
const input = { courseId: "course", studentId: "student", stageKey: "make", language: "python", requestId: "request", conversationId: "legacy", intent: "discuss", message: "explain", artifact };
const request = (body: object) => new NextRequest("http://localhost/api/ai-collaboration/code", { method: "POST", body: JSON.stringify(body) });
describe("code AI route receipts", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks(); mocks.tasks.clear();
    mocks.auth.mockResolvedValue({ studentId: "student", participationId: "participation", claims: { sub: 'student', role: 'student', sv: 1 } });
    mocks.alias.mockResolvedValue(null); mocks.findAlias.mockResolvedValue(null); mocks.assertScope.mockResolvedValue(undefined);
    mocks.enqueue.mockImplementation(async ({ task }) => ({ kind: 'queued', state: { requestId: task.requestId,
      status: mocks.tasks.has(task.requestId) ? 'completed' : 'processing', response: mocks.tasks.get(task.requestId), retryable: false } }));
    mocks.context.mockResolvedValue({ student: { id: "student" }, currentStageKey: "make" });
    mocks.course.mockResolvedValue({ id: "course", name: "project", students: [{ id: "student", name: "Student" }], stages: [{ key: "make" }], currentStageIndex: 0, content: {} });
    mocks.thread.mockResolvedValue({ messages: [] }); mocks.memories.mockResolvedValue([]);
    mocks.pair.mockResolvedValue([undefined, undefined]);
    mocks.llm.mockResolvedValue(JSON.stringify({ kind: "discussion", message: "answer", findings: [], starters: ["check"] }));
    mocks.background.mockImplementation((operation: () => unknown) => operation());
    mocks.claim.mockImplementation(async (task: { requestId: string; history: unknown }) => mocks.tasks.has(task.requestId)
      ? { kind: "existing", state: { status: "completed" } } : { kind: "run", token: "lease", history: task.history });
    mocks.prepare.mockResolvedValue(true);
    mocks.complete.mockImplementation(async (task: { requestId: string; response: Record<string, unknown> }) => { mocks.tasks.set(task.requestId, task.response); return true; });
    mocks.receipt.mockImplementation(async (task: { requestId: string }) => ({ status: 200, body: mocks.tasks.get(task.requestId) }));
  });
  it.each(['reset-conversation', 'read-code-comment', 'resolve-code-comment', 'interactive'])('rejects a bound alias changed into %s before any side effect', async action => {
    mocks.alias.mockResolvedValue(Response.json({ error: 'REQUEST_ID_CONFLICT' }, { status: 409 }));
    const response = await POST(request({ ...input, ...(action === 'interactive' ? {} : { action }), commentThreadId: 'comment' }));
    expect(response.status).toBe(409); expect(mocks.thread).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled(); expect(mocks.llm).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it.each(['code-task-starters', 'proactive-review'])('preserves shared capacity errors for worker retry accounting: %s', async operation => {
    const payload = operation === 'code-task-starters' ? { ...input, action: operation } : { ...input, intent: operation };
    expect((await POST(request(payload))).status).toBe(202);
    const local = new BackgroundAiCapacityError(10_000);
    vi.resetModules();
    const foreign = await vi.importActual<typeof import('@/lib/llm/classroom-capacity')>('@/lib/llm/classroom-capacity');
    for (const error of [local, new foreign.BackgroundAiCapacityError(12_000)]) {
      mocks.llm.mockRejectedValueOnce(error);
      await expect(executeEnqueued()).rejects.toBe(error);
    }
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('returns a live enqueue scope failure without starting the model', async () => {
    const { DocumentReviewScopeChanged } = await import('@/lib/ai-collaboration/document-review-queue');
    mocks.enqueue.mockRejectedValueOnce(new DocumentReviewScopeChanged('REVIEW_IDENTITY_CHANGED'));
    expect((await POST(request({ ...input, action: 'code-task-starters' }))).status).toBe(409);
    expect(mocks.llm).not.toHaveBeenCalled();
  });
  it('resumes only the owned alias with a distinct immutable command identity', async () => {
    mocks.findAlias.mockResolvedValue({ state: { requestId: 'canonical', conversationId: 'original-conversation' } });
    mocks.resume.mockResolvedValue({ kind: 'queued', state: { requestId: 'canonical', status: 'processing' } });
    const body = { ...input, requestId: 'new-command', action: 'retry-code-background', targetRequestId: 'original-client' };
    const response = await POST(request(body));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ requestId: 'original-client', canonicalRequestId: 'canonical', status: 'processing' });
    expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'canonical', conversationId: 'original-conversation' }),
      { requestId: 'new-command', body });
    expect(mocks.llm).not.toHaveBeenCalled(); expect(mocks.append).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'target'])('rejects a retry without a separate explicit persistent command ID: %s', async requestId => {
    const command = { ...input, action: 'retry-code-background', requestId, targetRequestId: 'target' };
    expect((await POST(request(command))).status).toBe(400);
    expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.findAlias).not.toHaveBeenCalled(); expect(mocks.append).not.toHaveBeenCalled();
  });
  it("GET keeps full conversation reset/visibility windows and comment history without assembling Course", async () => {
    const base = { role: "student", visibility: "student-and-teacher", createdAt: "2026-10-16T00:00:00Z" };
    const messages = Array.from({ length: 45 }, (_, i) => ({ ...base, id: `message-${i}`, content: `body-${i}`, conversationId: "new" }));
    const meta = { id: "comment", filePath: "main.py", title: "Review", quotedCode: "print(1)", startLine: 1, endLine: 1, createdAt: base.createdAt };
    mocks.pair.mockResolvedValueOnce([{ messages: [
      { ...base, id: "old", content: "old", conversationId: "legacy" },
      { ...base, role: "system-trigger", id: "reset", triggerKind: "conversation-reset", conversationId: "new", content: "" },
      ...messages, { ...base, id: "hidden", content: "hidden", conversationId: "new", hiddenFromStudentAt: base.createdAt },
    ] }, { messages: [
      { ...base, role: "system-trigger", id: "meta", content: `OPENPBL_CODE_COMMENT_META:${JSON.stringify(meta)}` },
      { ...base, role: "agent", id: "answer", conversationId: "comment", content: "Original comment" },
      { ...base, role: "system-trigger", id: "read", content: `OPENPBL_CODE_COMMENT_READ:${JSON.stringify({ id: "comment", at: base.createdAt })}` },
    ] }]);
    const memories = [{ id: "memory", content: "Retained memory", evidence: ["original"] }]; mocks.memories.mockResolvedValue(memories);
    const response = await GET(new NextRequest("http://localhost/api/ai-collaboration/code?courseId=course&studentId=student&stageKey=make&language=python"));
    expect(await response.json()).toEqual({ conversationId: "new", messages: messages.slice(-40), memories, continuation: null,
      commentThreads: [{ ...meta, severity: "notice", readAt: base.createdAt, comments: [{ id: "answer", role: "assistant", content: "Original comment", createdAt: base.createdAt }] }] });
    expect(mocks.course).not.toHaveBeenCalled();
    expect(mocks.pair.mock.calls).toEqual([["course", "student", ["ai-code-collaboration:make:python", "ai-code-comments:make:python"]]]);
    expect(mocks.thread).not.toHaveBeenCalled();
    expect(mocks.memories).toHaveBeenCalledWith("participation");
  });
  it.each([
    [undefined, 404, "COURSE_NOT_FOUND"],
    [{ currentStageKey: "make" }, 403, "STUDENT_NOT_IN_COURSE"],
    [{ student: { id: "student" }, currentStageKey: "proposal" }, 409, "STAGE_CHANGED"],
  ])("GET keeps missing/stale scope response %s", async (context, status, error) => {
    mocks.context.mockResolvedValueOnce(context);
    const response = await GET(new NextRequest("http://localhost/api/ai-collaboration/code?courseId=course&stageKey=make&language=c"));
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error });
    expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.pair).not.toHaveBeenCalled(); expect(mocks.memories).not.toHaveBeenCalled();
  });
  it('GET empty history uses the authenticated student and server-derived keys, not a requested conversation ID', async () => {
    const response = await GET(new NextRequest('http://localhost/api/ai-collaboration/code?courseId=course&stageKey=make&language=c&conversationId=untrusted'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ conversationId: 'legacy', messages: [], commentThreads: [], memories: [] });
    expect(mocks.pair).toHaveBeenCalledExactlyOnceWith('course', 'student', ['ai-code-collaboration:make:c', 'ai-code-comments:make:c']);
    expect(mocks.thread).not.toHaveBeenCalled();
  });
  it("GET stops at live authentication failure before any context, receipt or history read", async () => {
    mocks.auth.mockResolvedValueOnce(Response.json({ error: "UNAUTHENTICATED" }, { status: 401 }));
    expect((await GET(new NextRequest("http://localhost/api/ai-collaboration/code?courseId=course&stageKey=make&language=c&requestId=receipt"))).status).toBe(401);
    expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.receipt).not.toHaveBeenCalled(); expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.pair).not.toHaveBeenCalled();
  });
  it("replays chat and GET receipts with one model call and one atomic history commit", async () => {
    const first = await (await POST(request(input))).json();
    const replay = await (await POST(request(input))).json();
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "completed", requestId: "request", result: { message: "answer" } });
    expect(mocks.llm).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.complete.mock.calls[0][0].messages).toHaveLength(2);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.course).toHaveBeenCalled();
    const receipt = await GET(new NextRequest("http://localhost/api/ai-collaboration/code?courseId=course&studentId=student&stageKey=make&language=python&requestId=request"));
    expect(await receipt.json()).toEqual(first);
    expect(mocks.pair).not.toHaveBeenCalled();
    expect(receipt.headers.get("Server-Timing")).toContain("code-auth;dur=");
    expect(receipt.headers.get("Server-Timing")).toContain("code-context;dur=");
    expect(receipt.headers.get("Server-Timing")).toContain("handler;dur=");
  });
  it("reuses no-finding background reviews and runs them with background priority", async () => {
    const body = { ...input, intent: "proactive-review", message: "" };
    expect((await POST(request(body))).status).toBe(202); expect(mocks.llm).not.toHaveBeenCalled();
    const first = await (await executeEnqueued()).json();
    expect(first.commentThreads).toEqual([]);
    expect(await (await POST(request({ ...body, requestId: "another-tab" }))).json()).toMatchObject({ ...first, requestId: 'another-tab', canonicalRequestId: first.requestId });
    expect(mocks.llm).toHaveBeenCalledOnce();
    expect(mocks.claim).not.toHaveBeenCalled();
    await POST(request({ ...body, artifact: { ...artifact, files: [{ ...artifact.files[0], content: "print(2)" }] } }));
    await executeEnqueued();
    expect(mocks.llm).toHaveBeenCalledTimes(2);
  });
  it("reuses task suggestions across new client request IDs", async () => {
    const body = { ...input, action: "code-task-starters", mode: "discuss" };
    expect((await POST(request(body))).status).toBe(202); expect(mocks.llm).not.toHaveBeenCalled();
    const first = await (await executeEnqueued()).json();
    expect(first.starters).toEqual(["check"]);
    expect(await (await POST(request({ ...body, requestId: "another-tab" }))).json()).toMatchObject({ ...first, requestId: 'another-tab', canonicalRequestId: first.requestId });
    expect(mocks.llm).toHaveBeenCalledOnce();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("returns a bounded retry hint when shared durable admission is full", async () => {
    mocks.enqueue.mockResolvedValueOnce({ kind: 'full' });
    const response = await POST(request({ ...input, action: "code-task-starters", mode: "discuss" }));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(await response.json()).toMatchObject({ error: 'AI_PROACTIVE_REVIEW_BUSY', requestId: input.requestId });
    expect(mocks.llm).not.toHaveBeenCalled();
  });
  it.each(['code-task-starters', 'proactive-review'])('executes the original canonical task after JSONB prompt-key reordering: %s', async operation => {
    const body = operation === 'code-task-starters' ? { ...input, action: operation } : { ...input, intent: operation };
    expect((await POST(request(body))).status).toBe(202);
    const original = mocks.enqueue.mock.calls.at(-1)![0];
    const response = await executeEnqueued(undefined, snapshot => {
      const stored = JSON.parse(JSON.stringify(snapshot)) as CodeReviewSnapshot;
      stored.prompts = { user: stored.prompts.user, system: stored.prompts.system };
      stored.context = Object.fromEntries(Object.entries(stored.context).reverse());
      expect(JSON.stringify(stored.prompts)).not.toBe(JSON.stringify(snapshot.prompts));
      return stored;
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'completed', requestId: original.task.requestId });
    expect(mocks.llm).toHaveBeenCalledOnce();
    expect(mocks.llm.mock.calls[0][0]).toEqual([{ role: 'system', content: original.prompts.system }, { role: 'user', content: original.prompts.user }]);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ requestId: original.task.requestId, token: 'lease' }));
    expect(mocks.assertScope).toHaveBeenCalled();
  });
  it.each(['system', 'user', 'context'] as const)('rejects actual immutable %s changes before invoking a model', async field => {
    await POST(request({ ...input, action: 'code-task-starters' }));
    await expect(executeEnqueued(undefined, snapshot => {
      const stored = structuredClone(snapshot);
      if (field === 'context') stored.context.mode = 'task';
      else stored.prompts[field] += '-changed';
      return stored;
    })).rejects.toMatchObject({ code: 'REVIEW_INPUT_CHANGED' });
    expect(mocks.llm).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('keeps live-scope and stopped-lease fences before the actual queued executor model call', async () => {
    await POST(request({ ...input, action: 'code-task-starters' }));
    mocks.assertScope.mockRejectedValueOnce(Object.assign(new Error('REVIEW_STAGE_CHANGED'), { code: 'REVIEW_STAGE_CHANGED' }));
    await expect(executeEnqueued()).rejects.toMatchObject({ code: 'REVIEW_STAGE_CHANGED' });
    const stop = new AbortController(); stop.abort(new Error('REVIEW_LEASE_LOST'));
    await expect(executeEnqueued(stop.signal)).rejects.toThrow('REVIEW_LEASE_LOST');
    expect(mocks.llm).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each([
    { intent: "proactive-review", message: "" },
    { action: "code-task-starters", mode: "discuss" },
  ])("runs background $intent $action on its worker budget after the caller leaves", async action => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const caller = new AbortController();
    await POST(new NextRequest("http://localhost/api/ai-collaboration/code", {
      method: "POST", body: JSON.stringify({ ...input, ...action }), signal: caller.signal,
    }));
    expect(mocks.llm).not.toHaveBeenCalled();
    caller.abort(new Error('page closed'));
    await executeEnqueued();
    expect(timeout).toHaveBeenCalledWith(COLLABORATION_EXECUTION_TIMEOUT_MS);
    expect(COLLABORATION_EXECUTION_TIMEOUT_MS).toBe(110_000);
    expect(COLLABORATION_REQUEST_LEASE_MS).toBeGreaterThan(COLLABORATION_EXECUTION_TIMEOUT_MS);
    const modelSignal = mocks.llm.mock.calls[0][1].abortSignal as AbortSignal;
    expect(modelSignal.aborted).toBe(false);
    deadline.abort(new Error("worker deadline"));
    expect(modelSignal.aborted).toBe(true);
    expect(modelSignal.reason.message).toBe("worker deadline");
  });
});
