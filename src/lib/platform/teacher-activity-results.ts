import { z } from "zod";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { gradeExperimentAnswers, type ExperimentQuestion, type ExperimentQuestionGroup } from "./experiment";
import { PostTestConfigSchema } from "./posttest";
import { activityForTeacher, isActivityOpen, PlatformError } from "./repository";

export type ResultQuestion = {
  id: string;
  prompt: string;
  type: string;
  group?: ExperimentQuestionGroup;
  correctAnswer?: string | string[];
  options?: string[];
  scale?: ExperimentQuestion["scale"];
  optional?: boolean;
};

type ResultSubmission = {
  id: string;
  submittedAt: string;
  activityVersion: number;
  questions: ResultQuestion[];
  answers: Record<string, string | string[]>;
  answer?: string;
  objectiveScore: number | null;
  objectiveTotal: number | null;
  snapshotSource: "submission" | "legacy";
};

export type ActivityResults = {
  activity: {
    id: string;
    title: string;
    type: "PostTest" | "Quiz";
    description: string | null;
    isOpen: boolean;
    questionCount: number;
    chapter: { id: string; title: string };
    offering: { id: string; name: string };
  };
  summary: { totalStudents: number; notStartedCount: number; inProgressCount: number; submittedCount: number };
  students: Array<{
    student: { id: string; displayName: string; username: string };
    status: "not-started" | "in-progress" | "submitted";
    submission: ResultSubmission | null;
  }>;
};

const MEMBERS = ["ACTIVE", "active", "COMPLETED", "completed"];
const answersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const payloadSchema = z.object({ answers: answersSchema.optional(), answer: z.string().optional() }).passthrough();
const quizConfigSchema = z.object({
  questions: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    required: z.boolean().optional(),
    correctAnswer: z.union([z.string(), z.array(z.string())]).optional(),
  }).passthrough()).default([]),
}).passthrough().superRefine((config, context) => {
  if (new Set(config.questions.map((question) => question.id)).size !== config.questions.length) {
    context.addIssue({ code: "custom", message: "测验题目编号重复", path: ["questions"] });
  }
});

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidSubmission(id: string, reason: string): never {
  throw new PlatformError("INVALID_ACTIVITY_SUBMISSION", "正式答卷记录有误，请联系管理员核对", 409, { submissionId: id, reason });
}

function questionsFor(type: "PostTest" | "Quiz", config: unknown, submissionId?: string): ResultQuestion[] {
  if (type === "PostTest") {
    const parsed = PostTestConfigSchema.safeParse(config);
    if (parsed.success) return parsed.data.questions;
  } else {
    // A quiz without authored questions accepts one top-level free-text answer.
    const parsed = quizConfigSchema.safeParse(config ?? {});
    if (parsed.success) return parsed.data.questions.map((question) => ({
      id: question.id,
      prompt: question.title,
      type: "short-answer",
      ...(question.required === false ? { optional: true } : {}),
      ...(question.correctAnswer === undefined ? {} : { correctAnswer: question.correctAnswer }),
    }));
  }
  if (submissionId) invalidSubmission(submissionId, "题目快照配置无效");
  throw new PlatformError("INVALID_ACTIVITY_CONFIG", "学习内容的题目配置有误，请先检查配置", 409);
}

function parsePayload(input: unknown, id: string) {
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success || parsed.data.answers === undefined && parsed.data.answer === undefined) invalidSubmission(id, "答卷需包含真实的文字或文字数组，不能将其他值转换为答案");
  return parsed.data;
}

function formalSubmission(type: "PostTest" | "Quiz", row: { id: string; activityVersion: number; activitySnapshot: unknown; payload: unknown; submittedAt: Date }): ResultSubmission {
  const snapshot = object(row.activitySnapshot);
  if (!snapshot || typeof snapshot.type !== "string" || snapshot.type.toUpperCase() !== type.toUpperCase() || !("config" in snapshot)) invalidSubmission(row.id, "缺少原始题目快照或快照内容类型不匹配");
  if (!Number.isInteger(row.activityVersion) || row.activityVersion < 1 || snapshot.version !== row.activityVersion) invalidSubmission(row.id, "提交版本与题目快照版本不一致");
  const questions = questionsFor(type, snapshot.config, row.id);
  const payload = parsePayload(row.payload, row.id);
  const answers = payload.answers ?? {};
  let objectiveScore: number | null = null;
  let objectiveTotal: number | null = null;
  if (type === "PostTest") {
    if (!payload.answers || !gradeExperimentAnswers(questions as ExperimentQuestion[], answers)) invalidSubmission(row.id, "已保存答案不符合原始后测题目");
    const score = payload.objectiveScore;
    const total = payload.objectiveTotal;
    if (typeof score !== "number" || typeof total !== "number" || !Number.isInteger(score) || !Number.isInteger(total) || score < 0 || total < score) invalidSubmission(row.id, "后测客观评分记录无效");
    objectiveScore = score;
    objectiveTotal = total;
  }
  return {
    id: row.id,
    submittedAt: row.submittedAt.toISOString(),
    activityVersion: row.activityVersion,
    questions,
    answers,
    ...(payload.answer === undefined ? {} : { answer: payload.answer }),
    objectiveScore,
    objectiveTotal,
    snapshotSource: "submission",
  };
}

function legacyQuizSubmission(enrollmentId: string, activity: { id: string; version: number }, questions: ResultQuestion[], progress: { status: string; completedAt: Date | null; progressData: unknown } | undefined): ResultSubmission | null {
  if (!progress?.completedAt || !["completed", "submitted"].includes(progress.status.toLowerCase())) return null;
  const raw = object(progress.progressData);
  if (!raw || !("answer" in raw || "answers" in raw)) return null;
  const id = `legacy:${enrollmentId}:${activity.id}`;
  const payload = parsePayload(raw, id);
  const answers = payload.answers ?? {};
  const hasAnswer = Boolean(payload.answer?.trim()) || Object.values(answers).some((answer) => Array.isArray(answer) ? answer.some((item) => item.trim()) : Boolean(answer.trim()));
  if (!hasAnswer) return null;
  return {
    id,
    submittedAt: progress.completedAt.toISOString(),
    activityVersion: activity.version,
    questions,
    answers,
    ...(payload.answer === undefined ? {} : { answer: payload.answer }),
    objectiveScore: null,
    objectiveTotal: null,
    snapshotSource: "legacy",
  };
}

export async function getTeacherActivityResults(claims: AuthClaims, activityId: string): Promise<ActivityResults> {
  const activity = await activityForTeacher(claims, activityId);
  const storedType = activity.type.toUpperCase();
  if (storedType !== "POSTTEST" && storedType !== "QUIZ") throw new PlatformError("INVALID_ACTIVITY", "此内容类型不提供测评结果", 400);
  const type = storedType === "POSTTEST" ? "PostTest" : "Quiz";
  const currentQuestions = questionsFor(type, activity.config);
  const roster = await prisma.enrollment.findMany({
    where: { offeringId: activity.chapter.offeringId, status: { in: MEMBERS } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      user: { select: { id: true, displayName: true, username: true } },
      submissions: {
        where: { activityId },
        orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { id: true, activityVersion: true, activitySnapshot: true, payload: true, submittedAt: true },
      },
      activityProgress: {
        where: { activityId },
        take: 1,
        select: { status: true, startedAt: true, completedAt: true, lastAccessedAt: true, progressData: true },
      },
    },
  });
  const students: ActivityResults["students"] = roster.map((enrollment) => {
    const progress = enrollment.activityProgress[0];
    const latest = enrollment.submissions[0];
    const submission = latest ? formalSubmission(type, latest)
      : type === "Quiz" ? legacyQuizSubmission(enrollment.id, activity, currentQuestions, progress) : null;
    const engaged = progress && (progress.status.toLowerCase() !== "not_started" || progress.startedAt || progress.lastAccessedAt || object(progress.progressData)?.posttestDraft);
    return { student: enrollment.user, status: submission ? "submitted" : engaged ? "in-progress" : "not-started", submission };
  });
  return {
    activity: {
      id: activity.id,
      title: activity.title,
      type,
      description: activity.description,
      isOpen: activity.chapter.offering.status.toLowerCase() === "open" && isActivityOpen(activity.chapter, activity),
      questionCount: currentQuestions.length,
      chapter: { id: activity.chapter.id, title: activity.chapter.title },
      offering: { id: activity.chapter.offering.id, name: activity.chapter.offering.name },
    },
    summary: {
      totalStudents: students.length,
      notStartedCount: students.filter((student) => student.status === "not-started").length,
      inProgressCount: students.filter((student) => student.status === "in-progress").length,
      submittedCount: students.filter((student) => student.status === "submitted").length,
    },
    students,
  };
}
