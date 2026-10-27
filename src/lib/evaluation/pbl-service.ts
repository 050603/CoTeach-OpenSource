import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { lockCourseMutation } from "@/lib/db/course-mutation-lock";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { getPlatformUser, type PlatformDb } from "@/lib/platform/access";
import { isActivityOpen, PlatformError } from "@/lib/platform/repository";
import { pblAssignmentPairs, pblCommandSchema, pblConfig, pblObject, pblReportView, validatePblAnswers } from "./pbl-policy";
import { notifyProcessEvaluation } from "./process-notifications";
import { pblWeightedScore, type PblArtifact, type PblEvaluationCommand, type PblEvaluationRecord, type PblEvaluationSnapshot, type PblParticipantDossier } from "./pbl-contract";
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const humanTypes = ["PBL_SELF", "PBL_PEER", "PBL_TEACHER"];
const writableEnrollments = ["ACTIVE", "active"];
const readableEnrollments = [...writableEnrollments, "COMPLETED", "completed"];
export async function pblContext(db: PlatformDb, claims: AuthClaims, instanceId: string) {
  const user = await getPlatformUser(claims, db);
  if (!user) throw new PlatformError("UNAUTHORIZED", "请重新登录", 401);
  if (claims.sv !== undefined && claims.sv !== user.sessionVersion) throw new PlatformError("FORBIDDEN", "登录状态已变化，请重新登录", 403);
  const instance = await db.classroomInstance.findUnique({ where: { id: instanceId }, include: {
    templateVersion: true, activity: { include: { chapter: { include: { offering: true } } } },
    participations: { where: { enrollment: { status: { in: readableEnrollments } } }, include: { enrollment: { include: { user: { select: { id: true, displayName: true } } } } }, orderBy: { id: "asc" } } } });
  if (!instance) throw new PlatformError("NOT_FOUND", "课堂不存在", 404);
  const offeringId = instance.activity.chapter.offeringId;
  const participants = instance.participations.filter(p => p.enrollment.offeringId === offeringId);
  const own = participants.find(p => p.enrollment.userId === user.id);
  if (user.role === "teacher") {
    if (!await db.courseTeacher.findFirst({ where: { userId: user.id, offeringId } })) throw new PlatformError("FORBIDDEN", "无权访问该课堂", 403);
  } else if (!own) throw new PlatformError("FORBIDDEN", "无权访问该课堂", 403);
  const runtime = pblObject(instance.runtimeConfig);
  if (runtime.evaluationContractVersion !== 2) throw new PlatformError("LEGACY_EVALUATION", "此场次保留原评价流程", 409);
  const stageIndex = Number(runtime.currentStageIndex ?? 0);
  const status = instance.status.toUpperCase(), offeringStatus = instance.activity.chapter.offering.status.toUpperCase();
  const canWrite = user.role === "teacher" ? ["OPEN", "FINISHED"].includes(offeringStatus) && ["SCHEDULED", "TEACHING", "FINISHED"].includes(status)
    : offeringStatus === "OPEN" && status === "TEACHING" && stageIndex >= 4 && own?.enrollment.status.toUpperCase() === "ACTIVE" && !own.completedAt && isActivityOpen(instance.activity.chapter, instance.activity);
  return { user, instance, offeringId, participants, own, runtime, stageIndex, status, canWrite,
    canPublish: user.role === "teacher" && (stageIndex >= 4 || status === "FINISHED") && canWrite,
    canConfigureRubric: user.role === "teacher" && status === "SCHEDULED" && !instance.startedAt && canWrite,
    config: pblConfig(runtime, instance.templateVersion.snapshot) };
}
type Context = Awaited<ReturnType<typeof pblContext>>;
function record(row: { result: unknown } | null | undefined): PblEvaluationRecord | null {
  const data = pblObject(row?.result);
  return typeof data.id === "string" && ["self", "peer", "teacher"].includes(String(data.source)) ? data as PblEvaluationRecord : null;
}
function anonymousPeer(item: PblEvaluationRecord, anonymous: boolean): PblEvaluationRecord {
  const { evaluatorName, history: _history, ...safe } = item; void _history;
  return { ...safe, assignmentId: null, history: [], ...(anonymous ? {} : { evaluatorName }) };
}
function publishedTeacher(item: PblEvaluationRecord | null): PblEvaluationRecord | null {
  // Earlier submitted drafts and return notes are teacher-only until explicitly published.
  return item ? { ...item, history: [], returnedReason: null } : null;
}
const artifactSelect = { id: true, sequence: true, sourceHtml: true, mimeType: true, submittedAt: true, fileAssetId: true, artifact: { select: { participationId: true, title: true } } } satisfies Prisma.ArtifactVersionSelect;
type ArtifactRow = Prisma.ArtifactVersionGetPayload<{ select: typeof artifactSelect }>;
function artifactView(row: ArtifactRow, instanceId: string): PblArtifact {
  return { versionId: row.id, sequence: row.sequence, title: row.artifact.title, sourceHtml: row.sourceHtml, mimeType: row.mimeType,
    submittedAt: row.submittedAt?.toISOString() ?? null, fileUrl: row.fileAssetId ? `/api/courses/${encodeURIComponent(instanceId)}/showcase/artifacts/${encodeURIComponent(row.id)}` : null };
}
export async function getPblEvaluation(claims: AuthClaims, instanceId: string, db: PlatformDb = prisma): Promise<PblEvaluationSnapshot> {
  const ctx = await pblContext(db, claims, instanceId);
  return snapshot(db, ctx);
}
async function snapshot(db: PlatformDb, ctx: Context): Promise<PblEvaluationSnapshot> {
  const { user, instance, config } = ctx;
  const teacher = user.role === "teacher", ownId = ctx.own?.id;
  const participantIds = teacher ? ctx.participants.map(p => p.id) : [ownId!];
  const [rows, assignments, artifacts, reports] = await Promise.all([
    db.evaluation.findMany({ where: { participation: { instanceId: instance.id }, type: { in: [...humanTypes, "PBL_PUBLICATION"] }, ...(teacher ? {} : { OR: [{ participationId: ownId }, { evaluatorId: user.id, type: "PBL_PEER" }] }) }, orderBy: { createdAt: "desc" } }),
    db.peerReviewAssignment.findMany({ where: { instanceId: instance.id, status: "ACTIVE", ...(teacher ? {} : { reviewerParticipationId: ownId }) }, include: { artifactVersion: { select: artifactSelect } }, orderBy: { createdAt: "asc" } }),
    db.artifactVersion.findMany({ where: { status: "SUBMITTED", artifact: { participationId: { in: participantIds } } }, orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }], select: artifactSelect }),
    teacher ? db.aiSupportRecord.findMany({ where: { participationId: { in: participantIds }, type: "PBL_PROCESS_REPORT", status: "READY" }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
  ]);
  const human = rows.flatMap(row => { const value = record(row); return value ? [value] : []; });
  const participants: PblParticipantDossier[] = ctx.participants.filter(p => participantIds.includes(p.id)).map(p => {
    const pub = pblObject(rows.find(row => row.participationId === p.id && row.type === "PBL_PUBLICATION")?.result);
    const published = typeof pub.at === "string" ? { at: pub.at, teacherEvaluation: publishedTeacher(record({ result: pub.teacherEvaluation })), processReport: pblReportView(pub.processReport) } : null;
    const received = human.filter(r => r.participationId === p.id && r.source === "peer" && r.status === "submitted");
    return { participationId: p.id, studentId: p.enrollment.userId, name: p.enrollment.user.displayName,
      artifacts: artifacts.filter(a => a.artifact.participationId === p.id).map(a => artifactView(a, instance.id)),
      selfEvaluation: human.find(r => r.participationId === p.id && r.source === "self") ?? null,
      peerEvaluations: teacher ? received : published && Array.isArray(pub.peerEvaluations) ? pub.peerEvaluations.flatMap(value => { const r = record({ result: value }); return r ? [anonymousPeer(r, config.anonymous)] : []; }) : [],
      teacherEvaluation: teacher ? human.find(r => r.participationId === p.id && r.source === "teacher") ?? null : published?.teacherEvaluation ?? null,
      processReport: teacher ? pblReportView(reports.find(r => r.participationId === p.id)?.structuredPayload) : published?.processReport ?? null,
      published };
  });
  const name = (id: string) => ctx.participants.find(p => p.id === id)?.enrollment.user.displayName ?? "学生";
  const ownAssignments = assignments.map(a => ({ id: a.id, reviewerParticipationId: a.reviewerParticipationId, targetParticipationId: a.targetParticipationId,
    targetName: name(a.targetParticipationId), ...(teacher ? { reviewerName: name(a.reviewerParticipationId) } : {}), artifact: artifactView(a.artifactVersion, instance.id), evaluation: human.find(r => r.assignmentId === a.id) ?? null }));
  return { contractVersion: 2, role: user.role, instanceId: instance.id,
    stage: ["launch", "ai-learning", "make", "showcase", "reflection"][ctx.stageIndex] ?? "reflection", canWrite: ctx.canWrite, canConfigureRubric: ctx.canConfigureRubric, canPublish: ctx.canPublish,
    config, participants, assignments: ownAssignments,
    completion: { total: participants.length, selfSubmitted: participants.filter(p => p.selfEvaluation?.status === "submitted").length,
      peerAssigned: ownAssignments.length, peerSubmitted: ownAssignments.filter(a => a.evaluation?.status === "submitted").length,
      teacherSubmitted: participants.filter(p => p.teacherEvaluation?.status === "submitted").length, published: participants.filter(p => p.published).length } };
}
function requireTeacher(ctx: Context) { if (ctx.user.role !== "teacher") throw new PlatformError("FORBIDDEN", "此操作仅限授课教师", 403); }
function assertVersion(actual: number, expected: number) { if (actual !== expected) throw new PlatformError("DRAFT_VERSION_CONFLICT", "评价已更新，请重新载入后再修改", 409); }
function targetParticipant(ctx: Context, id: string) {
  const p = ctx.participants.find(p => p.id === id);
  if (!p) throw new PlatformError("NOT_FOUND", "学生不属于当前课堂", 404);
  return p;
}
export async function mutatePblEvaluation(claims: AuthClaims, instanceId: string, raw: PblEvaluationCommand): Promise<PblEvaluationSnapshot> {
  const input = pblCommandSchema.parse(raw);
  let selfChangedStudentId: string | undefined;
  await runMutationTransaction(async tx => {
    await lockCourseMutation(tx, instanceId);
    const ctx = await pblContext(tx, claims, instanceId);
    const receiptKey = `pbl-evaluation:${instanceId}:${ctx.user.id}:${input.idempotencyKey}`;
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const receipt = await tx.domainEvent.findUnique({ where: { idempotencyKey: receiptKey } });
    if (receipt) {
      if (pblObject(receipt.payload).requestHash !== requestHash) throw new PlatformError("IDEMPOTENCY_CONFLICT", "同一请求标识不能提交不同内容", 409);
      return;
    }
    if (!ctx.canWrite) throw new PlatformError("EVALUATION_LOCKED", "当前阶段或选课状态不允许修改评价", 409);
    if (input.action === "config") {
      requireTeacher(ctx); assertVersion(ctx.config.version, input.version);
      if (!ctx.canConfigureRubric && JSON.stringify(input.config.rubric) !== JSON.stringify(ctx.config.rubric)) throw new PlatformError("RUBRIC_FROZEN", "开课后量规已固定", 409);
      if (ctx.status === "FINISHED") throw new PlatformError("EVALUATION_LOCKED", "课堂结束后不能更改评价设置", 409);
      await tx.classroomInstance.update({ where: { id: instanceId }, data: { runtimeConfig: json({ ...ctx.runtime, pblEvaluationConfig: { ...input.config, version: ctx.config.version + 1 } }) } });
      if (input.config.peerMode === "off") await cancelUnsubmittedAssignments(tx, instanceId);
    } else if (input.action === "assign") {
      requireTeacher(ctx); await assignReviews(tx, ctx, input.pairs);
    } else if (input.action === "return") {
      requireTeacher(ctx);
      const row = await tx.evaluation.findFirst({ where: { id: input.evaluationId, participation: { instanceId }, type: { in: humanTypes } } });
      const previous = record(row); if (!row || !previous) throw new PlatformError("NOT_FOUND", "评价不存在", 404);
      assertVersion(previous.version, input.version);
      if (previous.status !== "submitted") throw new PlatformError("EVALUATION_LOCKED", "只有已提交评价可退回", 409);
      if (previous.source === "self") selfChangedStudentId = targetParticipant(ctx, previous.participationId).enrollment.userId;
      const now = new Date().toISOString();
      await tx.evaluation.update({ where: { id: row.id }, data: { result: json({ ...previous, version: previous.version + 1, status: "returned", returnedReason: input.reason, updatedAt: now,
        history: [...previous.history, { version: previous.version, status: previous.status, answers: previous.answers, at: now }] }) } });
    } else if (input.action === "publish") {
      requireTeacher(ctx); await publish(tx, ctx, input);
    } else {
      await saveEvaluation(tx, ctx, input);
      if (input.action === "submit" && input.source === "self") selfChangedStudentId = targetParticipant(ctx, input.participationId).enrollment.userId;
    }
    if (["submit", "return", "assign", "config"].includes(input.action)) await updateEvaluationProgress(tx, ctx);
    await tx.domainEvent.create({ data: { idempotencyKey: receiptKey, actorId: ctx.user.id, offeringId: ctx.offeringId, classroomInstanceId: instanceId,
      eventType: `PBL_EVALUATION_${input.action.toUpperCase()}`, payload: json({ requestHash, action: input.action }) } });
  });
  if (selfChangedStudentId) notifyProcessEvaluation(instanceId, selfChangedStudentId, true);
  return getPblEvaluation(claims, instanceId);
}
async function cancelUnsubmittedAssignments(tx: Prisma.TransactionClient, instanceId: string, keep: string[] = []) {
  const submitted = await tx.evaluation.findMany({ where: { participation: { instanceId }, type: "PBL_PEER" }, select: { result: true } });
  const locked = submitted.flatMap(row => { const value = record(row); return value && (value.status === "submitted" || value.history.some(h => h.status === "submitted")) && value.assignmentId ? [value.assignmentId] : []; });
  await tx.peerReviewAssignment.updateMany({ where: { instanceId, id: { notIn: [...locked, ...keep] } }, data: { status: "CANCELLED" } });
}
async function assignReviews(tx: Prisma.TransactionClient, ctx: Context, pairs?: Array<{ reviewerParticipationId: string; targetParticipationId: string }>) {
  if (ctx.config.peerMode === "off") throw new PlatformError("PEER_REVIEW_DISABLED", "请先开启互评", 409);
  if (ctx.stageIndex < 3 || ctx.status !== "TEACHING") throw new PlatformError("EVALUATION_LOCKED", "请在成果汇报或项目评价阶段分配互评", 409);
  const versions = await tx.artifactVersion.findMany({ where: { status: "SUBMITTED", artifact: { participationId: { in: ctx.participants.filter(p => writableEnrollments.includes(p.enrollment.status)).map(p => p.id) } } }, orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }], select: artifactSelect });
  const latest = new Map<string, ArtifactRow>(); for (const v of versions) if (!latest.has(v.artifact.participationId)) latest.set(v.artifact.participationId, v);
  let targets = [...latest.keys()];
  if (ctx.config.peerMode === "presenters-only") {
    const presenters = await tx.showcasePresentation.findMany({ where: { participation: { instanceId: ctx.instance.id }, status: { in: ["PRESENTED", "COMPLETED", "ENDED", "ACTIVE", "completed", "ended", "active"] } }, select: { participationId: true } });
    targets = targets.filter(id => presenters.some(p => p.participationId === id));
  }
  const desired = ctx.config.peerMode === "manual" ? pairs ?? [] : pblAssignmentPairs(ctx.participants.filter(p => writableEnrollments.includes(p.enrollment.status)).map(p => p.id), targets, ctx.config.reviewsPerStudent);
  if (ctx.config.peerMode !== "manual" && pairs) throw new PlatformError("INVALID_INPUT", "手动指定仅适用于手动互评模式", 400);
  const keep: string[] = [];
  for (const pair of desired) {
    const reviewer = targetParticipant(ctx, pair.reviewerParticipationId); targetParticipant(ctx, pair.targetParticipationId);
    if (pair.reviewerParticipationId === pair.targetParticipationId || !writableEnrollments.includes(reviewer.enrollment.status)) throw new PlatformError("INVALID_ASSIGNMENT", "互评必须分配给其他有效选课学生", 400);
    const version = latest.get(pair.targetParticipationId);
    if (!version) throw new PlatformError("INVALID_ARTIFACT_VERSION", "被评者尚未正式提交作品", 400);
    const row = await tx.peerReviewAssignment.upsert({ where: { instanceId_reviewerParticipationId_targetParticipationId: { instanceId: ctx.instance.id, ...pair } },
      create: { instanceId: ctx.instance.id, ...pair, artifactVersionId: version.id }, update: { status: "ACTIVE" } });
    keep.push(row.id);
  }
  await cancelUnsubmittedAssignments(tx, ctx.instance.id, keep);
}
async function saveEvaluation(tx: Prisma.TransactionClient, ctx: Context, input: Extract<PblEvaluationCommand, { action: "save" | "submit" }>) {
  const target = targetParticipant(ctx, input.participationId);
  if (input.source === "teacher") { requireTeacher(ctx); if (ctx.stageIndex < 3 && ctx.status !== "FINISHED") throw new PlatformError("EVALUATION_LOCKED", "请在成果汇报后填写教师评价", 409); }
  if (input.source === "teacher" && input.action === "submit" && ctx.stageIndex < 4 && ctx.status !== "FINISHED") throw new PlatformError("EVALUATION_LOCKED", "成果汇报阶段可保存观察草稿，项目评价阶段再提交定评", 409);
  if (input.source !== "teacher" && ctx.user.role !== "student") throw new PlatformError("FORBIDDEN", "自评和互评须由学生本人填写", 403);
  if (input.source === "self" && ctx.own?.id !== input.participationId) throw new PlatformError("FORBIDDEN", "只能填写本人自评", 403);
  if (input.source === "peer") {
    const assignment = input.assignmentId && await tx.peerReviewAssignment.findFirst({ where: { id: input.assignmentId, instanceId: ctx.instance.id, reviewerParticipationId: ctx.own?.id, targetParticipationId: target.id, status: "ACTIVE", artifactVersion: { status: "SUBMITTED" } } });
    if (!assignment) throw new PlatformError("FORBIDDEN", "互评任务未分配给你或已失效", 403);
  } else if (input.assignmentId) throw new PlatformError("INVALID_INPUT", "此评价不应关联互评任务", 400);
  const pblKey = input.source === "peer" ? `peer:${input.assignmentId}` : `${input.source}:${target.id}`;
  const previousRow = await tx.evaluation.findUnique({ where: { pblKey } });
  const previous = record(previousRow); assertVersion(previous?.version ?? 0, input.version);
  if (previous?.status === "submitted") throw new PlatformError("EVALUATION_LOCKED", "评价已提交，请由教师退回后修改", 409);
  const rubric = previous?.rubric ?? ctx.config.rubric;
  validatePblAnswers(input.source, input.answers, rubric, input.action === "submit");
  const now = new Date().toISOString(), id = previousRow?.id ?? randomUUID(), suggested = pblWeightedScore(rubric, input.answers.dimensionScores);
  const result: PblEvaluationRecord = { id, participationId: target.id, source: input.source, assignmentId: input.assignmentId ?? null,
    evaluatorName: ctx.user.displayName, version: (previous?.version ?? 0) + 1, status: input.action === "submit" ? "submitted" : "draft", rubric, answers: input.answers,
    suggestedScore: suggested, score: input.source === "teacher" ? input.answers.finalScore ?? suggested : null,
    submittedAt: input.action === "submit" ? now : null, returnedReason: previous?.returnedReason ?? null, updatedAt: now, history: previous?.history ?? [] };
  const data = { evaluatorId: ctx.user.id, score: result.score, rubric: json(rubric), content: input.answers.comment, result: json(result) };
  if (previousRow) await tx.evaluation.update({ where: { id: previousRow.id }, data });
  else await tx.evaluation.create({ data: { ...data, id, pblKey, participationId: target.id, activityId: ctx.instance.activityId, studentId: target.enrollment.userId, evaluatorType: input.source.toUpperCase(), type: `PBL_${input.source.toUpperCase()}`, metadata: json({ contractVersion: 2 }) } });
}
async function publish(tx: Prisma.TransactionClient, ctx: Context, input: Extract<PblEvaluationCommand, { action: "publish" }>) {
  if (!ctx.canPublish) throw new PlatformError("EVALUATION_LOCKED", "进入项目评价阶段后可发布", 409);
  if (!input.includeTeacher && !input.includeProcess) throw new PlatformError("INVALID_INPUT", "请选择需要发布的评价或报告", 400);
  for (const id of [...new Set(input.participationIds)]) {
    const target = targetParticipant(ctx, id);
    const teacher = record(await tx.evaluation.findUnique({ where: { pblKey: `teacher:${id}` } }));
    const process = input.includeProcess ? await tx.aiSupportRecord.findFirst({ where: { participationId: id, type: "PBL_PROCESS_REPORT", status: "READY" }, orderBy: { createdAt: "desc" } }) : null;
    const priorRow = await tx.evaluation.findUnique({ where: { pblKey: `publication:${id}` } });
    const prior = pblObject(priorRow?.result);
    const selectedTeacher = publishedTeacher(input.includeTeacher && teacher?.status === "submitted" ? teacher : record({ result: prior.teacherEvaluation }));
    const selectedProcess = input.includeProcess && process ? process.structuredPayload : prior.processReport ?? null;
    if (!selectedTeacher && !selectedProcess) continue;
    const peerRows = await tx.evaluation.findMany({ where: { participationId: id, type: "PBL_PEER" }, orderBy: { createdAt: "asc" } });
    const peerEvaluations = peerRows.flatMap(row => { const r = record(row); return r?.source === "peer" && r.status === "submitted" ? [r] : []; });
    const result = json({ at: new Date().toISOString(), teacherEvaluation: selectedTeacher, processReport: selectedProcess, peerEvaluations: peerEvaluations.map(r => anonymousPeer(r, ctx.config.anonymous)) });
    const data = { result, score: selectedTeacher ? (selectedTeacher as PblEvaluationRecord).score : null };
    await tx.evaluation.upsert({ where: { pblKey: `publication:${id}` }, update: data,
      create: { ...data, pblKey: `publication:${id}`, participationId: id, activityId: ctx.instance.activityId, studentId: target.enrollment.userId, evaluatorId: ctx.user.id, evaluatorType: "TEACHER", type: "PBL_PUBLICATION", metadata: json({ contractVersion: 2 }) } });
  }
}

/** Student stage progress reflects their own assigned work; AI and teacher timing never gate completion. */
async function updateEvaluationProgress(tx: Prisma.TransactionClient, ctx: Context) {
  const [rows, assignments] = await Promise.all([
    tx.evaluation.findMany({ where: { participation: { instanceId: ctx.instance.id }, type: { in: ["PBL_SELF", "PBL_PEER"] } }, select: { result: true } }),
    tx.peerReviewAssignment.findMany({ where: { instanceId: ctx.instance.id, status: "ACTIVE" } }),
  ]);
  const values = rows.flatMap(row => { const r = record(row); return r ? [r] : []; });
  for (const p of ctx.participants) {
    const ownTasks = assignments.filter(a => a.reviewerParticipationId === p.id);
    const selfDone = values.some(r => r.source === "self" && r.participationId === p.id && r.status === "submitted");
    const peersDone = ownTasks.filter(a => values.some(r => r.source === "peer" && r.assignmentId === a.id && r.status === "submitted")).length;
    const progress = Math.round(((selfDone ? 1 : 0) + peersDone) / (1 + ownTasks.length) * 100);
    const stageProgress = pblObject(p.stageProgress), old = pblObject(stageProgress.progress);
    if (Number(old.reflection ?? 0) !== progress) await tx.classroomParticipation.update({ where: { id: p.id }, data: { stageProgress: json({ ...stageProgress, progress: { ...old, reflection: progress } }) } });
  }
}
