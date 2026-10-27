import type { CompanionMessageVisibility, CompanionThread, CompanionTriggerKind, TeacherAgentDirective } from "@/lib/session/types";

const PROACTIVE_COOLDOWNS_MS: Partial<Record<CompanionTriggerKind, number>> = {
  idle: 10 * 60_000,
  "document-saved": 8 * 60_000,
  "file-uploaded": 2 * 60_000,
};

export function shouldAllowProactiveIntervention(input: {
  kind: CompanionTriggerKind;
  now: number;
  lastProactiveAt?: number;
}): boolean {
  const cooldown = PROACTIVE_COOLDOWNS_MS[input.kind] ?? 0;
  return cooldown === 0 || !input.lastProactiveAt || input.now - input.lastProactiveAt >= cooldown;
}

export function shouldProactivelyReviewArtifact(
  kind: "document-saved" | "file-uploaded",
  milestone = false,
): boolean {
  return kind === "file-uploaded" || milestone;
}

export function maxSpeakersForTurn(
  trigger: CompanionTriggerKind | undefined,
  message: string,
): 1 | 2 {
  if (trigger) return 1;
  return /多角色|不同角度|分别|两个角度|大家/.test(message) ? 2 : 1;
}

function normalizedBigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const grams = new Set<string>();
  for (let index = 0; index < clean.length - 1; index += 1) grams.add(clean.slice(index, index + 2));
  return grams;
}

export function isSubstantiallyRepeatedResponse(response: string, previousResponses: string[]): boolean {
  const candidate = normalizedBigrams(response);
  if (candidate.size < 8) return false;
  return previousResponses.some((previous) => {
    const prior = normalizedBigrams(previous);
    if (!prior.size) return false;
    let overlap = 0;
    for (const gram of candidate) if (prior.has(gram)) overlap += 1;
    return overlap / Math.min(candidate.size, prior.size) >= 0.72;
  });
}

export function shouldSendStageOpening(thread?: CompanionThread): boolean {
  return !thread?.openingSentAt;
}

export function recorderVisibility(trigger?: CompanionTriggerKind): CompanionMessageVisibility {
  void trigger;
  return "teacher-only";
}

export function shouldUseReviewer(trigger?: CompanionTriggerKind): boolean {
  return trigger === "artifact-stalled" || trigger === "file-uploaded" || trigger === "milestone";
}

export function activeDirectivesForStudent(
  directives: TeacherAgentDirective[],
  studentId: string,
  stageKey: string,
): TeacherAgentDirective[] {
  return directives.filter((directive) =>
    directive.status === "active" &&
    directive.stageKey === stageKey &&
    (directive.targetScope === "course" || directive.targetStudentIds.includes(studentId)),
  );
}
