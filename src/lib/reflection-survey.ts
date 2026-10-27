import type {
  ReflectionRecord,
  ReflectionSurveyResponseV1,
  ReflectionSurveyScore,
} from "@/lib/session/types";

export const REFLECTION_SURVEY_SCHEMA_VERSION = 1 as const;

export const REFLECTION_SURVEY_QUESTIONS = {
  learningReflection:
    "回顾这门课或项目：你最重要的收获是什么？遇到的主要困难是什么，你是怎样应对的？",
  systemReflection:
    "回顾与 AI 组员及系统的协作：什么最有帮助？如果下一轮只能改进一处，你希望调整什么？",
  aiHelpfulness: "AI 组员的引导帮助我推进了课程或项目任务。",
  systemUsability: "系统的阶段与操作容易理解。",
  reuseIntention: "我愿意在类似课程中继续使用这个系统。",
} as const;

export const REFLECTION_SURVEY_FALLBACK_SUGGESTIONS = [
  "你最重要的收获和最难的一步分别是什么？它们之间有什么联系？",
  "AI 协作中什么真正帮助了你？下一轮课程最值得调整什么？",
] as const;

export const REFLECTION_SURVEY_SCALE = [
  { value: 1 as const, label: "非常不同意" },
  { value: 2 as const, label: "不同意" },
  { value: 3 as const, label: "不确定" },
  { value: 4 as const, label: "同意" },
  { value: 5 as const, label: "非常同意" },
] as const;

export const REFLECTION_SURVEY_TEXT_MAX_LENGTH = 300;

export type ReflectionSurveyDraft = {
  learningReflection: string;
  systemReflection: string;
  aiHelpfulness?: ReflectionSurveyScore;
  systemUsability?: ReflectionSurveyScore;
  reuseIntention?: ReflectionSurveyScore;
};

export function isReflectionSurveyScore(value: unknown): value is ReflectionSurveyScore {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/**
 * Parse the flexible JSON payload stored in ReflectionRecord.content.
 * Invalid or partial values are ignored so malformed historical records do
 * not make the student or teacher pages fail to render.
 */
export function normalizeReflectionSurvey(
  value: unknown,
): ReflectionSurveyResponseV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== REFLECTION_SURVEY_SCHEMA_VERSION) return undefined;
  const learningReflection = candidate.learningReflection;
  const systemReflection = candidate.systemReflection;
  if (
    typeof learningReflection !== "string"
    || typeof systemReflection !== "string"
    || !isReflectionSurveyScore(candidate.aiHelpfulness)
    || !isReflectionSurveyScore(candidate.systemUsability)
    || !isReflectionSurveyScore(candidate.reuseIntention)
  ) {
    return undefined;
  }
  const normalizedLearningReflection = learningReflection.trim().slice(0, REFLECTION_SURVEY_TEXT_MAX_LENGTH);
  const normalizedSystemReflection = systemReflection.trim().slice(0, REFLECTION_SURVEY_TEXT_MAX_LENGTH);
  if (!normalizedLearningReflection || !normalizedSystemReflection) return undefined;
  return {
    schemaVersion: REFLECTION_SURVEY_SCHEMA_VERSION,
    learningReflection: normalizedLearningReflection,
    systemReflection: normalizedSystemReflection,
    aiHelpfulness: candidate.aiHelpfulness,
    systemUsability: candidate.systemUsability,
    reuseIntention: candidate.reuseIntention,
  };
}

export function normalizeReflectionContent(value: unknown): {
  content: string;
  improvementPlan?: string;
  survey?: ReflectionSurveyResponseV1;
} {
  if (typeof value === "string") return { content: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { content: "" };
  const payload = value as Record<string, unknown>;
  const survey = normalizeReflectionSurvey(payload.survey) ?? normalizeReflectionSurvey(payload);
  const legacyContent = typeof payload.content === "string" ? payload.content : "";
  return {
    content: legacyContent || (survey ? reflectionToLegacyContent(survey) : ""),
    improvementPlan: typeof payload.improvementPlan === "string" ? payload.improvementPlan : undefined,
    survey,
  };
}

export function latestReflectionByStudent(
  reflections: readonly ReflectionRecord[] | undefined,
): Map<string, ReflectionRecord> {
  const result = new Map<string, ReflectionRecord>();
  [...(reflections ?? [])]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .forEach((reflection) => {
      if (!result.has(reflection.studentId)) result.set(reflection.studentId, reflection);
    });
  return result;
}

export function reflectionSurveyScoreValues(
  reflections: Iterable<ReflectionRecord>,
  key: keyof Pick<ReflectionSurveyResponseV1, "aiHelpfulness" | "systemUsability" | "reuseIntention">,
): ReflectionSurveyScore[] {
  const values: ReflectionSurveyScore[] = [];
  for (const reflection of reflections) {
    const score = reflection.survey?.[key];
    if (isReflectionSurveyScore(score)) values.push(score);
  }
  return values;
}

export function reflectionSurveyAverage(
  reflections: Iterable<ReflectionRecord>,
  key: keyof Pick<ReflectionSurveyResponseV1, "aiHelpfulness" | "systemUsability" | "reuseIntention">,
): number | null {
  const values = reflectionSurveyScoreValues(reflections, key);
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

export function reflectionSurveyDistribution(
  reflections: Iterable<ReflectionRecord>,
  key: keyof Pick<ReflectionSurveyResponseV1, "aiHelpfulness" | "systemUsability" | "reuseIntention">,
): Record<ReflectionSurveyScore, number> {
  const result: Record<ReflectionSurveyScore, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const value of reflectionSurveyScoreValues(reflections, key)) result[value] += 1;
  return result;
}

export function reflectionToLegacyContent(response: ReflectionSurveyResponseV1): string {
  return [
    `【课程收获】\n${response.learningReflection}`,
    `【系统使用反思】\n${response.systemReflection}`,
  ].join("\n\n");
}

export function reflectionCsvCell(value: unknown): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Avoid spreadsheet formula execution when a free-text answer begins with
  // a formula-like character. The leading apostrophe remains visible only in
  // raw CSV and is interpreted as a text marker by common spreadsheet tools.
  // Spreadsheet applications can trim leading whitespace before deciding
  // whether a cell is a formula, so protect formula-like characters after
  // optional whitespace as well.
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
