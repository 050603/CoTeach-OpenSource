import {
  buildStudentAiInteractionTurns,
  companionPracticeEvents,
  mergePracticeAiInteractionEvents,
  type StudentAiInteractionModification,
  type StudentAiInteractionTurn,
} from "@/lib/ai-collaboration/interaction-transcript";
import { parseCodeArtifact } from "@/lib/ai-collaboration/code-artifact";
import { documentHtmlToPlainText } from "@/lib/ai-collaboration/document-policy";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import type { AiInteractionEvent, ClassroomSubmission, Course } from "@/lib/session/types";

export type PracticeDecisionKind = "adopted" | "modified" | "rejected" | "revision" | "undone" | "pending";

export type PracticeDecisionRecord = {
  key: string;
  studentId: string;
  contributionId?: string;
  decision: PracticeDecisionKind;
  updatedAt: string;
  summary?: string;
  title?: string;
  targetText?: string;
  replacement?: string;
  documentActions?: unknown[];
};

export type ProjectPracticeTurn = Omit<StudentAiInteractionTurn, "messages"> & {
  messages: Array<Omit<StudentAiInteractionTurn["messages"][number], "modification"> & {
    modification?: Omit<StudentAiInteractionModification, "decision"> & { decision?: PracticeDecisionKind };
  }>;
};

export type ProjectPracticeProgressState = "not-started" | "in-progress" | "submitted";

export type ProjectPracticeRow = {
  student: Course["students"][number];
  artifact: ClassroomSubmission | undefined;
  documentVersions: NonNullable<Course["projectDocumentVersions"]>;
  externalVersions: NonNullable<Course["projectPdfVersions"]>;
  signals: NonNullable<Course["learningSignals"]>;
  submitted: boolean;
  hasDraft: boolean;
  progressState: ProjectPracticeProgressState;
  contentCharacters: number;
  contentCharactersKnown: boolean;
  submissionCount: number;
  boundaryTriggerCount: number;
  aiEvents: AiInteractionEvent[];
  dialogueRounds: number;
  participating: boolean;
  updatedAt: string;
  turns: ProjectPracticeTurn[];
  decisions: PracticeDecisionRecord[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function latestTimestamp(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left) || right.localeCompare(left))[0] ?? "";
}

function currentPracticeRecord(course: Course, item: { courseId: string; studentId: string; stageKey: string }): boolean {
  return item.courseId === course.id && item.stageKey === "make" && course.students.some((student) => student.id === item.studentId);
}

/** Audit facts are authoritative; saved companion messages recover missing dialogue. */
function practiceEvents(course: Course): AiInteractionEvent[] {
  const external = normalizePblCourseConfig(course.pblConfig).makeArtifactMode === "other";
  const visibleWorkspace = (item: AiInteractionEvent) => (!item.courseId || item.courseId === course.id) && item.stageKey === "make"
    && course.students.some((student) => student.id === item.studentId)
    && (record(item.payload).workspaceKind === "external-artifact") === external;
  const audited = (course.aiInteractionEvents ?? []).filter(visibleWorkspace);
  const fallback = companionPracticeEvents((course.companionThreads ?? []).filter((thread) =>
    thread.courseId === course.id && course.students.some((student) => student.id === thread.studentId)))
    .filter(visibleWorkspace);
  const seen = new Set<string>();
  return mergePracticeAiInteractionEvents(audited, fallback).filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

export function deriveAiCollaborationMetrics(events: readonly AiInteractionEvent[]) {
  const turns = buildStudentAiInteractionTurns(events);
  const proactiveSuggestions = turns.filter((turn) => turn.location === "paragraph-comment"
    && turn.messages.some((message) => message.role === "ai")).length;
  const dialogueRounds = new Set(events.flatMap((event) => event.eventType === "request" && event.actorRole === "student"
    ? [`${event.studentId}:${event.requestId || event.id}`] : [])).size;
  const boundaryTriggers = new Set(events.flatMap((event) => {
    const payload = record(event.payload);
    return (event.eventType === "response" && payload.kind === "boundary")
      || (event.eventType === "policy" && Boolean(string(payload.protectedCapability)))
      ? [`${event.studentId}:${event.requestId || `${event.conversationId ?? "conversation"}:${event.id}`}`] : [];
  })).size;
  return { proactiveSuggestions, dialogueRounds, boundaryTriggers, turns };
}

type DecisionFact = {
  studentId: string;
  aliases: string[];
  contributionId?: string;
  updatedAt: string;
  durable?: boolean;
  decision?: PracticeDecisionKind;
  summary?: string;
  title?: string;
  targetText?: string;
  replacement?: string;
  documentActions?: unknown[];
};

function persistedDecisionKind(decision: NonNullable<Course["studentAiDecisions"]>[number]): PracticeDecisionKind {
  if (decision.decision !== "rejected") return decision.decision;
  if (/撤销|恢复修改前/.test(decision.reason)) return "undone";
  if (/退回.*修改/.test(decision.reason)) return "revision";
  return "rejected";
}

function eventDecisionKind(event: AiInteractionEvent): PracticeDecisionKind | undefined {
  if (event.actorRole !== "student") return undefined;
  if (event.eventType === "undo") return "undone";
  if (event.eventType !== "decision") return undefined;
  const payload = record(event.payload);
  if (payload.reason === "revision" || payload.decision === "revision") return "revision";
  const decision = payload.decision;
  return decision === "adopted" || decision === "modified" || decision === "rejected"
    || decision === "pending" || decision === "undone" ? decision : undefined;
}

function decisionRecords(course: Course, events: AiInteractionEvent[]): PracticeDecisionRecord[] {
  const facts: DecisionFact[] = [];
  for (const contribution of (course.aiContributions ?? []).filter((item) => currentPracticeRecord(course, item))) {
    facts.push({
      studentId: contribution.studentId,
      contributionId: contribution.id,
      aliases: [contribution.id],
      updatedAt: contribution.createdAt,
      summary: contribution.suggestion,
      replacement: contribution.proposedChange,
    });
  }
  for (const decision of (course.studentAiDecisions ?? []).filter((item) => currentPracticeRecord(course, item))) {
    facts.push({
      studentId: decision.studentId,
      contributionId: decision.contributionId,
      aliases: [decision.id, decision.contributionId].filter(Boolean),
      updatedAt: decision.decidedAt,
      durable: true,
      decision: persistedDecisionKind(decision),
      summary: decision.reason,
      title: decision.appliedChangeSummary,
    });
  }
  for (const event of events) {
    const payload = record(event.payload);
    const suggestion = record(payload.suggestion);
    const deliverable = record(payload.deliverable);
    const decision = eventDecisionKind(event);
    if (!decision && !Object.keys(suggestion).length && !Object.keys(deliverable).length) continue;
    const contributionId = string(payload.contributionId);
    facts.push({
      studentId: event.studentId,
      contributionId,
      aliases: [contributionId, event.requestId, string(payload.decisionId), event.id].filter((value): value is string => Boolean(value)),
      updatedAt: string(payload.occurredAt) ?? event.createdAt,
      decision,
      summary: event.content,
      title: string(suggestion.title) ?? string(deliverable.title),
      targetText: string(suggestion.targetText),
      replacement: string(suggestion.replacement) ?? string(deliverable.content),
      documentActions: Array.isArray(deliverable.documentActions) ? deliverable.documentActions : undefined,
    });
  }

  // Connect request, contribution and decision IDs before reducing. Historical
  // decision events sometimes had only the request ID; proposals supply the link.
  const parents = new Map<string, string>();
  const find = (key: string): string => {
    const parent = parents.get(key);
    if (!parent) { parents.set(key, key); return key; }
    if (parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };
  for (const fact of facts) {
    const keys = fact.aliases.map((alias) => `${fact.studentId}:${alias}`);
    for (const key of keys.slice(1)) parents.set(find(key), find(keys[0]));
  }
  const groups = new Map<string, DecisionFact[]>();
  for (const fact of facts) {
    const key = find(`${fact.studentId}:${fact.aliases[0]}`);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  return [...groups.values()].map((facts): PracticeDecisionRecord => {
    const sorted = [...facts].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const durable = sorted.find((fact) => fact.durable);
    const latestDecision = durable ?? sorted.find((fact) => fact.decision);
    // An undo is a later lifecycle fact, rather than a competing acceptance.
    const undo = sorted.find((fact) => fact.decision === "undone"
      && (!latestDecision || Date.parse(fact.updatedAt) >= Date.parse(latestDecision.updatedAt)));
    const selected = undo ?? latestDecision;
    const contributionId = sorted.find((fact) => fact.contributionId)?.contributionId;
    const latestDetail = <K extends "title" | "targetText" | "replacement" | "documentActions">(key: K): DecisionFact[K] =>
      sorted.find((fact) => fact[key] !== undefined)?.[key];
    return {
      key: `${facts[0].studentId}:${contributionId ?? facts[0].aliases[0]}`,
      studentId: facts[0].studentId,
      contributionId,
      decision: selected?.decision ?? "pending",
      updatedAt: selected?.updatedAt ?? sorted[0].updatedAt,
      summary: selected?.summary ?? sorted.find((fact) => fact.summary)?.summary,
      title: latestDetail("title"),
      targetText: latestDetail("targetText"),
      replacement: latestDetail("replacement"),
      documentActions: latestDetail("documentActions"),
    };
  }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.key.localeCompare(right.key));
}

/** Latest decision per student/suggestion; durable decisions win audit fallbacks. */
export function derivePracticeDecisions(course: Course): PracticeDecisionRecord[] {
  return decisionRecords(course, practiceEvents(course));
}

function artifactsForStudent(course: Course, studentId: string): ClassroomSubmission[] {
  const includeExternalBrief = normalizePblCourseConfig(course.pblConfig).makeArtifactMode === "other";
  const groupIds = new Set((course.groups ?? []).filter((group) => group.members.some((member) => member.studentId === studentId)).map((group) => group.id));
  return (course.submissions ?? []).filter((submission) => (!submission.courseId || submission.courseId === course.id) && submission.stageKey === "make" && submission.status !== "failed"
    && (submission.type === "document" || submission.type === "code" || (includeExternalBrief && submission.type === "artifact-brief") || Boolean(submission.files?.length))
    && (submission.studentId === studentId || Boolean(submission.groupId && groupIds.has(submission.groupId))))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function nonWhitespaceCharacters(value: string): number {
  return [...value.replace(/[\s\u200b-\u200d\ufeff]/gu, "")].length;
}

function visibleDocumentHtml(html: string): string {
  return html.replace(/<!--[^]*?-->/g, "")
    .replace(/<(script|style|template)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
    .replace(/&(?:ensp|emsp|thinsp|hairsp|ZeroWidthSpace);/gi, " ");
}

function documentCharacters(html: string): number {
  const decoded = documentHtmlToPlainText(visibleDocumentHtml(html)).replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
    const point = code.toLowerCase().startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
  return nonWhitespaceCharacters(decoded);
}

function artifactCharacters(artifact: ClassroomSubmission): number {
  if (artifact.type === "code") {
    const code = parseCodeArtifact(artifact.content);
    return code?.files.reduce((total, file) => total + nonWhitespaceCharacters(file.content), 0) ?? 0;
  }
  return artifact.type === "document" || artifact.type === "artifact-brief" ? documentCharacters(artifact.content) : 0;
}

function validUploads(artifact: ClassroomSubmission): boolean {
  if (artifact.files?.some((file) => file.url?.trim())) return true;
  if (artifact.type !== "document" && artifact.type !== "artifact-brief") return false;
  // Uploaded images are document content, but carry no text and are not listed
  // in submission.files. Empty image placeholders must not count as work.
  return [...visibleDocumentHtml(artifact.content).matchAll(/<img\b[^>]*>/gi)].some(([tag]) => {
    const source = tag.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const url = (source?.[1] ?? source?.[2] ?? source?.[3] ?? "").trim();
    return /^\/api\/uploads\/[a-z0-9_-]+(?:[?#]|$)/i.test(url);
  });
}

type SuccessfulSubmission = { aliases: string[]; submissionId?: string };

/** A current draft is only a projection of its last submitted version. Include
 * immutable versions and committed audit receipts so continued editing cannot
 * erase a previous success (code archives are represented by submit receipts). */
function successfulSubmissionCount(
  artifacts: ClassroomSubmission[],
  documents: ProjectPracticeRow["documentVersions"],
  external: ProjectPracticeRow["externalVersions"],
  events: AiInteractionEvent[],
): number {
  const successful: SuccessfulSubmission[] = [];
  const draftAliases = (submissionId: string | undefined, version: unknown, submittedAt: unknown) => [
    ...(submissionId && typeof version === "number" ? [`draft:${submissionId}:${version}`] : []),
    ...(submissionId && typeof submittedAt === "string" && submittedAt ? [`submitted:${submissionId}:${submittedAt}`] : []),
  ];
  for (const version of documents.filter((item) => item.status === "submitted")) {
    successful.push({ submissionId: version.submissionId, aliases: [
      `version:${version.id}`, ...(version.requestId ? [`request:${version.requestId}`] : []),
      ...draftAliases(version.submissionId, version.sourceVersion + 1, version.submittedAt),
    ] });
  }
  for (const version of external.filter((item) => item.status === "submitted" && Boolean(item.uploadId))) {
    successful.push({ aliases: [`version:${version.id}`, ...(version.requestId ? [`request:${version.requestId}`] : [])] });
  }
  for (const event of events) {
    const payload = record(event.payload);
    const versionId = string(payload.versionId);
    if (event.eventType !== "submit" || event.actorRole !== "student" || !versionId || payload.status === "failed" || payload.status === "processing") continue;
    const submissionId = string(payload.submissionId);
    successful.push({ submissionId, aliases: [
      `version:${versionId}`, ...(event.requestId ? [`request:${event.requestId}`] : []),
      ...draftAliases(submissionId, payload.submissionVersion ?? (typeof payload.sourceVersion === "number" ? payload.sourceVersion + 1 : undefined), payload.submittedAt),
    ] });
  }
  for (const artifact of artifacts.filter((item) => item.status === "submitted")) {
    const aliases = draftAliases(artifact.id, artifact.version, artifact.submittedAt);
    // Legacy submitted snapshots omitted the version/time link. The matching
    // immutable history already proves their success, so do not count it again.
    if (!aliases.length && successful.some((item) => item.submissionId === artifact.id)) continue;
    if (artifact.files?.some((file) => external.some((version) => version.status === "submitted"
      && file.url?.split(/[?#]/)[0].endsWith(`/api/uploads/${version.uploadId}`)))) continue;
    successful.push({ submissionId: artifact.id, aliases: aliases.length ? aliases : [`legacy:${artifact.id}`] });
  }
  const owners = new Map<string, Set<string>>();
  for (const item of successful) {
    const merged = new Set(item.aliases);
    for (const alias of item.aliases) for (const previous of owners.get(alias) ?? []) merged.add(previous);
    for (const alias of merged) owners.set(alias, merged);
  }
  return new Set(owners.values()).size;
}

export function deriveProjectPracticeRows(course: Course): ProjectPracticeRow[] {
  const events = practiceEvents(course);
  const decisions = decisionRecords(course, events);
  return course.students.map((student) => {
    const artifacts = artifactsForStudent(course, student.id);
    const artifact = artifacts[0];
    const aiEvents = events.filter((item) => item.studentId === student.id);
    const documentVersions = (course.projectDocumentVersions ?? []).filter((item) => currentPracticeRecord(course, item) && item.studentId === student.id);
    const externalVersions = (course.projectPdfVersions ?? []).filter((item) => currentPracticeRecord(course, item) && item.studentId === student.id);
    const signals = (course.learningSignals ?? []).filter((item) => currentPracticeRecord(course, item) && item.studentId === student.id && item.status === "open");
    const studentDecisions = decisions.filter((item) => item.studentId === student.id);
    const submissionCount = successfulSubmissionCount(artifacts, documentVersions, externalVersions, aiEvents);
    const submitted = submissionCount > 0;
    const latestDocument = [...documentVersions].filter((item) => item.status !== "failed")
      .sort((left, right) => Date.parse(right.submittedAt ?? right.createdAt) - Date.parse(left.submittedAt ?? left.createdAt))[0];
    const contentCharacters = artifact ? artifactCharacters(artifact) : documentCharacters(latestDocument?.sourceHtml ?? "");
    // The classroom projection intentionally omits archived sourceHtml. An
    // absent archive body proves neither an empty document nor zero characters.
    const contentCharactersKnown = Boolean(artifact) || Boolean(latestDocument?.sourceHtml) || (!submissionCount && !latestDocument);
    const hasDraft = submitted || contentCharacters > 0 || Boolean(artifact && validUploads(artifact));
    const progressState: ProjectPracticeProgressState = submitted ? "submitted" : hasDraft ? "in-progress" : "not-started";
    const metrics = deriveAiCollaborationMetrics(aiEvents);
    const turns: ProjectPracticeTurn[] = metrics.turns.map((turn) => ({
      ...turn,
      messages: turn.messages.map((message) => {
        const decision = message.modification?.contributionId ? studentDecisions.find((item) => item.contributionId === message.modification!.contributionId) : undefined;
        if (!message.modification || !decision) return message;
        return { ...message, modification: { ...message.modification, decision: decision.decision, decisionAt: decision.updatedAt, decisionSummary: decision.summary,
          undoneAt: decision.decision === "undone" ? decision.updatedAt : undefined } };
      }),
    })).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return {
      student, artifact, documentVersions, externalVersions, signals, submitted, hasDraft,
      progressState, contentCharacters, contentCharactersKnown, submissionCount, boundaryTriggerCount: metrics.boundaryTriggers,
      aiEvents, dialogueRounds: metrics.dialogueRounds, participating: metrics.dialogueRounds > 0 || studentDecisions.some((item) => item.decision !== "pending"),
      turns, decisions: studentDecisions,
      updatedAt: latestTimestamp([artifact?.updatedAt, ...aiEvents.map((item) => item.createdAt), ...documentVersions.map((item) => item.submittedAt ?? item.createdAt),
        ...externalVersions.map((item) => item.submittedAt ?? item.createdAt), ...signals.map((item) => item.lastDetectedAt), ...studentDecisions.map((item) => item.updatedAt)]),
    };
  });
}
