import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { loadPblTemplateCourse, savePblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import { GenerationReferenceError, resolveGenerationReferenceMaterials, formatGenerationReferenceContext } from "@/lib/course-design/generation-references";
import { CourseEvidenceError, resolveCourseEvidenceSnapshot } from "@/lib/textbook/course-evidence";
import { formatCourseEvidenceContext } from "@/lib/textbook/course-evidence-types";
import { resolveLlmRequestTimeoutMs } from "@/lib/llm/request-policy";
import { LlmNotConfiguredError } from "@/lib/llm/types";
import { generatePreparationTurn } from "./model";
import { preparationMissingFields, preparationPlanSchema } from "./schema";
import type { ConfirmedPreparation, PreparationModelResult, PreparationMutationInput, PreparationSessionSnapshot } from "./types";

type SessionRow = Prisma.CoursePreparationSessionGetPayload<{ include: { turns: true } }>;
type State = Omit<PreparationSessionSnapshot, "id" | "revision" | "status" | "turns" | "confirmed" | "error" | "missingFields">;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const emptyState = (): State => ({ currentQuestion: null, plan: {}, fieldOrigins: {}, readyToConfirm: false, suggestions: [], referenceIds: [], referenceMaterials: [], textbookSelections: [] });
const activeStatuses = ["QUEUED", "RUNNING", "REVIEW_AVAILABLE", "PAUSED", "CANCELLING"];
export class PreparationError extends Error {
  constructor(message: string, readonly code = "PREPARATION_INVALID", readonly status = 400) { super(message); this.name = "PreparationError"; }
}
function stateOf(row: Pick<SessionRow, "state">): State { return { ...emptyState(), ...(row.state as unknown as Partial<State>) }; }

export function preparationSnapshot(row: SessionRow): PreparationSessionSnapshot {
  const state = stateOf(row);
  const turns: PreparationSessionSnapshot["turns"] = [];
  for (const turn of row.turns) {
    if (turn.userMessage) turns.push({ id: `${turn.id}:user`, role: "user", content: turn.userMessage, createdAt: turn.createdAt.toISOString() });
    const stored = turn.result as unknown as { response?: PreparationModelResult } | null;
    const result = stored?.response;
    if (result?.message) turns.push({ id: `${turn.id}:assistant`, role: "assistant", content: result.message, question: result.question, createdAt: turn.updatedAt.toISOString() });
  }
  return { ...state, id: row.id, revision: row.revision, status: row.status.toLowerCase() as PreparationSessionSnapshot["status"], turns,
    missingFields: preparationMissingFields(state.plan), confirmed: row.confirmedSnapshot as unknown as ConfirmedPreparation | null, error: row.error };
}

async function assertOwner(db: Prisma.TransactionClient, courseId: string, ownerId: string) {
  const template = await db.classroomTemplate.findUnique({ where: { id: courseId }, select: { ownerId: true, status: true } });
  if (!template || template.ownerId !== ownerId || template.status === "DELETED") throw new PreparationError("课程不存在或无权访问。", "PREPARATION_NOT_FOUND", 404);
  if (template.status === "ARCHIVED") throw new PreparationError("已归档课程不可修改。", "PREPARATION_ARCHIVED", 409);
}
async function assertNoRunningGeneration(db: Prisma.TransactionClient, courseId: string) {
  const running = await db.generationJob.findFirst({ where: { targetType: "CLASSROOM_TEMPLATE", targetId: courseId, jobType: { in: ["COURSE_DESIGN", "COURSE_CONTENT", "COURSE_RESOURCE_PACKAGE"] }, status: { in: activeStatuses } }, select: { id: true } });
  if (running) throw new PreparationError("课程正在生成或导入，请先等待完成或停止当前任务，再修改备课方案。", "PREPARATION_GENERATION_RUNNING", 409);
}
function sameSources(a: Pick<State, "referenceIds" | "textbookSelections">, b: Pick<State, "referenceIds" | "textbookSelections">) {
  // JSONB storage and request schema parsing use different property orders.
  // Compare the selected identities, not their serialized object insertion order.
  const normalize = (value: typeof a) => ({ referenceIds: [...new Set(value.referenceIds)].sort(), textbookSelections: value.textbookSelections.map((s) => ({ revisionId: s.revisionId, primary: s.primary === true, sectionIds: [...new Set(s.sectionIds)].sort() })).sort((x, y) => x.revisionId.localeCompare(y.revisionId)) });
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

async function resolveSources(courseId: string, ownerId: string, state: State, teacherBrief: string) {
  const materials = await resolveGenerationReferenceMaterials({ courseId, uploadedById: ownerId, uploadIds: state.referenceIds });
  const evidence = state.textbookSelections.length ? await resolveCourseEvidenceSnapshot({ courseId, selections: state.textbookSelections,
    upstreamKnowledgePoints: (state.plan.knowledgePoints ?? []).map((point) => ({ id: point.id, name: point.name, description: `${point.depth}\n${point.teachingApproach}` })), teacherBrief }) : undefined;
  return { referenceMaterials: materials.map(({ id, fileName, mimeType }) => ({ id, fileName, mimeType })), context: [formatGenerationReferenceContext(materials), evidence ? formatCourseEvidenceContext(evidence) : ""].filter(Boolean).join("\n\n") };
}

async function validateConfirmationSources(courseId: string, ownerId: string, state: Pick<State, "referenceIds" | "textbookSelections">) {
  await resolveGenerationReferenceMaterials({ courseId, uploadedById: ownerId, uploadIds: state.referenceIds });
  if (!state.textbookSelections.length) return;
  // Confirmation validates immutable source identity; it does not run retrieval again.
  const revisions = await prisma.textbookRevision.findMany({ where: { id: { in: state.textbookSelections.map((selection) => selection.revisionId) } }, select: { id: true, status: true, textbook: { select: { status: true } }, sections: { select: { id: true } } } });
  for (const selection of state.textbookSelections) {
    const revision = revisions.find((revision) => revision.id === selection.revisionId);
    if (!revision || revision.textbook.status === "ARCHIVED" || !["READY", "WAITING_EMBEDDING"].includes(revision.status) || selection.sectionIds.some((id) => !revision.sections.some((section) => section.id === id))) throw new PreparationError("采用的教材版本或章节已不可用，请重新选择并更新方案。", "PREPARATION_SOURCES_CHANGED", 409);
  }
}

/** GET is allowed to mark abandoned model work retryable, never to run another model call. */
export async function loadPreparationSession(courseId: string, ownerId: string): Promise<PreparationSessionSnapshot | null> {
  let row = await prisma.coursePreparationSession.findUnique({ where: { templateId: courseId }, include: { turns: { orderBy: { revision: "asc" } } } });
  if (!row || row.ownerId !== ownerId) return null;
  const currentRevision = row.revision;
  const pending = row.turns.find((turn) => turn.revision === currentRevision && ["PENDING", "RUNNING"].includes(turn.status));
  if (row.status === "PROCESSING" && pending && (pending.leaseExpiresAt ?? new Date(pending.createdAt.getTime() + 60_000)).getTime() < Date.now()) {
    await runMutationTransaction(async (tx) => {
      const changed = await tx.coursePreparationTurn.updateMany({ where: { id: pending.id, status: pending.status, executionId: pending.executionId, leaseExpiresAt: pending.leaseExpiresAt }, data: { status: "FAILED", error: "本轮处理已中断，回答已保存，请重试。", executionId: null, leaseExpiresAt: null } });
      if (changed.count) await tx.coursePreparationSession.updateMany({ where: { id: row!.id, revision: pending.revision, status: "PROCESSING" }, data: { status: "FAILED", error: "本轮处理已中断，回答已保存，请重试。" } });
    });
    row = await prisma.coursePreparationSession.findUnique({ where: { templateId: courseId }, include: { turns: { orderBy: { revision: "asc" } } } });
  }
  return row ? preparationSnapshot(row) : null;
}

async function setCourseConfirmation(tx: Prisma.TransactionClient, courseId: string, ownerId: string, confirmed: ConfirmedPreparation | null) {
  const course = await loadPblTemplateCourse(courseId, tx);
  if (!course) throw new PreparationError("课程不存在。", "PREPARATION_NOT_FOUND", 404);
  await savePblTemplateCourse({ ...course, status: "preparing", content: { ...course.content, preparationSource: "collaborative-preparation",
    confirmedPreparation: confirmed ?? undefined, qualityReviewRequired: true, teacherReview: undefined } }, ownerId, tx);
}

/** Saves the teacher's answer before any external model call. */
export async function submitPreparationMutation(courseId: string, ownerId: string, input: PreparationMutationInput): Promise<{ session: PreparationSessionSnapshot; turnId: string | null }> {
  if (input.action === "confirm") {
    const existing = await loadPreparationSession(courseId, ownerId);
    if (!existing) throw new PreparationError("请先完成备课讨论。", "PREPARATION_NOT_FOUND", 404);
    const proposedSources = { referenceIds: input.referenceIds ?? existing.referenceIds, textbookSelections: input.textbookSelections ?? existing.textbookSelections };
    if (!sameSources(existing, proposedSources)) throw new PreparationError("资料选择已变化，请先继续讨论并更新方案，再确认。", "PREPARATION_SOURCES_CHANGED", 409);
    // Revalidate source access; a deleted upload must never become a frozen source.
    await validateConfirmationSources(courseId, ownerId, proposedSources);
  }
  return runMutationTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pbl-template:${courseId}`}, 0))`;
    await assertOwner(tx, courseId, ownerId);
    let row = await tx.coursePreparationSession.findUnique({ where: { templateId: courseId }, include: { turns: { orderBy: { revision: "asc" } } } });
    if (row && row.ownerId !== ownerId) throw new PreparationError("无权访问此备课会话。", "PREPARATION_NOT_FOUND", 404);
    const prior = row?.turns.find((turn) => turn.requestId === input.requestId);
    if (prior) {
      if (!isDeepStrictEqual(prior.request, json(input))) throw new PreparationError("同一请求标识不能用于不同回答，请重新提交。", "PREPARATION_REQUEST_CONFLICT", 409);
      return { session: preparationSnapshot(row!), turnId: prior.status === "PENDING" ? prior.id : null };
    }
    if ((row?.revision ?? 0) !== input.revision) throw new PreparationError("备课内容已更新，请刷新后重试；你的输入仍然保留。", "PREPARATION_REVISION_CONFLICT", 409);
    if (row?.status === "PROCESSING") throw new PreparationError("AI 正在处理上一轮，请等待回答。", "PREPARATION_BUSY", 409);
    await assertNoRunningGeneration(tx, courseId);
    if (!row) {
      if (input.action) throw new PreparationError("请先描述课程需求。", "PREPARATION_NOT_STARTED", 400);
      row = await tx.coursePreparationSession.create({ data: { templateId: courseId, ownerId, state: json(emptyState()) }, include: { turns: true } });
    }
    const previous = stateOf(row);
    const revision = row.revision + 1;
    if (input.action === "confirm") {
      const plan = preparationPlanSchema.safeParse(previous.plan);
      if (!plan.success || !previous.readyToConfirm) throw new PreparationError(`请先完善方案：${preparationMissingFields(previous.plan).join("、") || "继续讨论后再确认"}。`, "PREPARATION_INCOMPLETE", 409);
      const confirmed: ConfirmedPreparation = { sessionId: row.id, revision, confirmedAt: new Date().toISOString(), confirmedBy: ownerId, plan: plan.data,
        referenceIds: previous.referenceIds, textbookSelections: previous.textbookSelections };
      await setCourseConfirmation(tx, courseId, ownerId, confirmed);
      await tx.coursePreparationTurn.create({ data: { sessionId: row.id, requestId: input.requestId, revision, action: "confirm", status: "COMPLETED", userMessage: "已确认课程方案。", request: json(input) } });
      row = await tx.coursePreparationSession.update({ where: { id: row.id }, data: { revision, status: "CONFIRMED", confirmedSnapshot: json(confirmed), error: null }, include: { turns: { orderBy: { revision: "asc" } } } });
      return { session: preparationSnapshot(row), turnId: null };
    }
    if (input.action === "retry" && row.status !== "FAILED") throw new PreparationError("当前没有失败的备课轮次。", "PREPARATION_RETRY_UNAVAILABLE", 409);
    const option = input.selectedOptionId ? previous.currentQuestion?.options.find((item) => item.id === input.selectedOptionId) : null;
    if (input.selectedOptionId && !option) throw new PreparationError("问题或选项已更新，请使用当前问题作答。", "PREPARATION_QUESTION_CHANGED", 409);
    const userMessage = input.action === "retry" ? "" : [option ? `关于“${previous.currentQuestion!.prompt}”，我选择：${option.label}。${option.description}` : "", input.message?.trim() || (input.action === "continue" ? "请继续深入讨论这份方案，帮助我考虑还值得推敲的教学取舍。" : "")].filter(Boolean).join("\n");
    if (input.action !== "retry" && !userMessage) throw new PreparationError("请描述课程需求或选择一个方案。");
    const state: State = { ...previous, readyToConfirm: false, referenceIds: input.referenceIds ?? previous.referenceIds, textbookSelections: input.textbookSelections ?? previous.textbookSelections };
    const sourceChanged = !sameSources(previous, state);
    if (sourceChanged) state.referenceMaterials = [];
    await setCourseConfirmation(tx, courseId, ownerId, null);
    const turn = await tx.coursePreparationTurn.create({ data: { sessionId: row.id, requestId: input.requestId, revision, action: input.action ?? "answer", userMessage,
      request: json(input), leaseExpiresAt: new Date(Date.now() + 60_000) } });
    row = await tx.coursePreparationSession.update({ where: { id: row.id }, data: { revision, status: "PROCESSING", state: json(state), confirmedSnapshot: Prisma.DbNull, error: null }, include: { turns: { orderBy: { revision: "asc" } } } });
    return { session: preparationSnapshot(row), turnId: turn.id };
  });
}

export async function runPreparationTurn(turnId: string): Promise<void> {
  const executionId = randomUUID();
  const claimed = await prisma.coursePreparationTurn.updateMany({ where: { id: turnId, status: "PENDING" }, data: { status: "RUNNING", executionId,
    leaseExpiresAt: new Date(Date.now() + resolveLlmRequestTimeoutMs("standard") + 60_000) } });
  if (!claimed.count) return;
  const turn = await prisma.coursePreparationTurn.findUnique({ where: { id: turnId }, include: { session: { include: { turns: { orderBy: { revision: "asc" } } } } } });
  if (!turn || turn.session.revision !== turn.revision || turn.session.status !== "PROCESSING") return;
  const heartbeat = setInterval(() => {
    void prisma.coursePreparationTurn.updateMany({ where: { id: turnId, status: "RUNNING", executionId }, data: { leaseExpiresAt: new Date(Date.now() + 60_000) } }).catch(() => { /* The lease guard rejects late writes if persistence stays unavailable. */ });
  }, 15_000);
  heartbeat.unref?.();
  let rawResponse: string | undefined;
  try {
    const snapshot = preparationSnapshot(turn.session);
    const sources = await resolveSources(turn.session.templateId, turn.session.ownerId, stateOf(turn.session), snapshot.turns.filter((t) => t.role === "user").map((t) => t.content).join("\n"));
    const result = await generatePreparationTurn({ snapshot, sourceContext: sources.context, onResponse: async (response) => {
      rawResponse = response;
      const stored = await prisma.coursePreparationTurn.updateMany({ where: { id: turnId, status: "RUNNING", executionId }, data: { result: json({ rawResponse: response }) } });
      if (!stored.count) throw new PreparationError("本轮响应已过期，请读取当前备课状态。", "PREPARATION_RESPONSE_STALE", 409);
    } });
    await runMutationTransaction(async (tx) => {
      const updated = await tx.coursePreparationTurn.updateMany({ where: { id: turnId, status: "RUNNING", executionId }, data: { status: "COMPLETED", result: json({ response: result, rawResponse }), executionId: null, leaseExpiresAt: null, error: null } });
      if (!updated.count) return;
      const state: State = { ...stateOf(turn.session), plan: result.plan, fieldOrigins: result.fieldOrigins, currentQuestion: result.question,
        readyToConfirm: result.readyToConfirm, suggestions: result.suggestions, referenceMaterials: sources.referenceMaterials };
      await tx.coursePreparationSession.updateMany({ where: { id: turn.sessionId, revision: turn.revision, status: "PROCESSING" }, data: { status: result.readyToConfirm ? "READY" : "DISCUSSING", state: json(state), error: null } });
    });
  } catch (error) {
    const message = error instanceof PreparationError || error instanceof GenerationReferenceError || error instanceof CourseEvidenceError ? error.message
      : error instanceof LlmNotConfiguredError ? "请先配置系统教学模型，再重试本轮；你的回答已保存。"
      : "本轮 AI 讨论未完成，已保留你的回答和上一份方案，请重试。";
    await runMutationTransaction(async (tx) => {
      const updated = await tx.coursePreparationTurn.updateMany({ where: { id: turnId, status: "RUNNING", executionId }, data: { status: "FAILED", error: message,
        result: json({ rawResponse, diagnostic: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: "Unknown preparation failure" } }), executionId: null, leaseExpiresAt: null } });
      if (updated.count) await tx.coursePreparationSession.updateMany({ where: { id: turn.sessionId, revision: turn.revision, status: "PROCESSING" }, data: { status: "FAILED", error: message } });
    });
  } finally { clearInterval(heartbeat); }
}

export async function resolveConfirmedPreparation(courseId: string, sessionId: string, revision: number, ownerId: string): Promise<ConfirmedPreparation> {
  await assertOwner(prisma, courseId, ownerId);
  const row = await prisma.coursePreparationSession.findUnique({ where: { templateId: courseId } });
  if (!row || row.id !== sessionId || row.ownerId !== ownerId) throw new PreparationError("备课会话不存在或无权访问。", "PREPARATION_NOT_FOUND", 404);
  const confirmed = row.confirmedSnapshot as unknown as ConfirmedPreparation | null;
  if (row.status !== "CONFIRMED" || !confirmed) throw new PreparationError("请先确认当前备课方案。", "PREPARATION_CONFIRMATION_REQUIRED", 409);
  if (row.revision !== revision || confirmed.revision !== revision) throw new PreparationError("备课方案已更新，请重新确认当前版本。", "PREPARATION_REVISION_CONFLICT", 409);
  const course = await loadPblTemplateCourse(courseId);
  if (course?.content.preparationSource !== "collaborative-preparation" || course.content.confirmedPreparation?.sessionId !== sessionId || course.content.confirmedPreparation.revision !== revision) throw new PreparationError("当前课程的备课来源已变化，请重新确认方案。", "PREPARATION_SOURCE_CHANGED", 409);
  return { ...confirmed, plan: preparationPlanSchema.parse(confirmed.plan) };
}
