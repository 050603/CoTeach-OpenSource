import { describe, expect, it } from "vitest";
import {
  assessKnowledgeGraphQuality,
  isKnowledgeStructureReviewCurrent,
  knowledgeStructureSignature,
} from "./knowledge-graph-quality";
import type { KnowledgeGraph } from "./session/types";

const points = [
  { id: "kp-1", name: "数据特征", description: "用于描述样本", keyInfo: "特征来自可观察数据", level: "foundation" as const },
  { id: "kp-2", name: "分类规则", description: "依据特征作出判断", keyInfo: "规则需要可解释", level: "core" as const },
  { id: "kp-3", name: "模型验证", description: "使用新样本检验规则", keyInfo: "验证关注未见样本", level: "application" as const },
];

describe("knowledge graph quality", () => {
  it("accepts a connected, acyclic graph that preserves teacher requirements", () => {
    const graph = {
      nodes: points.map((point) => ({ id: point.id, label: point.name, description: point.description, keyInfo: point.keyInfo, level: point.level })),
      edges: [
        { id: "e-1", source: "kp-1", target: "kp-2", label: "是构建的前提" },
        { id: "e-2", source: "kp-2", target: "kp-3", label: "用于" },
      ],
    };

    expect(assessKnowledgeGraphQuality(graph, points, ["分类规则"]).ok).toBe(true);
  });

  it("rejects omitted teacher points, vague edges, isolated nodes and cycles", () => {
    const graph = {
      nodes: points.map((point) => ({ id: point.id, label: point.name, description: point.description, keyInfo: point.keyInfo, level: point.level })),
      edges: [
        { id: "e-1", source: "kp-1", target: "kp-2", label: "关联" },
        { id: "e-2", source: "kp-2", target: "kp-1", label: "支撑" },
      ],
    };
    const result = assessKnowledgeGraphQuality(graph, points, ["混淆矩阵"]);

    expect(result.ok).toBe(false);
    expect(result.issues.join("；")).toContain("教师指定知识点未被保留");
    expect(result.issues.join("；")).toContain("不能只写");
    expect(result.issues.join("；")).toContain("孤立节点");
    expect(result.issues.join("；")).toContain("循环");
  });

  it("accepts curriculum prerequisites as graph nodes without turning them into lesson targets", () => {
    const lessonPoints = [
      { id: "kp-nlp", name: "自然语言处理基本任务", description: "理解文本处理任务", keyInfo: "文本需要转化为可处理的数据表示", masteryBoundary: "能解释文本表示与两类基本任务", objectiveIndexes: [0], level: "core" as const },
      { id: "kp-project", name: "文本分类项目", description: "完成一个文本分类方案", keyInfo: "依据数据特征选择并验证算法", masteryBoundary: "能完成并解释文本分类方案", objectiveIndexes: [1], level: "application" as const },
    ];
    const graph = {
      nodes: [
        ...lessonPoints.map((point) => ({ ...point, label: point.name, instructionalRole: "lesson" as const })),
        {
          id: "prereq-ai-foundations",
          label: "人工智能三大基石与数据特征",
          description: "理解数据、算法、算力及数据特征与算法选择的关系",
          keyInfo: "不同数据特征会影响算法选择",
          level: "foundation" as const,
          instructionalRole: "prerequisite" as const,
          priorKnowledgeEvidence: "高中信息技术前序人工智能模块",
          diagnosticBoundary: "能解释三大基石，并依据数据特征说明算法选择差异",
        },
        {
          id: "prereq-supervised-learning",
          label: "监督学习与数据集划分",
          description: "理解监督学习过程以及训练集、验证集、测试集的分工",
          keyInfo: "不同数据子集承担训练、调参与最终检验的不同职责",
          level: "foundation" as const,
          instructionalRole: "prerequisite" as const,
          priorKnowledgeEvidence: "高中信息技术前序机器学习模块",
          diagnosticBoundary: "能按用途区分训练集、验证集和测试集并概述监督学习流程",
        },
      ],
      edges: [
        { id: "e-1", source: "prereq-ai-foundations", target: "kp-nlp", label: "是理解文本数据处理的前提", type: "required-prerequisite" as const, strength: "required" as const, rationale: "不了解数据特征与算法关系就无法理解文本为何需要表示和建模" },
        { id: "e-2", source: "prereq-supervised-learning", target: "kp-project", label: "是训练与验证文本分类模型的前提", type: "required-prerequisite" as const, strength: "required" as const, rationale: "无法区分数据集职责会直接导致训练与评价流程错误" },
        { id: "e-3", source: "kp-nlp", target: "kp-project", label: "支撑项目应用", type: "application" as const, strength: "required" as const, rationale: "项目需要应用自然语言处理基本任务" },
      ],
    };

    expect(assessKnowledgeGraphQuality(graph, lessonPoints).ok).toBe(true);
  });

  it("does not treat a merely helpful background relation as a diagnosable prerequisite", () => {
    const lessonPoints = [
      { id: "kp-nlp", name: "自然语言处理", description: "理解自然语言处理", keyInfo: "处理文本数据", level: "core" as const },
    ];
    const graph = {
      nodes: [
        { ...lessonPoints[0], label: lessonPoints[0].name, instructionalRole: "lesson" as const },
        { id: "background", label: "语言趣闻", description: "有助于激发兴趣", level: "foundation" as const, instructionalRole: "prerequisite" as const, priorKnowledgeEvidence: "生活经验", diagnosticBoundary: "听说过语言趣闻" },
      ],
      edges: [
        { id: "e-1", source: "background", target: "kp-nlp", label: "有助于理解", type: "supports" as const, strength: "helpful" as const, rationale: "只用于激发兴趣" },
      ],
    };

    expect(assessKnowledgeGraphQuality(graph, lessonPoints).ok).toBe(false);
    expect(assessKnowledgeGraphQuality(graph, lessonPoints).issues.join("；")).toContain("必需先修路径");
  });

  it("allows independent reviewed lesson branches instead of requiring fabricated links", () => {
    const independentPoints = [
      { id: "kp-a", name: "文本表示", description: "理解文本表示", keyInfo: "文本可转为数值表示", masteryBoundary: "能解释一种表示方法", objectiveIndexes: [0], level: "foundation" as const },
      { id: "kp-b", name: "伦理判断", description: "判断文本应用风险", keyInfo: "关注偏差与隐私", masteryBoundary: "能识别一项风险", objectiveIndexes: [1], level: "application" as const },
    ];
    const graph = {
      nodes: independentPoints.map((point) => ({ ...point, label: point.name, instructionalRole: "lesson" as const })),
      edges: [],
    };

    expect(assessKnowledgeGraphQuality(graph, independentPoints, [], { objectiveCount: 2 }).ok).toBe(true);
  });

  it("requires a current review with one accepted decision for every target, prerequisite and edge", () => {
    const reviewedPoints = [
      { id: "kp-1", name: "文本分类", description: "完成文本分类", keyInfo: "按特征进行分类", masteryBoundary: "能解释分类结果", objectiveIndexes: [0], level: "application" as const },
    ];
    const graph = {
      nodes: [
        { ...reviewedPoints[0], label: reviewedPoints[0].name, instructionalRole: "lesson" as const },
        { id: "pre-1", label: "监督学习", description: "理解监督学习", keyInfo: "使用标注数据学习", level: "foundation" as const, instructionalRole: "prerequisite" as const, priorKnowledgeEvidence: "前序机器学习课程", diagnosticBoundary: "能概述监督学习过程" },
      ],
      edges: [
        { id: "e-1", source: "pre-1", target: "kp-1", label: "是分类学习的必要前提", type: "required-prerequisite" as const, strength: "required" as const, rationale: "缺失会无法理解模型如何从标注样本学习" },
      ],
    };
    const reviewedGraph: KnowledgeGraph = {
      ...graph,
      semanticReview: {
        status: "passed" as const,
        summary: "通过",
        sourceSignature: knowledgeStructureSignature(graph, reviewedPoints),
        lessonDecisions: [{ knowledgePointId: "kp-1", verdict: "accept" as const, issues: [] }],
        prerequisiteDecisions: [{ nodeId: "pre-1", verdict: "accept" as const, issues: [] }],
        relationshipDecisions: [],
      },
    };

    expect(isKnowledgeStructureReviewCurrent(reviewedGraph, reviewedPoints)).toBe(false);
    reviewedGraph.semanticReview!.relationshipDecisions.push({ edgeId: "e-1", verdict: "accept", issues: [] });
    expect(isKnowledgeStructureReviewCurrent(reviewedGraph, reviewedPoints)).toBe(true);
  });

  it("rejects required-prerequisite edges between two lesson targets", () => {
    const lessonPoints = [
      { id: "kp-a", name: "图像表示", description: "理解像素矩阵", keyInfo: "像素构成数字图像", masteryBoundary: "能解释像素矩阵", objectiveIndexes: [0], level: "foundation" as const },
      { id: "kp-b", name: "图像分类", description: "理解类别预测", keyInfo: "模型输出类别标签", masteryBoundary: "能解释分类结果", objectiveIndexes: [1], level: "application" as const },
    ];
    const graph: KnowledgeGraph = {
      nodes: lessonPoints.map((point) => ({ ...point, label: point.name, instructionalRole: "lesson" })),
      edges: [{ id: "e-illegal", source: "kp-a", target: "kp-b", label: "先学习图像表示", type: "required-prerequisite", strength: "required", rationale: "图像表示支撑分类" }],
    };

    const quality = assessKnowledgeGraphQuality(graph, lessonPoints, [], { objectiveCount: 2 });

    expect(quality.ok).toBe(false);
    expect(quality.issues.join("；")).toContain("只能从课前先修节点指向本课目标");
  });

  it("enforces at least one real prerequisite for newly generated course structures", () => {
    const lessonPoints = [{ id: "kp-a", name: "计算机视觉", description: "理解视觉识别任务", keyInfo: "图像数据经模型处理", masteryBoundary: "能解释基本流程", objectiveIndexes: [0], level: "core" as const }];
    const graph: KnowledgeGraph = {
      nodes: lessonPoints.map((point) => ({ ...point, label: point.name, instructionalRole: "lesson" })),
      edges: [],
    };

    const quality = assessKnowledgeGraphQuality(graph, lessonPoints, [], {
      objectiveCount: 1,
      minimumPrerequisites: 1,
    });

    expect(quality.ok).toBe(false);
    expect(quality.issues.join("；")).toContain("至少需要 1 项真实课前先修");
  });

  it("rejects overlapping edges and backward instructional progression", () => {
    const graph: KnowledgeGraph = {
      nodes: points.map((point) => ({
        ...point,
        label: point.name,
        instructionalRole: "lesson",
      })),
      edges: [
        { id: "e-1", source: "kp-3", target: "kp-1", label: "反向支撑", type: "supports", strength: "helpful", rationale: "错误的倒序关系" },
        { id: "e-2", source: "kp-3", target: "kp-1", label: "再次应用", type: "application", strength: "helpful", rationale: "同一方向的重叠关系" },
      ],
    };

    const quality = assessKnowledgeGraphQuality(graph, points);

    expect(quality.ok).toBe(false);
    expect(quality.issues.join("；")).toContain("每个方向只保留最准确的一条关系");
    expect(quality.issues.join("；")).toContain("逆向进阶");
    expect(quality.issues.join("；")).toContain("应指向应用层或拓展层");
  });
});
