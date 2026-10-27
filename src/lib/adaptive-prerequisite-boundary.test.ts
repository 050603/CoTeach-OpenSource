import { describe, expect, it } from "vitest";
import {
  applyAdaptivePrerequisiteSemanticReview,
  confirmAdaptiveLearningPlan,
  evaluateAdaptiveBranchDecision,
  evaluateAdaptiveLearningPlanQuality,
  hasCompleteAdaptivePrerequisiteLoop,
  improveAdaptiveLearningPlanQuality,
  normalizeAdaptiveLearningPlan,
} from "@/lib/adaptive-learning";
import type {
  AdaptiveLearningPlan,
  AdaptivePrerequisiteKnowledgePoint,
  KnowledgePoint,
  OpenMaicSceneOutlineSnapshot,
} from "@/lib/session/types";

const nlpKnowledgePoints: KnowledgePoint[] = [
  { id: "kp-tokenization", name: "中文分词概念与基本方法", description: "本课讲解如何把连续文本切成词语", level: "foundation" },
  { id: "kp-pos", name: "词性标注概念与简单例子", description: "本课讲解如何标注词性", level: "foundation" },
  { id: "kp-classification", name: "文本分类概念", description: "本课讲解文本分类", level: "application" },
  { id: "kp-rule", name: "规则驱动方法", description: "本课讲解条件规则如何用于文本处理", level: "core" },
];

const nlpScenes: OpenMaicSceneOutlineSnapshot[] = nlpKnowledgePoints.map((point, index) => ({
  id: `scene-${index + 1}`,
  title: point.name,
  type: "slide",
  order: index,
  stageKey: "ai-learning",
  audience: "student",
  knowledgePointIds: [point.id],
  keyPoints: [point.description],
}));

function prerequisite(
  id: string,
  name: string,
  relatedId: string,
): AdaptivePrerequisiteKnowledgePoint {
  return {
    id,
    name,
    description: `${name}的基础含义`,
    relatedIds: [relatedId],
    expectedPriorKnowledgeEvidence: "模型声称高中生此前已经学过",
    necessityRationale: `缺失会影响 ${relatedId}`,
    diagnosticBoundary: `能够正确完成一道${name}辨析题`,
  };
}

function emptyPlan(): AdaptiveLearningPlan {
  return {
    enabled: true,
    status: "draft",
    updatedAt: "2026-08-12T00:00:00.000Z",
    timeBudgetMin: 8,
    thresholds: { enrichmentMasteryMin: 80 },
    prerequisiteKnowledgePoints: [],
    prerequisiteAnalysis: {
      summary: "本课从零建立领域概念，不需要专门课前诊断。",
      decisions: nlpKnowledgePoints.map((point) => ({
        targetKnowledgePointId: point.id,
        decision: "teach-in-main-course" as const,
        prerequisiteKnowledgePointIds: [],
        rationale: "该概念就是本课明确的新授目标。",
      })),
    },
    prerequisiteSemanticReview: {
      status: "passed",
      summary: "逐项审校后确认无需专门先修诊断。",
      decisions: [],
    },
    pretest: {
      title: "无需专门先修诊断",
      introduction: "本课会从必要基础开始讲解。",
      estimatedMinutes: 0,
      questions: [],
    },
    enrichmentStrategy: {
      recommendedMin: 0,
      recommendedMax: 2,
      runtimeMaxPerStudent: 1,
      summary: "暂无必要拓展。",
      decisions: [],
    },
    branches: [],
  };
}

describe("strict adaptive prerequisite boundary", () => {
  it("rejects zero-pretest plans while still forbidding trivia disguised as prerequisites", () => {
    const plan = emptyPlan();
    const quality = evaluateAdaptiveLearningPlanQuality(plan, {
      knowledgePoints: nlpKnowledgePoints,
      mainScenes: nlpScenes,
    });

    expect(hasCompleteAdaptivePrerequisiteLoop(plan, nlpKnowledgePoints.length)).toBe(false);
    expect(quality.issues.join("；")).toContain("当前课程至少需要 1 项");
    expect(quality.issues).toContain("前序知识、前测与补缺资源没有形成闭环");
  });

  it("removes NLP lesson content that was repackaged as prerequisite questions", () => {
    const prerequisites = [
      prerequisite("prereq-word", "词语边界", "kp-tokenization"),
      prerequisite("prereq-pos", "词性识别", "kp-pos"),
      prerequisite("prereq-category", "一般分类", "kp-classification"),
      prerequisite("prereq-rule", "条件规则", "kp-rule"),
    ];
    const generated = normalizeAdaptiveLearningPlan({
      prerequisiteKnowledgePoints: prerequisites,
      prerequisiteAnalysis: {
        summary: "四项基础均需前测。",
        decisions: prerequisites.map((point) => ({
          targetKnowledgePointId: point.relatedIds![0],
          decision: "diagnose-prerequisite",
          prerequisiteKnowledgePointIds: [point.id],
          rationale: point.necessityRationale,
        })),
      },
      pretest: {
        title: "自然语言处理课程前测",
        introduction: "检查基础",
        questions: [
          { id: "q-word", prompt: "句子‘我爱学习’由哪些基本单位组成？", options: ["汉字", "词语", "字母", "拼音"], correctOptionIndex: 1, rationale: "正确掌握词语边界是学习中文分词的基础。", knowledgePointIds: ["prereq-word"] },
          { id: "q-pos", prompt: "‘猫喜欢鱼’中的‘喜欢’是什么词性？", options: ["名词", "动词", "形容词", "副词"], correctOptionIndex: 1, rationale: "认识词性是学习词性标注的前提。", knowledgePointIds: ["prereq-pos"] },
          { id: "q-category", prompt: "将词语与类别匹配。", type: "matching", options: ["水果", "学校"], matchingPairs: [{ left: "苹果", right: "水果" }, { left: "中学", right: "学校" }], correctOptionIndex: 0, rationale: "理解分类是学习文本分类的基础。", knowledgePointIds: ["prereq-category"] },
          { id: "q-rule", prompt: "若条件成立则执行动作，这个判断是否正确？", options: ["正确", "错误"], correctOptionIndex: 0, rationale: "条件规则是学习规则驱动方法的基础。", knowledgePointIds: ["prereq-rule"] },
        ],
      },
      branches: [],
    }, emptyPlan());

    const reviewed = applyAdaptivePrerequisiteSemanticReview(generated, {
      status: "failed",
      summary: "四项候选都是本课新授内容的简化或同义前置练习。",
      decisions: prerequisites.map((point) => ({
        prerequisiteKnowledgePointId: point.id,
        verdict: "reject" as const,
        issues: ["与本课新授边界重叠，且缺少课前理应掌握的可靠依据"],
      })),
    });
    const improved = improveAdaptiveLearningPlanQuality(reviewed, emptyPlan(), {
      knowledgePoints: nlpKnowledgePoints,
      mainScenes: nlpScenes,
    });

    expect(improved.prerequisiteKnowledgePoints).toEqual([]);
    expect(improved.pretest.questions).toEqual([]);
    expect(improved.branches.filter((branch) => branch.kind === "prerequisite")).toEqual([]);
  });

  it("rejects one remediation resource that would replay several unrelated gaps", () => {
    const plan = emptyPlan();
    plan.prerequisiteKnowledgePoints = [
      prerequisite("prereq-a", "基础 A", "kp-tokenization"),
      prerequisite("prereq-b", "基础 B", "kp-pos"),
    ];
    plan.prerequisiteAnalysis = {
      summary: "两项独立基础需要诊断。",
      decisions: [
        { targetKnowledgePointId: "kp-tokenization", decision: "diagnose-prerequisite", prerequisiteKnowledgePointIds: ["prereq-a"], rationale: "A 是必要输入。" },
        { targetKnowledgePointId: "kp-pos", decision: "diagnose-prerequisite", prerequisiteKnowledgePointIds: ["prereq-b"], rationale: "B 是必要输入。" },
        { targetKnowledgePointId: "kp-classification", decision: "teach-in-main-course", prerequisiteKnowledgePointIds: [], rationale: "本课新授。" },
        { targetKnowledgePointId: "kp-rule", decision: "teach-in-main-course", prerequisiteKnowledgePointIds: [], rationale: "本课新授。" },
      ],
    };
    plan.pretest.questions = [
      { id: "q-a", prompt: "检查 A", options: ["对", "错"], correctOptionIndex: 0, knowledgePointIds: ["prereq-a"] },
      { id: "q-b", prompt: "检查 B", options: ["对", "错"], correctOptionIndex: 0, knowledgePointIds: ["prereq-b"] },
    ];
    plan.pretest.estimatedMinutes = 2;
    plan.branches = [{
      id: "combined-review",
      kind: "prerequisite",
      title: "全部基础补修",
      objective: "同时补 A 和 B",
      keyPoints: ["A", "B"],
      anchorKnowledgePointIds: ["kp-tokenization", "kp-pos"],
      prerequisiteKnowledgePointIds: ["prereq-a", "prereq-b"],
      noveltyStatement: "根据两个诊断结果提供新的纠错例子。",
      mainCourseOverlapSceneIds: [],
      sceneType: "slide",
      targetDurationSec: 180,
      trigger: { placement: "before-main-course", evidenceRule: "pretest-gap", minimumRemainingSec: 180 },
      status: "draft",
    }];

    const quality = evaluateAdaptiveLearningPlanQuality(plan, {
      knowledgePoints: nlpKnowledgePoints,
      mainScenes: nlpScenes,
    });

    expect(quality.passed).toBe(false);
    expect(quality.issues.join("；")).toContain("一个独立先修知识缺口");
  });

  it("keeps legacy zero-pretest playback safe while new generation rejects such plans", () => {
    const plan = confirmAdaptiveLearningPlan({
      ...emptyPlan(),
      branches: [{
        id: "extension-1",
        kind: "extension",
        title: "新情境迁移",
        objective: "迁移主课知识",
        keyPoints: ["新数据材料", "比较结论"],
        anchorKnowledgePointIds: ["kp-tokenization"],
        prerequisiteKnowledgePointIds: [],
        noveltyStatement: "使用主课未出现的新案例检验边界条件。",
        mainCourseOverlapSceneIds: [],
        sceneType: "slide",
        targetDurationSec: 120,
        preparedResource: { status: "ready", classroomId: "extension-classroom" },
        trigger: { placement: "after-module", assessmentSceneIds: ["quiz-final"], evidenceRule: "module-mastery", scoreThreshold: 80, minimumRemainingSec: 120 },
        status: "draft",
      }],
    });

    const result = evaluateAdaptiveBranchDecision({
      plan,
      state: { evidence: [], branchRuns: [], microLessons: [] },
      nodeQuizScore: 90,
      anchorKnowledgePointIds: ["kp-tokenization"],
      completedSceneId: "quiz-final",
      phase: "after-module",
      remainingBudgetSec: 180,
    });

    expect(result.decision.action, JSON.stringify(result, null, 2)).toBe("insert");
  });
});
