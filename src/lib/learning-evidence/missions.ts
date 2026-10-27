import type { Course } from "@/lib/session/types";
import type {
  LearningEvidenceKind,
  LearningPresetId,
  MissionActionDefinition,
  StageMissionDefinition,
} from "./types";

export type LearningPreset = {
  id: LearningPresetId;
  label: string;
  expression: string;
  requiredIterations: number;
  targetIterations: number;
  requiresSources: boolean;
  requiresEthics: boolean;
};

export const LEARNING_PRESETS: Record<LearningPresetId, LearningPreset> = {
  guided: {
    id: "guided",
    label: "引导型",
    expression: "可用选择、口述转写、图示或短句提交证据",
    requiredIterations: 1,
    targetIterations: 1,
    requiresSources: false,
    requiresEthics: false,
  },
  standard: {
    id: "standard",
    label: "标准型",
    expression: "用短文本比较方案并说明证据与理由",
    requiredIterations: 2,
    targetIterations: 2,
    requiresSources: false,
    requiresEthics: false,
  },
  research: {
    id: "research",
    label: "研究型",
    expression: "说明来源、方法、限制与伦理边界",
    requiredIterations: 2,
    targetIterations: 3,
    requiresSources: true,
    requiresEthics: true,
  },
};

export function inferLearningPreset(
  grade: string | undefined,
  configured?: LearningPresetId,
): LearningPresetId {
  if (configured) return configured;
  const normalized = (grade ?? "").trim().toLowerCase();
  if (/大学|本科|专科|研究生|college|university|undergraduate/.test(normalized)) {
    return "research";
  }
  if (/小学|一至六年级|[1-6一二三四五六]年级|primary|elementary/.test(normalized)) {
    return "guided";
  }
  return "standard";
}

export function resolveCourseLearningPreset(course: Pick<Course, "grade" | "pblConfig">): LearningPresetId {
  return inferLearningPreset(course.grade, course.pblConfig?.learnerPreset);
}

const ACTIONS: Record<string, MissionActionDefinition[]> = {
  launch: [
    {
      id: "choose-topic",
      label: "了解课程并选择研究方向",
      description: "查看课程流程和资料，从教师提供的问题中选择自己感兴趣的方向。",
      evidenceKinds: [],
      doneWhen: "完成资料查阅并选定研究方向。",
    },
  ],
  "ai-learning": [
    {
      id: "ai-learning",
      label: "完成当前知识讲授活动",
      description: "完成分节知识讲授、节末小测与必要的助教讲解；本阶段不使用新的项目证据任务。",
      evidenceKinds: [],
      doneWhen: "完成当前知识讲授阶段的全部小节。",
    },
  ],
  proposal: [
    {
      id: "core-plan",
      label: "项目方案",
      description: "围绕已选问题，说明准备做什么、怎样运用所学知识、如何实施，以及怎样判断方案有效。",
      evidenceKinds: ["plan-version"],
      doneWhen: "明确方案目标、实施步骤与验证方法，并提交教师确认。",
    },
  ],
  make: [
    {
      id: "make-workbench",
      label: "作品制作",
      description: "记录制作进展并提交作品版本。",
      evidenceKinds: ["revision-decision", "artifact-version"],
      doneWhen: "保存一条真实的作品进展，并提交一个作品版本。",
    },
  ],
  showcase: [
    {
      id: "final-artifact",
      label: "确认最终作品",
      description: "提交最终版本，并补充便于查看的作品摘录或标注。",
      evidenceKinds: ["final-artifact"],
      doneWhen: "最终作品具有可检查快照或学生标注。",
    },
    {
      id: "claim",
      label: "完成“主张—证据—局限”汇报图",
      description: "说明你的核心主张、支持证据以及目前仍存在的局限。",
      evidenceKinds: ["presentation-claim"],
      doneWhen: "主张、证据和局限三者均已说明。",
    },
    {
      id: "defense",
      label: "回答 AI 答辩追问",
      description: "回答一至两个针对证据或局限的追问，并引用项目证据。",
      evidenceKinds: ["defense-response"],
      doneWhen: "至少一条答辩回应引用了真实项目证据。",
    },
  ],
  reflection: [
    {
      id: "causal-reflection",
      label: "用真实证据完成因果反思",
      description: "从时间线选择证据，说明“选择—行动—结果—认识”的因果链。",
      evidenceKinds: ["reflection-chain"],
      doneWhen: "反思引用真实证据，四个环节相互对应；不以字数判定。",
    },
    {
      id: "transfer",
      label: "解决一个新情境迁移题",
      description: "把本项目学到的方法用于一个新的但相关的情境。",
      evidenceKinds: ["transfer-response"],
      doneWhen: "给出迁移方案及其理由。",
    },
  ],
};

const COMPLETION: Record<string, string[]> = {
  launch: ["了解课程流程并选择研究方向"],
  "ai-learning": ["完成知识讲授阶段全部小节与节末小测"],
  proposal: ["形成一份能够实施和验证的项目方案", "教师确认方案方向"],
  make: ["保存作品制作过程", "提交一个可查看的作品版本"],
  showcase: ["最终作品可检查", "汇报包含主张、证据和局限", "完成 AI 追问与教师现场评价"],
  reflection: ["反思引用真实过程证据并形成因果链", "完成新情境迁移"],
};

const REQUIRED_KINDS: Record<string, LearningEvidenceKind[]> = {
  launch: [],
  "ai-learning": [],
  proposal: ["plan-version"],
  make: ["artifact-version", "revision-decision"],
  showcase: [],
  reflection: [],
};

export function getStageMissionDefinition(
  stageKey: string,
  presetId: LearningPresetId,
  missingEvidenceKinds: LearningEvidenceKind[] = [],
): StageMissionDefinition {
  const preset = LEARNING_PRESETS[presetId];
  const actions = ACTIONS[stageKey] ?? ACTIONS.launch;
  const currentAction =
    actions.find((action) =>
      action.evidenceKinds.some((kind) => missingEvidenceKinds.includes(kind)),
    ) ?? actions[0];
  const iterationCount = stageKey === "make" ? 1 : 0;
  const targetIterations = stageKey === "make" ? 1 : 0;
  const teacherRequirement = stageKey === "proposal"
      ? "plan-approval"
      : stageKey === "showcase"
        ? "live-evaluation"
        : "none";

  const rolePlan = stageKey === "launch"
    ? { allowed: ["ideation", "knowledge", "critic"], lead: "ideation", support: "knowledge" }
    : stageKey === "proposal"
      ? { allowed: ["ideation", "knowledge", "critic", "planner", "recorder"], lead: "critic", support: "planner" }
      : stageKey === "make"
        ? { allowed: ["planner", "knowledge", "critic", "reviewer", "ideation", "recorder"], lead: "planner", support: "reviewer" }
        : stageKey === "showcase"
          ? { allowed: ["reviewer", "critic", "recorder"], lead: "critic", support: "reviewer" }
          : stageKey === "reflection"
            ? { allowed: ["recorder", "reviewer"], lead: "recorder", support: "reviewer" }
            : { allowed: ["knowledge", "critic"], lead: "knowledge", support: "critic" };

  return {
    id: `mission-${stageKey}-${presetId}`,
    stageKey,
    preset: presetId,
    objective: COMPLETION[stageKey]?.[0] ?? "完成当前阶段任务",
    currentAction,
    actions,
    completionCriteria: [
      ...(COMPLETION[stageKey] ?? []),
      preset.expression,
      ...(stageKey === "make" ? ["至少保存一条真实的作品进展"] : []),
      ...(preset.requiresSources && stageKey !== "ai-learning"
        ? ["对关键事实标注来源、方法、限制与伦理边界"]
        : []),
    ],
    suggestedMinutes:
      stageKey === "launch" ? 12
        : stageKey === "proposal" ? 25
          : stageKey === "make" ? 35
            : stageKey === "showcase" ? 20
              : stageKey === "reflection" ? 15
                : 0,
    allowedCompanionIds: rolePlan.allowed as StageMissionDefinition["allowedCompanionIds"],
    leadCompanionId: rolePlan.lead as StageMissionDefinition["leadCompanionId"],
    supportingCompanionId: rolePlan.support as StageMissionDefinition["supportingCompanionId"],
    requiredEvidenceKinds: REQUIRED_KINDS[stageKey] ?? [],
    requiredIterations: iterationCount,
    targetIterations,
    teacherRequirement,
  };
}
