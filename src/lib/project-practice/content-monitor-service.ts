import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { authorizeLegacyAiScope } from "@/lib/ai-collaboration/legacy-scope";
import { PlatformError } from "@/lib/platform/repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { getStagesForSystemMode } from "@/lib/system-mode";
import { createPblTemplateCourse, decodePblTemplate } from "@/lib/platform/pbl-template";
import { buildCourseStageRequirementsContext } from "@/lib/resource-package/course-requirements";
import {
  CONTENT_MONITOR_EVENT_TYPE, CONTENT_MONITOR_QUEUE, CONTENT_MONITOR_POLICY_VERSION,
  CONTENT_MONITOR_SINGLE_MIN, CONTENT_MONITOR_WINDOW_MIN, nonWhitespaceLength,
  type ContentMonitorCheckInput, type ContentMonitorEvent, type ContentMonitorEventAction, type ContentMonitorReceipt,
} from "./content-monitor-contract";
import { normalizeMonitorText } from "./content-monitor-policy";

export const monitorObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const monitorJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type MonitorSnapshot = {
  requestId: string; fingerprint: string; courseId: string; studentId: string; participationId: string;
  offeringId: string; researchKey: string | null; sessionVersion: number; stageVersion: number; templateVersionId: string;
  studentName: string; submittedAt: string; fragments: Array<{ text: string; blockId?: string }>; documentText: string;
};
type MonitorScope = { runtimeConfig: unknown; snapshot: unknown; templateVersionId: string; instanceStatus: string;
  offeringStatus: string; enrollmentStatus: string; archivedAt: Date | null; userStatus: string; userRole: string;
  sessionVersion: number; studentName: string; researchKey: string | null; offeringId: string };

export class ContentMonitorScopeClosed extends Error {
  constructor() { super("CONTENT_MONITOR_SCOPE_CLOSED"); }
}

/** Lock the live authorization/configuration rows during the short enqueue/commit transaction. */
export async function assertContentMonitorScope(db: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: Pick<MonitorSnapshot, "courseId" | "studentId" | "participationId" | "sessionVersion"> & Partial<Pick<MonitorSnapshot, "stageVersion" | "templateVersionId">>) {
  const [scope] = await db.$queryRaw<MonitorScope[]>`SELECT ci."runtimeConfig", ci.status AS "instanceStatus", ci."templateVersionId", tv.snapshot,
    o.status AS "offeringStatus", o.id AS "offeringId", e.status AS "enrollmentStatus", e."researchKey", a."archivedAt",
    u.status AS "userStatus", u.role AS "userRole", u."sessionVersion", u."displayName" AS "studentName"
    FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id=p."enrollmentId"
    JOIN "User" u ON u.id=e."userId" JOIN "ClassroomInstance" ci ON ci.id=p."instanceId"
    JOIN "ClassroomTemplateVersion" tv ON tv.id=ci."templateVersionId"
    JOIN "Activity" a ON a.id=ci."activityId" JOIN "Chapter" ch ON ch.id=a."chapterId"
    JOIN "CourseOffering" o ON o.id=ch."offeringId"
    WHERE p.id=${input.participationId} AND ci.id=${input.courseId} AND u.id=${input.studentId} AND e."offeringId"=o.id
    FOR SHARE OF ci, u, e, o, a`;
  const runtime = monitorObject(scope?.runtimeConfig);
  const design = monitorObject(monitorObject(scope?.snapshot).design);
  const mode = runtime.makeArtifactMode ?? monitorObject(design.pblConfig).makeArtifactMode ?? "document";
  const stages = Array.isArray(design.stages) ? design.stages : getStagesForSystemMode();
  if (!scope || scope.instanceStatus.toUpperCase() !== "TEACHING" || scope.offeringStatus.toUpperCase() !== "OPEN"
    || scope.enrollmentStatus.toUpperCase() !== "ACTIVE" || scope.userStatus.toUpperCase() !== "ACTIVE" || scope.userRole.toUpperCase() !== "STUDENT"
    || scope.archivedAt || scope.sessionVersion !== input.sessionVersion || runtime.documentPasteMonitoringEnabled !== true
    || monitorObject(stages[Number(runtime.currentStageIndex ?? 0)]).key !== "make" || mode !== "document"
    || input.stageVersion !== undefined && Number(runtime.stageVersion ?? 1) !== input.stageVersion
    || input.templateVersionId !== undefined && scope.templateVersionId !== input.templateVersionId) throw new ContentMonitorScopeClosed();
  return { ...scope, runtime, design };
}

function taskId(participationId: string, requestId: string) { return `paste-monitor:${hash([participationId, requestId])}`; }

/** Only durable scope metadata survives completion; clipboard/document bodies are transient. */
export function clearedMonitorInput(input: MonitorSnapshot) {
  return { requestId: input.requestId, fingerprint: input.fingerprint, courseId: input.courseId,
    studentId: input.studentId, participationId: input.participationId, submittedAt: input.submittedAt };
}

export { cancelContentMonitorChecks } from "./content-monitor-cancellation";

async function receiptFromTask(task: { input: unknown; output: unknown; status: string }): Promise<ContentMonitorReceipt> {
  const input = monitorObject(task.input), output = monitorObject(task.output);
  const status: ContentMonitorReceipt["status"] = task.status === "PENDING" || task.status === "RUNNING" ? "pending"
    : task.status === "CANCELLED" ? "cancelled" : task.status === "FAILED" ? "incomplete" : output.status === "flagged" ? "flagged" : "clear";
  const receipt: ContentMonitorReceipt = { requestId: String(input.requestId), status };
  if (status === "flagged" && typeof output.eventId === "string") {
    const row = await prisma.domainEvent.findFirst({ where: { id: output.eventId, eventType: CONTENT_MONITOR_EVENT_TYPE,
      classroomInstanceId: String(input.courseId), participationId: String(input.participationId), actorId: String(input.studentId) } });
    if (row) receipt.event = await projectMonitorEvent(row);
  }
  return receipt;
}

export async function submitContentMonitorCheck(claims: AuthClaims, body: ContentMonitorCheckInput): Promise<ContentMonitorReceipt> {
  if (claims.role !== "student") throw new PlatformError("FORBIDDEN", "仅学生可提交检测", 403);
  const scope = await authorizeLegacyAiScope(claims, body.courseId);
  const participation = scope.participation!;
  const id = taskId(participation.id, body.requestId);
  const fingerprint = hash(body);
  const task = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
    const existing = await tx.aiTask.findUnique({ where: { id } });
    if (existing) {
      if (monitorObject(existing.input).fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他检测", 409);
      return existing;
    }
    const live = await assertContentMonitorScope(tx, { courseId: body.courseId, participationId: participation.id, studentId: scope.user.id, sessionVersion: claims.sv });
    const snapshot: MonitorSnapshot = { ...body, fragments: body.fragments.map(({ text, blockId }) => ({ text, ...(blockId ? { blockId } : {}) })), fingerprint, studentId: scope.user.id, participationId: participation.id,
      offeringId: live.offeringId, researchKey: live.researchKey, sessionVersion: claims.sv, stageVersion: Number(live.runtime.stageVersion ?? 1),
      templateVersionId: live.templateVersionId, studentName: live.studentName, submittedAt: new Date().toISOString() };
    const eligible = body.fragments.some(f => nonWhitespaceLength(f.text) >= CONTENT_MONITOR_SINGLE_MIN)
      || body.fragments.reduce((sum, f) => sum + nonWhitespaceLength(f.text), 0) >= CONTENT_MONITOR_WINDOW_MIN;
    const pending = eligible ? await tx.aiTask.count({ where: { queueKey: CONTENT_MONITOR_QUEUE, createdById: scope.user.id, status: { in: ["PENDING", "RUNNING"] } } }) : 0;
    if (pending >= 8) throw new PlatformError("CONTENT_MONITOR_BUSY", "检测暂时繁忙，文档可继续编辑保存", 429);
    return tx.aiTask.create({ data: { id, taskType: CONTENT_MONITOR_QUEUE, queueKey: CONTENT_MONITOR_QUEUE,
      offeringId: live.offeringId, createdById: scope.user.id, status: eligible ? "PENDING" : "COMPLETED",
      input: monitorJson(eligible ? snapshot : clearedMonitorInput(snapshot)),
      ...(eligible ? { availableAt: new Date() } : { completedAt: new Date(), output: monitorJson({ status: "clear" }) }) } });
  });
  return receiptFromTask(task);
}

export async function readContentMonitorCheck(claims: AuthClaims, courseId: string, requestId: string) {
  if (claims.role !== "student") throw new PlatformError("FORBIDDEN", "仅学生可读取自己的检测回执", 403);
  const scope = await authorizeLegacyAiScope(claims, courseId);
  const task = await prisma.aiTask.findFirst({ where: { id: taskId(scope.participation!.id, requestId), queueKey: CONTENT_MONITOR_QUEUE, createdById: scope.user.id } });
  if (!task) throw new PlatformError("CHECK_NOT_FOUND", "检测回执不存在", 404);
  return receiptFromTask(task);
}

const sourcePaths: string[][] = [
  ...["content", "message", "replacement", "html", "text", "code"].map(key => [key]),
  ["replyBlocks", "*", "content"],
  ...["support", "projectSupport"].flatMap(prefix => [
    [prefix, "replyBlocks", "*", "content"], [prefix, "nextStep"],
    [prefix, "sources", "*", "excerpt"], [prefix, "sources", "*", "title"], [prefix, "sources", "*", "locator"],
    [prefix, "knowledgePoints", "*", "label"],
  ]),
  ["suggestion", "replacement"], ["suggestion", "reason"], ["suggestion", "title"],
  ["deliverable", "content"], ["deliverable", "summary"], ["deliverable", "title"],
  ["deliverable", "sources", "*", "excerpt"],
  ...[[], ["deliverable"]].flatMap(prefix => [[...prefix, "documentActions", "*", "content"], [...prefix, "documentActions", "*", "description"]]),
  ...["proposal", "modification"].flatMap(prefix => [[prefix, "content"], [prefix, "replacement"]]),
];

function textAtSourcePath(value: unknown, path: string[]): string[] {
  if (!path.length) return typeof value === "string" && value ? [value] : [];
  const [key, ...rest] = path;
  if (key === "*") return Array.isArray(value) ? value.flatMap(item => textAtSourcePath(item, rest)) : [];
  return textAtSourcePath(monitorObject(value)[key], rest);
}

/** Whitelist the fields rendered by ProjectReplyContent, ProjectSupportCard and
 * the document suggestion/delivery panels. Never descend into request/raw/history
 * or targetText (which belongs to the student's existing document). */
function visibleTexts(value: unknown): string[] {
  return sourcePaths.flatMap(path => textAtSourcePath(value, path));
}

export async function readContentMonitorEvidence(snapshot: MonitorSnapshot) {
  const live = await assertContentMonitorScope(prisma, snapshot);
  const [messages, interactions, group, directives] = await Promise.all([
    prisma.aiMessage.findMany({ where: { role: "assistant", conversation: { userId: snapshot.studentId, participationId: snapshot.participationId,
      participation: { instanceId: snapshot.courseId } } }, select: { content: true, metadata: true }, orderBy: { createdAt: "desc" }, take: 301 }),
    prisma.aiInteractionEvent.findMany({ where: { participationId: snapshot.participationId, userId: snapshot.studentId,
      actor: { in: ["assistant", "ai"] }, eventType: { in: ["response", "proposal", "comment"] } },
      select: { content: true, payload: true }, orderBy: { createdAt: "desc" }, take: 301 }),
    prisma.projectGroup.findFirst({ where: { offeringId: snapshot.offeringId, members: { some: { userId: snapshot.studentId, leftAt: null } } }, select: { board: { select: { snapshot: true } } } }),
    prisma.teacherAgentDirective.findMany({ where: { offeringId: snapshot.offeringId, status: "ACTIVE", AND: [
      { OR: [{ participationId: snapshot.participationId }, { payload: { path: ["instanceId"], equals: snapshot.courseId } }] },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    ] }, select: { payload: true }, orderBy: { createdAt: "desc" }, take: 12 }),
  ]);
  const course = createPblTemplateCourse(snapshot.courseId, decodePblTemplate(live.snapshot) ?? live.design);
  const proposal = monitorObject(monitorObject(group?.board?.snapshot).proposal);
  const instructions = directives.flatMap(row => {
    const payload = monitorObject(row.payload), directive = monitorObject(payload.view ?? payload);
    if (directive.stageKey !== "make" || directive.status !== "active"
      || !(directive.targetScope === "course" || Array.isArray(directive.targetStudentIds) && directive.targetStudentIds.includes(snapshot.studentId))) return [];
    return [directive.goal, directive.instruction];
  });
  const taskRequirements = [buildCourseStageRequirementsContext(course, "make", { includeEvaluation: false }),
    course.stages.find(stage => stage.key === "make")?.description, course.drivingQuestion, course.expectedOutcome,
    ...(course.learningObjectives ?? []), course.pblConfig?.outcome.artifact, proposal.topic, proposal.goal, ...instructions,
  ].filter((v): v is string => typeof v === "string" && !!v.trim()).join("\n\n").slice(0, 24000);
  const knownSources = [...messages.slice(0, 300).flatMap(m => [m.content, ...visibleTexts(m.metadata)]),
    ...interactions.slice(0, 300).flatMap(e => [e.content ?? "", ...visibleTexts(monitorObject(e.payload).detail)])];
  // A bounded source window must never mislabel a copy from an older owned AI reply.
  return { taskRequirements, pastedText: snapshot.fragments.map(f => f.text).join("\n\n"), nearbyText: snapshot.documentText.slice(0, 12000), knownSources,
    sourceCoverageComplete: messages.length <= 300 && interactions.length <= 300 };
}

type EventRow = { id: string; payload: unknown; createdAt: Date; participationId: string | null };
type HistoryRow = { payload: unknown; createdAt: Date };
function applyMonitorHistory(event: ContentMonitorEvent, rows: HistoryRow[]) {
  const result = { ...event, history: [...event.history] };
  for (const row of rows) {
    const value = monitorObject(row.payload);
    const at = row.createdAt.toISOString();
    if (value.actor === "teacher" && (value.action === "reviewed" || value.action === "dismissed")) result.status = value.action;
    if (value.actor === "student" && (value.action === "acknowledge" || value.action === "explain")) result.acknowledgedAt ??= at;
    if (value.actor === "student" && value.action === "explain") {
      result.studentSource = value.source as ContentMonitorEvent["studentSource"];
      result.studentExplanation = typeof value.note === "string" ? value.note : "";
    }
    result.history.push({ at, actor: value.actor as "student" | "teacher", action: String(value.action), ...(typeof value.note === "string" ? { note: value.note } : {}) });
  }
  return result;
}

export function monitorEventContentState(excerpt: string, saved: { text: string; updatedAt: Date } | undefined, detectedAt: Date): ContentMonitorEvent["contentState"] {
  if (!saved || saved.updatedAt < detectedAt) return "unknown";
  const needle = normalizeMonitorText(excerpt), text = normalizeMonitorText(saved.text);
  if (!needle) return "unknown";
  if (text.includes(needle)) return "unchanged";
  const chunks = Array.from({ length: Math.ceil(needle.length / 24) }, (_, i) => needle.slice(i * 24, (i + 1) * 24)).filter(s => s.length >= 12);
  return chunks.some(chunk => text.includes(chunk)) ? "modified" : "removed";
}

async function projectMonitorEvent(row: EventRow, saved?: { text: string; updatedAt: Date } | null, history?: HistoryRow[]): Promise<ContentMonitorEvent> {
  const payload = monitorObject(row.payload);
  if (saved === undefined && row.participationId) {
    const document = await prisma.classroomSubmission.findUnique({ where: { participationId_stageKey: { participationId: row.participationId, stageKey: "make:document" } }, select: { payload: true, updatedAt: true } });
    if (document) { const value = monitorObject(document.payload); saved = { text: String(monitorObject(value.view ?? value).content ?? ""), updatedAt: document.updatedAt }; }
  }
  const rows = history ?? await prisma.domainEvent.findMany({ where: { eventType: `${CONTENT_MONITOR_EVENT_TYPE}_history`,
    participationId: row.participationId, payload: { path: ["eventId"], equals: row.id } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { payload: true, createdAt: true } });
  const event = applyMonitorHistory(monitorObject(payload.event) as unknown as ContentMonitorEvent, rows);
  return { ...event, id: row.id, contentState: monitorEventContentState(event.excerpt, saved ?? undefined, new Date(String(payload.submittedAt ?? row.createdAt.toISOString()))) };
}

export type ContentMonitorStudentCount = {
  studentId: string;
  pendingCount: number;
  reviewedCount: number;
  dismissedCount: number;
};

export async function listContentMonitorEvents(claims: AuthClaims, input: { courseId: string; studentId?: string; cursor?: string }) {
  const scope = await authorizeLegacyAiScope(claims, input.courseId, input.studentId);
  const where: Prisma.DomainEventWhereInput = { classroomInstanceId: input.courseId, eventType: CONTENT_MONITOR_EVENT_TYPE,
    ...(scope.studentId ? { actorId: scope.studentId } : {}) };
  const [rows, counts] = await Promise.all([
    prisma.domainEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 101,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) }),
    // One latest teacher decision per observation; pagination never limits these totals.
    prisma.$queryRaw<Array<Omit<ContentMonitorStudentCount, "studentId"> & { studentId: string | null }>>`
      SELECT e."actorId" AS "studentId",
        count(*) FILTER (WHERE latest.action IS NULL)::int AS "pendingCount",
        count(*) FILTER (WHERE latest.action='reviewed')::int AS "reviewedCount",
        count(*) FILTER (WHERE latest.action='dismissed')::int AS "dismissedCount"
      FROM "DomainEvent" e
      LEFT JOIN LATERAL (
        SELECT h.payload->>'action' AS action FROM "DomainEvent" h
        WHERE h."eventType"=${`${CONTENT_MONITOR_EVENT_TYPE}_history`}
          AND h."classroomInstanceId"=e."classroomInstanceId" AND h.payload->>'eventId'=e.id
          AND h.payload->>'actor'='teacher' AND h.payload->>'action' IN ('reviewed','dismissed')
        ORDER BY h."createdAt" DESC, h.id DESC LIMIT 1
      ) latest ON true
      WHERE e."classroomInstanceId"=${input.courseId} AND e."eventType"=${CONTENT_MONITOR_EVENT_TYPE}
        AND (${scope.studentId ?? null}::text IS NULL OR e."actorId"=${scope.studentId ?? null})
      GROUP BY e."actorId" ORDER BY e."actorId" ASC`,
  ]);
  const page = rows.slice(0, 100);
  const participationIds = [...new Set(page.flatMap(row => row.participationId ? [row.participationId] : []))];
  const documents = participationIds.length ? await prisma.classroomSubmission.findMany({ where: { participationId: { in: participationIds }, stageKey: "make:document" },
    select: { participationId: true, payload: true, updatedAt: true } }) : [];
  const saved = new Map(documents.map(document => {
    const payload = monitorObject(document.payload);
    return [document.participationId, { text: String(monitorObject(payload.view ?? payload).content ?? ""), updatedAt: document.updatedAt }];
  }));
  const history = page.length ? await prisma.domainEvent.findMany({ where: { classroomInstanceId: input.courseId,
    eventType: `${CONTENT_MONITOR_EVENT_TYPE}_history`, OR: page.map(row => ({ payload: { path: ["eventId"], equals: row.id } })) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { payload: true, createdAt: true } }) : [];
  const events = await Promise.all(page.map(row => projectMonitorEvent(row, saved.get(row.participationId ?? "") ?? null,
    history.filter(entry => monitorObject(entry.payload).eventId === row.id))));
  const studentCounts = counts.filter((count): count is ContentMonitorStudentCount => typeof count.studentId === "string");
  return { events, pendingCount: counts.reduce((total, count) => total + count.pendingCount, 0), studentCounts,
    ...(rows.length > 100 ? { nextCursor: rows[99].id } : {}) };
}

export async function updateContentMonitorEvent(claims: AuthClaims, id: string, action: ContentMonitorEventAction) {
  const scope = await authorizeLegacyAiScope(claims, action.courseId);
  if (action.action === "review" ? scope.user.role !== "teacher" : scope.user.role !== "student") throw new PlatformError("FORBIDDEN", "无权执行此操作", 403);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`content-monitor-event:${id}`}, 0))`;
    const row = await tx.domainEvent.findFirst({ where: { id, eventType: CONTENT_MONITOR_EVENT_TYPE, classroomInstanceId: action.courseId,
      ...(scope.user.role === "student" ? { actorId: scope.user.id, participationId: scope.participation!.id } : {}) } });
    if (!row) throw new PlatformError("EVENT_NOT_FOUND", "提醒记录不存在", 404);
    const previous = await tx.domainEvent.findMany({ where: { eventType: `${CONTENT_MONITOR_EVENT_TYPE}_history`, classroomInstanceId: action.courseId,
      payload: { path: ["eventId"], equals: id } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { payload: true, createdAt: true } });
    const payload = monitorObject(row.payload), event = applyMonitorHistory(monitorObject(payload.event) as unknown as ContentMonitorEvent, previous);
    const at = new Date().toISOString();
    if (action.action === "acknowledge" && event.acknowledgedAt) return { ...row, payload: { ...payload, event } };
    const update = action.action === "review" ? { status: action.status }
      : action.action === "explain" ? { studentSource: action.source, studentExplanation: action.explanation, acknowledgedAt: event.acknowledgedAt ?? at }
        : { acknowledgedAt: at };
    const note = action.action === "explain" ? action.explanation : action.action === "review" ? action.note : undefined;
    const history = { at, actor: scope.user.role, action: action.action === "review" ? action.status : action.action, ...(note ? { note } : {}) };
    await tx.domainEvent.create({ data: { idempotencyKey: `content-monitor-history:${randomUUID()}`, eventType: `${CONTENT_MONITOR_EVENT_TYPE}_history`,
      classroomInstanceId: action.courseId, participationId: row.participationId, offeringId: row.offeringId, researchKey: row.researchKey,
      actorId: scope.user.id, payload: monitorJson({ eventId: id, ...history, ...(action.action === "explain" ? { source: action.source } : {}) }) } });
    // The original observation is immutable; this is only a response projection.
    return { ...row, payload: { ...payload, event: { ...event, ...update, history: [...event.history, history] } } };
  });
  const event = await projectMonitorEvent(result, undefined, []);
  await notifyContentMonitorChange(action.courseId, event.studentId);
  return event;
}

export async function notifyContentMonitorChange(courseId: string, studentId: string) {
  try { await publishCourseEvent(courseId, { type: "course-updated", courseId, at: new Date().toISOString(),
    payload: { source: "content-monitor", scope: "student", studentId } }); }
  catch { console.warn("[content-monitor] notification unavailable; durable receipt retained"); }
}

export function redactContentMonitorEvent(event: ContentMonitorEvent, includeContent: boolean) {
  if (includeContent) return event;
  return { id: event.id, studentId: event.studentId, studentName: event.studentName, createdAt: event.createdAt,
    pastedCharacters: event.pastedCharacters, status: event.status, studentSource: event.studentSource,
    acknowledgedAt: event.acknowledgedAt, contentState: event.contentState,
    history: event.history.map(({ at, actor, action }) => ({ at, actor, action })) };
}

export { CONTENT_MONITOR_POLICY_VERSION };
