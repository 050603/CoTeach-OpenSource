import { DOCUMENT_DISCUSSION_FIDELITY_VERSION, DOCUMENT_DISCUSSION_FIDELITY_RULE, inspectDocumentDiscussionFidelity } from "./document-discussion-fidelity";
import { timeProgress, timeProgressSync } from "@/lib/observability/progress-request-timing";
import { documentRequestFailureDetails } from "./document-request-failure";
import { cancelRetiredDocumentReviews, isDocumentReviewScopeChanged, type QueuedDocumentReview } from "./document-review-queue";
import { DOCUMENT_COMMENT_ANCHOR_VERSION } from "@/lib/ai-collaboration/document-comment-anchor";
import { restoreDocumentCommentReplyOrder } from "@/lib/ai-collaboration/document-comment-history";
import { COLLABORATION_EXECUTION_TIMEOUT_MS, DOCUMENT_COLLABORATION_EXECUTION_TIMEOUT_MS } from "@/lib/ai-collaboration/request-budget";
import { after } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { NextRequest } from "next/server";
import {
  buildDocumentCollaborationPrompts,
  buildDocumentDiscussionReviewPrompts,
  coreConclusionResponsePolicy,
  inspectCoreConclusionResponse,
  documentDiscussionReviewPassed,
  isValidDocumentDiscussionReview,
  DOCUMENT_DISCUSSION_REVIEW_VERSION,
  DOCUMENT_COLLABORATION_POLICY_VERSION,
  buildAuthoritativeCourseContext,
  documentHtmlToPlainText,
  evaluateAiWorkPolicy,
  isDocumentCollaborationIntent,
  normalizeDocumentCollaborationResponse,
  protectedBoundaryForPolicy,
  separableAuxiliaryTask,
  type DocumentCollaborationIntent,
  type DocumentCollaborationResponse,
  type AiWorkPolicyDecision,
} from "@/lib/ai-collaboration/document-policy";
import { appendDurableAiInteractionEvents } from "@/lib/ai-collaboration/audit-outbox";
import { DocumentModelStructureError, repairDocumentModelResponse, type DocumentModelMessage } from "@/lib/ai-collaboration/document-model-response";
import { recordedStructuredResponse, type StructuredModelAttempt } from "@/lib/ai-collaboration/recorded-structured-response";
import { readDocumentRequestHtml, readDocumentRequestMessage } from "@/lib/ai-collaboration/document-request-input";
import {
  buildDocumentCommentReplyPrompts,
  documentParagraphVersionFingerprint,
  normalizeDocumentCommentReply,
  DOCUMENT_COMMENT_REVIEW_VERSION,
} from "@/lib/ai-collaboration/document-comment-policy";
import type {
  DocumentAiComment,
  DocumentAiCommentThread,
} from "@/lib/ai-collaboration/document-comment-types";
import {
  assessmentToBoundaryResponse,
  buildDelegatedWorkAssessmentPrompts,
  buildDelegatedWorkExecutionPrompts,
  buildDelegatedWorkDeliveryReviewPrompts,
  isValidDelegatedWorkAssessment,
  inspectDelegatedWorkPlacement,
  isValidDelegatedWorkDeliveryReview,
  normalizeDelegatedWorkDeliveryReview,
  buildDelegatedWorkStarterReviewPrompts,
  buildDelegatedWorkStarterPrompts,
  generateDelegatedDeliveryWithRepair,
  normalizeDelegatedWorkAssessment,
  normalizeDelegatedWorkDelivery,
  normalizeDelegatedWorkStarters,
  type DelegatedDeliveryCheckpoint,
  DELEGATED_DELIVERY_POLICY_VERSION,
  headingNumberingAssessmentPolicy,
} from "@/lib/ai-collaboration/delegated-work-policy";
import {
  activeConversationId,
  modelConversationHistory,
  visibleConversationMessages,
} from "@/lib/ai-collaboration/conversation-window";
import {
  companionLimiter,
  getClientIp,
  rateLimitKey,
  rateLimitedResponse,
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
import { getActiveAiSettings } from "@/lib/llm/settings";
import { withClassroomAiUsage } from "@/lib/observability/classroom-ai";
import { buildDocumentSuggestionRequest, cachedDocumentSuggestions } from "@/lib/ai-collaboration/document-suggestion-cache";
import {
  LlmCallFailedError,
  LlmJsonModeUnsupportedError,
  LlmNotConfiguredError,
  LlmRateLimitError,
  LlmTimeoutError,
} from "@/lib/llm/errors";
import { getDocumentReadContext } from "@/lib/ai-collaboration/document-read-context";
import { getDocumentCourseContext } from "@/lib/ai-collaboration/document-course-context";
import { authenticateLegacyAiStudent } from "@/lib/ai-collaboration/legacy-scope";
import { CourseAdmissionTimeoutError } from "@/lib/db/transaction-retry";
import { PlatformError } from "@/lib/platform/repository";
import type { AiCompanionId } from "@/lib/ai-companions";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import type { CompanionMessage, Course, Student } from "@/lib/session/types";
import { normalizeProjectSupportOutput, type ProjectMemoryCandidate } from "@/lib/ai-collaboration/project-support-types";
import {
  dismissProjectMemories,
  listProjectMemories,
  projectMemoryContinuation,
  resolveProjectSupportContext,
  saveProjectMemoryCandidates,
} from "@/lib/ai-collaboration/project-support-server";
import {
  collaborationWorkspaceInstruction,
  normalizeCollaborationWorkspaceKind,
  type CollaborationWorkspaceKind,
} from "@/lib/ai-collaboration/workspace-kind";
import {
  isProactiveReviewCapacityError,
  withProactiveReviewCapacity,
} from "@/lib/ai-collaboration/proactive-review-capacity";
import {
  cancelDocumentRequest,
  claimDocumentRequest,
  completeDocumentRequest,
  failDocumentRequest,
  getDocumentRequest,
  readDocumentRequestReceipt,
  prepareDocumentRequestResponse,
  listDocumentRequests,
  readDelegatedWorkSummary,
  type DocumentRequestInput,
} from "@/lib/ai-collaboration/document-request-store";


const COLLABORATION_STAGE_KEYS = new Set(["proposal", "make"]);
const THREAD_PREFIX = "ai-collaboration";
const COMMENT_THREAD_PREFIX = "ai-collaboration-comments";
const COMMENT_META_PREFIX = "OPENPBL_DOCUMENT_COMMENT_META:";
const COMMENT_READ_PREFIX = "OPENPBL_DOCUMENT_COMMENT_READ:";
const COMMENT_STATUS_PREFIX = "OPENPBL_DOCUMENT_COMMENT_STATUS:";
const COMMENT_SUGGESTION_PREFIX = "OPENPBL_DOCUMENT_COMMENT_SUGGESTION:";
const COMMENT_REVIEW_PREFIX = "OPENPBL_DOCUMENT_COMMENT_REVIEW:";
const COLLABORATION_TRANSIENT_RETRIES = 2;
const activeDocumentRequests = new Map<string, AbortController>();

function proactiveReviewEnabled(): boolean {
  return false;
}

function documentRequestKey(participationId: string, requestId: string): string {
  return `${participationId}:${requestId}`;
}

async function persistedDocumentRequestResponse(input: DocumentRequestInput): Promise<Response> {
  const receipt = await readDocumentRequestReceipt(input);
  return Response.json(receipt.body, { status: receipt.status });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function callStructuredCollaborationModel(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal,
  valid: (value: Record<string, unknown>) => boolean,
  record: (attempt: StructuredModelAttempt) => Promise<void>,
): Promise<Record<string, unknown>> {
  return recordedStructuredResponse({ signal, valid, record, parse: parseLLMJson,
    generate: attempt => callCollaborationModel(attempt === 1 ? messages : [
      ...messages,
      { role: "user", content: "上一条回答的 JSON 结构不完整。请只返回一个严格 JSON 对象，保留本轮任务和教学边界，完整填写必需字段。" },
    ], signal),
  });
}

type PaidReviewOutput = { fingerprint: string; repairStructure: boolean; raw: string };
function savedReviewOutputs(value: unknown): PaidReviewOutput[] {
  return Array.isArray(value) ? value.filter((item): item is PaidReviewOutput => item && typeof item === "object"
    && typeof item.fingerprint === "string" && typeof item.repairStructure === "boolean" && typeof item.raw === "string").slice(-2) : [];
}

/** Draft structure, review structure and content share one persisted repair. */
async function reviewedDocumentDiscussion(input: {
  messages: DocumentModelMessage[];
  compactMessages: () => DocumentModelMessage[];
  request: string;
  expectedKind: "boundary" | "discussion" | "task-clarification";
  documentText: string;
  studentHistory: string[];
  initialDraft?: string;
  initialRepairUsed?: boolean;
  lockedResponse?: Record<string, unknown>;
  signal: AbortSignal;
  prepared?: Record<string, unknown>;
  checkpoint: (value: Record<string, unknown>) => Promise<void>;
  record: (step: string, attempt: StructuredModelAttempt) => Promise<void>;
  visibleCandidate: (candidate: Record<string, unknown>) => Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const fingerprint = digest({ version: DOCUMENT_DISCUSSION_REVIEW_VERSION, paidReviewVersion: 1, messages: input.messages, request: input.request,
    expectedKind: input.expectedKind, lockedResponse: input.lockedResponse,
    fidelityVersion: DOCUMENT_DISCUSSION_FIDELITY_VERSION, documentText: input.documentText, studentHistory: input.studentHistory,
    ...coreConclusionResponsePolicy(input.request, input.expectedKind, input.expectedKind === "boundary") });
  type PendingRepair = { kind: "draft" | "review"; issues: string[] };
  const prepared = input.prepared?.discussionReview as { fingerprint?: unknown; drafts?: unknown; repairUsed?: unknown; pendingRepair?: PendingRepair | null; reviewOutputs?: unknown } | undefined;
  const reusable = prepared?.fingerprint === fingerprint && Array.isArray(prepared.drafts)
    && prepared.drafts.length <= 2 && prepared.drafts.every(raw => typeof raw === "string")
    && typeof prepared.repairUsed === "boolean";
  const state = { fingerprint, drafts: reusable ? [...prepared.drafts as string[]] : [] as string[],
    repairUsed: reusable ? prepared.repairUsed as boolean : input.initialRepairUsed ?? false,
    pendingRepair: reusable ? prepared.pendingRepair ?? null : null as PendingRepair | null,
    reviewOutputs: reusable ? savedReviewOutputs(prepared.reviewOutputs) : [] as PaidReviewOutput[] };
  const save = () => input.checkpoint({ discussionReview: { ...state, drafts: [...state.drafts], reviewOutputs: [...state.reviewOutputs] } });
  const reserveRepair = async (kind: PendingRepair["kind"], issues: string[]) => {
    if (state.repairUsed) throw new Error("AI_DISCUSSION_REVIEW_FAILED");
    state.repairUsed = true;
    state.pendingRepair = { kind, issues };
    await save();
    input.signal.throwIfAborted();
  };
  const generate = async (issues?: string[]) => {
    input.signal.throwIfAborted();
    const repairMessages: DocumentModelMessage[] = issues ? [
        { role: "assistant" as const, content: state.drafts.at(-1) ?? "" },
        { role: "user" as const, content: `修复本轮回复，保持原任务和教学边界，不扩大范围。纠正以下具体问题并返回完整严格JSON，kind=${input.expectedKind}、非空message、suggestion=null；${input.expectedKind === "boundary" ? "保持强制核心学习边界，不得降级为普通讨论或在拒绝后交付替代分析/结论。" : input.expectedKind === "task-clarification" ? "只修正澄清问题，不执行尚未获准的任务。" : "按本轮请求进行讨论、检查或忠实总结，不提供替写。"}${input.lockedResponse ? "只可修改message/focus，其余判定、责任与字段由服务端保留，不得新增操作或交付物。" : ""}\n${issues.join("\n")}` },
    ] : [];
    let raw: string;
    try {
      raw = await timeProgress(issues ? "document-discussion-repair" : "document-discussion-initial",
        () => callCollaborationModel([...input.messages, ...repairMessages], input.signal));
    } catch (error) {
      if (!(error instanceof LlmCallFailedError) || upstreamFailureCategory(error) !== "context-limit") throw error;
      // Preserve the existing context-limit recovery; there are no draft bytes
      // to repair yet, and this call shares the original deadline and settings.
      raw = await timeProgress("document-model-context-retry", () => callLLM([...input.compactMessages(), ...repairMessages], {
        jsonMode: false, abortSignal: input.signal, maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
      }));
    }
    state.drafts.push(raw);
    if (issues) state.pendingRepair = null;
    // Save paid bytes before parsing or reviewing, including malformed drafts.
    await save();
    await input.record("discussion-draft", { raw, sha256: digest(raw), attempt: state.drafts.length, validation: "received" });
    input.signal.throwIfAborted();
    return raw;
  };
  if (!state.drafts.length && input.initialDraft !== undefined) {
    state.drafts.push(input.initialDraft);
    await save();
    await input.record("discussion-seed", { raw: input.initialDraft, sha256: digest(input.initialDraft), attempt: 1, validation: "received" });
  }
  // A transport failure with no returned repair bytes resumes that unfinished
  // phase on an explicit failed-request retry. A saved repair is never regenerated.
  let raw = state.pendingRepair?.kind === "draft" ? await generate(state.pendingRepair.issues)
    : state.drafts.at(-1) ?? await generate();
  let reviewAttempt = 0;
  while (true) {
    input.signal.throwIfAborted();
    let candidate: Record<string, unknown> | undefined;
    try {
      const value = parseLLMJson<Record<string, unknown>>(raw);
      if (value && typeof value === "object" && !Array.isArray(value)
        && typeof value.message === "string" && value.message.trim()
        && ["discussion", "boundary", "edit-suggestion", "task-clarification"].includes(String(value.kind))) candidate = value;
    } catch { /* Structure failures consume the same repair as semantic errors. */ }
    if (!candidate) {
      const issues = ["回复JSON结构不完整或message为空。"];
      await reserveRepair("draft", issues);
      raw = await generate(issues);
      continue;
    }
    const visibleCandidate = input.visibleCandidate(candidate);
    const conclusionIssues = [...inspectCoreConclusionResponse(input.request, input.expectedKind, visibleCandidate, input.expectedKind === "boundary"),
      ...inspectDocumentDiscussionFidelity({ documentText: input.documentText, request: input.request, studentHistory: input.studentHistory }, visibleCandidate)];
    const prompts = buildDocumentDiscussionReviewPrompts({ context: input.messages.map(message => message.content).join("\n\n"), request: input.request, candidate: visibleCandidate, expectedKind: input.expectedKind });
    const review = async (repairStructure = false) => recordedStructuredResponse({
      signal: input.signal, maxCalls: 1, parse: parseLLMJson, valid: isValidDocumentDiscussionReview,
      generate: async () => {
        const reviewFingerprint = digest({ prompts, draftAttempt: state.drafts.length });
        const paid = state.reviewOutputs.find(output => output.fingerprint === reviewFingerprint && output.repairStructure === repairStructure);
        if (paid) return paid.raw;
        // This pass verifies a fixed candidate against explicit checks. Keep
        // generation's reasoning unchanged; avoid a second open-ended reasoning
        // pass here, using the provider's existing screening adapter.
        const reviewRaw = await timeProgress("document-discussion-review", () => callCollaborationModel([
          { role: "system", content: prompts.system }, { role: "user", content: prompts.user },
          ...(repairStructure ? [{ role: "user" as const, content: "上一条复核JSON结构不完整；只修复复核结构，完整填写全部checks、passed与issues。不要改写候选回复。" }] : []),
        ], input.signal, { lightweightScreening: true }));
        state.reviewOutputs.push({ fingerprint: reviewFingerprint, repairStructure, raw: reviewRaw });
        await save();
        return reviewRaw;
      },
      record: async attempt => {
        await input.record("discussion-review", { ...attempt, attempt: ++reviewAttempt });
      },
    });
    let verdict: Record<string, unknown>;
    try {
      const paidRepair = state.reviewOutputs.some(output => output.fingerprint === digest({ prompts, draftAttempt: state.drafts.length }) && output.repairStructure);
      verdict = await review(state.pendingRepair?.kind === "review" || paidRepair);
      if (state.pendingRepair?.kind === "review") { state.pendingRepair = null; await save(); }
    }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "AI_RESPONSE_INVALID_STRUCTURE") throw error;
      if (state.pendingRepair?.kind === "review") { state.pendingRepair = null; await save(); }
      await reserveRepair("review", ["复核JSON结构不完整。"]);
      try { verdict = await review(true); state.pendingRepair = null; await save(); }
      catch (repairError) {
        if (repairError instanceof Error && repairError.message === "AI_RESPONSE_INVALID_STRUCTURE") throw new Error("AI_DISCUSSION_REVIEW_FAILED");
        throw repairError;
      }
    }
    const changedLockedFields = input.lockedResponse && Object.entries(candidate).some(([key, value]) =>
      !["message", "focus"].includes(key) && !(key === "suggestion" && value == null)
      && !isDeepStrictEqual(value, input.lockedResponse![key]));
    if (documentDiscussionReviewPassed(verdict) && candidate.kind === input.expectedKind && candidate.suggestion == null && !changedLockedFields && !conclusionIssues.length) return candidate;
    const issues = (verdict.issues as string[]).filter(Boolean);
    const repairIssues = [...issues, ...conclusionIssues,
      ...(candidate.kind !== input.expectedKind ? [`本轮必须保持 kind=${input.expectedKind}，不能改变服务端判定的教学边界。`] : []),
      ...(candidate.suggestion != null ? ["本轮不得生成文稿修改操作。"] : []),
      ...(changedLockedFields ? ["只允许修正message/focus，不得改变已锁定的判定、学生责任或新增字段/交付。"] : []),
    ];
    if (!repairIssues.length) repairIssues.push("回复未通过事实、推理或教学边界检查；按原任务回应，不生成替写或文稿操作。");
    await reserveRepair("draft", repairIssues);
    raw = await generate(repairIssues);
  }
}

async function recordInteractionEvents(
  events: Parameters<typeof appendDurableAiInteractionEvents>[0],
  workspaceKind?: CollaborationWorkspaceKind,
): Promise<void> {
  await appendDurableAiInteractionEvents(workspaceKind
    ? events.map(event => ({ ...event, payload: { ...(event.payload ?? {}), workspaceKind } }))
    : events);
}

type DocumentCollaborationRequest = {
  courseId?: unknown;
  studentId?: unknown;
  stageKey?: unknown;
  intent?: unknown;
  message?: unknown;
  documentHtml?: unknown;
  selectedText?: unknown;
  history?: unknown;
  proactive?: unknown;
  action?: unknown;
  conversationId?: unknown;
  revisionOf?: unknown;
  commentThreadId?: unknown;
  targetText?: unknown;
  blockIndex?: unknown;
  blockId?: unknown;
  paragraphs?: unknown;
  contributionId?: unknown;
  workspaceKind?: unknown;
  requestId?: unknown;
  status?: unknown;
};

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function collaborationThreadKey(
  stageKey: string,
  workspaceKind: CollaborationWorkspaceKind = "document",
): string {
  return workspaceKind === "external-artifact"
    ? `${THREAD_PREFIX}:external-artifact:${stageKey}`
    : `${THREAD_PREFIX}:${stageKey}`;
}

function documentCommentThreadKey(
  stageKey: string,
  workspaceKind: CollaborationWorkspaceKind = "document",
): string {
  return workspaceKind === "external-artifact"
    ? `${COMMENT_THREAD_PREFIX}:external-artifact:${stageKey}`
    : `${COMMENT_THREAD_PREFIX}:${stageKey}`;
}

function withWorkspaceInstruction(
  system: string,
  workspaceKind: CollaborationWorkspaceKind,
): string {
  const instruction = collaborationWorkspaceInstruction(workspaceKind);
  return instruction ? `${system}\n\n${instruction}` : system;
}

type DocumentCommentMeta = {
  id: string;
  blockId?: string;
  anchorVersion?: 1;
  blockIndex: number;
  blockText?: string;
  targetText: string;
  issueType?: string;
  issueKey?: string;
  severity?: "critical" | "improvement" | "style";
  evidenceSource?: "document" | "course";
  evidenceQuote?: string;
  impact?: string;
  relatedAnchors?: Array<{ blockId?: string; blockIndex: number; targetText: string }>;
  createdAt: string;
  reviewVersion?: number;
};

type DocumentReviewCheckpoint = {
  fingerprint: string;
  blockId?: string;
  blockIndex: number;
  reviewedAt: string;
  reviewVersion: number;
};

function parseDocumentReviewCheckpoint(message: CompanionMessage): DocumentReviewCheckpoint | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_REVIEW_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_REVIEW_PREFIX.length)) as Record<string, unknown>;
    const fingerprint = boundedString(raw.fingerprint, 120);
    const blockId = boundedString(raw.blockId, 160) || undefined;
    const blockIndex = Number(raw.blockIndex);
    const reviewedAt = boundedString(raw.reviewedAt, 80) || message.createdAt;
    const reviewVersion = Number(raw.reviewVersion);
    if (
      !fingerprint
      || !Number.isInteger(blockIndex)
      || blockIndex < 0
      || !Number.isInteger(reviewVersion)
      || reviewVersion < 1
    ) return null;
    return { fingerprint, blockId, blockIndex, reviewedAt, reviewVersion };
  } catch {
    return null;
  }
}

function documentReviewedParagraphFingerprints(messages: CompanionMessage[]): string[] {
  const fingerprints = new Set(messages
    .map(parseDocumentReviewCheckpoint)
    .filter((checkpoint): checkpoint is DocumentReviewCheckpoint =>
      Boolean(checkpoint && checkpoint.reviewVersion === DOCUMENT_COMMENT_REVIEW_VERSION)
    )
    .map((checkpoint) => checkpoint.fingerprint));

  documentCommentThreads(messages)
    .filter((thread) =>
      thread.reviewVersion === DOCUMENT_COMMENT_REVIEW_VERSION
      && Boolean(thread.blockText)
    )
    .forEach((thread) => {
      fingerprints.add(documentParagraphVersionFingerprint(thread.blockText ?? ""));
    });
  return [...fingerprints];
}

function parseDocumentCommentMeta(message: CompanionMessage): DocumentCommentMeta | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_META_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_META_PREFIX.length)) as Record<string, unknown>;
    const id = boundedString(raw.id, 160);
    const blockId = boundedString(raw.blockId, 160) || undefined;
    const blockText = boundedString(raw.blockText, 3_000) || undefined;
    const targetText = boundedString(raw.targetText, 3_000);
    const issueType = boundedString(raw.issueType, 40) || undefined;
    const issueKey = boundedString(raw.issueKey, 160) || undefined;
    const severity = raw.severity === "critical" || raw.severity === "improvement" || raw.severity === "style"
      ? raw.severity : undefined;
    const evidenceSource = raw.evidenceSource === "document" || raw.evidenceSource === "course"
      ? raw.evidenceSource : undefined;
    const evidenceQuote = boundedString(raw.evidenceQuote, 500) || undefined;
    const impact = boundedString(raw.impact, 500) || undefined;
    const relatedAnchors = Array.isArray(raw.relatedAnchors)
      ? raw.relatedAnchors.slice(0, 16).flatMap((anchor) => {
          const item = jsonRecord(anchor);
          const index = Number(item?.blockIndex);
          const text = boundedString(item?.targetText, 3_000);
          return Number.isInteger(index) && index >= 0 && text
            ? [{ blockId: boundedString(item?.blockId, 160) || undefined, blockIndex: index, targetText: text }]
            : [];
        }) : undefined;
    const blockIndex = Number(raw.blockIndex);
    const createdAt = boundedString(raw.createdAt, 80) || message.createdAt;
    const reviewVersion = Number(raw.reviewVersion);
    if (!id || !targetText || !Number.isInteger(blockIndex) || blockIndex < 0) return null;
    return {
      id,
      blockId,
      anchorVersion: raw.anchorVersion === DOCUMENT_COMMENT_ANCHOR_VERSION ? DOCUMENT_COMMENT_ANCHOR_VERSION : undefined,
      blockText,
      targetText,
      issueType,
      issueKey,
      severity,
      evidenceSource,
      evidenceQuote,
      impact,
      relatedAnchors,
      blockIndex,
      createdAt,
      reviewVersion: Number.isInteger(reviewVersion) && reviewVersion > 0
        ? reviewVersion
        : undefined,
    };
  } catch {
    return null;
  }
}

function parseDocumentCommentRead(message: CompanionMessage): { id: string; readAt: string } | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_READ_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_READ_PREFIX.length)) as Record<string, unknown>;
    const id = boundedString(raw.id, 160);
    const readAt = boundedString(raw.readAt, 80) || message.createdAt;
    return id ? { id, readAt } : null;
  } catch {
    return null;
  }
}

type CommentStatus = "open" | "resolved" | "deferred" | "not-applicable" | "invalidated";

function parseDocumentCommentStatus(message: CompanionMessage): { id: string; status: CommentStatus } | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_STATUS_PREFIX)) return null;
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_STATUS_PREFIX.length)) as Record<string, unknown>;
    const id = boundedString(raw.id, 160);
    const status = raw.status;
    return id && (status === "open" || status === "resolved" || status === "deferred"
      || status === "not-applicable" || status === "invalidated")
      ? { id, status } : null;
  } catch {
    return null;
  }
}

function documentCommentThreads(messages: CompanionMessage[]): DocumentAiCommentThread[] {
  const metas = messages.map(parseDocumentCommentMeta).filter((meta): meta is DocumentCommentMeta => !!meta);
  const reads = messages.map(parseDocumentCommentRead).filter((read): read is { id: string; readAt: string } => !!read);
  const statuses = new Map(messages.map(parseDocumentCommentStatus)
    .filter((status): status is { id: string; status: CommentStatus } => !!status)
    .map((status) => [status.id, status.status] as const));
  return metas.map((meta) => {
    const readAt = reads
      .filter((read) => read.id === meta.id)
      .map((read) => read.readAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    return {
      ...meta,
      readAt,
      status: statuses.get(meta.id) ?? "open",
      comments: messages
      .filter((message) =>
        message.conversationId === meta.id
        && (message.role === "student" || message.role === "agent")
        && !message.hiddenFromStudentAt
      )
      .map((message): DocumentAiComment => ({
        id: message.id,
        role: message.role === "student" ? "student" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
      })),
    };
  }).filter((thread) => thread.comments.length > 0);
}

function companionForIntent(intent: DocumentCollaborationIntent): AiCompanionId {
  if (intent === "delegate") return "knowledge";
  if (intent === "check") return "critic";
  if (intent === "summarize" || intent === "organize" || intent === "edit") {
    return "recorder";
  }
  return "planner";
}

type DelegatedWorkRevision = { title: string; content: string };

function parseDelegatedWorkRevision(value: unknown): DelegatedWorkRevision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const title = boundedString(record.title, 120);
  const content = boundedString(record.content, 8_000);
  return title && content ? { title, content } : undefined;
}

function assistantRecordForResult(result: DocumentCollaborationResponse): string {
  if (result.deliverable) {
    const sources = result.deliverable.sources.length
      ? `\n来源：${result.deliverable.sources.map((source) => [source.title, source.locator, source.url].filter(Boolean).join(" ")).join("；")}`
      : "";
    const actions = result.deliverable.documentActions
      .map((action) => action.description)
      .join("；");
    return `${result.message}\n组员交付「${result.deliverable.title}」：\n${result.deliverable.content}\n文档操作计划：${actions}${sources}`;
  }
  return [
    result.message,
    result.suggestion
      ? `修改建议「${result.suggestion.title}」：${result.suggestion.replacement}`
      : undefined,
  ].filter(Boolean).join("\n");
}

async function executeDelegatedWork(input: {
  course: Course;
  student: Student;
  stageKey: string;
  request: string;
  auxiliaryRequest?: string;
  documentText: string;
  documentHeadings: Array<{ text: string; level: number }>;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  signal: AbortSignal;
  revisionOf?: DelegatedWorkRevision;
  workspaceKind: CollaborationWorkspaceKind;
  projectSupportContext: Awaited<ReturnType<typeof resolveProjectSupportContext>>;
  deliveredWorkSummary: string;
  prepared?: Record<string, unknown>;
  checkpoint: (value: Record<string, unknown>) => Promise<void>;
  recordModel: (step: string, attempt: StructuredModelAttempt) => Promise<void>;
}): Promise<DocumentCollaborationResponse> {
  const assessmentPrompts = buildDelegatedWorkAssessmentPrompts({
    course: input.course,
    studentId: input.student.id,
    studentName: input.student.name,
    stageKey: input.stageKey,
    request: input.request,
    auxiliaryRequest: input.auxiliaryRequest,
    documentText: input.documentText,
    documentHeadings: input.documentHeadings,
    history: input.history,
    revisionOf: input.revisionOf,
    deliveredWorkSummary: input.deliveredWorkSummary,
    includeDelivery: true,
    researchContext: input.projectSupportContext.promptContext,
  });
  assessmentPrompts.system += `\n若判定为protected或clarify，给学生的解释也必须遵守：${DOCUMENT_DISCUSSION_FIDELITY_RULE}`;
  const assessmentContext = {
    courseText: buildAuthoritativeCourseContext(input.course, input.student.id, input.stageKey),
    documentText: input.documentText, request: input.request, auxiliaryRequest: input.auxiliaryRequest,
    documentHeadings: input.documentHeadings,
  };
  const assessmentFingerprint = digest({ ...assessmentContext,
    deliveredWorkSummary: input.deliveredWorkSummary, policyVersion: DOCUMENT_COLLABORATION_POLICY_VERSION,
    deliveryPolicyVersion: DELEGATED_DELIVERY_POLICY_VERSION, explanationFidelityVersion: DOCUMENT_DISCUSSION_FIDELITY_VERSION,
    researchContext: input.projectSupportContext.promptContext,
    ...headingNumberingAssessmentPolicy(input.request) });
  const sameAssessmentContext = input.prepared?.delegationContextFingerprint === assessmentFingerprint;
  const preparedAssessment = sameAssessmentContext ? jsonRecord(input.prepared?.delegationAssessment) : null;
  const reuseAssessment = Boolean(preparedAssessment && isValidDelegatedWorkAssessment(preparedAssessment, assessmentContext));
  type AssessmentGeneration = { version: 1; drafts: string[]; repairUsed: boolean; pendingRepair: boolean };
  const savedGeneration = sameAssessmentContext ? input.prepared?.delegationAssessmentGeneration as Partial<AssessmentGeneration> | undefined : undefined;
  const reusableGeneration = savedGeneration?.version === 1 && Array.isArray(savedGeneration.drafts)
    && savedGeneration.drafts.length <= 2 && savedGeneration.drafts.every(raw => typeof raw === "string")
    && typeof savedGeneration.repairUsed === "boolean" && typeof savedGeneration.pendingRepair === "boolean";
  const generation: AssessmentGeneration = reusableGeneration
    ? { ...savedGeneration as AssessmentGeneration, drafts: [...savedGeneration!.drafts!] }
    : { version: 1, drafts: [], repairUsed: false, pendingRepair: false };
  let assessmentRepairUsed = (sameAssessmentContext && input.prepared?.delegationAssessmentRepairUsed === true) || generation.repairUsed;
  const saveAssessmentGeneration = () => input.checkpoint({ delegationContextFingerprint: assessmentFingerprint,
    delegationAssessmentGeneration: { ...generation, drafts: [...generation.drafts] }, delegationAssessmentRepairUsed: assessmentRepairUsed });
  const obtainAssessment = async (): Promise<Record<string, unknown>> => {
    while (true) {
      input.signal.throwIfAborted();
      let raw = generation.pendingRepair ? undefined : generation.drafts.at(-1);
      if (raw === undefined) {
        raw = await timeProgress("document-delegation-assessment", () => callCollaborationModel([
          { role: "system", content: withWorkspaceInstruction(assessmentPrompts.system, input.workspaceKind) },
          { role: "user", content: assessmentPrompts.user },
          ...(generation.pendingRepair ? [
            { role: "assistant" as const, content: generation.drafts.at(-1)! },
            { role: "user" as const, content: "上一条回答未通过结构或引用校验。请修正上面的回答并只返回完整严格 JSON，保留本轮任务和教学边界。accepted 必须填写所有必需字段；requirementAnchor 的 quote 必须逐字出自 source 对应的课程、当前文稿或本次原始完整安排，source=request 不得引用历史消息。materialQuotes 只能引用当前文稿或本次请求的实际整理对象（明确索要课程要求清单时才可引用课程要求），不得混入历史消息。不要将本次修改要求改成上次的审阅建议；范围不明确则 clarify 并只问一个具体问题。" },
          ] : []),
        ], input.signal));
        generation.drafts.push(raw);
        generation.pendingRepair = false;
        // Paid bytes precede audit, parsing, and any attempt to reserve a repair.
        await saveAssessmentGeneration();
      }
      let parsed: Record<string, unknown> | undefined;
      let validation: StructuredModelAttempt["validation"] = "invalid-json";
      try {
        const value = parseLLMJson<Record<string, unknown>>(raw);
        validation = "invalid-schema";
        if (value && typeof value === "object" && !Array.isArray(value) && isValidDelegatedWorkAssessment(value, assessmentContext)) {
          parsed = value; validation = "valid";
        }
      } catch { /* Keep the exact invalid output for recovery. */ }
      await input.recordModel("delegation-assessment", { raw, sha256: createHash("sha256").update(raw).digest("hex"),
        attempt: generation.drafts.length, validation });
      input.signal.throwIfAborted();
      if (parsed) return parsed;
      if (assessmentRepairUsed) throw new Error("AI_DELEGATED_DELIVERY_INCOMPLETE");
      assessmentRepairUsed = true;
      generation.repairUsed = true;
      generation.pendingRepair = true;
      await saveAssessmentGeneration();
    }
  };
  let assessment = normalizeDelegatedWorkAssessment(reuseAssessment ? preparedAssessment! : await obtainAssessment());
  if (!reuseAssessment) await input.checkpoint({ delegationAssessment: assessment, delegationContextFingerprint: assessmentFingerprint,
    delegationAssessmentRepairUsed: assessmentRepairUsed });
  const placementRepairState = sameAssessmentContext ? input.prepared?.delegationPlacementRepair as {
    version?: number; pending?: boolean; raw?: string;
  } | undefined : undefined;
  let placementDraft = placementRepairState?.version === 1 && placementRepairState.pending === false
    && typeof placementRepairState.raw === "string" ? placementRepairState.raw : undefined;
  const placementIssues = inspectDelegatedWorkPlacement(assessment, assessmentContext);
  if (placementIssues.length) {
    const saved = reuseAssessment ? placementRepairState : undefined;
    const repair = saved?.version === 1 && typeof saved.pending === "boolean" ? saved : undefined;
    let raw = typeof repair?.raw === "string" ? repair.raw : undefined;
    if (raw === undefined) {
      if (assessmentRepairUsed && !repair?.pending) throw new Error("AI_DELEGATED_DELIVERY_INCOMPLETE");
      assessmentRepairUsed = true;
      await input.checkpoint({ delegationAssessment: assessment, delegationContextFingerprint: assessmentFingerprint,
        delegationAssessmentRepairUsed: true, delegationPlacementRepair: { version: 1, pending: true } });
      raw = await timeProgress("document-delegation-placement-repair", () => callCollaborationModel([
        { role: "system", content: withWorkspaceInstruction(assessmentPrompts.system, input.workspaceKind) },
        { role: "user", content: assessmentPrompts.user },
        { role: "assistant", content: JSON.stringify(assessment) },
        { role: "user", content: `上次接单的用途/位置与原始安排不一致：${placementIssues.join("；")}。这是本轮唯一修复机会，只修正接单一致性并返回完整严格JSON；保留原始限制与教学边界。若当前文稿缺少真实目标，改为clarify并询问所缺材料，不能编造目标、擅自追加或扩大任务。` },
      ], input.signal, { lightweightScreening: true }));
      // Retain paid repair bytes and consumed allowance before parsing/audit.
      await input.checkpoint({ delegationAssessment: assessment, delegationContextFingerprint: assessmentFingerprint,
        delegationAssessmentRepairUsed: true, delegationPlacementRepair: { version: 1, pending: false, raw } });
      await input.recordModel("delegation-placement-repair", { raw, sha256: createHash("sha256").update(raw).digest("hex"), attempt: 2, validation: "received" });
      input.signal.throwIfAborted();
    }
    let corrected: Record<string, unknown>;
    try { corrected = parseLLMJson<Record<string, unknown>>(raw); }
    catch { throw new Error("AI_DELEGATED_DELIVERY_INCOMPLETE"); }
    if (!corrected || !isValidDelegatedWorkAssessment(corrected, assessmentContext)) throw new Error("AI_DELEGATED_DELIVERY_INCOMPLETE");
    const normalized = normalizeDelegatedWorkAssessment(corrected);
    if (inspectDelegatedWorkPlacement(normalized, assessmentContext).length) throw new Error("AI_DELEGATED_DELIVERY_INCOMPLETE");
    assessment = normalized;
    placementDraft = raw;
    assessmentRepairUsed = true;
    await input.checkpoint({ delegationAssessment: assessment, delegationContextFingerprint: assessmentFingerprint,
      delegationAssessmentRepairUsed: true, delegationPlacementRepair: { version: 1, pending: false, raw } });
  }
  if (assessment.decision !== "accepted") {
    const seed = assessmentToBoundaryResponse(assessment);
    const expectedKind = seed.kind === "boundary" ? "boundary" : "task-clarification";
    const locked = seed as unknown as Record<string, unknown>;
    const messages: DocumentModelMessage[] = [
      { role: "system", content: withWorkspaceInstruction(`你是项目AI组员。委派判定已由服务端完成并锁定，本轮只修正给学生的解释，不重新判定或执行任务。${DOCUMENT_DISCUSSION_FIDELITY_RULE}只返回严格JSON，kind=${expectedKind}，message为完整回复，focus为焦点，suggestion=null。其余判定和学生责任由服务端保留。拒绝核心代做后只提供方法帮助，不能交付替代分析或可复制的结论；澄清只询问真正缺少的信息。`, input.workspaceKind) },
      { role: "user", content: `${assessmentPrompts.user}\n\n【已锁定的委派判定与原回复】\n${JSON.stringify(seed)}` },
    ];
    const visibleCandidate = (candidate: Record<string, unknown>) => ({ ...locked,
      message: boundedString(candidate.message, 1_800), focus: boundedString(candidate.focus, 160) || seed.focus });
    const reviewed = await reviewedDocumentDiscussion({ messages, compactMessages: () => messages,
      request: input.request, expectedKind, signal: input.signal, prepared: input.prepared,
      documentText: input.documentText, studentHistory: input.history.filter(message => message.role === "user").map(message => message.content),
      initialDraft: JSON.stringify(seed), initialRepairUsed: assessmentRepairUsed, lockedResponse: locked,
      checkpoint: input.checkpoint, record: input.recordModel, visibleCandidate });
    return visibleCandidate(reviewed) as unknown as DocumentCollaborationResponse;
  }

  const sources = input.projectSupportContext.sources.flatMap((source) =>
    source.type === "textbook"
      ? [{ id: source.id, type: "textbook" as const, title: source.title, locator: source.locator, note: source.excerpt }]
      : []);

  const executionPrompts = buildDelegatedWorkExecutionPrompts({
    course: input.course,
    studentId: input.student.id,
    stageKey: input.stageKey,
    request: input.request,
    auxiliaryRequest: input.auxiliaryRequest,
    documentText: input.documentText,
    documentHeadings: input.documentHeadings,
    assessment,
    history: input.history,
    researchContext: input.projectSupportContext.promptContext,
    revisionOf: input.revisionOf,
    deliveredWorkSummary: input.deliveredWorkSummary,
  });
  const deliveryMessages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: withWorkspaceInstruction(executionPrompts.system, input.workspaceKind) },
    { role: "user", content: executionPrompts.user },
  ];
  const savedDelivery = reuseAssessment ? input.prepared?.delegationDelivery as Partial<DelegatedDeliveryCheckpoint> | undefined : undefined;
  const reusableDeliveryState = savedDelivery?.version === 1 && Array.isArray(savedDelivery.drafts)
    && savedDelivery.drafts.length <= 2 && savedDelivery.drafts.every(raw => typeof raw === "string")
    && typeof savedDelivery.repairUsed === "boolean" && (savedDelivery.drafts.length < 2 || savedDelivery.repairUsed)
    && (savedDelivery.pendingRepair === null || (savedDelivery.repairUsed
      && ["delivery", "review"].includes(savedDelivery.pendingRepair?.kind ?? "")
      && Array.isArray(savedDelivery.pendingRepair?.issues) && savedDelivery.pendingRepair.issues.every(issue => typeof issue === "string")));
  const legacyDraft = reuseAssessment && typeof input.prepared?.delegationDraft === "string" ? input.prepared.delegationDraft : undefined;
  // The paid combined response is already durable in assessment generation.
  // Reuse a combined intake or placement-repair delivery only when its own
  // assessment matches the final validated material identity and placement.
  // The original rejected draft cannot replace an approved repaired draft.
  let assessedDraft: string | undefined;
  for (const assessedRaw of [placementDraft, generation.drafts.at(-1)]) {
    if (!assessedRaw) continue;
    try {
      const candidate = parseLLMJson<Record<string, unknown>>(assessedRaw);
      if (candidate.deliverable && isValidDelegatedWorkAssessment(candidate, assessmentContext)
        && isDeepStrictEqual(normalizeDelegatedWorkAssessment(candidate), assessment)
        && !inspectDelegatedWorkPlacement(assessment, assessmentContext).length) {
        assessedDraft = assessedRaw;
        break;
      }
    } catch { /* Invalid paid bytes remain available for diagnosis, never application. */ }
  }
  const deliveryState: DelegatedDeliveryCheckpoint = reusableDeliveryState
    ? { ...savedDelivery as DelegatedDeliveryCheckpoint, repairUsed: savedDelivery!.repairUsed! || assessmentRepairUsed }
    // An old paid draft has unknown repair history: review it, but do not grant
    // a new repair allowance merely because its older checkpoint omitted it.
    : { version: 1, drafts: legacyDraft !== undefined ? [legacyDraft] : assessedDraft ? [assessedDraft] : [],
      repairUsed: assessmentRepairUsed || legacyDraft !== undefined, pendingRepair: null };
  const saveDelivery = (state: DelegatedDeliveryCheckpoint) => input.checkpoint({
    delegationAssessment: assessment, delegationAssessmentRepairUsed: assessmentRepairUsed,
    delegationContextFingerprint: assessmentFingerprint, delegationDelivery: state,
    ...(state.drafts.length ? { delegationDraft: state.drafts.at(-1) } : {}),
  });
  if (!reusableDeliveryState && deliveryState.drafts.length) await saveDelivery(deliveryState);
  let deliveryAttempt = deliveryState.drafts.length;
  let reviewAttempt = 0;
  const deliveryReviewOutputs = sameAssessmentContext ? savedReviewOutputs(input.prepared?.delegationReviewOutputs) : [];
  const delivery = await generateDelegatedDeliveryWithRepair(
    async (repair, issues) => {
      return timeProgress("document-delegation-delivery", () => callDelegatedWorkModel(repair
      ? [...deliveryMessages, { role: "user", content: `上次交付未通过校验：${(issues ?? []).join("；")}。仅在原批准范围内修复，返回完整严格 JSON 与真实可用的交付；不能以清单或扩大代做范围替代。` }]
      : deliveryMessages, input.signal));
    },
    input.signal,
    async (candidate, repairStructure) => {
      const prompts = buildDelegatedWorkDeliveryReviewPrompts({
        course: input.course, studentId: input.student.id, stageKey: input.stageKey,
        request: input.request, auxiliaryRequest: input.auxiliaryRequest, documentText: input.documentText, assessment,
        documentHeadings: input.documentHeadings,
        history: input.history, researchContext: input.projectSupportContext.promptContext,
        deliveredWorkSummary: input.deliveredWorkSummary, delivery: candidate,
      });
      const reviewFingerprint = digest({ prompts, workspaceKind: input.workspaceKind, draftAttempt: deliveryAttempt });
      repairStructure = Boolean(repairStructure) || deliveryReviewOutputs.some(output => output.fingerprint === reviewFingerprint && output.repairStructure);
      const review = await timeProgress("document-delegation-review", () => recordedStructuredResponse({
        signal: input.signal, maxCalls: 1, parse: parseLLMJson, valid: isValidDelegatedWorkDeliveryReview,
        generate: async () => {
          const paid = deliveryReviewOutputs.find(output => output.fingerprint === reviewFingerprint && output.repairStructure === Boolean(repairStructure));
          if (paid) return paid.raw;
          const raw = await callCollaborationModel([
            { role: "system", content: withWorkspaceInstruction(prompts.system, input.workspaceKind) },
            { role: "user", content: prompts.user },
            ...(repairStructure ? [{ role: "user" as const, content: "上一条交付复核JSON结构不完整。只修复复核结构，完整填写全部checks、passed与issues，不改写交付。" }] : []),
          ], input.signal, { lightweightScreening: true });
          deliveryReviewOutputs.push({ fingerprint: reviewFingerprint, repairStructure: Boolean(repairStructure), raw });
          await input.checkpoint({ delegationReviewOutputs: [...deliveryReviewOutputs] });
          return raw;
        },
        record: attempt => input.recordModel(`delegation-review-${deliveryAttempt}`, { ...attempt, attempt: ++reviewAttempt }),
      }));
      return normalizeDelegatedWorkDeliveryReview(review);
    },
    { assessment, documentText: input.documentText, request: input.request, auxiliaryRequest: input.auxiliaryRequest, courseText: assessmentContext.courseText,
      documentHeadings: input.documentHeadings },
    { state: deliveryState, checkpoint: saveDelivery, recordDraft: async (raw, attempt) => {
      deliveryAttempt = attempt;
      await input.recordModel("delegation-delivery", { raw, sha256: createHash("sha256").update(raw).digest("hex"), attempt, validation: "received" });
    } },
  );
  const result = normalizeDelegatedWorkDelivery({
    raw: delivery,
    assessment,
    sources,
    researchMode: sources.length ? "textbook" : "model",
    documentText: input.documentText,
  });
  if (result.kind === "task-clarification" && result.delegation?.decision === "unavailable") {
    throw new Error("AI_DELEGATED_DELIVERY_INCOMPLETE");
  }
  return result;
}

function collaborationFailureResponse(
  error: unknown,
  intent?: DocumentCollaborationIntent,
): Response {
  if (error instanceof CourseAdmissionTimeoutError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof DocumentModelStructureError || (error instanceof Error && error.message === "AI_RESPONSE_INVALID_STRUCTURE")) {
    return Response.json({
      error: "AI_RESPONSE_INVALID_STRUCTURE",
      message: "AI 回答格式暂时不完整，你的消息已保留。请重试这条消息。",
    }, { status: 503 });
  }
  if (error instanceof Error && error.message === "AI_DELEGATED_DELIVERY_INCOMPLETE") {
    const details = documentRequestFailureDetails("AI_DELEGATED_DELIVERY_INCOMPLETE");
    return Response.json({ error: "AI_DELEGATED_DELIVERY_INCOMPLETE", message: details.failureMessage, retryable: details.retryable }, { status: 503 });
  }
  if (error instanceof Error && error.message === "AI_DISCUSSION_REVIEW_FAILED") {
    const details = documentRequestFailureDetails("AI_DISCUSSION_REVIEW_FAILED");
    return Response.json({ error: "AI_DISCUSSION_REVIEW_FAILED", message: details.failureMessage, retryable: details.retryable }, { status: 503 });
  }
  if (error instanceof Error && error.message === "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE") {
    return Response.json({ error: "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE", message: "暂时无法读取项目协作记录，尚未执行这项工作。你的消息已保留，请稍后重试。" }, { status: 503 });
  }
  if (error instanceof LlmRateLimitError) {
    const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
    return Response.json(
      {
        error: "AI_COLLABORATION_RATE_LIMITED",
        message: `AI 服务当前请求较多，请在 ${retryAfterSeconds} 秒后重试。本次没有修改文档。`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }
  if (error instanceof LlmTimeoutError) {
    return Response.json(
      {
        error: "AI_COLLABORATION_TIMEOUT",
        message: "AI 组员本次思考超时，请重新发送任务。本次没有修改文档。",
      },
      { status: 504 },
    );
  }
  if (error instanceof LlmNotConfiguredError) {
    return Response.json(
      {
        error: "AI_COLLABORATION_NOT_CONFIGURED",
        message: "AI 服务尚未配置，请联系教师或系统管理员。本次没有修改文档。",
      },
      { status: 503 },
    );
  }
  if (error instanceof LlmCallFailedError) {
    if (error.status === 400) {
      const category = upstreamFailureCategory(error);
      if (category !== "context-limit" && category !== "content-policy") {
        return Response.json({
          error: "AI_COLLABORATION_UPSTREAM_FAILED",
          message: "这次回答没能完成，你的消息已保留。可以重新尝试。",
        }, { status: 503 });
      }
      return Response.json(
        {
          error: "AI_COLLABORATION_INPUT_REJECTED",
          message: category === "content-policy"
            ? "这项请求未通过模型服务的内容检查。你可以换一种具体的表述后重试。"
            : intent === "delegate"
            ? "当前工作范围过大或描述不够明确。请把它缩小为一项可核验的辅助工作后重试；本次没有修改文档。"
            : "当前任务内容未被模型接受。请缩小选区或新建对话后重试；本次没有修改文档。",
        },
        { status: 422 },
      );
    }
    return Response.json(
      {
        error: "AI_COLLABORATION_UPSTREAM_FAILED",
        message: "AI 服务刚才出现短暂波动，请重新发送任务。本次没有修改文档。",
      },
      { status: error.status === 429 ? 429 : 503 },
    );
  }
  return Response.json(
    {
      error: "AI_COLLABORATION_FAILED",
      message: "AI 组员暂时无法回应，请稍后重试。本次没有修改文档。",
    },
    { status: 503 },
  );
}

function documentRequestFailure(error: unknown, requestId: string): Response {
  if (isDocumentReviewScopeChanged(error)) return Response.json({ error: error.message, requestId, status: "failed", retryable: false }, { status: 409 });
  if (error instanceof CourseAdmissionTimeoutError || error instanceof PlatformError) {
    return Response.json({ error: error.code, message: error.message, requestId,
      status: "failed", retryable: error.status >= 500 }, { status: error.status });
  }
  console.error("[ai-collaboration/document] request unavailable", { requestId,
    name: error instanceof Error ? error.name : "UnknownError" });
  return Response.json({ error: "DATABASE_UNAVAILABLE", message: "课堂数据暂时不可用，请重试",
    requestId, status: "failed", retryable: true }, { status: 503 });
}

function upstreamFailureCategory(error: unknown): string | undefined {
  if (!(error instanceof LlmCallFailedError)) return undefined;
  const summary = error.upstreamSummary.toLowerCase();
  if (/context|token|maximum.{0,20}length|too long|上下文|长度/.test(summary)) {
    return "context-limit";
  }
  if (/content|safety|moderation|policy|敏感|审核/.test(summary)) {
    return "content-policy";
  }
  if (/parameter|invalid|request|参数/.test(summary)) return "invalid-request";
  return error.status === 400 ? "input-rejected" : "upstream-failure";
}

async function callCollaborationModel(
  messages: DocumentModelMessage[],
  signal: AbortSignal,
  options: { lightweightScreening?: boolean } = {},
): Promise<string> {
  try {
    return await callLLM(messages, {
      ...options,
      jsonMode: true,
      abortSignal: signal,
      maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
    });
  } catch (error) {
    if (!(error instanceof LlmJsonModeUnsupportedError)) throw error;
    return callLLM(messages, {
      ...options,
      jsonMode: false,
      abortSignal: signal,
      maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
    });
  }
}

async function callDelegatedWorkModel(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  return callCollaborationModel(messages, signal);
}

async function authenticateStudent(
  request: Request,
  courseId: string,
  requestedStudentId: string,
): Promise<{ claims: StudentClaims; studentId: string; participationId: string } | Response> {
  return authenticateLegacyAiStudent(request, courseId, requestedStudentId);
}

async function loadCollaborationScope(input: {
  request: Request;
  courseId: string;
  requestedStudentId: string;
  stageKey: string;
  workspaceKind: CollaborationWorkspaceKind;
}) {
  if (!COLLABORATION_STAGE_KEYS.has(input.stageKey)) {
    return Response.json(
      { error: "STAGE_NOT_SUPPORTED", message: "AI 协作实验目前仅支持方案与制作阶段。" },
      { status: 400 },
    );
  }
  const authentication = await authenticateStudent(
    input.request,
    input.courseId,
    input.requestedStudentId,
  );
  if (authentication instanceof Response) return authentication;
  const course = await getDocumentCourseContext(input.courseId, authentication.studentId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  const configuredMode = normalizePblCourseConfig(course.pblConfig).makeArtifactMode;
  if (input.workspaceKind === "external-artifact") {
    if (input.stageKey !== "make" || configuredMode !== "other") {
      return Response.json(
        { error: "WORKSPACE_NOT_AVAILABLE", message: "当前课程尚未开放其他成果协作空间。" },
        { status: 409 },
      );
    }
  } else if (input.stageKey === "make" && configuredMode === "other") {
    return Response.json(
      { error: "WORKSPACE_CHANGED", message: "当前课程已切换为其他成果协作空间，请重新进入项目实践。" },
      { status: 409 },
    );
  }
  const student = course.students.find((item) => item.id === authentication.studentId);
  if (!student) {
    return Response.json({ error: "STUDENT_NOT_IN_COURSE" }, { status: 403 });
  }
  const activeStageKey = course.stages[course.currentStageIndex]?.key;
  if (activeStageKey !== input.stageKey) {
    return Response.json(
      { error: "STAGE_CHANGED", message: "课堂阶段已经变化，请返回课堂后重新进入 AI 协作。" },
      { status: 409 },
    );
  }
  return { authentication, course, student };
}

// History reads need live guards, not model prompt evidence. POST/DELETE keep
// their existing complete context path.
async function loadDocumentHistoryScope(input: {
  request: Request;
  courseId: string;
  requestedStudentId: string;
  stageKey: string;
  workspaceKind: CollaborationWorkspaceKind;
}) {
  if (!COLLABORATION_STAGE_KEYS.has(input.stageKey)) {
    return Response.json(
      { error: "STAGE_NOT_SUPPORTED", message: "AI 协作实验目前仅支持方案与制作阶段。" },
      { status: 400 },
    );
  }
  const authentication = await timeProgress("document-history-auth", () => authenticateStudent(
    input.request,
    input.courseId,
    input.requestedStudentId,
  ));
  if (authentication instanceof Response) return authentication;
  const course = await timeProgress("document-history-context", () => getDocumentReadContext(input.courseId, authentication.studentId));
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  const configuredMode = course.makeArtifactMode;
  if (input.workspaceKind === "external-artifact") {
    if (input.stageKey !== "make" || configuredMode !== "other") {
      return Response.json(
        { error: "WORKSPACE_NOT_AVAILABLE", message: "当前课程尚未开放其他成果协作空间。" },
        { status: 409 },
      );
    }
  } else if (input.stageKey === "make" && configuredMode === "other") {
    return Response.json(
      { error: "WORKSPACE_CHANGED", message: "当前课程已切换为其他成果协作空间，请重新进入项目实践。" },
      { status: 409 },
    );
  }
  const student = course.student;
  if (!student) {
    return Response.json({ error: "STUDENT_NOT_IN_COURSE" }, { status: 403 });
  }
  const activeStageKey = course.currentStageKey;
  if (activeStageKey !== input.stageKey) {
    return Response.json(
      { error: "STAGE_CHANGED", message: "课堂阶段已经变化，请返回课堂后重新进入 AI 协作。" },
      { status: 409 },
    );
  }
  return { authentication, student };
}

/** Compatibility entrypoint: retired document review work never calls the model. */
export async function executeQueuedDocumentReview(job: QueuedDocumentReview, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  await cancelRetiredDocumentReviews(job);
  return Response.json({ requestId: job.snapshot.task.requestId, status: "cancelled",
    error: "DOCUMENT_AUTOMATIC_REVIEW_RETIRED", proactiveReviewEnabled: false }, { status: 410 });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = boundedString(url.searchParams.get("courseId"), 120);
  const studentId = boundedString(url.searchParams.get("studentId"), 120);
  const stageKey = boundedString(url.searchParams.get("stageKey"), 80);
  const workspaceKind = normalizeCollaborationWorkspaceKind(url.searchParams.get("workspaceKind"));
  const requestId = boundedString(url.searchParams.get("requestId"), 160);
  try {
  if (!courseId || !stageKey) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  if (requestId) {
    if (!COLLABORATION_STAGE_KEYS.has(stageKey)) return Response.json({ error: "STAGE_NOT_SUPPORTED" }, { status: 400 });
    const authentication = await authenticateStudent(request, courseId, studentId);
    if (authentication instanceof Response) return authentication;
    const state = await getDocumentRequest({
      requestId,
      participationId: authentication.participationId,
      courseId,
      studentId: authentication.studentId,
      stageKey,
      workspaceKind,
      conversationId: "",
    });
    if (!state) return Response.json({ error: "REQUEST_NOT_FOUND" }, { status: 404 });
    if (!["comment-reply", "proactive-document-comment", "proactive-document-comments", "suggest-delegated-work"].includes(state.intent) && state.status !== "completed") {
      const current = await getCompanionThread(
        courseId, authentication.studentId, collaborationThreadKey(stageKey, workspaceKind),
      );
      if (state.conversationId !== activeConversationId(current?.messages ?? [])) {
        return Response.json({ error: "CONVERSATION_CHANGED", requestId }, { status: 409 });
      }
    }
    return Response.json(state.status === "completed"
      ? { ...state.response, requestId, status: state.status, conversationId: state.conversationId, documentVersion: state.documentVersion }
      : { ...state, retryable: state.retryable ?? state.status === "failed" });
  }
  const scope = await loadDocumentHistoryScope({
    request,
    courseId,
    requestedStudentId: studentId,
    stageKey,
    workspaceKind,
  });
  if (scope instanceof Response) return scope;
  const commentHistory = (messages: CompanionMessage[]) => restoreDocumentCommentReplyOrder({
    courseId, studentId: scope.student.id, participationId: scope.authentication.participationId,
    stageKey, workspaceKind, threadStageKey: documentCommentThreadKey(stageKey, workspaceKind),
  }, documentCommentThreads(messages));
  const [thread, commentStore] = await timeProgress("document-history-threads", () => getCompanionThreadPair(
    courseId, scope.student.id,
    [collaborationThreadKey(stageKey, workspaceKind), documentCommentThreadKey(stageKey, workspaceKind)],
  ));
  const conversationId = activeConversationId(thread?.messages ?? []);
  const messages = visibleConversationMessages(thread?.messages ?? [], conversationId)
    .slice(-40);
  let memoriesAvailable = true;
  const memories = await timeProgress("document-memory-read", () => listProjectMemories(scope.authentication.participationId)).catch((error) => {
    memoriesAvailable = false;
    console.warn("[ai-collaboration] project memory read unavailable", error);
    return [];
  });
  const requests = await timeProgress("document-history-requests", () => listDocumentRequests({
    participationId: scope.authentication.participationId,
    courseId,
    studentId: scope.student.id,
    stageKey,
    workspaceKind,
    conversationId,
  }));
  const responseBody = {
    messages,
    requests,
    memories,
    memoriesAvailable,
    proactiveReviewEnabled: proactiveReviewEnabled(),
    continuation: projectMemoryContinuation(memories),
    conversationId,
    workspaceKind,
    commentThreads: await timeProgress("document-history-comments", () => commentHistory(commentStore?.messages ?? [])),
    reviewedParagraphFingerprints: documentReviewedParagraphFingerprints(
      commentStore?.messages ?? [],
    ),
  };
  return timeProgressSync("document-history-serialization", () => Response.json(responseBody));
  } catch (error) { return documentRequestFailure(error, requestId); }
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = boundedString(url.searchParams.get("courseId"), 120);
  const requestedStudentId = boundedString(url.searchParams.get("studentId"), 120);
  const stageKey = boundedString(url.searchParams.get("stageKey"), 80);
  const workspaceKind = normalizeCollaborationWorkspaceKind(url.searchParams.get("workspaceKind"));
  const messageId = boundedString(url.searchParams.get("messageId"), 160);
  const requestedConversationId = boundedString(url.searchParams.get("conversationId"), 160);
  if (!courseId || !stageKey || !messageId || !requestedConversationId) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  const scope = await loadCollaborationScope({
    request,
    courseId,
    requestedStudentId,
    stageKey,
    workspaceKind,
  });
  if (scope instanceof Response) return scope;
  const thread = await getCompanionThread(courseId, scope.student.id, collaborationThreadKey(stageKey, workspaceKind));
  const currentConversationId = activeConversationId(thread?.messages ?? []);
  if (requestedConversationId !== currentConversationId) {
    return Response.json(
      { error: "CONVERSATION_CHANGED", message: "当前对话已经变化，请刷新后重试。" },
      { status: 409 },
    );
  }
  const changed = await softDeleteCompanionMessage({
    courseId,
    studentId: scope.student.id,
    stageKey: collaborationThreadKey(stageKey, workspaceKind),
    messageId,
    conversationId: currentConversationId,
  });
  if (changed) {
    await dismissProjectMemories({
      participationId: scope.authentication.participationId,
      sourceMessageId: messageId,
    });
  }
  return Response.json({ ok: true, changed });
}

export async function POST(request: NextRequest) {
  let body: DocumentCollaborationRequest;
  try {
    body = await request.json() as DocumentCollaborationRequest;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const requestId = boundedString(body.requestId, 160)
    || boundedString(request.headers.get("x-request-id"), 160)
    || randomUUID();

  try {
  const courseId = boundedString(body.courseId, 120);
  const requestedStudentId = boundedString(body.studentId, 120);
  const stageKey = boundedString(body.stageKey, 80);
  const workspaceKind = normalizeCollaborationWorkspaceKind(body.workspaceKind);
  const action = boundedString(body.action, 80);
  const messageInput = readDocumentRequestMessage(body.message);
  if (!messageInput.ok) return Response.json({ error: "AI_MESSAGE_TOO_LONG", message: "一次最多发送 1200 字，请缩短后作为新消息发送。" }, { status: 400 });
  const message = messageInput.message;
  const documentInput = readDocumentRequestHtml(body.documentHtml);
  if (!documentInput.ok) return Response.json({ error: "DOCUMENT_CONTEXT_TOO_LONG", message: "文档超过本次 AI 协作的 120000 字符上限，请缩短提供给 AI 的内容后重试。" }, { status: 413 });
  const documentHtml = documentInput.documentHtml;
  const selectedText = boundedString(body.selectedText, 12_000);
  const proactive = body.proactive === true;
  const commentThreadId = boundedString(body.commentThreadId, 160);
  const targetText = boundedString(body.targetText, 3_000);
  const contributionId = boundedString(body.contributionId, 160) || undefined;
  if (!courseId || !stageKey) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!action && (!message || !isDocumentCollaborationIntent(body.intent))) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (selectedText.length >= 6_000) {
    return Response.json(
      { error: "SELECTION_TOO_LONG", message: "一次最多处理约 6000 字，请缩小选区后再布置任务。" },
      { status: 413 },
    );
  }
  if (body.intent === "edit" && !selectedText) {
    return Response.json(
      { error: "SELECTION_REQUIRED", message: "请先在文档中选中需要 AI 协作修改的文字。" },
      { status: 422 },
    );
  }

  const scope = await loadCollaborationScope({
    request,
    courseId,
    requestedStudentId,
    stageKey,
    workspaceKind,
  });
  if (scope instanceof Response) return scope;
  const commentHistory = (messages: CompanionMessage[]) => restoreDocumentCommentReplyOrder({
    courseId, studentId: scope.student.id, participationId: scope.authentication.participationId,
    stageKey, workspaceKind, threadStageKey: documentCommentThreadKey(stageKey, workspaceKind),
  }, documentCommentThreads(messages));

  return await withClassroomAiUsage({ feature: "document-collaboration", courseId, studentId: scope.student.id, requestId }, async () => {

  if (["proactive-document-comments", "proactive-document-comment", "resume-proactive-review"].includes(action)) {
    return Response.json({ error: "DOCUMENT_AUTOMATIC_REVIEW_RETIRED", requestId,
      status: "cancelled", proactiveReviewEnabled: false }, { status: 410 });
  }

  const thread = await getCompanionThread(
    courseId,
    scope.student.id,
    collaborationThreadKey(stageKey, workspaceKind),
  );
  const currentConversationId = activeConversationId(thread?.messages ?? []);
  if (action === "cancel-request") {
    if (!boundedString(body.requestId, 160)) {
      return Response.json({ error: "REQUEST_ID_REQUIRED" }, { status: 400 });
    }
    const state = await cancelDocumentRequest({
      requestId,
      participationId: scope.authentication.participationId,
      courseId,
      studentId: scope.student.id,
      stageKey,
      workspaceKind,
      conversationId: commentThreadId || currentConversationId,
    });
    if (!state) return Response.json({ error: "REQUEST_NOT_FOUND" }, { status: 404 });
    activeDocumentRequests.get(documentRequestKey(scope.authentication.participationId, requestId))?.abort();
    return Response.json({ requestId, status: state.status });
  }
  if (action === "reset-conversation") {
    const conversationId = `ai-conversation-${randomUUID()}`;
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: collaborationThreadKey(stageKey, workspaceKind),
      messages: [companionMessage({
        role: "system-trigger",
        content: "学生在 AI 协作界面开始了新对话；此前记录保留用于学习过程分析。",
        visibility: "teacher-only",
        triggerKind: "conversation-reset",
        conversationId,
        authorName: "系统",
      })],
    });
    await recordInteractionEvents([{
      courseId,
      studentId: scope.student.id,
      stageKey,
      conversationId,
      source: "system",
      eventType: "comment",
      actorRole: "system",
      content: "学生开始了新的 AI 协作对话，旧记录保留。",
      payload: { action: "reset-conversation" },
      requestId,
    }], workspaceKind);
    return Response.json({ ok: true, conversationId, workspaceKind });
  }
  if (action === "read-document-comment") {
    if (!commentThreadId) {
      return Response.json({ error: "INVALID_COMMENT_THREAD" }, { status: 400 });
    }
    const commentStore = await getCompanionThread(
      courseId,
      scope.student.id,
      documentCommentThreadKey(stageKey, workspaceKind),
    );
    const existing = (await commentHistory(commentStore?.messages ?? []))
      .find((item) => item.id === commentThreadId);
    if (!existing) {
      return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    }
    const latestAssistantAt = existing.comments
      .filter((comment) => comment.role === "assistant")
      .map((comment) => comment.createdAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    if (existing.readAt && latestAssistantAt && Date.parse(existing.readAt) >= Date.parse(latestAssistantAt)) {
      return Response.json({ ok: true, readAt: existing.readAt });
    }
    const readAt = new Date().toISOString();
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: documentCommentThreadKey(stageKey, workspaceKind),
      messages: [companionMessage({
        role: "system-trigger",
        content: `${COMMENT_READ_PREFIX}${JSON.stringify({ id: commentThreadId, readAt })}`,
        visibility: "teacher-only",
        triggerKind: "document-comment-read",
        conversationId: commentThreadId,
        authorName: "系统",
      })],
    });
    return Response.json({ ok: true, readAt });
  }
  if (action === "set-document-comment-status") {
    const status = boundedString(body.status, 32);
    if (!commentThreadId || !["open", "resolved", "deferred", "not-applicable"].includes(status)) {
      return Response.json({ error: "INVALID_COMMENT_STATUS" }, { status: 400 });
    }
    const commentStore = await getCompanionThread(
      courseId,
      scope.student.id,
      documentCommentThreadKey(stageKey, workspaceKind),
    );
    const existing = (await commentHistory(commentStore?.messages ?? []))
      .find((item) => item.id === commentThreadId);
    if (!existing) return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    if (existing.status === status) return Response.json({ commentThread: existing });
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: documentCommentThreadKey(stageKey, workspaceKind),
      messages: [companionMessage({
        role: "system-trigger",
        content: `${COMMENT_STATUS_PREFIX}${JSON.stringify({ id: commentThreadId, status })}`,
        visibility: "teacher-only",
        triggerKind: "document-comment-read",
        conversationId: commentThreadId,
        authorName: "系统",
      })],
    });
    return Response.json({ commentThread: { ...existing, status } });
  }
  const userKey = scope.authentication.claims?.sub || getClientIp(request);
  const limit = companionLimiter.check(rateLimitKey(request, userKey));
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  if (action === "reply-document-comment") {
    if (!commentThreadId || !message) {
      return Response.json({ error: "INVALID_COMMENT_REPLY" }, { status: 400 });
    }
    const commentStore = await getCompanionThread(
      courseId,
      scope.student.id,
      documentCommentThreadKey(stageKey, workspaceKind),
    );
    const existing = (await commentHistory(commentStore?.messages ?? []))
      .find((item) => item.id === commentThreadId);
    if (!existing) {
      return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    }
    const documentVersion = digest(documentHtml);
    const replyTask: DocumentRequestInput = {
      requestId,
      participationId: scope.authentication.participationId,
      courseId,
      studentId: scope.student.id,
      stageKey,
      workspaceKind,
      threadStageKey: documentCommentThreadKey(stageKey, workspaceKind),
      conversationId: commentThreadId,
      documentVersion,
      message,
      intent: "comment-reply",
      history: existing.comments.map((comment) => ({
        role: comment.role === "student" ? "user" as const : "assistant" as const,
        content: comment.content,
      })),
      fingerprint: digest({ action, commentThreadId, message, documentHtml, targetText, contributionId }),
    };
    const replyClaim = await claimDocumentRequest(replyTask);
    if (replyClaim.kind === "conflict") return Response.json({ error: "REQUEST_ID_CONFLICT", requestId }, { status: 409 });
    if (replyClaim.kind === "existing") {
      if (replyClaim.state.status === "completed") {
        return Response.json({ ...replyClaim.state.response, requestId, status: "completed", documentVersion });
      }
      if (replyClaim.state.status === "cancelled") return Response.json({ requestId, status: "cancelled" }, { status: 409 });
      return Response.json({ requestId, status: "processing", retryAfterMs: 1_000 }, { status: 202 });
    }
    const replyController = new AbortController();
    const replyDeadline = AbortSignal.timeout(85_000);
    const replySignal = AbortSignal.any([replyController.signal, replyDeadline]);
    const activeKey = documentRequestKey(scope.authentication.participationId, requestId);
    activeDocumentRequests.set(activeKey, replyController);
    try {
      const commentPolicy = evaluateAiWorkPolicy({
        intent: "check",
        request: message,
        scope: "paragraph",
        hasStudentArtifact: Boolean(targetText || existing.blockText || existing.targetText),
        proactive: true,
        selectedText: existing.targetText,
      });
      const commentBoundary = protectedBoundaryForPolicy(commentPolicy, message);
      const prompts = buildDocumentCommentReplyPrompts({
        course: scope.course,
        studentId: scope.student.id,
        stageKey,
        documentText: documentHtmlToPlainText(documentHtml),
        targetText: existing.targetText,
        history: replyClaim.history.map((turn, index) => ({
          id: `request-history-${index}`,
          role: turn.role === "user" ? "student" as const : "assistant" as const,
          content: turn.content,
          createdAt: existing.createdAt,
        })),
        studentReply: message,
        protectedBoundary: commentBoundary,
      });
      const parsed = await callStructuredCollaborationModel([
        { role: "system", content: withWorkspaceInstruction(prompts.system, workspaceKind) },
        { role: "user", content: prompts.user },
      ], replySignal, (value) => typeof value.message === "string" && Boolean(value.message.trim()),
      attempt => recordInteractionEvents([{
        id: `document-reply-model:${replyClaim.token}:${attempt.attempt}`, courseId, studentId: scope.student.id,
        participationId: scope.authentication.participationId, stageKey, conversationId: commentThreadId,
        source: "proactive-comment", eventType: "response", actorRole: "system", requestId, content: attempt.raw,
        payload: { kind: "model-output", action, requestAttemptId: replyClaim.token, modelAttempt: attempt.attempt,
          validation: attempt.validation, rawSha256: attempt.sha256, rawLength: attempt.raw.length, documentVersion },
      }], workspaceKind));
      const reply = normalizeDocumentCommentReply(
        parsed,
        existing.targetText,
        commentBoundary,
      );
      if (!reply) throw new Error("EMPTY_DOCUMENT_COMMENT_REPLY");
      const studentMessage = companionMessage({
        // The persisted request predates model execution; do not timestamp
        // the student's question with the answer's completion time.
        createdAt: replyClaim.createdAt,
        role: "student",
        content: message,
        visibility: "student-and-teacher",
        authorId: scope.student.id,
        authorName: scope.student.name,
        conversationId: commentThreadId,
      });
      const agentMessage = companionMessage({
        role: "agent",
        content: reply.message,
        visibility: "student-and-teacher",
        companionId: "critic",
        authorName: "AI 组员",
        conversationId: commentThreadId,
      });
      const messages = [
        studentMessage,
        agentMessage,
        ...(reply.suggestion ? [companionMessage({
          role: "system-trigger",
          content: `${COMMENT_SUGGESTION_PREFIX}${JSON.stringify(reply.suggestion)}`,
          visibility: "teacher-only",
          triggerKind: "document-saved",
          authorName: "系统",
          conversationId: commentThreadId,
        })] : []),
      ];
      replySignal.throwIfAborted();
      const response = {
        commentThread: {
          ...existing,
          comments: [
            ...existing.comments,
            {
              id: studentMessage.id,
              role: "student" as const,
              content: studentMessage.content,
              createdAt: studentMessage.createdAt,
            },
            {
              id: agentMessage.id,
              role: "assistant" as const,
              content: agentMessage.content,
              createdAt: agentMessage.createdAt,
            },
          ],
        } satisfies DocumentAiCommentThread,
        result: reply,
        requestId,
        status: "completed",
        documentVersion,
      };
      const committed = await completeDocumentRequest({ ...replyTask, token: replyClaim.token, messages, response,
        messageFacts: {
          [studentMessage.id]: { eventType: "request", source: "proactive-comment",
            detail: { commentThreadId, targetText: existing.targetText } },
          [agentMessage.id]: { eventType: reply.suggestion ? "proposal" : "response", source: "proactive-comment",
            detail: { commentThreadId, contributionId, kind: reply.kind, suggestion: reply.suggestion ?? null } },
        },
      });
      if (!committed) return persistedDocumentRequestResponse(replyTask);
      return Response.json(response);
    } catch (error) {
      if (replyController.signal.aborted) return persistedDocumentRequestResponse(replyTask);
      const failure = collaborationFailureResponse(replyDeadline.aborted ? new LlmTimeoutError(85_000) : error, "discuss");
      const failureBody = await failure.json() as Record<string, unknown>;
      await failDocumentRequest({ ...replyTask, token: replyClaim.token, error: String(failureBody.error ?? "AI_COLLABORATION_FAILED") })
        .catch((taskError) => console.error("[ai-collaboration] comment reply receipt unavailable", taskError));
      return Response.json({ ...failureBody, requestId, status: "failed", retryable: true, documentVersion }, {
        status: failure.status,
        headers: failure.headers,
      });
    } finally {
      if (activeDocumentRequests.get(activeKey) === replyController) activeDocumentRequests.delete(activeKey);
    }
  }
  if (action === "suggest-delegated-work") {
    const suggestionContext = {
      course: scope.course,
      studentId: scope.student.id,
      stageKey,
      documentText: documentHtmlToPlainText(documentHtml),
    };
    const preparePrompts = (prompts: { system: string; user: string }) => ({
      ...prompts, system: withWorkspaceInstruction(prompts.system, workspaceKind),
    });
    const prompts = preparePrompts(buildDelegatedWorkStarterPrompts(suggestionContext));
    try {
      const task = buildDocumentSuggestionRequest({
        courseId, studentId: scope.student.id, participationId: scope.authentication.participationId,
        stageKey, workspaceKind, threadStageKey: collaborationThreadKey(stageKey, workspaceKind), documentHtml,
        generationPrompts: prompts,
        reviewPrompts: preparePrompts(buildDelegatedWorkStarterReviewPrompts({ ...suggestionContext, candidates: [] })),
        model: await getActiveAiSettings(),
      });
      const receipt = await cachedDocumentSuggestions(task, async (token, candidateStarters) => {
        // A disconnected browser may retrieve the completed durable result on retry.
        // Two reasoning calls share the existing 125-second durable lease.
        // Leave 15 seconds for committing the receipt after generation + review.
        const suggestionSignal = AbortSignal.timeout(COLLABORATION_EXECUTION_TIMEOUT_MS);
        try { return await withProactiveReviewCapacity(async () => {
          const generate = (step: "generation" | "review", messages: { system: string; user: string }) =>
            callStructuredCollaborationModel([
              { role: "system", content: messages.system },
              { role: "user", content: messages.user },
            ], suggestionSignal,
            value => Array.isArray(value.starters) && value.starters.every(item => typeof item === "string"),
            attempt => recordInteractionEvents([{
              id: `document-suggestions-model:${token}:${step}:${attempt.attempt}`,
              courseId, studentId: scope.student.id, participationId: scope.authentication.participationId,
              stageKey, source: "sidebar", eventType: "response", actorRole: "system",
              requestId: task.requestId, content: attempt.raw,
              payload: { kind: "model-output", action, modelStep: step, requestAttemptId: token,
                modelAttempt: attempt.attempt, validation: attempt.validation, rawSha256: attempt.sha256,
                rawLength: attempt.raw.length, documentVersion: task.documentVersion },
            }], workspaceKind));
          const candidates = candidateStarters ?? normalizeDelegatedWorkStarters(await generate("generation", prompts));
          if (!candidateStarters && !await prepareDocumentRequestResponse({ ...task, token, response: { candidateStarters: candidates } })) {
            throw new Error("SUGGESTION_LEASE_LOST");
          }
          if (!candidates.length) return [];
          const reviewPrompts = preparePrompts(buildDelegatedWorkStarterReviewPrompts({ ...suggestionContext, candidates }));
          return normalizeDelegatedWorkStarters(await generate("review", reviewPrompts));
        }, JSON.stringify(["document", courseId, scope.student.id, stageKey, workspaceKind, action, task.requestId])); } catch (error) {
          throw suggestionSignal.aborted ? new LlmTimeoutError(COLLABORATION_EXECUTION_TIMEOUT_MS) : error;
        }
      });
      return Response.json(receipt.body, { status: receipt.status });
    } catch (error) {
      if (isProactiveReviewCapacityError(error)) {
        return Response.json({ error: "AI_PROACTIVE_REVIEW_BUSY", message: "当前主动求助较多，稍后会重新准备任务建议。" }, {
          status: 503,
          headers: { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) },
        });
      }
      return collaborationFailureResponse(error, "delegate");
    }
  }
  if (action) {
    return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
  }
  if (!message || !isDocumentCollaborationIntent(body.intent)) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const intent = body.intent;
  // A selection-triggered request is always local. Older clients may still
  // label an organise/collect request as `delegate`; reinterpret that label
  // here so a stale browser can never escalate a selected paragraph into a
  // document-wide delegated operation.
  const effectiveIntent: DocumentCollaborationIntent = selectedText && intent === "delegate"
    ? "organize"
    : intent;
  const requestedConversationId = boundedString(body.conversationId, 160);
  if (requestedConversationId && requestedConversationId !== currentConversationId) {
    return Response.json(
      {
        error: "CONVERSATION_CHANGED",
        message: "当前对话已经更新，请重新发送。本次没有修改文档。",
        conversationId: currentConversationId,
      },
      { status: 409 },
    );
  }

  // The server, not the browser, owns the model context. This prevents old,
  // cleared, or client-injected turns from leaking back into a new task.
  const history = modelConversationHistory(thread?.messages ?? [], currentConversationId);
  const documentText = documentHtmlToPlainText(documentHtml);
  const revisionOf = parseDelegatedWorkRevision(body.revisionOf);
  const policyDecision: AiWorkPolicyDecision = evaluateAiWorkPolicy({
    intent: effectiveIntent,
    request: message,
    scope: selectedText ? "selection" : "document",
    hasStudentArtifact: Boolean(documentText),
    selectedText,
  });
  const protectedBoundary = protectedBoundaryForPolicy(policyDecision, message);
  const auxiliaryRequest = effectiveIntent === "delegate" && protectedBoundary
    ? separableAuxiliaryTask(message)
    : null;

  const documentVersion = digest(documentHtml);
  const respondAsync = request.headers.get("prefer")?.split(",")
    .some(value => value.trim().toLowerCase() === "respond-async") === true;
  const taskInput: DocumentRequestInput = {
    ...(respondAsync ? { executionMode: "background" as const } : {}),
    requestId,
    participationId: scope.authentication.participationId,
    courseId,
    studentId: scope.student.id,
    stageKey,
    workspaceKind,
    threadStageKey: collaborationThreadKey(stageKey, workspaceKind),
    conversationId: currentConversationId,
    documentVersion,
    message,
    intent: effectiveIntent,
    history,
    fingerprint: digest({
      courseId, stageKey, workspaceKind, currentConversationId, message,
      documentHtml, selectedText, proactive, intent, effectiveIntent, revisionOf,
      contributionId,
    }),
  };
  const claim = await claimDocumentRequest(taskInput);
  if (claim.kind === "conflict") {
    return Response.json({
      error: "REQUEST_ID_CONFLICT",
      message: "这条请求标识已用于另一项内容，请编辑后作为新消息发送。",
      requestId,
    }, { status: 409 });
  }
  if (claim.kind === "existing") {
    if (claim.state.status === "completed") {
      return Response.json({ ...claim.state.response, requestId, status: "completed", documentVersion });
    }
    if (claim.state.status === "cancelled") {
      return Response.json({ requestId, status: "cancelled", documentVersion }, { status: 409 });
    }
    return Response.json({ requestId, status: "processing", documentVersion, retryAfterMs: 1_000 }, { status: 202 });
  }
  const requestHistory = claim.history;

  const executionMs = respondAsync ? DOCUMENT_COLLABORATION_EXECUTION_TIMEOUT_MS
    : effectiveIntent === "delegate" ? 105_000 : 85_000;
  const deadlineSignal = AbortSignal.timeout(executionMs);
  const controller = new AbortController();
  const taskSignal = AbortSignal.any([deadlineSignal, controller.signal]);
  const activeKey = documentRequestKey(scope.authentication.participationId, requestId);
  activeDocumentRequests.set(activeKey, controller);
  let preparedCheckpoint: Record<string, unknown> = { ...claim.preparedResponse };
  const checkpoint = async (patch: Record<string, unknown>) => {
    preparedCheckpoint = { ...preparedCheckpoint, ...patch };
    if (!await prepareDocumentRequestResponse({ ...taskInput, token: claim.token, response: preparedCheckpoint })) {
      controller.abort(); taskSignal.throwIfAborted();
    }
  };

  const execute = async () => {
  try {
    taskSignal.throwIfAborted();
    // These are operation boundaries, not provider-only or DB-only time: support
    // includes memory/retrieval, model calls retain their existing retries, and
    // durable audits may fall back to the file outbox. Keep the original signal.
    const [projectSupportContext, deliveredWorkSummary] = await Promise.all([
      timeProgress("document-support-context", () => resolveProjectSupportContext({
      course: scope.course,
      studentId: scope.student.id,
      participationId: scope.authentication.participationId,
      message,
      history: requestHistory,
      allowRetrieval: !proactive && ["discuss", "check", "delegate"].includes(effectiveIntent),
      signal: taskSignal,
      })),
      effectiveIntent === "delegate" && (!protectedBoundary || auxiliaryRequest)
        ? timeProgress("document-delegation-history", () => readDelegatedWorkSummary(taskInput, { signal: taskSignal }))
        : Promise.resolve(""),
    ]);
    let result: DocumentCollaborationResponse;
    let memoryCandidates: ProjectMemoryCandidate[] = [];
    if (effectiveIntent === "delegate" && (!protectedBoundary || auxiliaryRequest)) {
      result = await executeDelegatedWork({
        course: scope.course,
        student: scope.student,
        stageKey,
        request: message,
        auxiliaryRequest: auxiliaryRequest ?? undefined,
        documentText,
        // Plain text deliberately omits markup; preserve heading identity for
        // formatting requests so prose cannot silently become a new heading.
        documentHeadings: [...documentHtml.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)]
          .map((match) => ({ text: documentHtmlToPlainText(match[2]), level: Number(match[1]) })),
        history: requestHistory,
        signal: taskSignal,
        revisionOf,
        workspaceKind,
        projectSupportContext,
        deliveredWorkSummary,
        prepared: claim.preparedResponse,
        checkpoint,
        recordModel: (step, attempt) => recordInteractionEvents([{
          id: `document-delegation-model:${claim.token}:${step}:${attempt.attempt}`, courseId, studentId: scope.student.id,
          participationId: scope.authentication.participationId, stageKey, conversationId: currentConversationId,
          source: "sidebar", eventType: "response", actorRole: "system", requestId, content: attempt.raw,
          payload: { kind: "model-output", modelStep: step, requestAttemptId: claim.token, modelAttempt: attempt.attempt,
            validation: attempt.validation, rawSha256: attempt.sha256, rawLength: attempt.raw.length, documentVersion },
        }], workspaceKind),
      });
      result.support = normalizeProjectSupportOutput(
        { sourceIds: result.deliverable?.sources.map((source) => source.id).filter(Boolean) ?? [] },
        projectSupportContext.sources,
        projectSupportContext,
        projectSupportContext.knowledgePointLabels,
      ).details;
      if (auxiliaryRequest && result.kind === "work-delivery") {
        result.message = `${result.message} 我只处理了可独立完成的辅助部分；核心判断和最终结论仍由你完成。`;
      }
    } else {
      const prompts = buildDocumentCollaborationPrompts({
        course: scope.course,
        studentId: scope.student.id,
        studentName: scope.student.name,
        stageKey,
        intent: effectiveIntent,
        request: message,
        documentText,
        documentHtml,
        selectedText,
        history: requestHistory,
        protectedBoundary,
        proactive,
        projectSupportContext: projectSupportContext.promptContext,
      });
      let llmMessages = [
        { role: "system" as const, content: withWorkspaceInstruction(prompts.system, workspaceKind) },
        { role: "user" as const, content: prompts.user },
      ];
      const reviewDiscussion = !selectedText && !proactive
        && (Boolean(protectedBoundary) || ["discuss", "check", "summarize"].includes(effectiveIntent));
      let parsed: Record<string, unknown>;
      if (reviewDiscussion) {
        parsed = await reviewedDocumentDiscussion({
          messages: llmMessages, request: message, documentText,
          studentHistory: requestHistory.filter(item => item.role === "user").map(item => item.content),
          expectedKind: protectedBoundary ? "boundary" : "discussion", signal: taskSignal, prepared: claim.preparedResponse,
          compactMessages: () => {
            const compact = buildDocumentCollaborationPrompts({ course: scope.course, studentId: scope.student.id,
              studentName: scope.student.name, stageKey, intent: effectiveIntent, request: message, documentText, documentHtml,
              selectedText, history: requestHistory, protectedBoundary, proactive, compact: true,
              projectSupportContext: projectSupportContext.promptContext });
            return [{ role: "system", content: withWorkspaceInstruction(compact.system, workspaceKind) },
              { role: "user", content: compact.user }];
          },
          visibleCandidate: candidate => {
            const response = normalizeDocumentCollaborationResponse(candidate, selectedText, protectedBoundary, effectiveIntent);
            const { replyBlocks, ...visibleSupport } = normalizeProjectSupportOutput(candidate.support,
              projectSupportContext.sources, projectSupportContext, projectSupportContext.knowledgePointLabels).details;
            return { ...response, message: replyBlocks?.length ? replyBlocks.map(block => block.content).join("\n\n") : response.message,
              support: visibleSupport };
          },
          checkpoint,
          record: (step, attempt) => recordInteractionEvents([{
            id: `document-discussion-model:${claim.token}:${step}:${attempt.attempt}`,
            courseId, studentId: scope.student.id, participationId: scope.authentication.participationId,
            stageKey, conversationId: currentConversationId, source: "sidebar", eventType: "response", actorRole: "system",
            requestId, content: attempt.raw,
            payload: { kind: "model-output", modelStep: step, requestAttemptId: claim.token, modelAttempt: attempt.attempt,
              validation: attempt.validation, rawSha256: attempt.sha256, rawLength: attempt.raw.length, documentVersion },
          }], workspaceKind),
        });
      } else {
      let raw: string;
      try {
        raw = await timeProgress("document-model-initial", () => callCollaborationModel(llmMessages, taskSignal));
      } catch (error) {
        if (!(error instanceof LlmCallFailedError) || upstreamFailureCategory(error) !== "context-limit") throw error;
        // A compatible endpoint can reject a dense prompt with HTTP 400. Retry
        // once with a smaller, history-light prompt before asking the student to
        // change anything. The current request and project boundary stay intact.
        const compactPrompts = buildDocumentCollaborationPrompts({
          course: scope.course,
          studentId: scope.student.id,
          studentName: scope.student.name,
          stageKey,
          intent: effectiveIntent,
          request: message,
          documentText,
          selectedText,
          history: requestHistory,
          protectedBoundary,
          proactive,
          compact: true,
          projectSupportContext: projectSupportContext.promptContext,
        });
        llmMessages = [
          { role: "system" as const, content: withWorkspaceInstruction(compactPrompts.system, workspaceKind) },
          { role: "user" as const, content: compactPrompts.user },
        ];
        raw = await timeProgress("document-model-context-retry", () => callLLM(llmMessages, {
          jsonMode: false,
          abortSignal: taskSignal,
          maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
        }));
      }
      parsed = await repairDocumentModelResponse({ raw, messages: llmMessages, signal: taskSignal,
        generate: (messages, signal) => timeProgress("document-model-repair", () => callCollaborationModel(messages, signal)),
        recordSuccess: output => timeProgress("document-audit-success", () => recordInteractionEvents([{
          id: `document-model-success:${claim.token}:${output.attempt}`,
          courseId: scope.course.id, studentId: scope.student.id, participationId: scope.authentication.participationId,
          stageKey, conversationId: currentConversationId, source: selectedText || intent === "edit" ? "selection" : "sidebar",
          eventType: "response", actorRole: "system", requestId, content: output.raw,
          payload: { kind: "model-output", requestAttemptId: claim.token, modelAttempt: output.attempt,
            rawSha256: output.sha256, rawLength: output.raw.length, intent, effectiveIntent, documentVersion,
            ...(output.recovery ? { recovery: output.recovery } : {}) },
        }], workspaceKind)),
        recordInvalid: attempt => timeProgress("document-audit-invalid", () => recordInteractionEvents([{
          id: `document-model:${claim.token}:${attempt.attempt}`,
          courseId: scope.course.id, studentId: scope.student.id, participationId: scope.authentication.participationId,
          stageKey, conversationId: currentConversationId, source: selectedText || intent === "edit" ? "selection" : "sidebar",
          eventType: "error", actorRole: "system", requestId, content: attempt.raw,
          payload: { kind: "invalid-model-response", code: "AI_RESPONSE_INVALID_STRUCTURE", requestAttemptId: claim.token,
            modelAttempt: attempt.attempt, reason: attempt.reason, rawSha256: attempt.sha256, rawLength: attempt.raw.length,
            intent, effectiveIntent, documentVersion },
        }], workspaceKind)),
      });
      }
      result = normalizeDocumentCollaborationResponse(
        parsed,
        selectedText,
        protectedBoundary,
        effectiveIntent,
      );
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
      memoryCandidates = normalizedSupport.memoryCandidates;
    }
    const companionId = companionForIntent(effectiveIntent);
    const assistantRecord = assistantRecordForResult(result);
    const persistedMessages = [
      ...(!proactive ? [companionMessage({
        role: "student" as const,
        content: message,
        visibility: "student-and-teacher" as const,
        authorId: scope.student.id,
        authorName: scope.student.name,
        conversationId: currentConversationId,
      })] : []),
      companionMessage({
        role: "agent",
        content: assistantRecord,
        visibility: "student-and-teacher",
        companionId,
        authorName: "AI 组员",
        conversationId: currentConversationId,
        projectSupport: result.support,
      }),
    ];
    // Once a valid answer exists, optional memory must not consume its right to commit.
    taskSignal.throwIfAborted();
    const memories = await timeProgress("document-memory-read", () => listProjectMemories(scope.authentication.participationId, { signal: taskSignal })).catch((memoryError) => {
      console.warn("[ai-collaboration] project memory read unavailable", memoryError);
      return null;
    });
    const response = {
      result,
      companionId,
      conversationId: currentConversationId,
      workspaceKind,
      messages: persistedMessages,
      ...(memories ? { memories } : {}),
      requestId,
      status: "completed",
      documentVersion,
    };
    controller.signal.throwIfAborted();
    const source = selectedText || intent === "edit" ? "selection" : "sidebar";
    const committed = await completeDocumentRequest({
      ...taskInput,
      token: claim.token,
      messages: persistedMessages,
      response,
      messageFacts: Object.fromEntries(persistedMessages.map(item => [item.id, {
        source,
        detail: item.role === "student"
          ? { intent, effectiveIntent, selectedText, documentLength: documentText.length }
          : { kind: result.kind, companionId, contributionId, suggestion: result.suggestion ?? null,
              deliverable: result.deliverable ?? null, support: result.support ?? null },
      }])),
      auditEvents: [{
        idempotencyKey: `document-policy:${taskInput.participationId}:${requestId}`,
        eventType: "policy", actor: "system", content: policyDecision.reason,
        payload: { schemaVersion: 1, legacy: { stageKey, source, conversationId: currentConversationId },
          detail: { ...policyDecision, workspaceKind } },
      }],
    });
    if (!committed) {
      return persistedDocumentRequestResponse(taskInput);
    }
    if (!proactive && memoryCandidates.length) {
      void saveProjectMemoryCandidates({
        participationId: scope.authentication.participationId,
        stageKey,
        studentId: scope.student.id,
        studentMessage: message,
        sourceMessageIds: persistedMessages.map((item) => item.id),
        candidates: memoryCandidates,
      }).catch((memoryError) => {
        console.warn("[ai-collaboration] project memory write unavailable", memoryError);
      });
    }
    return Response.json(response);
  } catch (error) {
    if (controller.signal.aborted) return persistedDocumentRequestResponse(taskInput);
    const failure = deadlineSignal.aborted ? new LlmTimeoutError(executionMs) : error;
    console.error(
      "[ai-collaboration/document] generation failed:",
      {
        requestId,
        name: failure instanceof Error ? failure.name : "UnknownError",
        status: failure instanceof LlmCallFailedError ? failure.status ?? "unknown" : undefined,
        category: failure instanceof DocumentModelStructureError ? failure.reason : upstreamFailureCategory(failure),
        modelAttempts: failure instanceof DocumentModelStructureError ? failure.attempts : undefined,
      },
    );
    const failureResponse = collaborationFailureResponse(failure, effectiveIntent);
    const failureBody = await failureResponse.json() as Record<string, unknown>;
    await failDocumentRequest({
      ...taskInput,
      token: claim.token,
      error: String(failureBody.error ?? "AI_COLLABORATION_FAILED"),
    }).catch((taskError) => console.error("[ai-collaboration] task failure receipt unavailable", taskError));
    await recordInteractionEvents([{
      courseId: scope.course.id,
      studentId: scope.student.id,
      stageKey,
      conversationId: currentConversationId,
      source: selectedText || intent === "edit" ? "selection" : "sidebar",
      eventType: "request",
      actorRole: "student",
      actorId: scope.student.id,
      content: message,
      payload: { intent, effectiveIntent, selectedText, documentLength: documentText.length },
      requestId,
    }, {
      id: `document-failure:${claim.token}`,
      courseId: scope.course.id,
      studentId: scope.student.id,
      stageKey,
      conversationId: currentConversationId,
      source: selectedText || intent === "edit" ? "selection" : "sidebar",
      eventType: "error",
      actorRole: "system",
      content: failure instanceof Error ? failure.message : "AI 组员请求失败",
      payload: { intent, effectiveIntent, requestAttemptId: claim.token,
        ...(failure instanceof DocumentModelStructureError ? { code: failure.code, reason: failure.reason, modelAttempts: failure.attempts } : {}) },
      requestId,
    }], workspaceKind);
    return Response.json({
      ...failureBody,
      requestId,
      status: "failed",
      retryable: typeof failureBody.retryable === "boolean" ? failureBody.retryable : failureResponse.status !== 422,
      documentVersion,
    }, { status: failureResponse.status, headers: failureResponse.headers });
  } finally {
    if (activeDocumentRequests.get(activeKey) === controller) activeDocumentRequests.delete(activeKey);
  }
  };
  if (respondAsync) {
    // Register with Next's response lifecycle. A short acknowledgement must not
    // cancel model work; explicit cancellation still uses the same controller.
    after(() => withClassroomAiUsage({ feature: "document-collaboration", courseId,
      studentId: scope.student.id, requestId }, async () => {
      try { await execute(); }
      catch (error) {
        // execute persists model failures itself. Persistence failures must also
        // be consumed after the response; the lease permits later recovery.
        console.error("[ai-collaboration/document] background receipt failed", {
          requestId, name: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }));
    return Response.json({ requestId, status: "processing", phase: "running",
      documentVersion, retryAfterMs: 1_500 }, {
      status: 202, headers: { "Preference-Applied": "respond-async" },
    });
  }
  return execute();
  });
  } catch (error) { return documentRequestFailure(error, requestId); }
}
