"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadMultipartWithReceipt } from '@/lib/browser/upload-request';
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";
import {
  ArrowLeft,
  Check,
  FilePenLine,
  LoaderCircle,
  RefreshCcw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import {
  PlateDocumentEditor,
  type PlateDocumentEditorHandle,
  type PlateDocumentSelection,
} from "@/components/plate-document-editor";
import { PrimaryButton } from "@/components/ui";
import { FinalArtifactSubmission } from "@/components/views/student/final-artifact-submission";
import { ExternalArtifactSubmission } from "@/components/views/student/external-artifact-submission";
import { CollaborationProjectDetails } from "./collaboration-project-details";
import {
  AiMemberWorkspace,
  type AiMemberWorkspaceMessage,
} from "@/components/views/student/ai-member-workspace";
import type {
  DelegatedWorkDeliverable,
  DocumentCollaborationIntent,
  DocumentCollaborationResponse,
  DocumentCollaborationSuggestion,
} from "@/lib/ai-collaboration/document-policy";
import type { AiContribution } from "@/lib/learning-evidence/types";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";
import { cn } from "@/lib/utils";
import { collaborationBackHref, inferStageCollectionMode } from "@/lib/system-mode";
import { DashboardTopBar } from "@/components/dashboard-shell";
import { StudentClassroomHeaderStatus } from "@/components/classroom/student-classroom-header-status";
import { useCoursePresence } from "@/hooks/use-course-presence";
import {
  EXTERNAL_ARTIFACT_COLLABORATION_TEMPLATE,
  type CollaborationWorkspaceKind,
} from "@/lib/ai-collaboration/workspace-kind";
import type { ProjectMemoryEntry, ProjectSupportDetails } from "@/lib/ai-collaboration/project-support-types";
import { useProjectMemory } from "@/components/views/student/use-project-memory";
import { clientUUID } from "@/lib/uuid";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import { sendOrRecoverDocumentRequest, DocumentRequestUnconfirmedError, DOCUMENT_RECEIPT_TIMEOUT_MS } from "@/lib/browser/document-collaboration-transport";
import { inferDocumentMemberIntent } from "@/lib/ai-collaboration/document-member-intent";
import { documentRequestFailureDetails } from "@/lib/ai-collaboration/document-request-failure";
import { flushAiInteractionEvents, queueAiInteractionEvent } from "@/lib/browser/ai-event-outbox";
import { documentVersionDigest } from "@/lib/ai-collaboration/document-version";
import { createAiRevisionSource } from "@/lib/browser/ai-revision-source";
import { SubmissionSaveConflictPanel } from "./submission-save-conflict";
import { buildDocumentDraftExport, documentDraftKey, readDocumentDrafts, writeDocumentDraft, type PendingDocumentDraft } from "@/lib/browser/document-draft";
import collaborationStyles from "./collaboration-responsive.module.css";
import { useWorkspaceToolbarOffset } from "./use-workspace-toolbar-offset";
import { DocumentWorkspaceLayout, useDocumentWorkspaceLayout } from "./document-workspace-layout";
import { useDocumentContentMonitor } from "./use-document-content-monitor";
import { DocumentContentReminder } from "./document-content-reminder";
import { DocumentContentMonitorStatus, DocumentRevisionNote } from "./document-workspace-header-tools";

type CollaborationMessage = AiMemberWorkspaceMessage;

function readOnlyResultMessage(result: DocumentCollaborationResponse, notice: string): string {
  return [
    result.message,
    result.deliverable?.content,
    result.suggestion ? `建议内容（仅供阅读）：\n\n${result.suggestion.replacement}` : "",
    notice,
  ].filter(Boolean).join("\n\n");
}

// A receipt owns this captured record, not a key another tab may have updated.
function acknowledgeExactDocumentDraft(draft: PendingDocumentDraft) {
  if (localStorage.getItem(draft.key) === JSON.stringify(draft)) localStorage.removeItem(draft.key);
}

type DocumentRequestSnapshot = {
  requestId: string;
  messageId: string;
  contributionId: string;
  createdAt: string;
  conversationId: string;
  intent: DocumentCollaborationIntent;
  message: string;
  documentHtml: string;
  selection: PlateDocumentSelection | null;
  revisionOf?: DeliveryRevision | null;
};

type DocumentRequestPayload = {
  requestId?: string;
  status?: "processing" | "completed" | "failed" | "cancelled";
  retryAfterMs?: number;
  retryable?: boolean;
  error?: string;
  message?: string;
  failureMessage?: string;
  phase?: "queued" | "running";
  result?: DocumentCollaborationResponse;
  companionId?: AiContribution["companionId"];
  conversationId?: string;
  documentVersion?: string;
  messages?: Array<{ id: string; role: string }>;
  memories?: ProjectMemoryEntry[];
};

type PendingSuggestion = {
  id: string;
  confirmationId: string;
  contribution: AiContribution;
  suggestion: DocumentCollaborationSuggestion;
  selection: PlateDocumentSelection | null;
  presentation: "inline" | "blocks";
  previewReady: boolean;
  conversationId: string;
};

type PendingDelivery = {
  id: string;
  confirmationId: string;
  contribution: AiContribution;
  deliverable: DelegatedWorkDeliverable;
  documentHtml: string;
  conversationId: string;
  previewReady: boolean;
  error?: string | null;
};

type DeliveryRevision = {
  title: string;
  content: string;
};

type UndoableEdit = {
  title: string;
  beforeHtml: string;
  afterHtml: string;
  confirmationId: string;
  contribution: AiContribution;
  decisionId: string;
  conversationId: string;
  source: "sidebar" | "selection" | "proactive-comment";
};

type EditNotice = {
  kind: "applied" | "undone";
  title: string;
};

const MODIFICATION_INTENTS = new Set<DocumentCollaborationIntent>(["edit"]);
const WRITING_INTENTS = new Set<DocumentCollaborationIntent>(["edit", "organize", "delegate"]);

function pendingRequestStorageKey(scope: string): string {
  return `openpbl:document-collaboration:requests:${scope}`;
}

function requestFailureMessage(error?: string, message?: string, originalMessage?: string): string {
  if (error === "REQUEST_INTERRUPTED") return "这次回答中断了，你的消息已保留。可以重新尝试。";
  if (error === "REQUEST_ID_CONFLICT") return "这次请求的内容已变化。请编辑后作为新消息发送。";
  if (message && message !== originalMessage) return message;
  return documentRequestFailureDetails(error).failureMessage;
}

function readPendingRequestSnapshots(scope: string): DocumentRequestSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(pendingRequestStorageKey(scope)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DocumentRequestSnapshot => {
      if (!item || typeof item !== "object") return false;
      const snapshot = item as Partial<DocumentRequestSnapshot>;
      return typeof snapshot.requestId === "string"
        && typeof snapshot.messageId === "string"
        && typeof snapshot.contributionId === "string"
        && typeof snapshot.message === "string"
        && typeof snapshot.documentHtml === "string"
        && typeof snapshot.conversationId === "string"
        && typeof snapshot.createdAt === "string"
        && Date.now() - Date.parse(snapshot.createdAt) < 24 * 60 * 60_000;
    }).slice(-8);
  } catch {
    return [];
  }
}

function writePendingRequestSnapshots(scope: string, snapshots: DocumentRequestSnapshot[]): void {
  try {
    if (snapshots.length) {
      window.sessionStorage.setItem(pendingRequestStorageKey(scope), JSON.stringify(snapshots.slice(-8)));
    } else {
      window.sessionStorage.removeItem(pendingRequestStorageKey(scope));
    }
  } catch {
    // The server task remains authoritative if browser storage is unavailable.
  }
}

function plainTextLength(html: string): number {
  if (typeof window === "undefined") return html.replace(/<[^>]*>/g, " ").trim().length;
  const node = window.document.createElement("div");
  node.innerHTML = html;
  return (node.textContent ?? "").replace(/\s+/g, "").length;
}

function nowId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}


export function DocumentAiCollaboration({
  courseId,
  workspaceKind = "document",
}: {
  courseId: string;
  workspaceKind?: CollaborationWorkspaceKind;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const course = useCourse(courseId);
  const resolvedCourseId = course?.id;
  const session = useSession();
  const studentId = session.studentId ?? "";
  const stage = course?.stages[course.currentStageIndex];
  useCoursePresence({
    courseId: course?.id,
    role: "student",
    enabled: course?.status === "teaching",
    heartbeat: true,
    readSnapshot: false,
    readPendingSaves: session.readPendingSubmissionSaves,
  });
  const stageKey = stage?.key ?? "";
  const requestScope = `${resolvedCourseId ?? courseId}:${studentId}:${stageKey}:${workspaceKind}`;
  const isExternalArtifact = workspaceKind === "external-artifact";
  const workspaceNoun = isExternalArtifact ? "成果协作稿" : "文档";
  const supportedStage = stageKey === "make" && course?.status === "teaching";
  const projectMemory = useProjectMemory({
    courseId: resolvedCourseId ?? "",
    studentId,
    enabled: Boolean(resolvedCourseId && studentId && supportedStage),
    initialRead: "deferred",
  });
  const replaceProjectMemories = projectMemory.replaceMemories;
  const refreshProjectMemories = projectMemory.refresh;
  const editorRef = useRef<PlateDocumentEditorHandle>(null);
  const { headerRef: workspaceHeaderRef, toolbarTop } = useWorkspaceToolbarOffset();
  const workspace = useDocumentWorkspaceLayout(studentId ?? "", toolbarTop);
  const submissionIdRef = useRef<string | undefined>(undefined);
  const submissionVersionRef = useRef(0);
  const pendingDraftRef = useRef<PendingDocumentDraft | null>(null);
  const draftKeyRef = useRef("");
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const finalizeInFlightRef = useRef(false);
  const [saveRetry, setSaveRetry] = useState(0);
  const recoveredDraftKeyRef = useRef<string | undefined>(undefined);
  const recoveredDraftRef = useRef<PendingDocumentDraft | null>(null);
  const saveConfirmationRef = useRef({ pending: 0, uncertain: false });
  const [localDraftError, setLocalDraftError] = useState<string | null>(null);
  const [interactionSyncError, setInteractionSyncError] = useState<string | null>(null);
  const loadedScopeRef = useRef("");
  const requestSnapshotsRef = useRef<Map<string, DocumentRequestSnapshot>>(new Map());
  const activeRequestRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const readOnlyRecoveryControllersRef = useRef<Map<string, AbortController>>(new Map());
  const cancellationControllersRef = useRef<Map<string, AbortController>>(new Map());
  const recoveredRequestIdsRef = useRef<Set<string>>(new Set());
  const recoverRequestRef = useRef<((requestId: string) => void) | null>(null);
  const savedContentRef = useRef("");
  const currentDocumentRef = useRef("");
  const currentConversationRef = useRef("legacy");
  const [documentHtml, setDocumentHtml] = useState("");
  const [documentReady, setDocumentReady] = useState(false);
  const pasteMonitoringEnabled = Boolean(supportedStage && !isExternalArtifact && documentReady
    && course?.pblConfig?.documentPasteMonitoringEnabled);
  const contentMonitor = useDocumentContentMonitor({
    courseId: resolvedCourseId ?? courseId,
    studentId,
    enabled: pasteMonitoringEnabled,
    documentHtml,
  });
  const [selection, setSelection] = useState<PlateDocumentSelection | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [intent, setIntent] = useState<DocumentCollaborationIntent>("discuss");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [conversationId, setConversationId] = useState("legacy");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSuggestion, setPendingSuggestion] = useState<PendingSuggestion | null>(null);
  const [pendingDelivery, setPendingDelivery] = useState<PendingDelivery | null>(null);
  const pendingReviewRef = useRef(false);
  pendingReviewRef.current = Boolean(pendingSuggestion || pendingDelivery);
  const [deliveryRevision, setDeliveryRevision] = useState<DeliveryRevision | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [undoableEdit, setUndoableEdit] = useState<UndoableEdit | null>(null);
  const [editNotice, setEditNotice] = useState<EditNotice | null>(null);
  const memberOpen = workspace.memberOpen;
  const [submitting, setSubmitting] = useState(false);
  const [revisionNote, setRevisionNote] = useState("");
  const aiRevisionSources = useRef(new Map<string, { before: string; contributionId: string; action: "adopted" | "undo" }>());
  const [submittedVersion, setSubmittedVersion] = useState<{
    sequence: number;
    submittedAt?: string;
    downloadUrl: string;
  } | null>(null);

  const group = course?.groups?.find((item) =>
    item.members.some((member) => member.studentId === studentId));
  const existingDocument = !course || !studentId || !supportedStage
    ? undefined
    : [...(course.submissions ?? [])]
      .filter((item) =>
        item.stageKey === stageKey
        && item.type === (isExternalArtifact ? "artifact-brief" : "document")
        && (
          item.studentId === studentId
          || Boolean(group?.id && item.groupId === group.id)
        ))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const saveConflict = session.submissionSaveConflicts?.find(item => item.action.payload.courseId === courseId
    && item.actorId === studentId && item.action.payload.submission.stageKey === stageKey
    && item.action.payload.submission.type === (isExternalArtifact ? "artifact-brief" : "document"));
  const documentTitle = isExternalArtifact
    ? "成果协作稿"
    : stageKey === "proposal"
      ? "项目方案协作文档"
      : "项目成果协作文档";
  const projectTitle = (course ? getCourseStageRequirements(course, stageKey)?.drivingQuestion : "")
    || course?.drivingQuestion
    || group?.topic
    || course?.name
    || documentTitle;
  const canSubmitFinal = stageKey === "make" && !isExternalArtifact;

  useEffect(() => {
    if (!editNotice) return;
    const timer = window.setTimeout(
      () => setEditNotice(null),
      editNotice.kind === "applied" ? 5_000 : 3_000,
    );
    return () => window.clearTimeout(timer);
  }, [editNotice]);

  useEffect(() => {
    const recoveries = readOnlyRecoveryControllersRef.current;
    const cancellations = cancellationControllersRef.current;
    const recoveredIds = recoveredRequestIdsRef.current;
    return () => {
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      recoveries.forEach((controller) => controller.abort());
      recoveries.clear();
      cancellations.forEach((controller) => controller.abort());
      cancellations.clear();
      recoveredIds.clear();
    };
  }, [resolvedCourseId, studentId, stageKey, workspaceKind]);

  useEffect(() => {
    if (!hydrated) return;
    if (session.joinedCourseId && session.joinedCourseId !== courseId) {
      router.replace("/student");
    }
  }, [courseId, hydrated, router, session.joinedCourseId]);

  useEffect(() => {
    if (!course || !studentId || !supportedStage) return;
    const scopeKey = `${course.id}:${studentId}:${stageKey}:${workspaceKind}`;
    if (loadedScopeRef.current === scopeKey) return;
    loadedScopeRef.current = scopeKey;
    aiRevisionSources.current.clear();
    setRevisionNote("");
    setBusy(false);
    const localDrafts = readDocumentDrafts(scopeKey);
    const confirmedVersion = existingDocument?.version ?? 0;
    for (const draft of localDrafts) {
      if (!draft.requiresConfirmation && existingDocument && draft.content === existingDocument.content && draft.expectedVersion <= confirmedVersion) {
        try { acknowledgeExactDocumentDraft(draft); } catch { /* Keep if local storage is unavailable. */ }
      }
    }
    const recoverable = localDrafts.filter(draft => draft.expectedVersion >= confirmedVersion
      && (draft.expectedVersion > confirmedVersion || draft.requiresConfirmation === true || draft.content !== existingDocument?.content));
    const recovered = recoverable[0];
    const conflicting = localDrafts.filter(draft => draft.expectedVersion < confirmedVersion
      && (draft.requiresConfirmation === true || draft.content !== existingDocument?.content));
    const serverContent = existingDocument?.content ?? (isExternalArtifact ? EXTERNAL_ARTIFACT_COLLABORATION_TEMPLATE : "");
    const initialContent = recovered?.content ?? serverContent;
    pendingDraftRef.current = recovered ?? null;
    recoveredDraftKeyRef.current = recovered?.key;
    recoveredDraftRef.current = recovered ?? null;
    // A new scope must not inherit an old scope's in-flight completion counter.
    saveConfirmationRef.current = { pending: 0, uncertain: recovered?.requiresConfirmation === true
      || Boolean(recovered && recovered.expectedVersion > confirmedVersion) };
    draftKeyRef.current = documentDraftKey(scopeKey);
    submissionIdRef.current = recovered?.submissionId ?? existingDocument?.id ?? clientUUID();
    submissionVersionRef.current = recovered?.expectedVersion ?? existingDocument?.version ?? 0;
    setLocalDraftError(conflicting.length ? `本机保留了 ${conflicting.length} 份与服务器版本冲突的草稿，请下载核对。` : null);
    // A new external workspace starts with a real, editable proxy draft.  Mark
    // it unsaved once so the normal autosave persists the template exactly once;
    // subsequent refreshes load that submission instead of reinserting it.
    savedContentRef.current = existingDocument ? serverContent : (isExternalArtifact ? "" : serverContent);
    setDocumentHtml(initialContent);
    currentDocumentRef.current = initialContent;
    setDocumentReady(true);
    setSaveStatus(recovered || (!existingDocument && isExternalArtifact) ? "unsaved" : "saved");
    setSelection(null);
    setPendingSuggestion(null);
    setPendingDelivery(null);
    setDeliveryRevision(null);
    setUndoableEdit(null);
    requestSnapshotsRef.current = new Map(readPendingRequestSnapshots(scopeKey).map((snapshot) => [snapshot.requestId, snapshot]));
  }, [course, existingDocument, existingDocument?.content, existingDocument?.id, existingDocument?.version, isExternalArtifact, stageKey, studentId, supportedStage, workspaceKind]);

  useEffect(() => {
    const latest = (course?.projectDocumentVersions ?? [])
      .filter((version) => version.submissionId === submissionIdRef.current && version.status === "submitted")
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (latest?.docxUploadId) {
      setSubmittedVersion({
        sequence: latest.sequence,
        submittedAt: latest.submittedAt,
        downloadUrl: `/api/uploads/${latest.docxUploadId}?download=1`,
      });
    }
  }, [course?.projectDocumentVersions, existingDocument?.id]);

  useEffect(() => {
    if (!resolvedCourseId || !studentId || !supportedStage) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ courseId: resolvedCourseId, studentId, stageKey, workspaceKind });
    void boundedFetch(`/api/ai-collaboration/document?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("无法加载文档协作记录。");
      const payload = await response.json() as {
        memories?: ProjectMemoryEntry[];
        memoriesAvailable?: boolean;
        conversationId?: string;
        messages?: Array<{
          id: string;
          role: string;
          content: string;
          createdAt: string;
          projectSupport?: ProjectSupportDetails;
        }>;
        requests?: Array<{
          requestId: string;
          conversationId?: string;
          message?: string;
          intent?: DocumentCollaborationIntent;
          status: "processing" | "failed" | "cancelled";
          createdAt?: string;
          error?: string;
          failureMessage?: string;
          retryable?: boolean;
        }>;
      };
      if (controller.signal.aborted) return;
      const loadedConversationId = payload.conversationId || "legacy";
      currentConversationRef.current = loadedConversationId;
      setConversationId(loadedConversationId);
      const loadedMessages: CollaborationMessage[] = (payload.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role === "student" ? "user" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
        support: message.projectSupport,
      }));
      const snapshots = readPendingRequestSnapshots(`${resolvedCourseId}:${studentId}:${stageKey}:${workspaceKind}`);
      requestSnapshotsRef.current = new Map(snapshots.map((snapshot) => [snapshot.requestId, snapshot]));
      const pendingById = new Map((payload.requests ?? [])
        .filter((request) => !request.conversationId || request.conversationId === loadedConversationId)
        .map((request) => [request.requestId, request]));
      const requestIds = new Set([...pendingById.keys(), ...snapshots
        .filter((snapshot) => snapshot.conversationId === loadedConversationId)
        .map((snapshot) => snapshot.requestId)]);
      for (const requestId of requestIds) {
        const request = pendingById.get(requestId);
        const snapshot = requestSnapshotsRef.current.get(requestId);
        const content = request?.message ?? snapshot?.message;
        if (!content) continue;
        loadedMessages.push({
          id: snapshot?.messageId ?? `document-request-${requestId}`,
          role: "user",
          content,
          createdAt: request?.createdAt ?? snapshot?.createdAt ?? new Date().toISOString(),
          requestId,
          requestStatus: request?.status === "failed" ? "failed" : request?.status === "cancelled" ? "cancelled" : "recovering",
          requestError: request?.status === "failed" ? requestFailureMessage(request.error, request.failureMessage, content) : undefined,
          retryable: Boolean(snapshot) && request?.retryable !== false,
        });
      }
      setMessages(loadedMessages);
      for (const requestId of requestIds) {
        const status = pendingById.get(requestId)?.status;
        if (status !== "failed" && status !== "cancelled") {
          window.setTimeout(() => recoverRequestRef.current?.(requestId), 0);
        }
      }
      if (payload.memoriesAvailable !== false && Array.isArray(payload.memories)) replaceProjectMemories(payload.memories);
      else void refreshProjectMemories(controller.signal);
    }).catch(() => {
      if (!controller.signal.aborted) void refreshProjectMemories(controller.signal);
    }).finally(() => {
      if (!controller.signal.aborted) setHistoryLoaded(true);
    });
    return () => controller.abort();
  }, [resolvedCourseId, stageKey, studentId, supportedStage, workspaceKind, replaceProjectMemories, refreshProjectMemories]);

  const keepLocalDraft = useCallback((content: string): PendingDocumentDraft | null => {
    if (!loadedScopeRef.current) return null;
    const pending: PendingDocumentDraft = {
      key: draftKeyRef.current || (draftKeyRef.current = documentDraftKey(loadedScopeRef.current)),
      scope: loadedScopeRef.current,
      submissionId: submissionIdRef.current,
      expectedVersion: submissionVersionRef.current,
      content,
      updatedAt: Date.now(),
      requiresConfirmation: saveConfirmationRef.current.pending > 0 || saveConfirmationRef.current.uncertain,
    };
    try {
      writeDocumentDraft(pending);
      pendingDraftRef.current = pending;
      setLocalDraftError(null);
      return pending;
    } catch {
      setLocalDraftError("浏览器未能保存本机草稿，请保持此页打开并尽快保存到服务器。");
      return null;
    }
  }, []);

  const persistDocument = useCallback((
    content: string,
    source: "auto" | "manual" | "ai" | "undo",
  ): Promise<boolean> => {
    const scope = loadedScopeRef.current;
    if (saveConflict) return Promise.resolve(false);
    const confirmation = saveConfirmationRef.current;
    if (content === savedContentRef.current && confirmation.pending === 0 && !confirmation.uncertain
      && !pendingDraftRef.current?.requiresConfirmation && session.saveState !== "error") return Promise.resolve(true);
    confirmation.pending += 1;
    const perform = async (): Promise<boolean> => {
      if (loadedScopeRef.current !== scope || !course || !studentId || !supportedStage || finalizeInFlightRef.current) return false;
      // Recheck only after preceding operations have settled: two clicks can
      // queue the same text before the first operation confirms it. A restored
      // or failed attempt keeps uncertainty set and must still reconcile.
      if (content === savedContentRef.current && !confirmation.uncertain) {
        const settled = pendingDraftRef.current;
        if (currentDocumentRef.current === content && settled?.content === content
          && settled.submissionId === submissionIdRef.current
          && settled.expectedVersion === submissionVersionRef.current) {
          try { acknowledgeExactDocumentDraft(settled); } catch { /* Retaining a confirmed copy is safe. */ }
          pendingDraftRef.current = null;
        }
        setSaveStatus(currentDocumentRef.current === content && confirmation.pending === 1 ? "saved" : "unsaved");
        return true;
      }
      // A queued request owns its immutable payload, while the editing draft
      // must keep any text entered after that request was queued.
      const currentContent = currentDocumentRef.current;
      const pending = pendingDraftRef.current?.content === currentContent && pendingDraftRef.current.requiresConfirmation
        ? pendingDraftRef.current : keepLocalDraft(currentContent);
      if (!pending) { setSaveStatus("error"); return false; }
      const recovered = recoveredDraftRef.current;
      const expectedVersion = submissionVersionRef.current;
      const submissionId = submissionIdRef.current;
      confirmation.uncertain = true;
      setSaveStatus("saving");
      try {
        const aiSource = aiRevisionSources.current.get(content);
        const aiRevisionSource = aiSource ? await createAiRevisionSource(aiSource.before, content, aiSource) : undefined;
        const submission = await session.persistSubmission({
          id: submissionId, courseId: course.id, studentId,
          studentName: session.studentName ?? session.user.name,
          groupId: group?.id, stageKey,
          type: isExternalArtifact ? "artifact-brief" : "document",
          title: documentTitle, content, expectedVersion, aiRevisionSource,
          draftKey: draftKeyRef.current, recoveredDraftKey: recoveredDraftKeyRef.current,
        });
        if (loadedScopeRef.current !== scope) return false;
        if (!submission || !submission.id || submission.content !== content
          || submission.courseId !== course.id || submission.studentId !== studentId || submission.stageKey !== stageKey
          || !Number.isSafeInteger(submission.version) || (submission.version ?? 0) < 1
          || (submission.version ?? 0) < expectedVersion) {
          setSaveStatus("error"); return false;
        }
        submissionIdRef.current = submission.id;
        submissionVersionRef.current = submission.version ?? 1;
        savedContentRef.current = content;
        aiRevisionSources.current.delete(content);
        // The provider can return either an own receipt or a full-business-field
        // equivalent server revision (including its canonical ID/same version).
        // Keep its receipt distinction intact; do not manufacture a version bump.
        // Persist newer text against that confirmed revision before cleanup.
        if (currentDocumentRef.current !== content) {
          if (!keepLocalDraft(currentDocumentRef.current)) { setSaveStatus("error"); return true; }
        }
        if (pending.submissionId === submissionId && pending.content === content) {
          try { acknowledgeExactDocumentDraft(pending); } catch { /* Retaining an acknowledged draft is safe. */ }
        }
        if (recovered && recovered.submissionId === submissionId && recovered.content === content) {
          try { acknowledgeExactDocumentDraft(recovered); } catch { /* Keep the exact original if storage is unavailable. */ }
          if (recoveredDraftRef.current === recovered) {
            recoveredDraftRef.current = null;
            recoveredDraftKeyRef.current = undefined;
          }
        }
        confirmation.uncertain = false;
        if (currentDocumentRef.current === content) pendingDraftRef.current = null;
        setSaveStatus(currentDocumentRef.current === content && confirmation.pending === 1 ? "saved" : "unsaved");
        void source;
        return true;
      } catch {
        if (loadedScopeRef.current === scope) setSaveStatus("error");
        return false;
      }
    };
    const saved = saveChainRef.current.then(perform, perform).finally(() => { confirmation.pending -= 1; });
    saveChainRef.current = saved;
    return saved;
  }, [course, documentTitle, group, isExternalArtifact, keepLocalDraft, saveConflict, session, stageKey, studentId, supportedStage]);

  useEffect(() => {
    const retry = () => {
      setSaveStatus((status) => status === "error" ? "unsaved" : status);
      setSaveRetry(value => value + 1);
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    return () => { window.removeEventListener("online", retry); window.removeEventListener("focus", retry); };
  }, []);

  useEffect(() => {
    if (!documentReady || !course || !studentId || !supportedStage || saveStatus !== "unsaved") return;
    if (documentHtml === savedContentRef.current && !saveConfirmationRef.current.uncertain
      && !pendingDraftRef.current?.requiresConfirmation) return;
    const timer = window.setTimeout(() => void persistDocument(documentHtml, "auto"), 900);
    return () => window.clearTimeout(timer);
  }, [course, documentHtml, documentReady, persistDocument, saveRetry, saveStatus, stageKey, studentId, supportedStage]);

  function handleDocumentChange(html: string) {
    const retained = keepLocalDraft(html);
    currentDocumentRef.current = html;
    setDocumentHtml(html);
    setSaveStatus(!retained ? "error" : html === savedContentRef.current && !retained.requiresConfirmation ? "saved" : "unsaved");
    if (undoableEdit && html !== undoableEdit.afterHtml) setUndoableEdit(null);
  }

  useEffect(() => {
    if (!studentId || !supportedStage) return;
    let active = true;
    const replay = () => {
      void flushAiInteractionEvents(requestScope).then(() => {
        if (active) setInteractionSyncError(null);
      }).catch(() => {
        if (active) setInteractionSyncError("协作过程记录尚未同步，请保持此页打开，恢复连接后将重试。");
      });
    };
    replay();
    const timer = window.setInterval(replay, 10_000);
    window.addEventListener("online", replay);
    window.addEventListener("focus", replay);
    window.addEventListener("pagehide", replay);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("online", replay);
      window.removeEventListener("focus", replay);
      window.removeEventListener("pagehide", replay);
    };
  }, [requestScope, studentId, supportedStage]);

  function recordAiInteraction(input: {
    conversationId?: string;
    source: "sidebar" | "selection" | "proactive-comment" | "system";
    eventType: "proposal" | "decision" | "undo" | "comment" | "error";
    content?: string;
    payload?: Record<string, unknown>;
  }) {
    if (!course || !studentId || !supportedStage) return;
    const { conversationId: targetConversationId, ...event } = input;
    try {
      queueAiInteractionEvent(requestScope, {
        courseId: course.id, studentId, stageKey, workspaceKind,
        conversationId: targetConversationId ?? conversationId,
        actorRole: "student", ...event,
      });
      void flushAiInteractionEvents(requestScope).then(() => setInteractionSyncError(null)).catch(() => {
        setInteractionSyncError("协作过程记录已暂存本机，恢复连接后将重试同步。");
      });
    } catch {
      setInteractionSyncError("浏览器未能暂存协作过程记录，请保持此页打开并联系教师。");
    }
  }

  async function sendRequest(
    requestedIntent = intent,
    preset?: string,
    selectionOverride?: PlateDocumentSelection | null,
    retrySnapshot?: DocumentRequestSnapshot,
    statusOnly = false,
  ) {
    const requestText = (retrySnapshot?.message ?? preset ?? draft).trim();
    if (!requestText || !course || !studentId || busy || activeRequestRef.current || !supportedStage) return null;
    if (!statusOnly && (pendingSuggestion || pendingDelivery) && WRITING_INTENTS.has(requestedIntent)) {
      setError("已有一项修改或交付待审阅。你可以继续讨论；请先处理它，再安排新的写入工作。");
      return null;
    }
    // A selection always narrows the operation to that local paragraph. The
    // server applies the same rule even if a stale client sends intent=delegate.
    const currentSelection = retrySnapshot ? retrySnapshot.selection : (selectionOverride === undefined ? selection : selectionOverride);
    const selectionSnapshot = currentSelection
      ? {
          ...currentSelection,
          anchor: { ...currentSelection.anchor, path: [...currentSelection.anchor.path] },
          focus: { ...currentSelection.focus, path: [...currentSelection.focus.path] },
        }
      : null;
    if (!statusOnly && MODIFICATION_INTENTS.has(requestedIntent) && !selectionSnapshot) {
      setIntent(requestedIntent);
      setError(`局部修改必须先选中文字。这样 AI 只能处理你指定的范围，不会接管整篇${workspaceNoun}。`);
      return null;
    }
    const requestId = retrySnapshot?.requestId ?? nowId("document-ai-request");
    const contributionId = retrySnapshot?.contributionId ?? nowId("document-ai-contribution");
    const optimistic: CollaborationMessage = {
      id: retrySnapshot?.messageId ?? nowId("student-message"),
      role: "user",
      content: requestText,
      createdAt: retrySnapshot?.createdAt ?? new Date().toISOString(),
      requestId,
      requestStatus: statusOnly || retrySnapshot ? "recovering" : "sending",
    };
    const snapshot: DocumentRequestSnapshot = retrySnapshot ?? {
      requestId,
      messageId: optimistic.id,
      contributionId,
      createdAt: optimistic.createdAt,
      conversationId,
      intent: requestedIntent,
      message: requestText,
      documentHtml,
      selection: selectionSnapshot,
      revisionOf: requestedIntent === "delegate" ? deliveryRevision : undefined,
    };
    requestSnapshotsRef.current.set(requestId, snapshot);
    writePendingRequestSnapshots(requestScope, [...requestSnapshotsRef.current.values()]);
    setMessages((current) => {
      const index = current.findIndex((message) => message.requestId === requestId || message.id === optimistic.id);
      if (index < 0) return [...current, optimistic];
      return current.map((message, itemIndex) => itemIndex === index ? { ...message, ...optimistic, id: message.id } : message);
    });
    if (!retrySnapshot) setDraft("");
    setIntent(requestedIntent);
    setBusy(true);
    setError(null);
    setSuggestionError(null);
    const controller = new AbortController();
    activeRequestRef.current = { id: requestId, controller };
    let retryable = true;
    try {
      const query = new URLSearchParams({ courseId: course.id, studentId, stageKey, workspaceKind, requestId, conversationId: snapshot.conversationId });
      const current = await sendOrRecoverDocumentRequest<DocumentRequestPayload>({
        statusUrl: `/api/ai-collaboration/document?${query}`,
        signal: controller.signal,
        retry: Boolean(retrySnapshot),
        submit: statusOnly ? undefined : {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student", "X-Request-Id": requestId },
          body: JSON.stringify({
            courseId: course.id, studentId, stageKey, workspaceKind,
            conversationId: snapshot.conversationId, requestId, intent: snapshot.intent,
            message: snapshot.message, documentHtml: snapshot.documentHtml,
            selectedText: snapshot.selection?.text, contributionId: snapshot.contributionId,
            revisionOf: snapshot.revisionOf,
          }),
        },
        onProcessing: ({ recovering, phase }) => setMessages((current) => current.map((message) => message.requestId === requestId
          ? { ...message, requestStatus: recovering ? "recovering" : "processing", requestPhase: phase }
          : message)),
      });
      if (activeRequestRef.current?.id !== requestId) return null;
      const { response, payload } = current;
      if (snapshot.conversationId !== currentConversationRef.current) return null;
      const currentVersion = payload.documentVersion
        ? await documentVersionDigest(currentDocumentRef.current).catch(() => null)
        : null;
      if (controller.signal.aborted || activeRequestRef.current?.id !== requestId
        || loadedScopeRef.current !== requestScope || snapshot.conversationId !== currentConversationRef.current) return null;
      const matchesCurrentWorkspace = snapshot.documentHtml === currentDocumentRef.current
        && snapshot.conversationId === currentConversationRef.current
        && (!payload.documentVersion || currentVersion === null || currentVersion === payload.documentVersion);
      const canReview = matchesCurrentWorkspace && !pendingReviewRef.current;
      if (payload.conversationId) {
        currentConversationRef.current = payload.conversationId;
        setConversationId(payload.conversationId);
      }
      if (!response.ok || payload.status === "failed" || payload.status === "cancelled" || !payload.result) {
        retryable = payload.retryable !== false && response.status !== 409 && payload.status !== "cancelled";
        throw new Error(requestFailureMessage(payload.error, payload.failureMessage ?? payload.message, snapshot.message));
      }
      requestSnapshotsRef.current.delete(requestId);
      writePendingRequestSnapshots(requestScope, [...requestSnapshotsRef.current.values()]);
      const assistantMessage: CollaborationMessage = {
        id: payload.messages?.find((message) => message.role === "agent")?.id
          ?? nowId("ai-message"),
        role: "assistant",
        content: canReview || (!payload.result.suggestion && !payload.result.deliverable)
          ? payload.result.message
          : readOnlyResultMessage(payload.result, matchesCurrentWorkspace
            ? "已有另一项修改待审阅，这次恢复的完整结果仅供阅读。请先处理待审阅内容，再基于当前文稿提出修改请求。"
            : "文稿或对话已更新，这次结果仅供参考。若要应用，请基于当前内容重新提出请求。"),
        createdAt: new Date().toISOString(),
        kind: payload.result.kind,
        support: payload.result.support,
      };
      const persistedStudentId = payload.messages?.find((message) => message.role === "student")?.id;
      setMessages((current) => [
        ...current
          .filter((message) => message.id !== optimistic.id && message.requestId !== requestId
            && message.id !== assistantMessage.id && message.id !== persistedStudentId),
        {
          ...optimistic,
          id: persistedStudentId ?? optimistic.id,
          requestStatus: undefined,
        },
        assistantMessage,
      ]);
      if (payload.memories) projectMemory.replaceMemories(payload.memories);
      const contribution: AiContribution = {
        id: contributionId,
        courseId: course.id,
        studentId,
        stageKey,
        companionId: payload.companionId ?? "recorder",
        impact: payload.result.suggestion || payload.result.deliverable ? "high" : "low",
        request: requestText,
        suggestion: payload.result.deliverable
          ? `${payload.result.message}\n${payload.result.deliverable.content}`
          : payload.result.suggestion
            ? `${payload.result.message}\n${payload.result.suggestion.replacement}`
            : payload.result.message,
        sourceEvidenceIds: (course.learningEvidence ?? [])
          .filter((item) => item.studentId === studentId && item.stageKey === stageKey)
          .slice(-8)
          .map((item) => item.id),
        proposedChange: payload.result.deliverable?.title ?? payload.result.suggestion?.title,
        status: payload.result.suggestion || payload.result.deliverable ? "pending-decision" : "decided",
        createdAt: new Date().toISOString(),
      };
      session.upsertAiContribution(contribution);
      session.addCompanionProcessRecord({
        courseId: course.id,
        studentId,
        stageKey,
        title: payload.result.kind === "boundary"
          ? "AI 组员守住了协作边界"
          : payload.result.kind === "work-delivery"
            ? "AI 组员提交了辅助工作"
            : `AI 组员参与${workspaceNoun}协作`,
        summary: payload.result.message.slice(0, 260),
        source: "agent",
        companionId: contribution.companionId,
      });
      const suggestion = payload.result.suggestion;
      if (canReview && suggestion && (selectionSnapshot || suggestion.operation === "insert")) {
        const preview = editorRef.current?.previewAiSuggestion(selectionSnapshot ? {
          operation: "replace",
          ...selectionSnapshot,
          replacement: suggestion.replacement,
        } : {
          operation: "insert",
          replacement: suggestion.replacement,
        });
        const confirmation = session.upsertCompanionConfirmation({
          courseId: course.id,
          studentId,
          stageKey,
          action: "edit-workspace",
          title: suggestion.title,
          summary: suggestion.reason,
          payload: {
            kind: selectionSnapshot ? "document-collaboration-edit" : "document-collaboration-insert",
            documentTitle,
            ...(selectionSnapshot ? {
              targetText: suggestion.targetText,
              selectionAnchor: selectionSnapshot.anchor,
              selectionFocus: selectionSnapshot.focus,
            } : {}),
            replacement: suggestion.replacement,
            contributionId: contribution.id,
          },
          status: "pending",
        });
        const previewText = selectionSnapshot?.text ?? suggestion.replacement;
        const candidate: PendingSuggestion = {
          id: nowId("suggestion"),
          confirmationId: confirmation.id,
          contribution,
          suggestion,
          selection: selectionSnapshot,
          presentation: preview?.presentation
            ?? (previewText.length >= 220 || previewText.includes("\n\n") ? "blocks" : "inline"),
          previewReady: preview?.ok === true,
          conversationId: currentConversationRef.current,
        };
        setPendingSuggestion(candidate);
        setSuggestionError(preview?.ok ? null : `尚未修改${workspaceNoun}。${preview?.reason ?? "未能在正文中生成修改标记，请重新选择目标内容后再试。"}`);
      } else if (canReview && payload.result.deliverable) {
        const deliverable = payload.result.deliverable;
        const confirmation = session.upsertCompanionConfirmation({
          courseId: course.id,
          studentId,
          stageKey,
          action: "edit-workspace",
          title: deliverable.title,
          summary: deliverable.summary,
          payload: {
            kind: "delegated-work-delivery",
            documentTitle,
            content: deliverable.content,
            documentActions: deliverable.documentActions,
            sources: deliverable.sources,
            contributionId: contribution.id,
          },
          status: "pending",
        });
        const changesDocument = deliverable.documentActions.some((action) => action.operation !== "none");
        const preview = changesDocument
          ? editorRef.current?.previewDelegatedWorkPlan(deliverable.documentActions)
          : null;
        const candidate: PendingDelivery = {
          id: nowId("delivery"),
          confirmationId: confirmation.id,
          contribution,
          deliverable,
          documentHtml: snapshot.documentHtml,
          conversationId: currentConversationRef.current,
          previewReady: preview?.ok === true,
          error: changesDocument && !preview?.ok
            ? `尚未修改${workspaceNoun}。${preview?.reason ?? "未能生成修改预览，请退回交付后重试。"}`
            : null,
        };
        setPendingDelivery(candidate);
        setDeliveryRevision(null);
      }
      return assistantMessage;
    } catch (requestError) {
      if (controller.signal.aborted) return null;
      recordAiInteraction({
        source: selectionSnapshot ? "selection" : "sidebar",
        eventType: "error",
        content: requestError instanceof Error ? requestError.message : "AI 组员请求失败",
        payload: { intent: requestedIntent, requestId },
      });
      setMessages((current) => current.map((message) => message.requestId === requestId
        ? {
            ...message,
            requestStatus: requestError instanceof DocumentRequestUnconfirmedError ? "unconfirmed" : "failed",
            requestError: requestError instanceof Error ? requestError.message : "这次回答没能完成，你的消息已保留。可以重新尝试。",
            retryable: !(requestError instanceof DocumentRequestUnconfirmedError) && retryable,
          }
        : message));
      return null;
    } finally {
      if (activeRequestRef.current?.id === requestId) {
        activeRequestRef.current = null;
        setBusy(false);
      }
    }
  }

  recoverRequestRef.current = (requestId) => {
    if (recoveredRequestIdsRef.current.has(requestId)) return;
    if (activeRequestRef.current || busy) {
      const capturedScope = loadedScopeRef.current;
      window.setTimeout(() => {
        if (capturedScope === loadedScopeRef.current) recoverRequestRef.current?.(requestId);
      }, 1_000);
      return;
    }
    recoveredRequestIdsRef.current.add(requestId);
    const snapshot = requestSnapshotsRef.current.get(requestId);
    if (snapshot) {
      void sendRequest(snapshot.intent, snapshot.message, snapshot.selection, snapshot, true);
      return;
    }
    // A request started in another tab has no local editor snapshot. Recover
    // its answer for reading, but never construct an editable preview from it.
    void (async () => {
      if (!course || !studentId) return;
      const query = new URLSearchParams({ courseId: course.id, studentId, stageKey, workspaceKind, requestId });
      const controller = new AbortController();
      const capturedConversation = currentConversationRef.current;
      query.set("conversationId", capturedConversation);
      readOnlyRecoveryControllersRef.current.set(requestId, controller);
      try {
        const { response, payload } = await sendOrRecoverDocumentRequest<DocumentRequestPayload>({
          statusUrl: `/api/ai-collaboration/document?${query}`, signal: controller.signal,
        });
        if (controller.signal.aborted || capturedConversation !== currentConversationRef.current) return;
        if (response.ok && payload.status === "completed" && payload.result) {
          const studentMessageId = payload.messages?.find((message) => message.role === "student")?.id;
          const assistantMessageId = payload.messages?.find((message) => message.role === "agent")?.id ?? nowId("ai-message");
          setMessages((current) => [
            ...current.filter((message) => message.requestId !== requestId && message.id !== assistantMessageId && message.id !== studentMessageId),
            ...current.filter((message) => message.requestId === requestId).map((message) => ({ ...message, id: studentMessageId ?? message.id, requestStatus: undefined })),
            {
              id: assistantMessageId, role: "assistant" as const,
              content: payload.result!.suggestion || payload.result!.deliverable
                ? readOnlyResultMessage(payload.result!, "这次结果已恢复。如需应用修改，请基于当前文稿重新提出请求。")
                : payload.result!.message,
              createdAt: new Date().toISOString(), kind: payload.result!.kind, support: payload.result!.support,
            },
          ]);
        } else {
          setMessages((current) => current.map((message) => message.requestId === requestId
            ? { ...message, requestStatus: payload.status === "cancelled" ? "cancelled" : "failed", requestError: requestFailureMessage(payload.error, payload.failureMessage ?? payload.message, message.content), retryable: false }
            : message));
        }
      } catch (error) {
        if (controller.signal.aborted || capturedConversation !== currentConversationRef.current) return;
        setMessages((current) => current.map((message) => message.requestId === requestId
          ? { ...message, requestStatus: "unconfirmed", requestError: error instanceof Error ? error.message : new DocumentRequestUnconfirmedError().message, retryable: false }
          : message));
      } finally {
        if (readOnlyRecoveryControllersRef.current.get(requestId) === controller) readOnlyRecoveryControllersRef.current.delete(requestId);
      }
    })();
  };

  function retryMessage(requestId: string) {
    const snapshot = requestSnapshotsRef.current.get(requestId);
    if (!snapshot) {
      recoveredRequestIdsRef.current.delete(requestId);
      recoverRequestRef.current?.(requestId);
      return;
    }
    recoveredRequestIdsRef.current.delete(requestId);
    const unconfirmed = messages.some((message) => message.requestId === requestId && message.requestStatus === "unconfirmed");
    void sendRequest(snapshot.intent, snapshot.message, snapshot.selection, snapshot, unconfirmed);
  }

  function editMessage(messageId: string) {
    const message = messages.find((item) => item.id === messageId);
    if (!message) return;
    setDraft(message.content);
    setError(null);
  }

  async function cancelMessage(requestId: string) {
    if (!course || !studentId) return;
    const controller = new AbortController();
    cancellationControllersRef.current.get(requestId)?.abort();
    cancellationControllersRef.current.set(requestId, controller);
    const capturedScope = requestScope;
    const stillCurrent = () => !controller.signal.aborted && loadedScopeRef.current === capturedScope;
    readOnlyRecoveryControllersRef.current.get(requestId)?.abort();
    if (activeRequestRef.current?.id === requestId) {
      activeRequestRef.current.controller.abort();
      activeRequestRef.current = null;
      setBusy(false);
    }
    setMessages((current) => current.map((message) => message.requestId === requestId
      ? { ...message, requestStatus: "recovering", requestError: undefined }
      : message));
    try {
      const response = await boundedFetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        signal: controller.signal,
        body: JSON.stringify({ action: "cancel-request", courseId: course.id, studentId, stageKey, workspaceKind, requestId }),
      }, DOCUMENT_RECEIPT_TIMEOUT_MS);
      const payload = await response.json().catch(() => ({})) as DocumentRequestPayload;
      if (!stillCurrent()) return;
      if (response.ok && payload.status === "completed") {
        // Completion can win the race with cancellation. Recover the saved
        // answer rather than showing a failure for a successful request.
        recoveredRequestIdsRef.current.delete(requestId);
        window.setTimeout(() => { if (stillCurrent()) recoverRequestRef.current?.(requestId); }, 0);
        return;
      }
      if (!response.ok || payload.status !== "cancelled") throw new Error(payload.message ?? "取消状态未能确认。");
      requestSnapshotsRef.current.delete(requestId);
      writePendingRequestSnapshots(requestScope, [...requestSnapshotsRef.current.values()]);
      setMessages((current) => current.map((message) => message.requestId === requestId
        ? { ...message, requestStatus: "cancelled", retryable: false }
        : message));
    } catch {
      if (!stillCurrent()) return;
      setMessages((current) => current.map((message) => message.requestId === requestId
        ? { ...message, requestStatus: "unconfirmed", requestError: "取消状态未能确认。你的消息已保留，可以查询结果或再次取消。", retryable: false }
        : message));
    } finally {
      if (cancellationControllersRef.current.get(requestId) === controller) cancellationControllersRef.current.delete(requestId);
    }
  }

  function submitMemberRequest() {
    const nextIntent = inferDocumentMemberIntent(draft, selection?.text);
    void sendRequest(nextIntent, undefined, selection);
  }

  async function startNewConversation() {
    if (!course || busy || pendingSuggestion || pendingDelivery) return;
    setBusy(true);
    setError(null);
    try {
      const response = await boundedFetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        body: JSON.stringify({
          action: "reset-conversation",
          courseId: course.id,
          studentId,
          stageKey,
          workspaceKind,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        conversationId?: string;
        message?: string;
      };
      if (!response.ok || !payload.conversationId) {
        throw new Error(payload.message ?? "暂时无法开始新对话，请稍后重试。");
      }
      currentConversationRef.current = payload.conversationId;
      setConversationId(payload.conversationId);
      requestSnapshotsRef.current.clear();
      writePendingRequestSnapshots(requestScope, []);
      recoveredRequestIdsRef.current.clear();
      setMessages([]);
      setDraft("");
      setDeliveryRevision(null);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "暂时无法开始新对话，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteConversationMessage(messageId: string) {
    if (!course || busy) return;
    const query = new URLSearchParams({
      courseId: course.id,
      studentId,
      stageKey,
      workspaceKind,
      conversationId,
      messageId,
    });
    setMessages((current) => current.filter((message) => message.id !== messageId));
    const response = await boundedFetch(`/api/ai-collaboration/document?${query.toString()}`, {
      method: "DELETE",
      headers: { "X-OpenPBL-Role": "student" },
    });
    if (!response.ok) {
      setError("这条记录暂时无法从当前对话中移除，请刷新后重试。");
    } else {
      projectMemory.replaceMemories((current) => current.filter((memory) =>
        !memory.sourceMessageIds.includes(messageId)));
    }
  }

  async function uploadDocumentImage(file: File): Promise<string> {
    if (!course) throw new Error("课程尚未加载，暂时不能上传图片。");
    const form = new FormData();
    form.set("file", file);
    form.set("title", file.name || `${workspaceNoun}图片`);
    form.set("courseId", course.id);
    const response = await uploadMultipartWithReceipt(`document-image:${studentId}:${course.id}:${stageKey}`, file, form);
    const payload = await response.json().catch(() => ({})) as { url?: string; message?: string };
    if (!response.ok || !payload.url) throw new Error(payload.message ?? "图片上传失败，请稍后再试。");
    return payload.url;
  }

  function resolveSuggestion(
    decision: "adopted" | "rejected",
    candidate = pendingSuggestion,
  ): boolean {
    if (!candidate || !course) return false;
    workspace.revealDocument();
    const decisionId = `document-ai-decision-${candidate.contribution.id}`;
    if (decision === "rejected") {
      if (candidate.previewReady) {
        const previewResult = editorRef.current?.resolveAiSuggestion("rejected");
        if (!previewResult?.ok) {
          setSuggestionError(previewResult?.reason ?? "未能撤销正文中的修改标记，请稍后重试。");
          return false;
        }
      }
      session.resolveCompanionConfirmation(course.id, candidate.confirmationId, "rejected");
      session.upsertAiContribution({ ...candidate.contribution, status: "decided" });
      session.recordStudentAiDecision({
        id: decisionId,
        courseId: course.id,
        studentId,
        stageKey,
        contributionId: candidate.contribution.id,
        decision: "rejected",
        reason: "学生查看正文中的红删绿增标记后选择保留自己的原文。",
        resultingEvidenceIds: [],
        decidedAt: new Date().toISOString(),
      });
      session.addCompanionProcessRecord({
        courseId: course.id,
        studentId,
        stageKey,
        title: `拒绝 AI 修改“${candidate.suggestion.title}”`,
        summary: `${workspaceNoun}没有发生变化，学生保留了原文。`,
        source: "student",
        companionId: candidate.contribution.companionId,
      });
      recordAiInteraction({
        conversationId: candidate.conversationId,
        source: candidate.selection ? "selection" : "sidebar",
        eventType: "decision",
        content: "学生拒绝 AI 修改建议，保留原文。",
        payload: { decision: "rejected", contributionId: candidate.contribution.id },
      });
      setPendingSuggestion(null);
      setSuggestionError(null);
      return true;
    }

    if (!candidate.previewReady) {
      setSuggestionError("正文中没有可确认的修改标记，请保留原文后重新发起任务。");
      return false;
    }
    const result = editorRef.current?.resolveAiSuggestion("accepted");
    if (!result?.ok || typeof result.beforeHtml !== "string" || typeof result.afterHtml !== "string") {
      setPendingSuggestion({ ...candidate, previewReady: false });
      setSuggestionError(`尚未修改${workspaceNoun}。${result?.reason ?? "修改未能确认，请重新选择目标内容并生成建议。"}`);
      return false;
    }
    session.resolveCompanionConfirmation(course.id, candidate.confirmationId, "confirmed");
    session.upsertAiContribution({ ...candidate.contribution, status: "decided" });
    session.recordStudentAiDecision({
      id: decisionId,
      courseId: course.id,
      studentId,
      stageKey,
      contributionId: candidate.contribution.id,
      decision: "adopted",
      reason: candidate.presentation === "blocks"
        ? "学生查看正文中的段落级修改标记后主动确认应用。"
        : "学生查看正文中的字词级修改标记后主动确认应用。",
      appliedChangeSummary: candidate.suggestion.title,
      resultingEvidenceIds: [],
      decidedAt: new Date().toISOString(),
    });
    session.addCompanionProcessRecord({
      courseId: course.id,
      studentId,
      stageKey,
      title: `确认 AI 修改“${candidate.suggestion.title}”`,
      summary: candidate.suggestion.reason,
      source: "student",
      companionId: candidate.contribution.companionId,
    });
    recordAiInteraction({
      conversationId: candidate.conversationId,
      source: candidate.selection ? "selection" : "sidebar",
      eventType: "decision",
      content: `学生确认应用 AI 修改：${candidate.suggestion.title}`,
      payload: { decision: "adopted", contributionId: candidate.contribution.id, confirmationId: candidate.confirmationId, authorization: "reviewed" },
    });
    aiRevisionSources.current.set(result.afterHtml, { before: result.beforeHtml, contributionId: candidate.contribution.id, action: "adopted" });
    handleDocumentChange(result.afterHtml);
    setUndoableEdit({
      title: candidate.suggestion.title,
      beforeHtml: result.beforeHtml,
      afterHtml: result.afterHtml,
      confirmationId: candidate.confirmationId,
      contribution: candidate.contribution,
      decisionId,
      conversationId: candidate.conversationId,
      source: candidate.selection ? "selection" : "sidebar",
    });
    setEditNotice({ kind: "applied", title: candidate.suggestion.title });
    setPendingSuggestion(null);
    setSuggestionError(null);
    setSelection(null);
    void persistDocument(result.afterHtml, "ai");
    return true;
  }

  function resolveDelivery(
    decision: "adopted" | "rejected" | "revision",
    candidate = pendingDelivery,
  ): boolean {
    if (!candidate || !course) return false;
    const decisionId = `document-ai-decision-${candidate.contribution.id}`;
    const { deliverable, contribution } = candidate;

    if (decision !== "adopted") {
      if (candidate.previewReady) {
        const result = editorRef.current?.resolveAiSuggestion("rejected");
        if (!result?.ok) {
          setPendingDelivery({ ...candidate, error: result?.reason ?? "未能撤销正文中的修改标记，请稍后重试。" });
          return false;
        }
      }
      session.resolveCompanionConfirmation(course.id, candidate.confirmationId, "rejected");
      session.upsertAiContribution({ ...contribution, status: "decided" });
      session.recordStudentAiDecision({
        id: decisionId,
        courseId: course.id,
        studentId,
        stageKey,
        contributionId: contribution.id,
        decision: "rejected",
        reason: decision === "revision"
          ? `学生作为组长审阅交付后退回修改，原交付未写入${workspaceNoun}。`
          : `学生作为组长审阅交付后决定暂不采用，${workspaceNoun}未发生变化。`,
        resultingEvidenceIds: [],
        decidedAt: new Date().toISOString(),
      });
      session.addCompanionProcessRecord({
        courseId: course.id,
        studentId,
        stageKey,
        title: decision === "revision"
          ? `退回组员交付“${deliverable.title}”`
          : `暂不采用组员交付“${deliverable.title}”`,
        summary: decision === "revision"
          ? "等待组长补充修改意见后重新交付。"
          : `${workspaceNoun}没有发生变化。`,
        source: "student",
        companionId: contribution.companionId,
      });
      recordAiInteraction({
        conversationId: candidate.conversationId,
        source: "sidebar",
        eventType: "decision",
        content: decision === "revision" ? "学生退回 AI 组员交付要求修改。" : "学生暂不采用 AI 组员交付。",
        payload: { decision: "rejected", reason: decision, contributionId: contribution.id },
      });
      if (decision === "revision") {
        setDeliveryRevision({ title: deliverable.title, content: deliverable.content });
        setIntent("delegate");
        setDraft(`请修改这份交付：${deliverable.title}\n\n需要调整的地方：`);
      }
      setPendingDelivery(null);
      return true;
    }

    const documentActions = deliverable.documentActions
      .filter((action) => action.operation !== "none");
    if (documentActions.length && currentDocumentRef.current !== candidate.documentHtml) {
      setPendingDelivery({ ...candidate, error: "尚未修改文稿。文稿已更新，不能应用基于旧版本的交付。请退回修改，基于当前文稿重新安排。" });
      return false;
    }
    if (documentActions.length && !candidate.previewReady) {
      setPendingDelivery({ ...candidate, error: candidate.error ?? "正文中没有可确认的修改标记，请退回交付后重新规划。" });
      return false;
    }
    const result = documentActions.length
      ? editorRef.current?.resolveAiSuggestion("accepted")
      : null;
    if (documentActions.length && (!result?.ok || typeof result.beforeHtml !== "string" || typeof result.afterHtml !== "string")) {
      setPendingDelivery({
        ...candidate,
        previewReady: false,
        error: `尚未修改${workspaceNoun}。${result?.reason ?? `AI 规划的${workspaceNoun}位置已经失效，请退回交付后重新规划。`}`,
      });
      return false;
    }
    session.resolveCompanionConfirmation(course.id, candidate.confirmationId, "confirmed");
    session.upsertAiContribution({ ...contribution, status: "decided" });
    session.recordStudentAiDecision({
      id: decisionId,
      courseId: course.id,
      studentId,
      stageKey,
      contributionId: contribution.id,
      decision: "adopted",
      reason: documentActions.length
        ? `学生作为组长审阅独立交付和${workspaceNoun}操作计划后，主动确认应用。`
        : `学生作为组长审阅了本次不涉及${workspaceNoun}修改的独立交付。`,
      appliedChangeSummary: deliverable.title,
      resultingEvidenceIds: [],
      decidedAt: new Date().toISOString(),
    });
    session.addCompanionProcessRecord({
      courseId: course.id,
      studentId,
      stageKey,
      title: `采纳组员交付“${deliverable.title}”`,
      summary: documentActions.length
        ? `学生确认执行：${documentActions.map((action) => action.description).join("；")}`
        : `本次交付只作为参考资料完成审阅，${workspaceNoun}没有变化。`,
      source: "student",
      companionId: contribution.companionId,
    });
    recordAiInteraction({
      conversationId: candidate.conversationId,
      source: "sidebar",
      eventType: "decision",
      content: `学生确认审阅 AI 组员交付：${deliverable.title}`,
      payload: { decision: "adopted", contributionId: contribution.id, confirmationId: candidate.confirmationId, appliedToDocument: documentActions.length > 0, authorization: "reviewed" },
    });
    if (result?.ok && typeof result.beforeHtml === "string" && typeof result.afterHtml === "string") {
      aiRevisionSources.current.set(result.afterHtml, { before: result.beforeHtml, contributionId: contribution.id, action: "adopted" });
      handleDocumentChange(result.afterHtml);
      setUndoableEdit({
        title: deliverable.title,
        beforeHtml: result.beforeHtml,
        afterHtml: result.afterHtml,
        confirmationId: candidate.confirmationId,
        contribution,
        decisionId,
        conversationId: candidate.conversationId,
        source: "sidebar",
      });
      setEditNotice({ kind: "applied", title: deliverable.title });
    }
    setPendingDelivery(null);
    setSelection(null);
    if (result?.ok && typeof result.afterHtml === "string") void persistDocument(result.afterHtml, "ai");
    return true;
  }

  function undoAiEdit() {
    if (!undoableEdit || !course) return;
    if (documentHtml !== undoableEdit.afterHtml) {
      setUndoableEdit(null);
      setError(`${workspaceNoun}在 AI 修改后又发生了变化。为避免覆盖新内容，本次不能整体撤销。`);
      return;
    }
    // Controlled editor replacements do not emit onChange. Keep the document
    // ref, recoverable draft and save state aligned before saving the undo.
    aiRevisionSources.current.set(undoableEdit.beforeHtml, { before: undoableEdit.afterHtml, contributionId: undoableEdit.contribution.id, action: "undo" });
    handleDocumentChange(undoableEdit.beforeHtml);
    setSelection(null);
    // The approval and adopted decision describe what actually happened. Undo
    // records a later student decision instead of rewriting those final facts.
    const undoDecisionId = nowId("document-ai-undo-decision");
    session.recordStudentAiDecision({
      id: undoDecisionId,
      courseId: course.id,
      studentId,
      stageKey,
      contributionId: undoableEdit.contribution.id,
      decision: "rejected",
      reason: "学生在应用后使用撤销，决定恢复修改前原文。",
      resultingEvidenceIds: [],
      decidedAt: new Date().toISOString(),
    });
    session.addCompanionProcessRecord({
      courseId: course.id,
      studentId,
      stageKey,
      title: `撤销 AI 内容“${undoableEdit.title}”`,
      summary: "已恢复修改前的文档内容。",
      source: "student",
      companionId: undoableEdit.contribution.companionId,
    });
    recordAiInteraction({
      conversationId: undoableEdit.conversationId,
      source: undoableEdit.source,
      eventType: "undo",
      content: `学生撤销 AI 修改：${undoableEdit.title}`,
      payload: { contributionId: undoableEdit.contribution.id, decisionId: undoDecisionId,
        adoptedDecisionId: undoableEdit.decisionId },
    });
    void persistDocument(undoableEdit.beforeHtml, "undo");
    setEditNotice({ kind: "undone", title: undoableEdit.title });
    setUndoableEdit(null);
  }

  async function submitFinalDocument() {
    if (!course || !studentId || !supportedStage || !canSubmitFinal || submitting || finalizeInFlightRef.current) return;
    if (pendingSuggestion || pendingDelivery) {
      setError("请先接受或拒绝当前待确认的 AI 修改或组员交付，再提交最终版。");
      return;
    }
    if (plainTextLength(documentHtml) < 2) {
      setError("文档还没有可提交的内容，请先完成自己的方案编写。");
      return;
    }
    if ((documentHtml !== savedContentRef.current || saveConfirmationRef.current.uncertain
      || pendingDraftRef.current?.requiresConfirmation) && !await persistDocument(documentHtml, "manual")) {
      setError("文档尚未保存成功，请先处理保存错误后再提交。");
      return;
    }
    const finalizeScope = loadedScopeRef.current;
    finalizeInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const flushed = await session.flushSaves();
      if (!flushed || !submissionIdRef.current) {
        throw new Error("文档尚未保存成功，请稍后重试。");
      }
      const requestId = `finalize:${submissionIdRef.current}:${submissionVersionRef.current}`;
      const response = await boundedFetch("/api/project-practice/submissions/finalize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenPBL-Role": "student",
          "X-Request-Id": requestId,
        },
        body: JSON.stringify({
          courseId: course.id,
          submissionId: submissionIdRef.current,
          studentId,
          stageKey,
          expectedVersion: submissionVersionRef.current,
          ...(revisionNote.trim() ? { revisionNote: revisionNote.trim() } : {}),
          requestId,
        }),
      }, 60_000);
      const payload = await response.json().catch(() => ({})) as {
        sequence?: number; submissionVersion?: number;
        submittedAt?: string;
        downloadUrl?: string;
        message?: string;
      };
      if (!response.ok || !payload.sequence || !payload.downloadUrl) {
        throw new Error(payload.message ?? "最终 Word 文档生成失败，请稍后重试。");
      }
      if (loadedScopeRef.current !== finalizeScope) return;
      if (payload.submissionVersion) submissionVersionRef.current = payload.submissionVersion;
      if (currentDocumentRef.current !== savedContentRef.current) keepLocalDraft(currentDocumentRef.current);
      setSubmittedVersion({
        sequence: payload.sequence,
        submittedAt: payload.submittedAt,
        downloadUrl: payload.downloadUrl,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "最终 Word 文档生成失败，请稍后重试。");
    } finally {
      finalizeInFlightRef.current = false;
      setSubmitting(false);
      setSaveRetry((value) => value + 1);
    }
  }

  if (!hydrated || !course) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-stone-500">
        <LoaderCircle className="mr-2 animate-spin" size={20} />正在准备 AI 协作空间…
      </div>
    );
  }

  if (!studentId) {
    return <UnavailableState message="学生身份尚未初始化，请重新进入课堂。" onBack={() => router.replace("/student")} />;
  }

  if (!supportedStage) {
    return (
      <UnavailableState
        message={course.status === "finished"
          ? "课堂已经结束，协作成果现已只读保存。"
          : `${workspaceNoun}协作目前仅在项目实践阶段开放。`}
        onBack={() => router.replace(collaborationBackHref(course.id))}
      />
    );
  }

  return (
    <main className="flex min-h-dvh flex-col bg-[var(--pbl-bg)] pt-16 text-[var(--pbl-text)]">
      {contentMonitor.event && <DocumentContentReminder key={contentMonitor.event.id} event={contentMonitor.event} onDismiss={contentMonitor.dismiss} onExplain={contentMonitor.explain} />}
      <DashboardTopBar
        currentCourse={{ id: course.id, name: course.name, status: course.status }}
        currentStage={{ index: course.currentStageIndex, total: course.stages.length, label: stage?.label ?? "项目实践" }}
        currentTask={stage?.description}
        headerSlot={stage ? <StudentClassroomHeaderStatus course={course} /> : undefined}
        headerEndSlot={pasteMonitoringEnabled ? <DocumentContentMonitorStatus notice={contentMonitor.notice} /> : undefined}
        saveStatus={{
          state: session.saveState === "error" ? "error"
            : saveStatus === "saved" && session.saveState === "saving" ? "saving" : saveStatus,
          onRetry: () => {
            if (saveStatus === "error" || saveStatus === "unsaved") void persistDocument(documentHtml, "manual");
            else void session.retrySave();
          },
        }}
        hideCourseSwitcher
        leadRole="学生"
        role="student"
        userName={session.studentName ?? session.user.name}
      />
      {saveConflict && <SubmissionSaveConflictPanel conflict={saveConflict} localContent={documentHtml} onResolve={async (choice) => {
        const scope = loadedScopeRef.current;
        const submittedContent = currentDocumentRef.current;
        const confirmation = saveConfirmationRef.current;
        confirmation.pending += 1;
        confirmation.uncertain = true;
        const resolve = async (): Promise<boolean> => {
          if (loadedScopeRef.current !== scope) return false;
          const pending = keepLocalDraft(submittedContent);
          if (!pending) return false;
          setSaveStatus("saving");
          const submission = await session.resolveSubmissionSaveConflict(saveConflict.requestId, choice, submittedContent);
          if (loadedScopeRef.current !== scope) return false;
          if (!submission) { setSaveStatus("error"); return false; }
          const latestContent = currentDocumentRef.current;
          const editedWhileResolving = latestContent !== submittedContent;
          submissionIdRef.current = submission.id;
          submissionVersionRef.current = submission.version ?? 1;
          savedContentRef.current = submission.content;
          if (choice === "local") {
            try { acknowledgeExactDocumentDraft(pending); } catch { /* Retaining a confirmed copy is safe. */ }
          } else draftKeyRef.current = documentDraftKey(scope);
          if (editedWhileResolving) {
            // The ACK only confirms the selected snapshot. Preserve subsequent typing and
            // let the normal save queue persist it against the newly confirmed revision.
            const retained = keepLocalDraft(latestContent);
            setSaveStatus(retained ? "unsaved" : "error");
          } else {
            currentDocumentRef.current = submission.content;
            setDocumentHtml(submission.content);
            pendingDraftRef.current = null;
            if (confirmation.pending === 1) confirmation.uncertain = false;
            setSaveStatus("saved");
            setLocalDraftError(choice === "remote" ? "已采用服务器版本；原本机内容仍可下载。" : null);
          }
          return true;
        };
        const resolution = saveChainRef.current.then(resolve, resolve).finally(() => { confirmation.pending -= 1; });
        saveChainRef.current = resolution;
        await resolution;
      }} />}
      <header ref={workspaceHeaderRef} className={cn(collaborationStyles.workspaceHeader, "sticky top-16 z-[60] min-h-16 border-b border-[var(--pbl-border)] bg-[color-mix(in_srgb,var(--pbl-surface)_96%,transparent)] backdrop-blur-sm")} style={{ maxHeight: "max(88px, calc(100dvh - 256px))" }}>
        <div className="flex min-h-16 w-full flex-wrap items-center justify-between gap-3 px-2 py-2 sm:px-3 lg:px-4">
          <CollaborationProjectDetails
            course={course}
            stageKey={stageKey}
            projectTitle={projectTitle}
            projectGoal={group?.goal}
            label={isExternalArtifact ? "本地成果协作" : "选题方向"}
          />
          <div className={cn(collaborationStyles.headerActions, "flex items-center gap-2 sm:gap-3")}>
            {session.saveState === "error" && session.saveError && <span role="alert" className="text-xs text-rose-700">{session.saveError}</span>}
            {localDraftError && <span role="alert" className="text-xs text-rose-700">{localDraftError}<button type="button" className="ml-2 underline" onClick={() => {
              const drafts = readDocumentDrafts(loadedScopeRef.current);
              const recovery = buildDocumentDraftExport({ scope: loadedScopeRef.current,
                submissionId: submissionIdRef.current, expectedVersion: submissionVersionRef.current,
                content: currentDocumentRef.current }, drafts);
              const url = URL.createObjectURL(new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" }));
              const anchor = document.createElement("a"); anchor.href = url; anchor.download = "本机文档草稿.json"; anchor.click(); URL.revokeObjectURL(url);
            }}>下载本机草稿</button></span>}
            {interactionSyncError && <span role="alert" className="text-xs text-rose-700">{interactionSyncError}</span>}
            {isExternalArtifact ? (
              <ExternalArtifactSubmission course={course} studentId={studentId} />
            ) : stageKey === "make" && inferStageCollectionMode(course.stages) === "new" ? (
              <FinalArtifactSubmission course={course} />
            ) : null}
            <PrimaryButton
              disabled={saveStatus === "saving" || submitting}
              onClick={() => void persistDocument(documentHtml, "manual")}
              size="sm"
              tone="slate"
              variant="outline"
            >
              <Save size={14} />保存
            </PrimaryButton>
            {canSubmitFinal && <DocumentRevisionNote value={revisionNote} onChange={setRevisionNote} />}
            {canSubmitFinal ? (
              <PrimaryButton
                disabled={submitting || saveStatus === "saving" || session.saveState === "saving" || Boolean(pendingSuggestion) || Boolean(pendingDelivery)}
                onClick={() => { void submitFinalDocument(); }}
                size="sm"
                tone="blue"
              >
                {submitting ? <LoaderCircle className="animate-spin" size={14} /> : <Send size={14} />}
                {submitting ? "生成 Word…" : submittedVersion ? `提交第 ${submittedVersion.sequence + (saveStatus === "unsaved" || saveStatus === "error" ? 1 : 0)} 版` : "提交最终版"}
              </PrimaryButton>
            ) : null}
          </div>
        </div>
      </header>

      <DocumentWorkspaceLayout controller={workspace} editor={
        <section className="min-w-0 overflow-visible bg-white">
          <div className="px-1 sm:px-2">
            {documentReady ? (
              <PlateDocumentEditor
                key={requestScope}
                appliedAiEdit={undoableEdit ? { title: undoableEdit.title, onUndo: undoAiEdit } : undefined}
                aiContext={{
                  courseId,
                  studentId,
                  stageKey,
                  projectGoal: projectTitle,
                  currentTask: stage?.label,
                }}
                minHeight={700}
                containedWorkspace
                stickyToolbarTop={0}
                aiMemberControls={workspace.aiMemberControls}
                workspaceLabel={isExternalArtifact ? "成果协作稿" : "文档"}
                onChange={handleDocumentChange}
                onDocumentPaste={pasteMonitoringEnabled ? contentMonitor.onPaste : undefined}
                onAiSuggestionDecision={(decision) => {
                  if (pendingDelivery) resolveDelivery(decision === "accepted" ? "adopted" : "rejected");
                  else resolveSuggestion(decision === "accepted" ? "adopted" : "rejected");
                }}
                onImageUpload={uploadDocumentImage}
                onOpenAiMember={() => { workspace.openMember(); setError(null); }}
                onSelectionChange={setSelection}
                ref={editorRef}
                value={documentHtml}
              />
            ) : null}
          </div>
          <footer className="border-t border-stone-100 px-5 py-3 text-xs text-stone-500">
            <span>{plainTextLength(documentHtml)} 字 · {isExternalArtifact ? "成果协作稿自动保存" : "当前草稿自动保存"}</span>
            {canSubmitFinal && submittedVersion ? <a className="ml-3 font-semibold text-emerald-700 hover:underline" download href={submittedVersion.downloadUrl}>下载第 {submittedVersion.sequence} 版 Word</a> : null}
          </footer>
        </section>
      } member={
          <AiMemberWorkspace
            busy={busy}
            draft={draft}
            error={error}
            historyLoaded={historyLoaded}
            messages={messages}
            memories={projectMemory.memories}
            memoryContinuation={projectMemory.continuation}
            onAcceptChange={() => resolveSuggestion("adopted")}
            onChangeDraft={setDraft}
            onClose={workspace.closeMember}
            onViewDocument={workspace.revealDocument}
            onDismissError={() => setError(null)}
            onDeleteMessage={(messageId) => { void deleteConversationMessage(messageId); }}
            onRetryMessage={retryMessage}
            onEditMessage={editMessage}
            onCancelMessage={(requestId) => { void cancelMessage(requestId); }}
            onNewConversation={() => { void startNewConversation(); }}
            onRejectChange={() => resolveSuggestion("rejected")}
            onAdoptDelivery={() => resolveDelivery("adopted")}
            onRejectDelivery={() => resolveDelivery("rejected")}
            onReviseDelivery={() => resolveDelivery("revision")}
            onSubmit={submitMemberRequest}
            onUpdateMemory={projectMemory.updateMemory}
            onDeleteMemory={projectMemory.deleteMemory}
            onClearMemories={projectMemory.clearMemories}
            workspaceLabel={isExternalArtifact ? "成果协作稿" : "文档"}
            pendingChange={pendingSuggestion ? {
              title: pendingSuggestion.suggestion.title,
              reason: pendingSuggestion.suggestion.reason,
              operation: pendingSuggestion.suggestion.operation,
              presentation: pendingSuggestion.presentation,
              error: suggestionError,
            } : null}
            pendingDelivery={pendingDelivery ? {
              ...pendingDelivery.deliverable,
              previewReady: pendingDelivery.previewReady,
              error: pendingDelivery.error,
            } : null}
            projectTitle={projectTitle}
            panelId={workspace.aiMemberControls.panelId}
            avatarRef={workspace.memberAvatarRef}
            headingRef={workspace.memberHeadingRef}
            avatarHidden={workspace.phase === "opening" || workspace.phase === "closing"}
          />
      } />
      <div>
        {!memberOpen && (pendingDelivery || (pendingSuggestion)) ? (
          <button
            className="fixed bottom-5 right-5 z-[79] inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 text-xs font-semibold text-stone-900 shadow-[0_16px_48px_-18px_rgba(28,25,23,0.5)] transition hover:-translate-y-0.5 hover:shadow-xl"
            onClick={() => {
              setIntent(pendingDelivery ? "delegate" : "edit");
              workspace.openMember();
            }}
            type="button"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-stone-950 text-white"><FilePenLine size={14} /></span>
            {pendingDelivery ? "查看待审阅的组员交付" : "查看待确认的 AI 修改"}
          </button>
        ) : null}
        {editNotice ? (
          <div
            aria-live="polite"
            className="fixed bottom-6 left-1/2 z-[90] flex w-[min(92vw,28rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 shadow-[0_20px_60px_-18px_rgba(28,25,23,0.45)]"
            role="status"
          >
            <span className={cn(
              "grid size-9 shrink-0 place-items-center rounded-full",
              editNotice.kind === "applied" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700",
            )}>
              {editNotice.kind === "applied" ? <Check size={18} /> : <RefreshCcw size={17} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-stone-900">{editNotice.kind === "applied" ? "AI 修改已应用" : "AI 修改已撤销"}</p>
              <p className="truncate text-xs text-stone-500">{editNotice.title}</p>
            </div>
            {editNotice.kind === "applied" && undoableEdit ? (
              <button
                className="shrink-0 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:border-blue-300 hover:text-blue-700"
                onClick={undoAiEdit}
                type="button"
              >
                撤销
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function UnavailableState({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] p-6">
      <section className="max-w-md rounded-[var(--radius-lg)] border border-stone-200 bg-white p-7 text-center shadow-[var(--shadow-raised)]">
        <ShieldCheck className="mx-auto text-[var(--pbl-ai)]" size={30} />
        <h1 className="mt-4 text-xl font-bold text-stone-950">AI 协作空间暂不可用</h1>
        <p className="mt-2 text-sm leading-6 text-stone-500">{message}</p>
        <PrimaryButton className="mt-5" onClick={onBack} tone="slate" variant="outline"><ArrowLeft size={15} />返回</PrimaryButton>
      </section>
    </div>
  );
}
