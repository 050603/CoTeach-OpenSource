import type { AiInteractionEvent, CompanionThread } from "@/lib/session/types";
import { companionPracticeEvents, mergePracticeAiInteractionEvents } from "@/lib/ai-collaboration/interaction-transcript";
import type {
  ShowcaseEvidenceBlock, ShowcaseQualityAnalysis, ShowcaseQualityDimension,
  ShowcaseRecommendationCandidate, ShowcaseRecommendationReason,
} from "./recommendation-types";

export const SHOWCASE_ANALYSIS_VERSION = 2;
export const DEFAULT_SHOWCASE_DIMENSIONS: ShowcaseQualityDimension[] = [
  { id: "completion", name: "任务完成度", description: "实际作品对项目要求和必交成果的完成情况", weight: 35 },
  { id: "accuracy", name: "内容准确性", description: "事实、概念和必要条件的准确性", weight: 30 },
  { id: "reasoning", name: "证据与推理", description: "结论是否由可检查的证据和推理支持", weight: 25 },
  { id: "clarity", name: "表达清晰度", description: "作品结构、图表及文字是否清楚可理解", weight: 10 },
];

/** Oral performance cannot be inferred from an artifact submitted before reporting. */
export function showcaseArtifactDimensions(dimensions?: ShowcaseQualityDimension[]): ShowcaseQualityDimension[] {
  const applicable = (dimensions ?? []).filter(item => item.id && Number.isFinite(item.weight) && item.weight > 0
    && !/现场|答辩|口头|口语|仪态|汇报表现|演讲|团队协作|协作过程|oral|presentation\s+(?:delivery|performance)|teamwork/i.test(`${item.name} ${item.description}`));
  const total = applicable.reduce((sum, item) => sum + item.weight, 0);
  return total > 0 ? applicable.map(item => ({ ...item, weight: item.weight / total * 100 }))
    : DEFAULT_SHOWCASE_DIMENSIONS.map(item => ({ ...item }));
}

export function showcaseRecommendationTarget(teacher: unknown, plan: unknown) {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 500;
  if (valid(teacher)) return { targetCount: teacher, targetSource: "teacher" as const };
  if (valid(plan)) return { targetCount: plan, targetSource: "plan" as const };
  return { targetCount: 3, targetSource: "default" as const };
}

/** Same request identity in the audit stream and old companion history counts once. */
export function showcaseAiRequestCounts(events: AiInteractionEvent[], threads: CompanionThread[] = []): Map<string, number> {
  const requests = new Map<string, Set<string>>();
  const add = (studentId: string, key: string) => { const set = requests.get(studentId) ?? new Set<string>(); set.add(key); requests.set(studentId, set); };
  for (const event of mergePracticeAiInteractionEvents(events, companionPracticeEvents(threads))) {
    if (event.stageKey !== "make" || event.actorRole !== "student" || event.eventType !== "request" || event.source === "system") continue;
    add(event.studentId, event.requestId ?? `event:${event.id}`);
  }
  return new Map([...requests].map(([id, keys]) => [id, keys.size]));
}

export function rankShowcaseCandidates(candidates: ShowcaseRecommendationCandidate[], selected: string[] = [],
  population: Array<{ firstSubmittedAt?: string; aiRequestCount: number }> = candidates): ShowcaseRecommendationCandidate[] {
  const pool = candidates.map(candidate => ({ ...candidate, reasons: candidate.reasons.filter(reason => reason.kind === "quality") }));
  const submitted = population.filter(item => item.firstSubmittedAt).sort((a, b) => Date.parse(a.firstSubmittedAt!) - Date.parse(b.firstSubmittedAt!));
  const earliest = submitted[0]?.firstSubmittedAt;
  const latest = submitted.at(-1)?.firstSubmittedAt;
  const maximum = Math.max(0, ...population.map(item => item.aiRequestCount));
  for (const item of pool) {
    if (earliest && item.firstSubmittedAt === earliest) item.reasons.push({ kind: "earliest", text: "首次提交时间最早" });
    if (latest && item.firstSubmittedAt === latest && latest !== earliest) item.reasons.push({ kind: "latest", text: "首次提交时间较晚" });
    if (maximum > 0 && item.aiRequestCount === maximum) item.reasons.push({ kind: "ai-interactions", text: `AI 协作请求 ${item.aiRequestCount} 次` });
  }
  const covered = new Set(pool.filter(item => selected.includes(item.studentId)).flatMap(item => item.reasons.map(reason => reason.kind)));
  const rank: ShowcaseRecommendationCandidate[] = [];
  const bucket = (item: ShowcaseRecommendationCandidate) => item.analysisStatus === "complete" && item.qualityScore !== undefined ? Math.floor(item.qualityScore / 5) : -1;
  const feature = (item: ShowcaseRecommendationCandidate) => ["earliest", "latest", "ai-interactions"].findIndex(kind => !covered.has(kind as ShowcaseRecommendationReason["kind"]) && item.reasons.some(reason => reason.kind === kind));
  while (pool.length) {
    pool.sort((a, b) => bucket(b) - bucket(a) || (feature(a) < 0 ? 3 : feature(a)) - (feature(b) < 0 ? 3 : feature(b)) || (b.qualityScore ?? -1) - (a.qualityScore ?? -1) || a.studentId.localeCompare(b.studentId));
    const next = pool.shift()!;
    rank.push(next);
    next.reasons.forEach(reason => covered.add(reason.kind));
  }
  return rank;
}

/** Reject fabricated evidence even when the model returns valid JSON. */
export function validateShowcaseQualityAnalysis(value: unknown, dimensions: ShowcaseQualityDimension[], blocks: ShowcaseEvidenceBlock[]): ShowcaseQualityAnalysis {
  if (!value || typeof value !== "object") throw new Error("QUALITY_INVALID_RESPONSE");
  const raw = value as Record<string, unknown>;
  const scores = raw.dimensionScores as Record<string, unknown> | undefined;
  if (!scores || dimensions.some(item => typeof scores[item.id] !== "number" || !Number.isFinite(scores[item.id]) || Number(scores[item.id]) < 0 || Number(scores[item.id]) > 100)) throw new Error("QUALITY_INVALID_SCORES");
  const reasons = (Array.isArray(raw.reasons) ? raw.reasons : []).flatMap((value): ShowcaseRecommendationReason[] => {
    if (!value || typeof value !== "object") return [];
    const reason = value as Record<string, unknown>;
    if (typeof reason.text !== "string" || !reason.text.trim() || typeof reason.location !== "string" || typeof reason.quote !== "string" || reason.quote.trim().length < 4) return [];
    const block = blocks.find(block => block.location === reason.location);
    if (!block || !block.text.includes(reason.quote)) return [];
    return [{ kind: "quality", text: reason.text.trim().slice(0, 160), location: reason.location, quote: reason.quote.slice(0, 300) }];
  }).slice(0, 3);
  if (!reasons.length) throw new Error("QUALITY_EVIDENCE_REQUIRED");
  const dimensionScores = Object.fromEntries(dimensions.map(item => [item.id, Number(scores[item.id])]));
  return { qualityScore: Math.round(dimensions.reduce((sum, item) => sum + dimensionScores[item.id] * item.weight, 0)) / 100, dimensionScores, reasons };
}
