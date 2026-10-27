import { withReadApiBoundary, readApiOptionsFor, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  buildCodeCollaborationPrompts,
  buildCodeTaskStarterPrompts,
  detectProtectedCodeWorkRequest,
  isCodeCollaborationIntent,
  normalizeCodeCollaborationResponse,
  normalizeCodeTaskStarters,
  type CodeCollaborationIntent,
  type CodeCollaborationResponse,
  type CodeRunContext,
  type CodeSelection,
} from "@/lib/ai-collaboration/code-policy";
import type {
  CodeAiComment,
  CodeAiCommentThread,
} from "@/lib/ai-collaboration/code-comment-types";
import {
  parseCodeArtifact,
  type CodeArtifactLanguage,
} from "@/lib/ai-collaboration/code-artifact";
import { beginCodeRequest, resumeCodeRequest, codeBackgroundRequestId, codeRequestDigest } from "@/lib/ai-collaboration/code-request";
import { assertDocumentReviewScope, enqueueCodeReview, resumeDocumentReview, DocumentReviewScopeChanged, isDocumentReviewScopeChanged, type QueuedCodeReview } from './document-review-queue';
import { codeAliasResponse, readCodeBackgroundAlias, findCodeBackgroundAlias, stableCodeDigest } from './code-background-alias';
import { prisma } from '@/lib/db/client';
import { COLLABORATION_EXECUTION_TIMEOUT_MS } from "@/lib/ai-collaboration/request-budget";
import { readDocumentRequestReceipt, type DocumentRequestInput } from "@/lib/ai-collaboration/document-request-store";
import type { AiInteractionEventInput } from "@/lib/ai-collaboration/audit-store";
import { isProactiveReviewCapacityError, withProactiveReviewCapacity } from "@/lib/ai-collaboration/proactive-review-capacity";
import { isBackgroundAiCapacityError } from '@/lib/llm/classroom-capacity';
import { withClassroomAiUsage } from "@/lib/observability/classroom-ai";
import { withHttpMetrics } from "@/lib/observability/http";
import { timeProgress } from "@/lib/observability/progress-request-timing";
import {
  activeConversationId,
  modelConversationHistory,
  visibleConversationMessages,
} from "@/lib/ai-collaboration/conversation-window";
import {
  companionLimiter,
  codeSuggestionLimiter,
  rateLimitKey,
} from "@/lib/auth/rate-limit";
import {
  type StudentClaims,
} from "@/lib/auth/session";
import {
  appendCompanionMessages,
  companionMessage,
  getCompanionThread,
  getCompanionThreadPair,
  softDeleteCompanionMessage,
} from "@/lib/companion/server-store";
import { callLLM, parseLLMJson } from "@/lib/llm/client";
import {
  LlmCallFailedError,
  LlmJsonModeUnsupportedError,
  LlmNotConfiguredError,
  LlmRateLimitError,
  LlmTimeoutError,
} from "@/lib/llm/errors";
import { getCourse } from "@/lib/session/server-store";
import { getCodeReadContext } from "@/lib/ai-collaboration/code-read-context";
import type { CompanionMessage } from "@/lib/session/types";
import { authenticateLegacyAiStudent } from "@/lib/ai-collaboration/legacy-scope";
import { normalizeProjectSupportOutput } from "@/lib/ai-collaboration/project-support-types";
import {
  dismissProjectMemories,
  listProjectMemories,
  projectMemoryContinuation,
  resolveProjectSupportContext,
  saveProjectMemoryCandidates,
} from "@/lib/ai-collaboration/project-support-server";

const COLLABORATION_STAGE_KEYS = new Set(["proposal", "make"]);
const THREAD_PREFIX = "ai-code-collaboration";
const COMMENT_THREAD_PREFIX = "ai-code-comments";
const COMMENT_META_PREFIX = "OPENPBL_CODE_COMMENT_META:";
const COMMENT_READ_PREFIX = "OPENPBL_CODE_COMMENT_READ:";
const COMMENT_RESOLVED_PREFIX = "OPENPBL_CODE_COMMENT_RESOLVED:";
const CODE_COMMENT_REVIEW_VERSION = 2;
const MAX_ARTIFACT_LENGTH = 120_000;
const TRANSIENT_RETRIES = 2;

type CodeCollaborationRequest = {
  courseId?: unknown;
  studentId?: unknown;
  stageKey?: unknown;
  language?: unknown;
  action?: unknown;
  intent?: unknown;
  message?: unknown;
  artifact?: unknown;
  selection?: unknown;
  run?: unknown;
  conversationId?: unknown;
  commentThreadId?: unknown;
  mode?: unknown;
  requestId?: unknown;
};

type CodeCommentMeta = Omit<CodeAiCommentThread, "comments" | "readAt" | "resolvedAt">;

function clean(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, maxLength)
    : "";
}

function parseLanguage(value: unknown): CodeArtifactLanguage | undefined {
  return value === "python" || value === "c" ? value : undefined;
}

function parseSelection(value: unknown, language: CodeArtifactLanguage): CodeSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const filePath = clean(record.filePath, 240);
  const text = clean(record.text, 16_000);
  const startLine = Number(record.startLine);
  const startColumn = Number(record.startColumn);
  const endLine = Number(record.endLine);
  const endColumn = Number(record.endColumn);
  const extensionAllowed = language === "python"
    ? filePath.toLowerCase().endsWith(".py")
    : /\.(?:c|h)$/i.test(filePath);
  if (
    !filePath
    || !text
    || !extensionAllowed
    || ![startLine, startColumn, endLine, endColumn].every((item) => Number.isInteger(item) && item > 0)
  ) return undefined;
  return { filePath, text, startLine, startColumn, endLine, endColumn };
}

function parseRunContext(value: unknown): CodeRunContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const status = clean(record.status, 20);
  if (status !== "idle" && status !== "success" && status !== "failed" && status !== "timeout") {
    return undefined;
  }
  const phase = record.phase === "compile" || record.phase === "run" ? record.phase : undefined;
  const rawExitCode = record.exitCode;
  const exitCode = rawExitCode === null
    ? null
    : Number.isInteger(Number(rawExitCode))
      ? Number(rawExitCode)
      : undefined;
  return {
    status,
    phase,
    exitCode,
    stdout: clean(record.stdout, 12_000),
    stderr: clean(record.stderr, 16_000),
  };
}

function threadKey(stageKey: string, language: CodeArtifactLanguage): string {
  return `${THREAD_PREFIX}:${stageKey}:${language}`;
}

function commentThreadKey(stageKey: string, language: CodeArtifactLanguage): string {
  return `${COMMENT_THREAD_PREFIX}:${stageKey}:${language}`;
}

function encodeCodeCommentMeta(meta: CodeCommentMeta): string {
  return `${COMMENT_META_PREFIX}${JSON.stringify(meta)}`;
}

function parseCodeCommentMeta(message: CompanionMessage): CodeCommentMeta | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_META_PREFIX)) return null;
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_META_PREFIX.length)) as Record<string, unknown>;
    const id = clean(raw.id, 160);
    const filePath = clean(raw.filePath, 240);
    const title = clean(raw.title, 100);
    const quotedCode = clean(raw.quotedCode, 2_000);
    const createdAt = clean(raw.createdAt, 80) || message.createdAt;
    const startLine = Number(raw.startLine);
    const endLine = Number(raw.endLine);
    const reviewVersion = Number(raw.reviewVersion);
    const severity = raw.severity === "error" || raw.severity === "warning" ? raw.severity : "notice";
    if (!id || !filePath || !title || !Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) return null;
    return {
      id,
      filePath,
      startLine,
      endLine,
      severity,
      title,
      quotedCode,
      createdAt,
      reviewVersion: Number.isInteger(reviewVersion) && reviewVersion > 0 ? reviewVersion : undefined,
    };
  } catch {
    return null;
  }
}

function parseThreadTimestamp(message: CompanionMessage, prefix: string): { id: string; at: string } | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(prefix)) return null;
  try {
    const raw = JSON.parse(message.content.slice(prefix.length)) as Record<string, unknown>;
    const id = clean(raw.id, 160);
    const at = clean(raw.at, 80) || message.createdAt;
    return id ? { id, at } : null;
  } catch {
    return null;
  }
}

function latestTimestamp(items: Array<{ id: string; at: string }>, id: string): string | undefined {
  return items
    .filter((item) => item.id === id)
    .map((item) => item.at)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function codeCommentThreads(messages: CompanionMessage[]): CodeAiCommentThread[] {
  const metas = messages.map(parseCodeCommentMeta).filter((item): item is CodeCommentMeta => Boolean(item));
  const reads = messages.map((message) => parseThreadTimestamp(message, COMMENT_READ_PREFIX)).filter((item): item is { id: string; at: string } => Boolean(item));
  const resolutions = messages.map((message) => parseThreadTimestamp(message, COMMENT_RESOLVED_PREFIX)).filter((item): item is { id: string; at: string } => Boolean(item));
  return metas.map((meta) => ({
    ...meta,
    readAt: latestTimestamp(reads, meta.id),
    resolvedAt: latestTimestamp(resolutions, meta.id),
    comments: messages
      .filter((message) => message.conversationId === meta.id
        && (message.role === "student" || message.role === "agent")
        && !message.hiddenFromStudentAt)
      .map((message): CodeAiComment => ({
        id: message.id,
        role: message.role === "student" ? "student" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
      })),
  })).filter((thread) => thread.comments.length > 0);
}

function threadSelection(thread: CodeAiCommentThread, artifact: ReturnType<typeof parseCodeArtifact>): CodeSelection | undefined {
  if (!artifact) return undefined;
  const file = artifact.files.find((item) => item.path === thread.filePath);
  if (!file) return undefined;
  const lines = file.content.split("\n");
  const startLine = Math.max(1, Math.min(lines.length, thread.startLine));
  const endLine = Math.max(startLine, Math.min(lines.length, thread.endLine));
  return {
    filePath: file.path,
    startLine,
    startColumn: 1,
    endLine,
    endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
    text: thread.quotedCode || lines.slice(startLine - 1, endLine).join("\n"),
  };
}

async function authenticateStudent(
  request: Request,
  courseId: string,
  requestedStudentId: string,
): Promise<{ claims: StudentClaims | null; studentId: string; participationId: string } | Response> {
  return authenticateLegacyAiStudent(request, courseId, requestedStudentId);
}

async function loadScope(input: {
  request: Request;
  courseId: string;
  requestedStudentId: string;
  stageKey: string;
}) {
  if (!COLLABORATION_STAGE_KEYS.has(input.stageKey)) {
    return Response.json({ error: "STAGE_NOT_SUPPORTED", message: "代码协作目前仅支持方案与制作阶段。" }, { status: 400 });
  }
  const authentication = await timeProgress("code-auth", () => authenticateStudent(input.request, input.courseId, input.requestedStudentId));
  if (authentication instanceof Response) return authentication;
  const course = await timeProgress("code-context", () => getCourse(input.courseId, { studentId: authentication.studentId }));
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  const student = course.students.find((item) => item.id === authentication.studentId);
  if (!student) return Response.json({ error: "STUDENT_NOT_IN_COURSE" }, { status: 403 });
  if (course.stages[course.currentStageIndex]?.key !== input.stageKey) {
    return Response.json({ error: "STAGE_CHANGED", message: "课堂阶段已经变化，请返回课堂后重新进入。" }, { status: 409 });
  }
  return { authentication, course, student };
}

async function callCodeModel(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await callLLM(messages, {
      jsonMode: true,
      abortSignal: signal,
      maxTransientRetries: TRANSIENT_RETRIES,
    });
  } catch (error) {
    if (!(error instanceof LlmJsonModeUnsupportedError)) throw error;
    return callLLM(messages, {
      jsonMode: false,
      abortSignal: signal,
      maxTransientRetries: TRANSIENT_RETRIES,
    });
  }
}

function failureResponse(error: unknown): Response {
  if (isDocumentReviewScopeChanged(error)) return Response.json({ error: error.code, message: '课堂或身份已变化，原代码审阅已保留，请在当前课堂重新发起。' }, { status: 409 });
  if (error instanceof LlmRateLimitError || isProactiveReviewCapacityError(error)) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
    return Response.json(
      { error: "AI_RATE_LIMITED", message: `AI 组员当前请求较多，请在 ${seconds} 秒后重试。本次没有修改代码。` },
      { status: 429, headers: { "Retry-After": String(seconds) } },
    );
  }
  if (error instanceof LlmTimeoutError) {
    return Response.json({ error: "AI_TIMEOUT", message: "AI 组员本次思考超时，请重试。本次没有修改代码。" }, { status: 504 });
  }
  if (error instanceof LlmNotConfiguredError) {
    return Response.json({ error: "AI_NOT_CONFIGURED", message: "AI 服务尚未配置，请联系教师或管理员。" }, { status: 503 });
  }
  if (error instanceof LlmCallFailedError) {
    return Response.json({ error: "AI_UPSTREAM_FAILED", message: "AI 服务刚才出现短暂波动，请重新发送。本次没有修改代码。" }, { status: error.status === 429 ? 429 : 503 });
  }
  return Response.json({ error: "AI_FAILED", message: "AI 组员暂时无法回应，请稍后重试。本次没有修改代码。" }, { status: 503 });
}

function assistantRecord(result: CodeCollaborationResponse): string {
  // The student sees this thread again after refresh, so persist the same
  // natural response shown in the live UI. Structured change metadata is
  // returned separately and must not leak into the conversational voice.
  return result.message;
}

async function getCode(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = clean(url.searchParams.get("courseId"), 120);
  const studentId = clean(url.searchParams.get("studentId"), 120);
  const stageKey = clean(url.searchParams.get("stageKey"), 80);
  const language = parseLanguage(url.searchParams.get("language"));
  if (!courseId || !stageKey || !language) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  if (!COLLABORATION_STAGE_KEYS.has(stageKey)) {
    return Response.json({ error: "STAGE_NOT_SUPPORTED", message: "代码协作目前仅支持方案与制作阶段。" }, { status: 400 });
  }
  const authentication = await timeProgress("code-auth", () => authenticateStudent(request, courseId, studentId));
  if (authentication instanceof Response) return authentication;
  const context = await timeProgress("code-context", () => getCodeReadContext(courseId, authentication.studentId));
  if (!context) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  if (!context.student) return Response.json({ error: "STUDENT_NOT_IN_COURSE" }, { status: 403 });
  if (context.currentStageKey !== stageKey) {
    return Response.json({ error: "STAGE_CHANGED", message: "课堂阶段已经变化，请返回课堂后重新进入。" }, { status: 409 });
  }
  const scope = { authentication, student: context.student };
  const requestId = clean(url.searchParams.get("requestId"), 160);
  if (requestId) {
    const alias = await readCodeBackgroundAlias({ requestId, courseId, studentId: scope.student.id,
      participationId: scope.authentication.participationId, stageKey, workspaceKind: `code:${language}`, conversationId: '' });
    if (alias) return alias;
    const receipt = await readDocumentRequestReceipt({ requestId, courseId, studentId: scope.student.id,
      participationId: scope.authentication.participationId, stageKey, workspaceKind: `code:${language}`,
      conversationId: clean(url.searchParams.get("conversationId"), 160) });
    return Response.json(receipt.body, { status: receipt.status, headers: { "Cache-Control": "private, no-store" } });
  }
  const [thread, commentStore] = await timeProgress("code-history-threads", () => getCompanionThreadPair(courseId, scope.student.id,
    [threadKey(stageKey, language), commentThreadKey(stageKey, language)]));
  const conversationId = activeConversationId(thread?.messages ?? []);
  const memories = await timeProgress("code-history-memory", () => listProjectMemories(scope.authentication.participationId));
  return Response.json({
    conversationId,
    messages: visibleConversationMessages(thread?.messages ?? [], conversationId).slice(-40),
    commentThreads: codeCommentThreads(commentStore?.messages ?? []),
    memories,
    continuation: projectMemoryContinuation(memories),
  });
}

export const GET = withReadApiBoundary(withHttpMetrics("GET", "/api/ai-collaboration/code", getCode, {
  operation: request => new URL(request.url).searchParams.has("requestId") ? "ai-background" : "read",
}));

async function deleteCode(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = clean(url.searchParams.get("courseId"), 120);
  const requestedStudentId = clean(url.searchParams.get("studentId"), 120);
  const stageKey = clean(url.searchParams.get("stageKey"), 80);
  const language = parseLanguage(url.searchParams.get("language"));
  const messageId = clean(url.searchParams.get("messageId"), 160);
  const conversationId = clean(url.searchParams.get("conversationId"), 160);
  if (!courseId || !stageKey || !language || !messageId || !conversationId) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  const scope = await loadScope({ request, courseId, requestedStudentId, stageKey });
  if (scope instanceof Response) return scope;
  const key = threadKey(stageKey, language);
  const thread = await getCompanionThread(courseId, scope.student.id, key);
  if (conversationId !== activeConversationId(thread?.messages ?? [])) {
    return Response.json({ error: "CONVERSATION_CHANGED", message: "当前对话已经变化，请刷新后重试。" }, { status: 409 });
  }
  const changed = await softDeleteCompanionMessage({
    courseId,
    studentId: scope.student.id,
    stageKey: key,
    messageId,
    conversationId,
  });
  if (changed) {
    await dismissProjectMemories({
      participationId: scope.authentication.participationId,
      sourceMessageId: messageId,
    });
  }
  return Response.json({ ok: true, changed });
}

type QueuedCodeExecution = { job: QueuedCodeReview; signal: AbortSignal; completion: Awaited<ReturnType<typeof resumeCodeRequest>> };
export async function executeQueuedCodeReview(job: QueuedCodeReview, stopSignal: AbortSignal): Promise<Response> {
  const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(COLLABORATION_EXECUTION_TIMEOUT_MS)]);
  signal.throwIfAborted();
  await assertDocumentReviewScope(prisma, job.snapshot);
  const completion = await resumeCodeRequest(job.snapshot.task, { token: job.token, preparedResponse: job.preparedResponse },
    tx => assertDocumentReviewScope(tx, job.snapshot), signal);
  if (completion.response) return completion.response;
  const original = JSON.parse(job.snapshot.fingerprintSource) as { prompts: { system: string; user: string }; context: unknown };
  // JSONB may reorder nested prompt keys. Keep the original canonical-ID bytes
  // while still rejecting any changed prompt or context, not merely its order.
  if (!original.prompts || typeof original.prompts.system !== 'string' || typeof original.prompts.user !== 'string'
    || stableCodeDigest(original.prompts) !== stableCodeDigest(job.snapshot.prompts)
    || stableCodeDigest(original.context) !== stableCodeDigest(job.snapshot.context)) {
    throw new DocumentReviewScopeChanged('REVIEW_INPUT_CHANGED');
  }
  if (await codeBackgroundRequestId({ prompts: original.prompts, action: job.snapshot.task.intent,
    language: String(job.snapshot.body.language), context: original.context }) !== (job.snapshot.baseRequestId ?? job.snapshot.task.requestId)) {
    throw new DocumentReviewScopeChanged('REVIEW_INPUT_CHANGED');
  }
  return postCode(new NextRequest('http://internal.invalid/api/ai-collaboration/code', { method: 'POST',
    body: JSON.stringify(job.snapshot.body) }), { job, signal, completion: { ...completion,
    async fail(error: unknown, fallback: Response) {
      if (isBackgroundAiCapacityError(error) || isProactiveReviewCapacityError(error) || signal.aborted || isDocumentReviewScopeChanged(error)) throw error;
      const receipt = await completion.fail(error, fallback);
      // FAILED + retained lease is recoverable processing, not a completed
      // execution. Let the owning worker reschedule it immediately.
      return receipt.status === 200 ? receipt : fallback;
    },
  } });
}

async function postCode(request: NextRequest, queued?: QueuedCodeExecution) {
  let requestId = request.headers.get("x-request-id") ?? randomUUID();
  let body: CodeCollaborationRequest;
  try {
    body = await request.json() as CodeCollaborationRequest;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const courseId = clean(body.courseId, 120);
  const requestedStudentId = clean(body.studentId, 120);
  const stageKey = clean(body.stageKey, 80);
  const language = parseLanguage(body.language);
  const action = clean(body.action, 80);
  const message = clean(body.message, 1_600);
  const commentThreadId = clean(body.commentThreadId, 160);
  const mode = body.mode === "task" ? "task" : "discuss";
  requestId = clean(body.requestId, 160) || clean(requestId, 160) || randomUUID();
  if (queued) requestId = queued.job.snapshot.task.requestId;
  const clientRequestId = requestId;
  const intent = isCodeCollaborationIntent(body.intent) ? body.intent : undefined;
  if (!courseId || !stageKey || !language || (!action && (!intent || (intent !== "proactive-review" && !message)))) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (action === 'retry-code-background' && (!clean(body.requestId, 160)
    || clean(body.requestId, 160) === clean((body as Record<string, unknown>).targetRequestId, 160))) {
    return Response.json({ error: 'INVALID_RETRY_COMMAND', message: '重试需要独立且可恢复的命令编号。' }, { status: 400 });
  }
  const snapshot = queued?.job.snapshot;
  const savedStudent = snapshot?.course.students.find(student => student.id === snapshot.task.studentId);
  if (snapshot && !savedStudent) throw new DocumentReviewScopeChanged('REVIEW_SCOPE_CHANGED');
  const scope = snapshot && savedStudent ? { course: snapshot.course, student: savedStudent, authentication: {
    studentId: savedStudent.id, participationId: snapshot.task.participationId,
    claims: { sub: savedStudent.id, role: 'student', sv: snapshot.guard.identity.sessionVersion } as StudentClaims,
  } } : await loadScope({ request, courseId, requestedStudentId, stageKey });
  if (scope instanceof Response) return scope;
  // A bound alias is immutable across ALL operations, including a changed
  // action which would otherwise reset history or start interactive work.
  if (!queued && scope.authentication.claims?.sv) {
    const existing = await readCodeBackgroundAlias({ requestId: clientRequestId, courseId, studentId: scope.student.id,
      participationId: scope.authentication.participationId, stageKey, workspaceKind: `code:${language}`, conversationId: '' }, body as Record<string, unknown>,
      action === 'retry-code-background' ? clean((body as Record<string, unknown>).targetRequestId, 160) : clientRequestId);
    if (existing) return existing;
  }
  if (action === 'retry-code-background') {
    const targetRequestId = clean((body as Record<string, unknown>).targetRequestId, 160);
    if (!targetRequestId) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const identity = { requestId: targetRequestId, courseId, studentId: scope.student.id,
      participationId: scope.authentication.participationId, stageKey, workspaceKind: `code:${language}`, conversationId: '' };
    const alias = await findCodeBackgroundAlias(prisma, identity);
    if (!alias) return Response.json({ error: 'REQUEST_NOT_FOUND', requestId: targetRequestId }, { status: 404 });
    if ('conflict' in alias) return Response.json({ error: 'REQUEST_ID_CONFLICT', requestId: targetRequestId }, { status: 409 });
    try {
      const result = await resumeDocumentReview({ ...identity, requestId: alias.state.requestId, conversationId: alias.state.conversationId },
        { requestId: clientRequestId, body: body as Record<string, unknown> });
      if (result.kind === 'conflict') return Response.json({ error: 'REQUEST_ID_CONFLICT', requestId: targetRequestId }, { status: 409 });
      if (result.kind === 'full') return Response.json({ error: 'AI_PROACTIVE_REVIEW_BUSY', requestId: targetRequestId }, { status: 503, headers: { 'Retry-After': '10' } });
      return codeAliasResponse(result.state, targetRequestId);
    } catch (error) { return failureResponse(error); }
  }
  const key = threadKey(stageKey, language);
  const thread = await getCompanionThread(courseId, scope.student.id, key);
  const currentConversationId = snapshot?.task.conversationId ?? activeConversationId(thread?.messages ?? []);

  if (action === "reset-conversation") {
    const conversationId = `code-conversation-${randomUUID()}`;
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: key,
      messages: [companionMessage({
        role: "system-trigger",
        content: "学生在代码协作空间开始了新对话；此前记录保留用于学习过程分析。",
        visibility: "teacher-only",
        triggerKind: "conversation-reset",
        conversationId,
        authorName: "系统",
      })],
    });
    return Response.json({ ok: true, conversationId, messages: [] });
  }
  const serializedArtifact = typeof body.artifact === "string"
    ? body.artifact
    : JSON.stringify(body.artifact ?? null);
  if (serializedArtifact.length > MAX_ARTIFACT_LENGTH) {
    return Response.json({ error: "ARTIFACT_TOO_LARGE", message: "当前代码项目过大，请减少单次协作范围后重试。" }, { status: 413 });
  }
  const artifact = parseCodeArtifact(serializedArtifact, language);
  if (!artifact || artifact.files.length > 16) {
    return Response.json({ error: "INVALID_ARTIFACT" }, { status: 400 });
  }
  const selection = parseSelection(body.selection, language);
  const run = parseRunContext(body.run);

  if (action === "read-code-comment" || action === "resolve-code-comment") {
    if (!commentThreadId) return Response.json({ error: "INVALID_COMMENT_THREAD" }, { status: 400 });
    const commentStore = await getCompanionThread(courseId, scope.student.id, commentThreadKey(stageKey, language));
    const existing = codeCommentThreads(commentStore?.messages ?? []).find((item) => item.id === commentThreadId);
    if (!existing) return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    const at = new Date().toISOString();
    const prefix = action === "resolve-code-comment" ? COMMENT_RESOLVED_PREFIX : COMMENT_READ_PREFIX;
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: commentThreadKey(stageKey, language),
      messages: [companionMessage({
        role: "system-trigger",
        content: `${prefix}${JSON.stringify({ id: commentThreadId, at })}`,
        visibility: "teacher-only",
        triggerKind: action === "resolve-code-comment" ? "document-saved" : "document-comment-read",
        conversationId: commentThreadId,
        authorName: "系统",
      })],
    });
    return Response.json({ ok: true, at });
  }

  const background = action === "code-task-starters" || intent === "proactive-review";
  const executionDeadline = AbortSignal.timeout(COLLABORATION_EXECUTION_TIMEOUT_MS);
  const signal = queued?.signal ?? (background ? AbortSignal.any([request.signal, executionDeadline]) : executionDeadline);
  const model = (prompts: { system: string; user: string }) => withClassroomAiUsage({
    courseId, studentId: scope.student.id, requestId, feature: "code-collaboration",
  }, () => {
    const limiter = background ? codeSuggestionLimiter : companionLimiter;
    const admission = limiter.check(rateLimitKey(request, scope.student.id));
    if (!admission.allowed) throw new LlmRateLimitError(admission.retryAfterMs, "AI 请求较多，请稍后重试");
    const operation = () => callCodeModel([{ role: "system", content: prompts.system }, { role: "user", content: prompts.user }], signal);
    return background && !queued ? withProactiveReviewCapacity(operation,
      JSON.stringify(["code", courseId, scope.student.id, stageKey, language, action, intent, requestId])) : operation();
  });
  const begin = async (prompts: { system: string; user: string }, history: DocumentRequestInput["history"], comments = false,
    support?: Awaited<ReturnType<typeof resolveProjectSupportContext>>) => {
    if (queued) return queued.completion;
    const ownGroups = (scope.course.groups ?? []).filter(group => group.members.some(member => member.studentId === scope.student.id));
    const context = { artifact, selection: body.selection ?? null, run: body.run ?? null, mode,
      requirements: { name: scope.course.name, grade: scope.course.grade,
        drivingQuestion: scope.course.drivingQuestion, learningObjectives: scope.course.learningObjectives,
        expectedOutcome: scope.course.expectedOutcome, content: scope.course.content, pblConfig: scope.course.pblConfig,
        stage: scope.course.stages.find(stage => stage.key === stageKey), groups: ownGroups,
        feedback: (scope.course.feedback ?? []).filter(item => item.stageKey === stageKey && (item.targetType === "course" || item.targetId === scope.student.id || ownGroups.some(group => group.id === item.targetId))),
        directives: (scope.course.teacherAgentDirectives ?? []).filter(item => item.stageKey === stageKey && (item.targetScope === "course" || item.targetStudentIds.includes(scope.student.id))),
        evidence: (scope.course.learningEvidence ?? []).filter(item => item.studentId === scope.student.id && item.stageKey === stageKey),
      } };
    if (background) requestId = await codeBackgroundRequestId({ prompts, action: action || intent!, language, context });
    const task: DocumentRequestInput = { requestId, participationId: scope.authentication.participationId, courseId,
      studentId: scope.student.id, stageKey, workspaceKind: `code:${language}`,
      threadStageKey: comments ? commentThreadKey(stageKey, language) : key,
      conversationId: action === "reply-code-comment" ? commentThreadId : currentConversationId,
      documentVersion: codeRequestDigest(artifact), message, intent: action || intent!, history,
      fingerprint: codeRequestDigest(background ? { prompts, action, intent, language, context } : {
        action, intent, courseId, stageKey, language, message, artifact, selection, run, commentThreadId,
        conversationId: clean(body.conversationId, 160) || currentConversationId,
      }),
    };
    if (!background) return beginCodeRequest(task);
    if (!scope.authentication.claims?.sv) return { response: Response.json({ error: 'UNAUTHORIZED' }, { status: 401 }) };
    let admission;
    try {
      admission = await enqueueCodeReview({ task, course: scope.course, body: { ...body, courseId, studentId: scope.student.id, stageKey, language, action, intent, mode, message }, prompts, context, support },
        scope.authentication.claims.sv, { requestId: clientRequestId, body: body as Record<string, unknown> });
    } catch (error) { return { response: failureResponse(error) }; }
    if (admission.kind === 'conflict') return { response: Response.json({ error: 'REQUEST_ID_CONFLICT', requestId: clientRequestId }, { status: 409 }) };
    if (admission.kind === 'full') return { response: Response.json({ error: 'AI_PROACTIVE_REVIEW_BUSY', requestId: clientRequestId, retryAfterMs: 10_000 }, { status: 503, headers: { 'Retry-After': '10' } }) };
    return { response: codeAliasResponse(admission.state, clientRequestId) };
  };
  const events: AiInteractionEventInput[] = [];
  const recordInteractionEvents = async (input: AiInteractionEventInput[]) => { events.push(...input); };

  if (action === "code-task-starters") {
    const prompts = snapshot?.prompts ?? buildCodeTaskStarterPrompts({
      course: scope.course,
      studentId: scope.student.id,
      stageKey,
      artifact,
      run,
      mode,
    });
    const task = await begin(prompts, []);
    if (task.response) return task.response;
    try {
      const raw = await model(prompts);
      return await task.finish!({ starters: normalizeCodeTaskStarters(parseLLMJson(raw)) }, []);
    } catch (error) { return task.fail!(error, failureResponse(error)); }
  }

  if (action === "reply-code-comment") {
    if (!commentThreadId || !message) return Response.json({ error: "INVALID_COMMENT_REPLY" }, { status: 400 });
    const commentStore = await getCompanionThread(courseId, scope.student.id, commentThreadKey(stageKey, language));
    const existing = codeCommentThreads(commentStore?.messages ?? []).find((item) => item.id === commentThreadId);
    if (!existing) return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    const replyIntent: CodeCollaborationIntent = /(?:改|修复|删除|删掉|新增|补上|替换|调整|写入|应用|处理掉)/.test(message)
      ? "edit"
      : "discuss";
    const protectedBoundary = detectProtectedCodeWorkRequest(message);
    let prompts = buildCodeCollaborationPrompts({
      course: scope.course,
      studentId: scope.student.id,
      studentName: scope.student.name,
      stageKey,
      intent: replyIntent,
      request: message,
      artifact,
      selection: threadSelection(existing, artifact),
      run,
      history: existing.comments.slice(-8).map((item) => ({
        role: item.role === "student" ? "user" : "assistant",
        content: item.content,
      })),
      protectedBoundary,
    });
    const task = await begin(prompts, existing.comments.slice(-8).map(item => ({ role: item.role === "student" ? "user" : "assistant", content: item.content })), true);
    if (task.response) return task.response;
    prompts = buildCodeCollaborationPrompts({ course: scope.course, studentId: scope.student.id,
      studentName: scope.student.name, stageKey, intent: replyIntent, request: message, artifact,
      selection: threadSelection(existing, artifact), run, history: task.history, protectedBoundary });
    try {
      const raw = await model(prompts);
      const result = normalizeCodeCollaborationResponse({
        raw: parseLLMJson(raw) as Record<string, unknown>,
        artifact,
        intent: replyIntent,
        protectedBoundary,
      });
      const studentMessage = companionMessage({
        role: "student",
        content: message,
        visibility: "student-and-teacher",
        conversationId: commentThreadId,
        authorId: scope.student.id,
        authorName: scope.student.name,
      });
      const agentMessage = companionMessage({
        role: "agent",
        content: result.message,
        visibility: "student-and-teacher",
        conversationId: commentThreadId,
        companionId: "critic",
        authorName: "AI 组员",
      });
      await recordInteractionEvents([
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: commentThreadId,
          source: "proactive-comment",
          eventType: "request",
          actorRole: "student",
          actorId: scope.student.id,
          content: message,
          payload: { intent: replyIntent, language, targetText: existing.quotedCode },
          requestId,
        },
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: commentThreadId,
          source: "proactive-comment",
          eventType: "policy",
          actorRole: "system",
          content: protectedBoundary ? `命中代码协作边界：${protectedBoundary}` : "本轮未命中强制代码协作边界。",
          payload: { ...(protectedBoundary ? { protectedCapability: protectedBoundary } : {}), outcome: result.kind },
          requestId,
        },
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: commentThreadId,
          source: "proactive-comment",
          eventType: "response",
          actorRole: "ai",
          content: result.message,
          payload: { kind: result.kind, language },
          requestId,
        },
      ]);
      return await task.finish!({
        commentThread: {
          ...existing,
          comments: [
            ...existing.comments,
            { id: studentMessage.id, role: "student", content: studentMessage.content, createdAt: studentMessage.createdAt },
            { id: agentMessage.id, role: "assistant", content: agentMessage.content, createdAt: agentMessage.createdAt },
          ],
        } satisfies CodeAiCommentThread,
        result,
      }, [studentMessage, agentMessage], events);
    } catch (error) { return task.fail!(error, failureResponse(error)); }
  }

  if (!intent) return Response.json({ error: "INVALID_INTENT" }, { status: 400 });
  const protectedBoundary = intent === "proactive-review" ? undefined : detectProtectedCodeWorkRequest(message);

  try {
    const history = intent === "proactive-review"
      ? []
      : modelConversationHistory(thread?.messages ?? [], currentConversationId);
    const projectSupportContext = snapshot?.support ?? await resolveProjectSupportContext({
      course: scope.course,
      studentId: scope.student.id,
      participationId: scope.authentication.participationId,
      message,
      history,
      allowRetrieval: intent !== "proactive-review" && ["discuss", "review", "delegate"].includes(intent),
      signal,
    });
    let prompts = snapshot?.prompts ?? buildCodeCollaborationPrompts({
      course: scope.course,
      studentId: scope.student.id,
      studentName: scope.student.name,
      stageKey,
      intent,
      request: message,
      artifact,
      selection,
      run,
      history,
      protectedBoundary,
      projectSupportContext: projectSupportContext.promptContext,
    });
    const task = await begin(prompts, history, intent === "proactive-review", projectSupportContext);
    if (task.response) return task.response;
    if (!background) prompts = buildCodeCollaborationPrompts({ course: scope.course, studentId: scope.student.id,
      studentName: scope.student.name, stageKey, intent, request: message, artifact, selection, run,
      history: task.history, protectedBoundary, projectSupportContext: projectSupportContext.promptContext });
    try {
      const raw = await model(prompts);
      const parsed = parseLLMJson(raw) as Record<string, unknown>;
      const result = normalizeCodeCollaborationResponse({
        raw: parsed,
        artifact,
        intent,
        protectedBoundary,
      });
      const normalizedSupport = normalizeProjectSupportOutput(
        parsed.support,
        projectSupportContext.sources,
        projectSupportContext,
        projectSupportContext.knowledgePointLabels,
      );
      result.support = normalizedSupport.details;
      if (normalizedSupport.details.replyBlocks?.length) {
        result.message = normalizedSupport.details.replyBlocks.map((block) => block.content).join("\n\n");
      }
      if (intent === "proactive-review") {
        const commentStore = await getCompanionThread(courseId, scope.student.id, commentThreadKey(stageKey, language));
        const existingThreads = codeCommentThreads(commentStore?.messages ?? []);
        const existingFingerprints = new Set(existingThreads.filter((item) => !item.resolvedAt).map((item) => [
          item.filePath,
          item.startLine,
          item.endLine,
          item.title,
          item.quotedCode,
        ].join(":")));
        const commentThreads: CodeAiCommentThread[] = [];
        const messages: CompanionMessage[] = [];
        result.findings.forEach((finding) => {
          const fingerprint = [
            finding.filePath,
            finding.startLine,
            finding.endLine,
            finding.title,
            finding.quotedCode,
          ].join(":");
          if (existingFingerprints.has(fingerprint)) return;
          existingFingerprints.add(fingerprint);
          const id = `code-comment-${randomUUID()}`;
          const createdAt = new Date().toISOString();
          const meta: CodeCommentMeta = {
            id,
            filePath: finding.filePath,
            startLine: finding.startLine,
            endLine: finding.endLine,
            severity: finding.severity,
            title: finding.title,
            quotedCode: finding.quotedCode,
            createdAt,
            reviewVersion: CODE_COMMENT_REVIEW_VERSION,
          };
          const metaMessage = companionMessage({
            role: "system-trigger",
            content: encodeCodeCommentMeta(meta),
            visibility: "teacher-only",
            triggerKind: "document-saved",
            conversationId: id,
            authorName: "系统",
          });
          const agentMessage = companionMessage({
            role: "agent",
            content: finding.message,
            visibility: "student-and-teacher",
            companionId: "critic",
            conversationId: id,
            authorName: "AI 组员",
          });
          messages.push(metaMessage, agentMessage);
          commentThreads.push({
            ...meta,
            comments: [{
              id: agentMessage.id,
              role: "assistant",
              content: agentMessage.content,
              createdAt: agentMessage.createdAt,
            }],
          });
        });
        if (messages.length) {
          await recordInteractionEvents(commentThreads.map((thread) => ({
            courseId,
            studentId: scope.student.id,
            stageKey,
            conversationId: thread.id,
            source: "proactive-comment" as const,
            eventType: "comment" as const,
            actorRole: "ai" as const,
            content: thread.comments[0]?.content ?? "AI 组员发起了代码批注。",
            payload: {
              commentThreadId: thread.id,
              filePath: thread.filePath,
              startLine: thread.startLine,
              endLine: thread.endLine,
              issueType: thread.title,
              targetText: thread.quotedCode,
              initialComment: true,
            },
            requestId,
          })));
        }
        return await task.finish!({ result, commentThreads }, messages, events);
      }

      const userMessage = companionMessage({
        role: "student",
        content: message,
        visibility: "student-and-teacher",
        conversationId: currentConversationId,
        authorName: scope.student.name,
      });
      const agentMessage = companionMessage({
        role: "agent",
        content: assistantRecord(result),
        visibility: "student-and-teacher",
        conversationId: currentConversationId,
        companionId: intent === "review" ? "critic" : intent === "delegate" ? "knowledge" : "planner",
        authorName: "AI 组员",
        projectSupport: result.support,
      });
      let memories = await listProjectMemories(scope.authentication.participationId);
      if (normalizedSupport.memoryCandidates.length) {
        try {
          memories = await saveProjectMemoryCandidates({
            participationId: scope.authentication.participationId,
            stageKey,
            studentId: scope.student.id,
            studentMessage: message,
            sourceMessageIds: [userMessage.id, agentMessage.id],
            candidates: normalizedSupport.memoryCandidates,
          });
        } catch (memoryError) {
          console.error("[ai-code-collaboration] project memory write failed", memoryError);
        }
      }
      const source = selection ? "selection" as const : "sidebar" as const;
      await recordInteractionEvents([
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: currentConversationId,
          source,
          eventType: "request",
          actorRole: "student",
          actorId: scope.student.id,
          content: message,
          payload: { intent, language, selection: selection ?? null },
          requestId,
        },
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: currentConversationId,
          source,
          eventType: "policy",
          actorRole: "system",
          content: protectedBoundary ? `命中代码协作边界：${protectedBoundary}` : "本轮未命中强制代码协作边界。",
          payload: { ...(protectedBoundary ? { protectedCapability: protectedBoundary } : {}), outcome: result.kind },
          requestId,
        },
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: currentConversationId,
          source,
          eventType: "response",
          actorRole: "ai",
          content: assistantRecord(result),
          payload: { kind: result.kind, language, support: result.support ?? null },
          requestId,
        },
      ]);
      return await task.finish!({
        result,
        conversationId: currentConversationId,
        messages: [userMessage, agentMessage],
        memories,
      }, [userMessage, agentMessage], events);
    } catch (error) { return task.fail!(error, failureResponse(error)); }
  } catch (error) {
    if (queued && (isBackgroundAiCapacityError(error) || isProactiveReviewCapacityError(error) || signal.aborted || isDocumentReviewScopeChanged(error))) throw error;
    if (request.signal.aborted) return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
    return failureResponse(error);
  }
}

export const POST = withReadApiBoundary((request: NextRequest) => postCode(request));

export const DELETE = withReadApiBoundary(deleteCode);

export const OPTIONS = readApiOptionsFor(["GET", "POST", "DELETE"]);
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
