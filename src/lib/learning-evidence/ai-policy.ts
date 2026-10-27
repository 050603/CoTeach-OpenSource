import type { Course } from "@/lib/session/types";
import type { CompanionRoleId, LearningEvidence } from "./types";

const HIGH_IMPACT_ROLES = new Set<CompanionRoleId>([
  "ideation",
  "planner",
  "reviewer",
]);

export function isReadyMadeDeliverableRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /(?:帮我|替我|直接|请你).{0,10}(?:生成|写|做|完成|制作).{0,14}(?:完整|全部|整个|可直接提交)?.{0,8}(?:方案|作品|报告|论文|ppt|演示稿|代码)/i.test(normalized)
    || /(?:生成|写出|做出|制作)(?:一份|一个)?(?:完整|全部|整个|可直接提交).{0,8}(?:方案|作品|报告|论文|ppt|演示稿|代码)/i.test(normalized)
    || /(?:do|write|generate|make).{0,18}(?:entire|complete|submission-ready).{0,18}(?:plan|project|report|essay|presentation|code)/i.test(normalized)
  );
}

export type AiSupportAccess = {
  allowed: boolean;
  highImpact: boolean;
  reason?: string;
  seedEvidenceIds: string[];
};

function hasStudentSeed(evidence: LearningEvidence): boolean {
  return (
    evidence.source === "student"
    && evidence.countsTowardReadiness
    && ["draft", "submitted", "teacher-confirmed"].includes(evidence.status)
    && Boolean(evidence.summary.trim() || Object.values(evidence.payload as Record<string, unknown>).some(
      (value) => typeof value === "string" && Boolean(value.trim()),
    ))
  );
}

/**
 * Knowledge clarification remains available without a seed. Roles capable of
 * proposing a direction, plan or quality judgement require the student's own
 * idea, draft or test result first.
 */
export function canRequestCompanionSupport(
  course: Course,
  studentId: string,
  stageKey: string,
  companionId: CompanionRoleId,
): AiSupportAccess {
  const highImpact = HIGH_IMPACT_ROLES.has(companionId);
  const seedEvidenceIds = (course.learningEvidence ?? [])
    .filter((item) => item.studentId === studentId && item.stageKey === stageKey && hasStudentSeed(item))
    .map((item) => item.id);
  if (!highImpact || seedEvidenceIds.length > 0) {
    return { allowed: true, highImpact, seedEvidenceIds };
  }
  return {
    allowed: false,
    highImpact,
    seedEvidenceIds,
    reason: "先提交你自己的想法、草稿或测试结果，AI 才能给出方向、计划或高影响评价建议。",
  };
}

export function canApplyAiDecision(
  decision: { decision: string; reason: string; appliedChangeSummary?: string },
): { allowed: boolean; reason?: string } {
  if (!decision.reason.trim()) {
    return { allowed: false, reason: "请先说明采纳、修改或拒绝这条建议的理由。" };
  }
  if (
    ["adopted", "modified"].includes(decision.decision)
    && !decision.appliedChangeSummary?.trim()
  ) {
    return { allowed: false, reason: "请说明这条建议实际改变了哪个版本或内容。" };
  }
  return { allowed: true };
}
