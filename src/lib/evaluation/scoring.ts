export function computeFinalScore(input: {
  aiScore?: number | null;
  aiWeight: number;
  teacherScore?: number | null;
  teacherWeight: number;
}): number | null {
  if (typeof input.aiScore !== "number" || typeof input.teacherScore !== "number") return null;
  const totalWeight = input.aiWeight + input.teacherWeight;
  if (totalWeight !== 100) return null;
  return Math.round((input.aiScore * input.aiWeight + input.teacherScore * input.teacherWeight) * 10) / 1000;
}

export function validateScoredWeights(flows: Array<{ weight: number; scored?: boolean }>): boolean {
  return flows.filter((flow) => flow.scored !== false).reduce((sum, flow) => sum + flow.weight, 0) === 100;
}
