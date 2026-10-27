import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeLectureTutorThread } from "@/lib/session/types";
type Task = { id: string; status: string; input: Record<string, unknown>; output?: unknown; conversationId: string; startedAt: Date | null };
type Message = { id: string; conversationId: string; content: string; metadata?: Record<string, unknown> };
const mocks = vi.hoisted(() => {
  const tasks = new Map<string, Task>();
  const messages = new Map<string, Message>();
  const tx = {
    aiTask: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiConversation: { upsert: vi.fn() }, aiMessage: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() }, aiInteractionEvent: { create: vi.fn() },
    classroomParticipation: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
    studentProjectWorkspace: { update: vi.fn() }, classroomInstance: { update: vi.fn() }, domainEvent: { create: vi.fn() },
  };
  return { tasks, messages, tx, lock: vi.fn() };
});
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (fn: (tx: typeof mocks.tx) => unknown) => fn(mocks.tx) }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn() }));
import { claimTutorRequest, failTutorRequest, finishTutorRequest, type TutorRequest } from "./knowledge-tutor-requests";
const input: TutorRequest = { courseId: "course", classroomId: "classroom", studentId: "student", requestId: "request", threadId: "thread", attemptId: "attempt", questionId: "question", message: "为什么", initial: false };
const additions = (index = 0): KnowledgeLectureTutorThread => ({ id: "thread", attemptId: "attempt", questionId: "question", messages: [ { id: `student-${index}`, role: "student", content: "为什么", createdAt: "2026-01-01T00:00:00.000Z" }, { id: `assistant-${index}`, role: "assistant", content: `解释${index}`, createdAt: "2026-01-01T00:00:00.000Z" } ], boardNotes: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
beforeEach(() => {
  vi.resetAllMocks(); mocks.tasks.clear(); mocks.messages.clear();
  mocks.tx.aiMessage.create.mockImplementation(async ({ data }: { data: Message }) => { mocks.messages.set(data.id, data); return data; });
  mocks.tx.aiMessage.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Message> }) => {
    const message = mocks.messages.get(where.id)!; Object.assign(message, data); return message;
  });
  mocks.tx.aiMessage.findMany.mockImplementation(async ({ where }: { where: { conversationId: string; id?: { in: string[] } } }) =>
    [...mocks.messages.values()].filter(message => message.conversationId === where.conversationId && (!where.id || where.id.in.includes(message.id))));
  mocks.tx.aiTask.findUnique.mockImplementation(async ({ where }) => mocks.tasks.get(where.id) ?? null);
  mocks.tx.aiTask.findUniqueOrThrow.mockImplementation(async ({ where }) => mocks.tasks.get(where.id)!);
  mocks.tx.aiTask.create.mockImplementation(async ({ data }: { data: Task }) => { mocks.tasks.set(data.id, data); return data; });
  mocks.tx.aiTask.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Task> }) => { Object.assign(mocks.tasks.get(where.id)!, data); return mocks.tasks.get(where.id); });
  const workspace = { projectState: { aiLearningProgress: { classroomId: "classroom", studentId: "student", knowledgeLectureTutorThreads: [] } } };
  const participation = { id: "participation", enrollment: { status: "ACTIVE", offeringId: "offering", researchKey: "research" }, workspace, instance: { status: "TEACHING", runtimeConfig: { version: 1 }, activity: { chapter: { offering: { status: "OPEN" } } } } };
  mocks.tx.classroomParticipation.findFirst.mockResolvedValue(participation);
  mocks.tx.classroomParticipation.findFirstOrThrow.mockResolvedValue(participation);
  mocks.tx.studentProjectWorkspace.update.mockImplementation(async ({ data }) => { workspace.projectState = data.projectState; });
});
describe("durable knowledge tutor requests", () => {
  it("records a question before AI and replays the committed result without duplicate messages", async () => {
    const claim = await claimTutorRequest(input);
    expect(claim.run).toBe(true);
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledOnce();
    expect(await claimTutorRequest(input)).toEqual({ run: false, status: "RUNNING", thread: undefined });
    if (!claim.run) throw new Error("claim failed");
    const thread = await finishTutorRequest(input, claim.token, additions());
    expect(await claimTutorRequest(input)).toEqual({ run: false, status: "COMPLETED", thread });
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledTimes(2);
    expect(mocks.tx.aiTask.create).toHaveBeenCalledOnce();
  });
  it("retains long answers and exact model JSON without extra facts or replay overwrite", async () => {
    const claim = await claimTutorRequest(input);
    if (!claim.run) throw new Error("claim failed");
    const threadInput = additions();
    const answer = "完整回答".repeat(1_500);
    threadInput.messages[1].content = answer;
    const raw = "  " + JSON.stringify({ answer, boardNotes: [{ title: "full title", body: "完整板书".repeat(300) }] }) + "\n";
    const thread = await finishTutorRequest(input, claim.token, threadInput, raw);
    const output = [...mocks.tasks.values()][0].output;
    expect(output).toMatchObject({ modelOutput: { raw, sha256: createHash("sha256").update(raw).digest("hex") } });
    expect(mocks.tx.aiMessage.create.mock.calls[1][0].data.content).toBe(answer);
    expect(mocks.tx.aiInteractionEvent.create.mock.calls[1][0].data).toMatchObject({ content: null,
      payload: { schemaVersion: 2, detail: { contentRef: "AiMessage", messageId: expect.stringMatching(/:assistant$/) } } });
    expect(output).not.toHaveProperty("thread");
    expect(output).toMatchObject({ threadReceipt: { messages: [expect.not.objectContaining({ content: expect.any(String) }), expect.not.objectContaining({ content: expect.any(String) })] } });
    expect(await finishTutorRequest(input, claim.token, additions(), "altered response")).toEqual(thread);
    expect(await claimTutorRequest(input)).toMatchObject({ status: "COMPLETED", thread });
    expect([...mocks.tasks.values()][0].output).toEqual(output);
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledTimes(2);
    expect(mocks.tx.aiInteractionEvent.create).toHaveBeenCalledTimes(2);
  });
  it.each([
    { raw: '{"answer":"完整回答"},"boardNotes":[]}', syntaxRepair: "removed-extra-object-close-before-board-notes" as const },
    { raw: '{"answer":"完整回答"}\n{"boardNotes":[]}', syntaxRepair: "joined-complete-answer-and-board-notes-objects" as const },
    { raw: '{"answer":"完整回答"boardNotes":[]}', syntaxRepair: "inserted-missing-board-notes-key-separator" as const },
  ])("retains original malformed model output and its syntax repair diagnostic atomically: $syntaxRepair", async ({ raw, syntaxRepair }) => {
    const claim = await claimTutorRequest(input); if (!claim.run) throw new Error("claim failed");
    await finishTutorRequest(input, claim.token, additions(), raw, "personalized", syntaxRepair);
    expect([...mocks.tasks.values()][0].output).toMatchObject({ modelOutput: { raw,
      sha256: createHash("sha256").update(raw).digest("hex"), syntaxRepair } });
  });
  it("retains the complete conversation beyond the bounded UI cache", async () => {
    for (let index = 0; index < 20; index++) {
      const request = { ...input, requestId: `request-${index}` };
      const claim = await claimTutorRequest(request);
      if (!claim.run) throw new Error("claim failed");
      await finishTutorRequest(request, claim.token, additions(index));
    }
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledTimes(40);
    expect(mocks.tx.aiInteractionEvent.create).toHaveBeenCalledTimes(40);
    const participation = await mocks.tx.classroomParticipation.findFirstOrThrow();
    expect(participation.workspace.projectState.aiLearningProgress.knowledgeLectureTutorThreads[0].messages).toHaveLength(30);
    expect(mocks.tx.aiMessage.create.mock.calls[1][0].data.content).toBe("解释0");
  });
  it("rejects a reused request id with different content", async () => {
    await claimTutorRequest(input);
    await expect(claimTutorRequest({ ...input, message: "其他问题" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledOnce();
  });
  it("replays the exact earlier thread and board notes after more turns are committed", async () => {
    const firstInput = additions();
    firstInput.boardNotes = [{ id: "note-one", kind: "concept", title: "概念", body: "第一轮板书", createdAt: firstInput.createdAt }];
    const firstClaim = await claimTutorRequest(input); if (!firstClaim.run) throw new Error("claim failed");
    const firstThread = await finishTutorRequest(input, firstClaim.token, firstInput);
    const secondRequest = { ...input, requestId: "second" };
    const secondInput = additions(1);
    // Same-time model notes can reuse their UI ID. A snapshot must still
    // resolve each immutable note, rather than substitute a later note by ID.
    secondInput.boardNotes = [{ id: "note-one", kind: "example", title: "例子", body: "第二轮板书", createdAt: secondInput.createdAt }];
    const secondClaim = await claimTutorRequest(secondRequest); if (!secondClaim.run) throw new Error("claim failed");
    const secondThread = await finishTutorRequest(secondRequest, secondClaim.token, secondInput);
    expect(secondThread.messages).toHaveLength(4);
    expect(secondThread.boardNotes).toHaveLength(2);
    expect(await claimTutorRequest(secondRequest)).toMatchObject({ status: "COMPLETED", thread: secondThread });
    expect(await claimTutorRequest(input)).toMatchObject({ status: "COMPLETED", thread: firstThread });
    expect(await finishTutorRequest(input, firstClaim.token, additions(9))).toEqual(firstThread);
    const receipt = ([...mocks.tasks.values()][1].output as { threadReceipt: { messages: unknown[]; boardNotes: unknown[] } }).threadReceipt;
    expect(JSON.stringify(receipt)).not.toContain("第一轮板书");
    expect(JSON.stringify(receipt)).not.toContain("解释");
  });
  it("accepts an initial explanation without a visible student message and preserves legacy receipts", async () => {
    const claim = await claimTutorRequest(input); if (!claim.run) throw new Error("claim failed");
    const initial = additions(); initial.messages = initial.messages.filter(message => message.role === "assistant");
    expect(await finishTutorRequest(input, claim.token, initial)).toEqual(initial);
    expect(mocks.tx.aiMessage.update).not.toHaveBeenCalled();
    [...mocks.tasks.values()][0].output = { thread: initial };
    mocks.tx.aiMessage.findMany.mockClear();
    expect(await claimTutorRequest(input)).toMatchObject({ status: "COMPLETED", thread: initial });
    expect(mocks.tx.aiMessage.findMany).not.toHaveBeenCalled();
  });
  it("fails explicitly when a referenced canonical message is missing instead of returning later workspace messages", async () => {
    const claim = await claimTutorRequest(input); if (!claim.run) throw new Error("claim failed");
    await finishTutorRequest(input, claim.token, additions());
    for (const id of mocks.messages.keys()) if (id.endsWith(":assistant")) mocks.messages.delete(id);
    await expect(claimTutorRequest(input)).rejects.toMatchObject({ code: "TUTOR_RECEIPT_MISSING", status: 503 });
  });
  it("keeps cancellation final and refuses a late assistant answer", async () => {
    const claim = await claimTutorRequest(input);
    if (!claim.run) throw new Error("claim failed");
    await failTutorRequest(input, claim.token, true);
    await expect(finishTutorRequest(input, claim.token, additions())).rejects.toMatchObject({ code: "TUTOR_REQUEST_EXPIRED" });
    expect(await claimTutorRequest(input)).toMatchObject({ run: false, status: "CANCELLED" });
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledOnce();
  });
  it("turns an interrupted process request into a durable failure on reconnect", async () => {
    await claimTutorRequest(input);
    for (const task of mocks.tasks.values()) task.startedAt = new Date(Date.now() - 181_000);
    expect(await claimTutorRequest(input)).toEqual({ run: false, status: "FAILED" });
    expect([...mocks.tasks.values()][0].status).toBe("FAILED");
  });
  it("rejects new questions after closure while preserving accepted results", async () => {
    const claim = await claimTutorRequest(input);
    if (!claim.run) throw new Error("claim failed");
    const participation = await mocks.tx.classroomParticipation.findFirst();
    participation.instance.status = "FINISHED";
    await expect(claimTutorRequest({ ...input, requestId: "new" })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    await expect(finishTutorRequest(input, claim.token, additions())).resolves.toMatchObject({ id: "thread" });
  });
});
