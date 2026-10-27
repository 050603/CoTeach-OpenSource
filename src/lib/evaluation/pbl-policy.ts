import { z } from "zod";
import { DEFAULT_PBL_RUBRIC, pblWeightedScore, type PblEvaluationAnswers, type PblEvaluationConfig, type PblEvaluationRecord, type PblProcessReport, type PblRubricDimension } from "./pbl-contract";
import { PlatformError } from "@/lib/platform/repository";
import { decodePblTemplate } from "@/lib/platform/pbl-template";
export const pblObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = z.string().trim().min(1).max(200);
const text = z.string().max(10000);
const score = z.number().min(0).max(100).nullable();
export const rubricSchema = z.array(z.object({ id, name: z.string().trim().min(1).max(200), description: z.string().max(2000), weight: z.number().min(0).max(100) }).strict()).min(1).max(20).refine(v => new Set(v.map(d => d.id)).size === v.length && Math.abs(v.reduce((s,d) => s + d.weight, 0) - 100) < 0.0001, "量规维度不能重复，权重之和须为100");
const configSchema = z.object({ rubric: rubricSchema, peerMode: z.enum(["off", "balanced", "presenters-only", "manual"]), reviewsPerStudent: z.number().int().min(1).max(20), anonymous: z.boolean() }).strict();
const answersSchema = z.object({ dimensionScores: z.record(id, score), comment: text, evidence: text, strengths: text, improvements: text, learning: text, plan: text, finalScore: score, overrideReason: text }).strict();
const version = z.number().int().min(0);
export const pblCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("config"), version, config: configSchema }),
  z.object({ action: z.literal("assign"), pairs: z.array(z.object({ reviewerParticipationId: id, targetParticipationId: id }).strict()).max(10000).optional() }),
  ...(["save", "submit"] as const).map(action => z.object({ action: z.literal(action), source: z.enum(["self", "peer", "teacher"]), participationId: id, assignmentId: id.optional(), version, answers: answersSchema })),
  z.object({ action: z.literal("return"), evaluationId: id, version, reason: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("publish"), participationIds: z.array(id).min(1).max(1000), includeTeacher: z.boolean(), includeProcess: z.boolean() }),
]).and(z.object({ idempotencyKey: z.string().uuid() }));
export function pblConfig(runtime: unknown, snapshot: unknown): PblEvaluationConfig {
  const saved = pblObject(pblObject(runtime).pblEvaluationConfig);
  const parsed = configSchema.safeParse(saved);
  // Strip the version before schema validation, rather than silently discarding a saved rubric.
  const { version: savedVersion, ...config } = saved;
  const known = parsed.success ? parsed : configSchema.safeParse(config);
  if (known.success) return { ...known.data, version: typeof savedVersion === "number" ? savedVersion : 0 };
  const design = decodePblTemplate(snapshot);
  const dimensions = design?.content?.stagePlan?.evaluationRubric?.dimensions ?? design?.content?.evaluationPlan?.dimensions;
  const rubric = rubricSchema.safeParse(dimensions?.map(d => ({ id: d.id, name: d.name, description: d.description ?? "", weight: d.weight })));
  return { version: 0, rubric: rubric.success ? rubric.data : structuredClone(DEFAULT_PBL_RUBRIC), peerMode: "off", reviewsPerStudent: 2, anonymous: true };
}
export function validatePblAnswers(source: PblEvaluationRecord["source"], answers: PblEvaluationAnswers, rubric: PblRubricDimension[], submit: boolean) {
  const ids = rubric.map(d => d.id);
  if (ids.some(id => !(id in answers.dimensionScores)) || Object.keys(answers.dimensionScores).some(id => !ids.includes(id))) throw new PlatformError("INVALID_INPUT", "请按当前量规填写每个维度；无法观察时选择无法判断", 400);
  if (source !== "teacher" && (answers.finalScore !== null || answers.overrideReason)) throw new PlatformError("FORBIDDEN", "只有教师可确定最终成绩", 403);
  const weighted = pblWeightedScore(rubric, answers.dimensionScores);
  if (answers.finalScore !== null && answers.finalScore !== weighted && !answers.overrideReason.trim()) throw new PlatformError("INVALID_INPUT", "调整最终成绩时请填写理由", 400);
  const required = source === "self" ? [answers.evidence, answers.learning, answers.plan] : source === "peer" ? [answers.strengths, answers.improvements] : [answers.comment];
  if (submit && required.some(v => !v.trim())) throw new PlatformError("INVALID_INPUT", source === "self" ? "请填写作品依据、主要收获和改进计划" : source === "peer" ? "请填写具体优点和改进建议" : "请填写教师评语", 400);
}
/** Deterministic circular assignment includes reviewers without submitted work. */
export function pblAssignmentPairs(reviewers: string[], targets: string[], count: number) {
  const sorted = [...new Set(reviewers)].sort();
  const candidates = [...new Set(targets)].sort();
  return sorted.flatMap((reviewerParticipationId, index) => {
    const own = candidates.indexOf(reviewerParticipationId);
    const start = own >= 0 ? own + 1 : index;
    const ring = candidates.map((_, n) => candidates[(start + n) % candidates.length]).filter(target => target !== reviewerParticipationId);
    return ring.slice(0, count).map(targetParticipationId => ({ reviewerParticipationId, targetParticipationId }));
  });
}
export function pblReportView(raw: unknown): PblProcessReport | null {
  const container = pblObject(raw), report = pblObject(container.report ?? raw);
  if (typeof report.id !== "string" || !Array.isArray(report.dimensions)) return null;
  const evidence = Array.isArray(report.evidence) ? report.evidence.map(pblObject) : [];
  return { id: report.id,
    evidenceThrough: typeof report.evidenceThrough === "string" ? report.evidenceThrough : null,
    evidenceGaps: Array.isArray(report.evidenceGaps) ? report.evidenceGaps.map(String) : [],
    ...(report.confidence === "low" || report.confidence === "medium" || report.confidence === "high" ? { confidence: report.confidence } : {}),
    ...(report.source === "llm" || report.source === "insufficient-evidence" ? { source: report.source } : {}),
    generatedAt: String(report.generatedAt ?? ""), summary: String(report.summary ?? ""), dimensions: report.dimensions.map(value => {
    const d = pblObject(value), refs = Array.isArray(d.evidenceIds) ? d.evidenceIds : [];
    return { id: String(d.dimensionId ?? d.id ?? ""), name: String(d.name ?? ""), judgment: String(d.rationale ?? d.judgment ?? ""), score: typeof d.score === "number" ? d.score : null,
      evidence: refs.flatMap(id => { const e = evidence.find(item => item.id === id); return e ? [{ id: String(id), label: String(e.title ?? e.label ?? e.kind ?? e.type ?? id), detail: String(e.content ?? e.text ?? e.detail ?? e.summary ?? "") }] : []; }),
      gaps: Array.isArray(d.evidenceGaps) ? d.evidenceGaps.map(String) : [], suggestion: Array.isArray(d.improvements) ? d.improvements.join("\n") : String(d.suggestion ?? "") };
  }) };
}
