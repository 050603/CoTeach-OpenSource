import { z } from "zod";
import { RESOURCE_PACKAGE_STAGE_KEYS } from "@/lib/resource-package/types";
import type { PreparationModelResult, PreparationPlan } from "./types";

const text = z.string().trim().min(1);
const strings = z.array(text);
const stageSchema = z.object({
  key: z.enum(RESOURCE_PACKAGE_STAGE_KEYS), title: text, durationMin: z.number().int().positive(),
  requirements: text, outputs: text, teacherActions: text, aiActions: z.string(),
  checkpoints: strings.optional(), observationPoints: strings.optional(),
});
const stagePlanSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), source: z.literal("collaborative-preparation"),
  drivingQuestion: text, projectTask: text, totalMinutes: z.number().int().positive(),
  lessonCount: z.number().int().positive().nullable(), minutesPerLesson: z.number().int().positive().nullable(),
  stages: z.array(stageSchema).length(5), evaluationCriteria: text, reflectionQuestions: strings.min(1),
  finalDeliverables: z.array(z.object({ id: text, name: text, format: text, requirements: text, required: z.boolean() })).optional(),
  aiUsagePolicy: z.string().optional(),
  evaluationRubric: z.object({ id: text, version: z.number().int().positive(), dimensions: z.array(z.object({ id: text, name: text, weight: z.number().positive(), description: text })).min(1), sourceWeights: z.object({ teacher: z.number().nonnegative(), ai: z.number().nonnegative() }) }).optional(),
  reflectionQuestionSet: z.object({ id: text, version: z.number().int().positive(), questions: z.array(z.object({ id: text, prompt: text, required: z.boolean() })) }).optional(),
  showcasePlan: z.object({ presenterCount: z.number().int().positive().optional(), presentationSec: z.number().positive().optional(), discussionSec: z.number().nonnegative().optional(), transitionSec: z.number().nonnegative().optional() }).optional(),
}).superRefine((value, ctx) => {
  if (RESOURCE_PACKAGE_STAGE_KEYS.some((key, i) => value.stages[i]?.key !== key)) ctx.addIssue({ code: "custom", path: ["stages"], message: "请按项目启动、知识讲授、项目实践、成果展示、反思评价排列五阶段。" });
  if (value.stages.reduce((sum, stage) => sum + stage.durationMin, 0) !== value.totalMinutes) ctx.addIssue({ code: "custom", path: ["totalMinutes"], message: "五阶段分钟数之和须等于课程总时长。" });
  if (value.lessonCount && value.minutesPerLesson && value.lessonCount * value.minutesPerLesson !== value.totalMinutes) ctx.addIssue({ code: "custom", path: ["lessonCount"], message: "课次数与每次时长须和总时长一致。" });
  if (value.evaluationRubric) {
    const rubric = value.evaluationRubric;
    if (Math.abs(rubric.dimensions.reduce((sum, d) => sum + d.weight, 0) - 100) > 0.01 || Math.abs(rubric.sourceWeights.teacher + rubric.sourceWeights.ai - 100) > 0.01) ctx.addIssue({ code: "custom", path: ["evaluationRubric"], message: "评价权重之和须为 100%。" });
  }
});
const planFields = {
  courseName: text, subject: text, grade: text, totalMinutes: z.number().int().positive(), learnerContext: text,
  learningObjectives: strings.min(1),
  knowledgePoints: z.array(z.object({ id: text, name: text, depth: text, teachingApproach: text })).min(1),
  teachingApproach: text, teacherRequirements: strings,
  stagePlan: stagePlanSchema,
};
export const preparationPlanSchema = z.object(planFields).superRefine((value, ctx) => {
  if (value.stagePlan.totalMinutes !== value.totalMinutes) ctx.addIssue({ code: "custom", path: ["stagePlan"], message: "阶段计划总时长须与课程总时长一致。" });
  if (new Set(value.knowledgePoints.map((point) => point.id)).size !== value.knowledgePoints.length) ctx.addIssue({ code: "custom", path: ["knowledgePoints"], message: "知识点标识不能重复。" });
});
export const preparationDraftSchema = z.object(planFields).partial();
export const preparationQuestionSchema = z.object({ id: text, prompt: text, reason: z.string().optional(), options: z.array(z.object({ id: text, label: text, description: text })).min(2).max(4) }).superRefine((value, ctx) => {
  if (new Set(value.options.map((option) => option.id)).size !== value.options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "选项标识不能重复。" });
});
export const preparationModelResultSchema = z.object({
  message: text, question: preparationQuestionSchema.nullable(), plan: preparationDraftSchema,
  fieldOrigins: z.record(z.string(), z.enum(["teacher-stated", "ai-proposed"])).default({}),
  readyToConfirm: z.boolean().default(false), suggestions: z.array(z.string()).default([]),
});
const fieldLabels: Record<string, string> = { courseName: "课程主题", subject: "学科", grade: "学段或年级", totalMinutes: "课程总分钟数", learnerContext: "学情", learningObjectives: "学习目标", knowledgePoints: "知识范围与深度", teachingApproach: "教学方式", teacherRequirements: "教师要求", stagePlan: "五阶段任务、时间与评价安排" };
export function preparationMissingFields(plan: Partial<PreparationPlan>): string[] {
  const result = preparationPlanSchema.safeParse(plan);
  return result.success ? [] : [...new Set(result.error.issues.map((issue) => issue.code === "custom" ? issue.message : fieldLabels[String(issue.path[0])] ?? "课程方案") )];
}
/** A model's readiness flag can never replace the executable plan contract. */
export function normalizePreparationResult(input: unknown): PreparationModelResult {
  const parsed = preparationModelResultSchema.parse(input) as PreparationModelResult;
  const readyToConfirm = parsed.readyToConfirm && preparationMissingFields(parsed.plan).length === 0;
  if (!readyToConfirm && !parsed.question) throw new Error("备课回答缺少下一步问题，请重试本轮。");
  return { ...parsed, fieldOrigins: Object.fromEntries(Object.keys(parsed.plan).map((field) => [field, parsed.fieldOrigins[field] ?? "ai-proposed"])), readyToConfirm };
}
const selectionSchema = z.object({ revisionId: z.string().uuid(), primary: z.boolean(), sectionIds: z.array(z.string().uuid()).max(200) });
export const preparationMutationSchema = z.object({
  action: z.enum(["revise", "continue", "confirm", "retry"]).optional(), revision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100),
  message: z.string().trim().max(12000).optional(), selectedOptionId: z.string().min(1).max(200).optional(),
  referenceIds: z.array(z.string().uuid()).max(3).optional(), textbookSelections: z.array(selectionSchema).max(5).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.textbookSelections?.length && (value.textbookSelections.filter((s) => s.primary).length !== 1 || new Set(value.textbookSelections.map((s) => s.revisionId)).size !== value.textbookSelections.length)) ctx.addIssue({ code: "custom", path: ["textbookSelections"], message: "请选择且只选择一本主教材，教材版本不能重复。" });
  if ((!value.action || value.action === "revise") && !value.message && !value.selectedOptionId) ctx.addIssue({ code: "custom", path: ["message"], message: "请描述需求或选择一个方案。" });
});
