import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { requireStudentUser, type PlatformDb } from "./access";
import { gradeExperimentAnswers, normalizeExperimentDraftAnswers, publicExperimentQuestions, type ExperimentAnswer } from "./experiment";
import { PostTestConfigSchema, type PostTestConfig } from "./posttest";
import { isActivityOpen, PlatformError } from "./repository";

type Answers = Record<string, ExperimentAnswer>;
type Draft = { answers: Answers; currentPage: number; version: number; updatedAt: string; questionVersion: string };
type SubmissionRow = { id: string; activitySnapshot: unknown; payload: unknown; submittedAt: Date };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function questionVersion(config: PostTestConfig) {
  return createHash("sha256").update(JSON.stringify(publicExperimentQuestions(config.questions))).digest("hex");
}

function configuration(value: unknown): PostTestConfig {
  const parsed = PostTestConfigSchema.safeParse(value);
  if (!parsed.success) throw new PlatformError("INVALID_ACTIVITY_CONFIG", "后测题目配置有误，请联系教师", 409);
  return parsed.data;
}

function draftView(progressData: unknown, config: PostTestConfig): Draft | null {
  const draft = object(object(progressData).posttestDraft);
  if (draft.questionVersion !== questionVersion(config)
    || !Number.isSafeInteger(draft.version) || Number(draft.version) < 1
    || !Number.isInteger(draft.currentPage) || Number(draft.currentPage) < 0 || Number(draft.currentPage) > 100
    || typeof draft.updatedAt !== "string" || !Number.isFinite(Date.parse(draft.updatedAt))) return null;
  const answers = normalizeExperimentDraftAnswers(config.questions, draft.answers);
  return answers ? { answers, currentPage: Number(draft.currentPage), version: Number(draft.version), updatedAt: draft.updatedAt, questionVersion: draft.questionVersion as string } : null;
}

function submissionView(row: SubmissionRow) {
  const config = configuration(object(row.activitySnapshot).config);
  const graded = gradeExperimentAnswers(config.questions, object(row.payload).answers);
  if (!graded) throw new PlatformError("INVALID_ASSESSMENT_SUBMISSION", "已提交的后测记录有误，请联系教师", 409);
  return { config, submission: { id: row.id, answers: graded.answers, submittedAt: row.submittedAt } };
}

async function studentAccess(claims: AuthClaims, activityId: string, db: PlatformDb) {
  if (claims.role !== "student") throw new PlatformError("FORBIDDEN", "仅学生可以作答后测", 403);
  const student = await requireStudentUser(claims, db);
  const activity = await db.activity.findUnique({ where: { id: activityId }, include: { chapter: { include: { offering: true } } } });
  if (!activity || activity.archivedAt || activity.chapter.archivedAt) throw new PlatformError("NOT_FOUND", "后测不存在", 404);
  if (activity.type.toUpperCase() !== "POSTTEST") throw new PlatformError("INVALID_ACTIVITY", "当前学习内容不是后测", 400);
  const offering = activity.chapter.offering;
  if (!["open", "finished", "archived"].includes(offering.status.toLowerCase())) throw new PlatformError("COURSE_NOT_OPEN", "课程尚未开放学习", 403);
  const enrollment = await db.enrollment.findUnique({ where: { userId_offeringId: { userId: student.id, offeringId: activity.chapter.offeringId } } });
  if (!enrollment || !["active", "completed"].includes(enrollment.status.toLowerCase())) throw new PlatformError("ENROLLMENT_REQUIRED", "请先加入教学班", 403);
  const open = isActivityOpen(activity.chapter, activity);
  const canWrite = open && offering.status.toLowerCase() === "open" && enrollment.status.toLowerCase() === "active";
  return { activity, enrollment, open, canWrite };
}

function assertWritable(access: Awaited<ReturnType<typeof studentAccess>>) {
  if (!access.canWrite) throw new PlatformError("ASSESSMENT_UNAVAILABLE", "当前后测未开放作答", 403);
}

function assertQuestionVersion(config: PostTestConfig, supplied: string) {
  if (supplied !== questionVersion(config)) throw new PlatformError("QUESTION_VERSION_CONFLICT", "后测题目已更新，请重新加载后作答", 409);
}

function sameAnswers(left: Answers, right: Answers): boolean {
  const ids = Object.keys(left);
  return ids.length === Object.keys(right).length && ids.every((id) => {
    const a = left[id];
    const b = right[id];
    return Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((item) => b.includes(item)) : a === b;
  });
}

export async function getStudentPostTestAssessment(claims: AuthClaims, activityId: string) {
  const access = await studentAccess(claims, activityId, prisma);
  const config = configuration(access.activity.config);
  const key = { enrollmentId: access.enrollment.id, activityId };
  const [progress, row] = access.open ? await Promise.all([
    prisma.activityProgress.findUnique({ where: { enrollmentId_activityId: key } }),
    prisma.activitySubmission.findFirst({ where: key, orderBy: [{ submittedAt: "asc" }, { id: "asc" }] }),
  ]) : [null, null];
  const submitted = row ? submissionView(row) : null;
  const visibleConfig = submitted?.config ?? config;
  return {
    enabled: true,
    available: access.canWrite && !submitted,
    questions: access.open && (access.canWrite || submitted) ? publicExperimentQuestions(visibleConfig.questions) : [],
    introduction: access.open ? visibleConfig.content : undefined,
    minutes: access.open ? visibleConfig.minutes : undefined,
    skipReasonPrompt: access.open ? visibleConfig.skipReasonPrompt : undefined,
    variant: "none" as const,
    questionVersion: questionVersion(visibleConfig),
    studentKey: access.enrollment.id,
    blockedReason: !access.open ? "教师开放此后测后即可作答。" : !access.canWrite ? "课程或学习记录已结束，当前仅可查看已提交的后测。" : null,
    draft: access.canWrite && !submitted ? draftView(progress?.progressData, config) : null,
    submission: submitted?.submission ?? null,
  };
}

export async function savePostTestDraft(claims: AuthClaims, activityId: string, input: { answers: unknown; currentPage: number; version: number; questionVersion: string }) {
  if (!Number.isInteger(input.currentPage) || input.currentPage < 0 || input.currentPage > 100
    || !Number.isSafeInteger(input.version) || input.version < 0 || input.version >= Number.MAX_SAFE_INTEGER) throw new PlatformError("INVALID_INPUT", "草稿页码或版本无效", 400);
  return runMutationTransaction(async (tx) => {
    // Teacher edits and submissions take this same row lock before reading config.
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE`;
    const access = await studentAccess(claims, activityId, tx);
    assertWritable(access);
    const config = configuration(access.activity.config);
    assertQuestionVersion(config, input.questionVersion);
    const key = { enrollmentId: access.enrollment.id, activityId };
    const submission = await tx.activitySubmission.findFirst({ where: key, select: { id: true } });
    if (submission) throw new PlatformError("ASSESSMENT_SUBMITTED", "后测已提交，不能修改草稿", 409);
    const answers = normalizeExperimentDraftAnswers(config.questions, input.answers);
    if (!answers) throw new PlatformError("INVALID_ANSWERS", "草稿包含无效题目或选项", 400);
    const progress = await tx.activityProgress.findUnique({ where: { enrollmentId_activityId: key } });
    const previous = draftView(progress?.progressData, config);
    if ((previous?.version ?? 0) !== input.version) throw new PlatformError("DRAFT_VERSION_CONFLICT", "草稿已在其他页面更新，请选择要保留的版本", 409);
    const now = new Date();
    const draft: Draft = { answers, currentPage: input.currentPage, version: input.version + 1, updatedAt: now.toISOString(), questionVersion: input.questionVersion };
    const progressData = { ...object(progress?.progressData), posttestDraft: draft } as Prisma.InputJsonValue;
    await tx.activityProgress.upsert({
      where: { enrollmentId_activityId: key },
      create: { ...key, status: "IN_PROGRESS", startedAt: now, lastAccessedAt: now, progressData },
      update: { status: "IN_PROGRESS", lastAccessedAt: now, progressData },
    });
    return { draft };
  });
}

export async function submitPostTestAssessment(claims: AuthClaims, activityId: string, input: { answers: unknown; questionVersion: string }) {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE`;
    const access = await studentAccess(claims, activityId, tx);
    assertWritable(access);
    const key = { enrollmentId: access.enrollment.id, activityId };
    const existing = await tx.activitySubmission.findFirst({ where: key, orderBy: [{ submittedAt: "asc" }, { id: "asc" }] });
    if (existing) {
      const original = submissionView(existing);
      assertQuestionVersion(original.config, input.questionVersion);
      const repeated = gradeExperimentAnswers(original.config.questions, input.answers);
      if (repeated && sameAnswers(repeated.answers, original.submission.answers)) return original.submission;
      throw new PlatformError("ASSESSMENT_SUBMITTED", "后测已提交，不能重复作答", 409);
    }
    const config = configuration(access.activity.config);
    assertQuestionVersion(config, input.questionVersion);
    const graded = gradeExperimentAnswers(config.questions, input.answers);
    if (!graded) throw new PlatformError("INVALID_ANSWERS", "请完成所有必答题并检查选项后提交", 400);
    const progress = await tx.activityProgress.findUnique({ where: { enrollmentId_activityId: key } });
    const now = new Date();
    const id = randomUUID();
    const payload = { ...graded, submittedAt: now.toISOString(), questionVersion: input.questionVersion };
    const row = await tx.activitySubmission.create({ data: {
      id,
      ...key,
      researchKey: access.enrollment.researchKey,
      activityVersion: access.activity.version,
      activitySnapshot: { type: access.activity.type, title: access.activity.title, config, version: access.activity.version } as Prisma.InputJsonValue,
      payload: payload as Prisma.InputJsonValue,
      submittedAt: now,
    } });
    const { posttestDraft: _draft, ...previous } = object(progress?.progressData);
    void _draft;
    const progressData = { ...previous, ...payload, submissionId: row.id } as Prisma.InputJsonValue;
    await tx.activityProgress.upsert({
      where: { enrollmentId_activityId: key },
      create: { ...key, status: "COMPLETED", startedAt: now, completedAt: now, lastAccessedAt: now, progressData },
      update: { status: "COMPLETED", completedAt: now, lastAccessedAt: now, progressData },
    });
    return { id: row.id, answers: graded.answers, submittedAt: row.submittedAt };
  });
}
