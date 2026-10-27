import type { TutorSyntaxRepair } from './knowledge-tutor-payload';
import { TUTOR_LEASE_MS } from "./knowledge-tutor-payload";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { PlatformError } from "@/lib/platform/repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { notifyProcessEvaluation } from "@/lib/evaluation/process-notifications";
import type { KnowledgeLectureBoardNote, KnowledgeLectureTutorMessage, KnowledgeLectureTutorThread, StudentAiProgress } from "@/lib/session/types";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type TutorRequest = { courseId: string; studentId: string; classroomId: string; requestId: string; threadId: string; attemptId: string; questionId: string; message: string; initial: boolean };
const taskId = (input: TutorRequest) => `lecture-tutor:${hash([input.courseId, input.studentId, input.requestId])}`;
type ThreadReceipt = Omit<KnowledgeLectureTutorThread, "messages" | "boardNotes"> & {
  messages: Array<Omit<KnowledgeLectureTutorMessage, "content"> & { messageId: string } | KnowledgeLectureTutorMessage>;
  boardNotes: Array<{ messageId: string; index: number } | KnowledgeLectureBoardNote>;
};

async function readTutorThread(db: Prisma.TransactionClient, output: unknown, conversationId: string | null): Promise<KnowledgeLectureTutorThread | undefined> {
  const saved = object(output);
  // Existing immutable receipts are still valid; never replace them with the
  // student's current workspace, which may contain later turns.
  if (saved.thread) return saved.thread as KnowledgeLectureTutorThread;
  if (!saved.threadReceipt) return undefined;
  if (!conversationId) throw new PlatformError("TUTOR_RECEIPT_MISSING", "已保存的问答回执暂时无法读取", 503);
  const receipt = saved.threadReceipt as ThreadReceipt;
  const refs = [...receipt.messages, ...receipt.boardNotes].flatMap(value => "messageId" in value ? [value.messageId] : []);
  const rows = await db.aiMessage.findMany({ where: { conversationId, id: { in: [...new Set(refs)] } },
    select: { id: true, content: true, metadata: true } });
  const byId = new Map(rows.map(row => [row.id, row]));
  const missing = () => new PlatformError("TUTOR_RECEIPT_MISSING", "已保存的问答回执暂时无法读取", 503);
  const messages = receipt.messages.map(value => {
    if (!("messageId" in value)) return value;
    const row = byId.get(value.messageId);
    if (!row) throw missing();
    return { id: value.id, role: value.role, createdAt: value.createdAt, content: row.content };
  });
  const boardNotes = receipt.boardNotes.map(value => {
    if (!("messageId" in value)) return value;
    const notes = object(byId.get(value.messageId)?.metadata).boardNotes as KnowledgeLectureBoardNote[] | undefined;
    if (!notes?.[value.index]) throw missing();
    return notes[value.index];
  });
  return { ...receipt, messages, boardNotes };
}

async function createThreadReceipt(db: Prisma.TransactionClient, conversationId: string, thread: KnowledgeLectureTutorThread): Promise<ThreadReceipt> {
  const rows = await db.aiMessage.findMany({ where: { conversationId, OR: [
    ...thread.messages.map(message => ({ metadata: { path: ["tutorMessage", "id"], equals: message.id } })),
    ...thread.boardNotes.map(note => ({ metadata: { path: ["boardNotes"], array_contains: json([note]) } })),
  ] }, select: { id: true, metadata: true } });
  const messageRefs = new Map(rows.flatMap(row => {
    const id = object(object(row.metadata).tutorMessage).id;
    return typeof id === "string" ? [[id, row.id] as const] : [];
  }));
  const noteRefs = new Map(rows.flatMap(row => ((object(row.metadata).boardNotes ?? []) as KnowledgeLectureBoardNote[])
    .map((note, index) => [hash(note), { messageId: row.id, index }] as const)));
  return { ...thread,
    messages: thread.messages.map(message => {
      const messageId = messageRefs.get(message.id);
      if (!messageId) return message; // Preserve older rows without a stable UI ID; do not infer identity from matching text.
      return { id: message.id, role: message.role, createdAt: message.createdAt, messageId };
    }),
    boardNotes: thread.boardNotes.map(note => noteRefs.get(hash(note)) ?? note),
  };
}

/** Durable claim survives response loss and records the question before contacting AI. */
export async function claimTutorRequest(input: TutorRequest): Promise<{ run: true; token: string } | { run: false; status: string; thread?: KnowledgeLectureTutorThread; resultSource?: "shared" | "personalized" }> {
  return runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const fingerprint = hash(input);
    const previous = await tx.aiTask.findUnique({ where: { id } });
    if (previous) {
      if (object(previous.input).fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他问题", 409);
      if (previous.status === "RUNNING" && (!previous.startedAt || Date.now() - previous.startedAt.getTime() > TUTOR_LEASE_MS)) {
        await tx.aiTask.update({ where: { id }, data: { status: "FAILED", error: "REQUEST_INTERRUPTED", completedAt: new Date() } });
        return { run: false, status: "FAILED" };
      }
      return { run: false, status: previous.status, thread: await readTutorThread(tx, previous.output, previous.conversationId), ...(object(previous.output).resultSource ? { resultSource: object(previous.output).resultSource as "shared" | "personalized" } : {}) };
    }
    const participation = await tx.classroomParticipation.findFirst({ where: { instanceId: input.courseId, enrollment: { userId: input.studentId } }, include: { enrollment: true, instance: { include: { activity: { include: { chapter: { include: { offering: true } } } } } } } });
    if (!participation || participation.enrollment.status !== "ACTIVE" || participation.instance.status !== "TEACHING" || participation.instance.activity.chapter.offering.status !== "OPEN") throw new PlatformError("CLASSROOM_READ_ONLY", "课堂已结束，无法发起新问题", 409);
    const conversationId = `lecture-tutor:${hash([participation.id, input.threadId])}`;
    await tx.aiConversation.upsert({ where: { id: conversationId }, create: { id: conversationId, userId: input.studentId, participationId: participation.id, offeringId: participation.enrollment.offeringId, title: "知识讲授伴学", metadata: { threadId: input.threadId, stageKey: "ai-learning" } }, update: {} });
    const token = randomUUID();
    await tx.aiTask.create({ data: { id, conversationId, offeringId: participation.enrollment.offeringId, createdById: input.studentId, taskType: "KNOWLEDGE_LECTURE_TUTOR", status: "RUNNING", input: json({ ...input, fingerprint, token }), startedAt: new Date() } });
    await tx.aiMessage.create({ data: { id: `${id}:student`, conversationId, userId: input.studentId, role: "user", content: input.message, metadata: { requestId: input.requestId, taskId: id, initial: input.initial } } });
    await tx.aiInteractionEvent.create({ data: { idempotencyKey: `${id}:question`, userId: input.studentId, participationId: participation.id, offeringId: participation.enrollment.offeringId, researchKey: participation.enrollment.researchKey, conversationId, taskId: id, requestId: input.requestId, eventType: "message", actor: "student", content: null, payload: { schemaVersion: 2, legacy: { stageKey: "ai-learning", source: "knowledge-tutor", conversationId: input.threadId }, detail: { contentRef: "AiMessage", messageId: `${id}:student`, attemptId: input.attemptId, questionId: input.questionId, initial: input.initial } } } });
    return { run: true, token };
  }, { lowPriorityCourseId: input.courseId });
}

export async function finishTutorRequest(input: TutorRequest, token: string, additions: KnowledgeLectureTutorThread, rawModelOutput?: string, resultSource?: "shared" | "personalized", syntaxRepair?: TutorSyntaxRepair): Promise<KnowledgeLectureTutorThread> {
  const result = await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const task = await tx.aiTask.findUniqueOrThrow({ where: { id } });
    if (task.status === "COMPLETED") {
      const thread = await readTutorThread(tx, task.output, task.conversationId);
      if (!thread) throw new PlatformError("TUTOR_RECEIPT_MISSING", "已保存的问答回执暂时无法读取", 503);
      return { thread, version: 0 };
    }
    if (task.status !== "RUNNING" || object(task.input).token !== token) throw new PlatformError("TUTOR_REQUEST_EXPIRED", "本次请求已结束，请重新提问", 409);
    const participation = await tx.classroomParticipation.findFirstOrThrow({ where: { instanceId: input.courseId, enrollment: { userId: input.studentId } }, include: { workspace: true, enrollment: true, instance: true } });
    const state = object(participation.workspace?.projectState);
    const progress = state.aiLearningProgress as StudentAiProgress | undefined;
    if (!progress || progress.classroomId !== input.classroomId) throw new PlatformError("QUIZ_SCENE_CHANGED", "课堂学习内容已变化", 409);
    const threads = progress.knowledgeLectureTutorThreads ?? [];
    const current = threads.find(thread => thread.id === input.threadId);
    const thread = { ...additions, messages: [...(current?.messages ?? []), ...additions.messages].slice(-30), boardNotes: [...(current?.boardNotes ?? []), ...additions.boardNotes].slice(-12), createdAt: current?.createdAt ?? additions.createdAt };
    // Messages remain complete; display-limited notes also retain their original model JSON in the task.
    const assistant = additions.messages.find(message => message.role === "assistant")!;
    const student = additions.messages.find(message => message.role === "student");
    const messageView = ({ id, role, createdAt }: KnowledgeLectureTutorMessage) => ({ id, role, createdAt });
    if (student) await tx.aiMessage.update({ where: { id: `${id}:student` }, data: { metadata: json({ requestId: input.requestId, taskId: id,
      initial: input.initial, tutorMessage: messageView(student) }) } });
    await tx.aiMessage.create({ data: { id: `${id}:assistant`, conversationId: task.conversationId!, role: "assistant", content: assistant.content,
      metadata: json({ requestId: input.requestId, taskId: id, tutorMessage: messageView(assistant), boardNotes: additions.boardNotes }) } });
    await tx.aiInteractionEvent.create({ data: { idempotencyKey: `${id}:answer`, userId: input.studentId, participationId: participation.id, offeringId: participation.enrollment.offeringId, researchKey: participation.enrollment.researchKey, conversationId: task.conversationId, taskId: id, requestId: input.requestId, eventType: "response", actor: "assistant", content: null, payload: json({ schemaVersion: 2, legacy: { stageKey: "ai-learning", source: "knowledge-tutor", conversationId: input.threadId }, detail: { contentRef: "AiMessage", messageId: `${id}:assistant`, attemptId: input.attemptId, questionId: input.questionId } }) } });
    await tx.studentProjectWorkspace.update({ where: { participationId: participation.id }, data: { version: { increment: 1 }, projectState: json({ ...state, aiLearningProgress: { ...progress, knowledgeLectureTutorThreads: [...threads.filter(item => item.id !== thread.id), thread].slice(-60), lastActiveAt: thread.updatedAt } }) } });
    const threadReceipt = await createThreadReceipt(tx, task.conversationId!, thread);
    await tx.aiTask.update({ where: { id }, data: { status: "COMPLETED", output: json({ schemaVersion: 2, threadReceipt, ...(resultSource ? { resultSource } : {}), ...(rawModelOutput === undefined ? {} : { modelOutput: { raw: rawModelOutput, sha256: createHash("sha256").update(rawModelOutput).digest("hex"), ...(syntaxRepair ? { syntaxRepair } : {}) } }) }), completedAt: new Date() } });
    const runtime = object(participation.instance.runtimeConfig);
    const version = Number(runtime.version ?? 1) + 1;
    await tx.classroomInstance.update({ where: { id: input.courseId }, data: { runtimeConfig: json({ ...runtime, version }) } });
    await tx.domainEvent.create({ data: { idempotencyKey: `${id}:completed`, actorId: input.studentId, offeringId: participation.enrollment.offeringId, classroomInstanceId: input.courseId, participationId: participation.id, researchKey: participation.enrollment.researchKey, eventType: "KNOWLEDGE_TUTOR_COMPLETED", payload: { courseVersion: version, scope: "student", studentId: input.studentId, requestId: input.requestId } } });
    return { thread, version };
  }, { lowPriorityCourseId: input.courseId });
  try { await publishCourseEvent(input.courseId, { type: "course-updated", courseId: input.courseId, at: new Date().toISOString(), payload: { scope: "student", studentId: input.studentId, courseVersion: result.version } }); } catch (error) { console.error("[knowledge-tutor] notification failed", error); }
  notifyProcessEvaluation(input.courseId, input.studentId);
  return result.thread;
}

export async function failTutorRequest(input: TutorRequest, token: string, cancelled: boolean, rawModelOutput?: string, errorCode = "TUTOR_GENERATION_FAILED"): Promise<void> {
  await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    const id = taskId(input);
    const task = await tx.aiTask.findUnique({ where: { id } });
    if (task?.status === "RUNNING" && object(task.input).token === token) await tx.aiTask.update({ where: { id }, data: { status: cancelled ? "CANCELLED" : "FAILED", error: cancelled ? "CLIENT_CANCELLED" : errorCode, ...(rawModelOutput === undefined ? {} : { output: json({ modelOutput: { raw: rawModelOutput, sha256: createHash("sha256").update(rawModelOutput).digest("hex") } }) }), completedAt: new Date() } });
  }, { lowPriorityCourseId: input.courseId });
}
