export type PreparationStepKey =
  | "base"
  | "knowledgePoints"
  | "projectDesign"
  | "evaluationPlan"
  | "teachingOutline"
  | "lessonOutline"
  | "adaptiveLearning";

export type PreparationStepState = "complete" | "current" | "available";

export type PreparationFlowStep = {
  key: PreparationStepKey;
  phase: string;
  label: string;
  shortLabel: string;
  description: string;
  upstream: string;
  output: string;
};

export const PREPARATION_FLOW_STEPS: readonly PreparationFlowStep[] = [
  {
    key: "base",
    phase: "定位",
    label: "课程定位",
    shortLabel: "课程定位",
    description: "明确教学对象、课时边界、学习目标与真实课程情境。",
    upstream: "课程主题与教师教学意图",
    output: "可供后续设计引用的课程底稿",
  },
  {
    key: "knowledgePoints",
    phase: "定标",
    label: "目标与知识",
    shortLabel: "目标知识",
    description: "圈定核心知识、前置关系和本课必须掌握的关键信息。",
    upstream: "已确认的课程定位与学习目标",
    output: "知识边界清晰、关系有效的知识图谱",
  },
  {
    key: "projectDesign",
    phase: "立项",
    label: "项目与成果",
    shortLabel: "项目成果",
    description: "确定项目难度、过程证据、AI 伴学角色和结构化成果。",
    upstream: "驱动问题、学习目标与知识图谱",
    output: "能够证明学习发生的项目成果要求",
  },
  {
    key: "evaluationPlan",
    phase: "评价",
    label: "成功标准",
    shortLabel: "成功标准",
    description: "先明确评价责任、证据和维度，再安排课堂学习活动。",
    upstream: "课程目标、知识图谱与项目成果",
    output: "AI 与教师职责清晰的评价方案",
  },
  {
    key: "teachingOutline",
    phase: "架构",
    label: "六阶段架构",
    shortLabel: "阶段架构",
    description: "组织六个宏观阶段，确认时间、师生分工和资源需求。",
    upstream: "项目成果、成功标准与课程总时长",
    output: "时间闭合、人机分工明确的课程骨架",
  },
  {
    key: "lessonOutline",
    phase: "深化",
    label: "主课程脚本",
    shortLabel: "主课脚本",
    description: "把课程骨架深化为真实页面、互动、测验和教师资源。",
    upstream: "已确认的六阶段架构与知识图谱",
    output: "可以进入资源生成的主课程页面序列",
  },
  {
    key: "adaptiveLearning",
    phase: "适配",
    label: "个性化学习路径",
    shortLabel: "个性化路径",
    description: "在完整主课路径中标明诊断补缺与达标拓展的插入位置和触发条件。",
    upstream: "已确认的主课程页面与知识节点",
    output: "主课主线清晰、插入点明确、可逐项审核的个性化学习路径",
  },
] as const;

export function resolvePreparationStepStates({
  completedKeys,
  currentKey,
}: {
  completedKeys: readonly PreparationStepKey[];
  currentKey: PreparationStepKey;
}): PreparationStepState[] {
  const completed = new Set(completedKeys);
  return PREPARATION_FLOW_STEPS.map((step) => {
    if (step.key === currentKey) return "current";
    if (completed.has(step.key)) return "complete";
    return "available";
  });
}
