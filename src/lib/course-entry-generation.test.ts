import { describe, expect, it, vi } from "vitest";
import {
  compileCourseEntryPackage,
  generateCourseEntryPackage,
  normalizeCourseEntryBlueprint,
  validateCourseEntryBlueprint,
  type CourseEntryBlueprint,
  type CourseEntryGenerationInput,
} from "@/lib/course-entry-generation";

const input: CourseEntryGenerationInput = {
  course: {
    name: "数据分类入门",
    subject: "信息科技",
    grade: "高一",
    hours: 1,
    summary: "理解图像分类如何从图片数据中学习规律。",
    learningObjectives: [],
    learnerProfile: { priorKnowledge: "学过人工智能和机器学习入门。" },
    pblConfig: undefined,
  },
  knowledgePoints: [
    {
      id: "kp-image-classification",
      name: "分类基本过程",
      description: "理解图片输入、特征提取和类别输出的基本过程。",
      keyInfo: "图片数据经过特征提取后由模型输出类别。",
      masteryBoundary: "能够解释一个图像分类任务的输入、处理和输出。",
      level: "core",
    },
    {
      id: "kp-evaluation",
      name: "分类结果评价",
      description: "根据测试结果判断模型是否可靠。",
      keyInfo: "使用未参与训练的数据评价模型表现。",
      masteryBoundary: "能够说明为什么不能用训练数据代替测试数据。",
      level: "application",
    },
  ],
  knowledgeGraph: {
    nodes: [
      {
        id: "kp-image-classification",
        label: "分类基本过程",
        description: "理解图片输入、特征提取和类别输出的基本过程。",
        keyInfo: "图片数据经过特征提取后由模型输出类别。",
        masteryBoundary: "能够解释一个图像分类任务的输入、处理和输出。",
        level: "core",
        instructionalRole: "lesson",
      },
      {
        id: "kp-evaluation",
        label: "分类结果评价",
        description: "根据测试结果判断模型是否可靠。",
        keyInfo: "使用未参与训练的数据评价模型表现。",
        masteryBoundary: "能够说明为什么不能用训练数据代替测试数据。",
        level: "application",
        instructionalRole: "lesson",
      },
    ],
    edges: [{
      id: "edge-lesson",
      source: "kp-image-classification",
      target: "kp-evaluation",
      label: "分类过程产生可评价的结果",
      type: "supports",
      strength: "helpful",
      rationale: "先理解模型输出，才能解释评价对象。",
    }],
  },
  mainScenes: [],
};

function validBlueprint(): CourseEntryBlueprint {
  return {
    stageAssumption: "高中（高一）",
    courseDepthRationale: "计算机视觉在高中人工智能课程中位于机器学习基础之后。",
    knowledgeLadder: [
      { order: 1, name: "数据与数据集", role: "earlier-foundation", rationale: "图片首先是一类数据。" },
      { order: 2, name: "监督学习基本流程", role: "lesson-entry", rationale: "分类模型依赖带标签样本学习。" },
      { order: 3, name: "图像分类", role: "lesson-target", rationale: "本课在这些基础上学习视觉分类。" },
    ],
    prerequisiteAnalysisSummary: "只诊断进入本课前理应掌握的机器学习基础，不提前考查图像分类结论。",
    prerequisites: [
      {
        foundationKind: "representation-or-data",
        curriculumFoundationCode: "data-dataset",
        name: "数据集与样本标签",
        description: "数据集由多条样本组成，监督学习样本带有目标标签。",
        keyInfo: "图片是样本，类别名称是监督学习所需标签。",
        expectedPriorKnowledgeEvidence: "高中人工智能入门先学习数据、数据集和标注，再进入具体应用领域。",
        necessityRationale: "若不能区分样本与标签，就无法理解图像分类的输入和学习目标。",
        diagnosticBoundary: "能够在一个简单分类任务中辨认样本、特征信息和标签。",
        unlocksLessonKnowledgePointIds: ["kp-image-classification"],
        question: {
          prompt: "某小组准备训练一个识别猫和狗的模型，下列哪项最准确地描述一条带标签训练样本？",
          options: ["一张图片及其正确类别", "所有图片的总数量", "模型最后给出的预测", "只写类别名称而没有图片"],
          correctOptionIndex: 0,
          rationale: "监督学习的一条训练样本需要输入图片及对应的正确类别；其他选项混淆了数据集规模、预测结果或孤立标签。",
        },
        reviewResource: {
          title: "数据集、样本与标签回顾",
          misconception: "把模型预测当作训练标签，或把整个数据集当成一条样本。",
          explanation: "区分数据集、单条输入样本和监督信号标签。",
          workedExample: "用水果照片及苹果/香蕉类别重新辨认样本与标签。",
          bridgeCheck: "在垃圾分类数据中指出一条样本及其标签。",
        },
      },
      {
        foundationKind: "disciplinary-process",
        curriculumFoundationCode: "supervised-learning-process",
        name: "训练集与测试集的职责",
        description: "训练集用于学习规律，测试集用于检验规律能否用于未见数据。",
        keyInfo: "测试数据不能参与训练，否则评价会失真。",
        expectedPriorKnowledgeEvidence: "高中机器学习入门通常先介绍训练与测试的基本过程。",
        necessityRationale: "若不能区分训练与测试，就无法理解图像分类结果评价是否可信。",
        diagnosticBoundary: "能够为一个分类任务正确安排训练数据和独立测试数据。",
        unlocksLessonKnowledgePointIds: ["kp-evaluation"],
        question: {
          prompt: "为了判断一个已经训练好的分类模型能否处理未见样本，最合理的做法是什么？",
          options: ["继续查看训练集上的结果", "使用未参与训练的带标签样本测试", "删掉所有错误预测", "只比较训练时间长短"],
          correctOptionIndex: 1,
          rationale: "独立测试集才能观察泛化表现；其余做法无法提供对未见样本的可靠证据。",
        },
        reviewResource: {
          title: "训练与测试职责回顾",
          misconception: "认为训练集表现好就能证明模型面对新数据也可靠。",
          explanation: "训练用于学习，独立测试用于检验对新样本的适用性。",
          workedExample: "用不同日期采集的植物照片划分训练和测试数据。",
          bridgeCheck: "判断三种数据划分中哪一种能形成独立测试。",
        },
      },
    ],
    extensions: [],
  };
}

function reviewerResponse(blueprint: CourseEntryBlueprint, verdict: "passed" | "revised" = "passed") {
  return JSON.stringify({
    verdict,
    reviewSummary: "已按高中知识阶梯逐项复核，先修、题目和补学边界成立。",
    findings: [],
    finalBlueprint: blueprint,
  });
}

describe("course entry generation", () => {
  it("compiles one source of truth into graph, one-question and one-resource loops", () => {
    const blueprint = validBlueprint();
    expect(validateCourseEntryBlueprint(blueprint, input)).toEqual([]);
    const result = compileCourseEntryPackage(input, blueprint, "独立审校通过", "2026-08-12T00:00:00.000Z");

    expect(result.issues).toEqual([]);
    expect(result.knowledgeGraph.nodes.filter((node) => node.instructionalRole === "prerequisite")).toHaveLength(2);
    expect(result.plan.prerequisiteKnowledgePoints).toHaveLength(2);
    expect(result.plan.pretest.questions).toHaveLength(2);
    expect(result.plan.branches.filter((branch) => branch.kind === "prerequisite")).toHaveLength(2);
    for (const point of result.plan.prerequisiteKnowledgePoints ?? []) {
      expect(result.plan.pretest.questions.filter((question) => question.knowledgePointIds[0] === point.id)).toHaveLength(1);
      expect(result.plan.branches.filter((branch) => branch.prerequisiteKnowledgePointIds[0] === point.id)).toHaveLength(1);
    }
  });

  it("uses the flow Agent's edited blueprint instead of persisting the producer draft", async () => {
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ ...validBlueprint(), prerequisites: [] }))
      .mockResolvedValueOnce(reviewerResponse(validBlueprint(), "revised"));

    const result = await generateCourseEntryPackage(input, { modelCall, maxModelCalls: 2, now: "2026-08-12T00:00:00.000Z" });

    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(modelCall.mock.calls.map((call) => call[1]?.requestClass)).toEqual([
      "long-generation",
      "standard",
    ]);
    expect(result.plan.pretest.questions).toHaveLength(2);
    expect(result.plan.prerequisiteSemanticReview?.status).toBe("passed");
  });

  it("allows one release repair when the first reviewer still returns an incomplete package", async () => {
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(validBlueprint()))
      .mockResolvedValueOnce(reviewerResponse({ ...validBlueprint(), prerequisites: [] }, "revised"))
      .mockResolvedValueOnce(reviewerResponse(validBlueprint(), "revised"));

    const result = await generateCourseEntryPackage(input, { modelCall, maxModelCalls: 3 });

    expect(modelCall).toHaveBeenCalledTimes(3);
    expect(result.plan.pretest.questions).toHaveLength(2);
    expect(result.revisionCount).toBe(2);
  });

  it("revises an oversized entry against the course-specific capacity instead of appending quota items", async () => {
    const base = validBlueprint();
    const oversized: CourseEntryBlueprint = {
      ...base,
      prerequisites: [
        ...base.prerequisites,
        ...Array.from({ length: 3 }, (_, index) => ({
          ...base.prerequisites[0],
          name: `额外候选 ${index + 1}`,
          question: {
            ...base.prerequisites[0].question,
            prompt: `为了检查第 ${index + 1} 项额外候选，下面哪一种处理方式能够提供可靠依据？`,
          },
          reviewResource: {
            ...base.prerequisites[0].reviewResource,
            title: `额外候选 ${index + 1} 回顾`,
          },
        })),
      ],
    };
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(oversized))
      .mockResolvedValueOnce(reviewerResponse(base, "revised"));

    const result = await generateCourseEntryPackage(input, { modelCall, maxModelCalls: 2 });

    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(result.plan.prerequisiteKnowledgePoints).toHaveLength(2);
    expect(result.reviewFindings).toEqual([]);
  });

  it("never returns a successful zero-prerequisite package", async () => {
    const empty = { ...validBlueprint(), prerequisites: [] };
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(empty))
      .mockResolvedValueOnce(reviewerResponse(empty, "revised"));

    await expect(generateCourseEntryPackage(input, { modelCall, maxModelCalls: 2 }))
      .rejects.toThrow("当前课程入口至少需要 1 项真实先修能力");
  });

  it("normalizes malformed optional collections without inventing prerequisites", () => {
    const blueprint = normalizeCourseEntryBlueprint({
      stageAssumption: "K12 学段待确认",
      courseDepthRationale: "待结合课程目标定位",
      knowledgeLadder: [],
      prerequisiteAnalysisSummary: "需要继续回溯",
    });
    expect(blueprint.prerequisites).toEqual([]);
    expect(validateCourseEntryBlueprint(blueprint, input).some((issue) => issue.includes("当前课程入口至少需要 1 项真实先修能力"))).toBe(true);
  });

  it("owns knowledge-ladder roles deterministically instead of spending another model retry", () => {
    const blueprint = normalizeCourseEntryBlueprint({
      ...validBlueprint(),
      knowledgeLadder: validBlueprint().knowledgeLadder.map((step) => ({ ...step, role: "lesson-entry" })),
    });

    expect(blueprint.knowledgeLadder.map((step) => step.role)).toEqual([
      "earlier-foundation",
      "lesson-entry",
      "lesson-target",
    ]);
  });

  it("treats AI curriculum codes as semantic labels instead of a fixed quota", () => {
    const computerVisionInput: CourseEntryGenerationInput = {
      ...input,
      course: { ...input.course, name: "计算机视觉", subject: "人工智能通识" },
    };
    const issues = validateCourseEntryBlueprint(validBlueprint(), computerVisionInput);

    expect(issues.some((issue) => issue.includes("必要课程台阶"))).toBe(false);
    expect(issues.some((issue) => issue.includes("ai-concept"))).toBe(false);
  });

  it("does not require prerequisites to mechanically cover half of a large lesson graph", () => {
    const expandedInput: CourseEntryGenerationInput = {
      ...input,
      knowledgePoints: [
        ...input.knowledgePoints,
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `kp-extra-${index + 1}`,
          name: `拓展目标 ${index + 1}`,
          description: `第 ${index + 1} 个本课目标`,
          keyInfo: "由主课负责完整讲授",
          masteryBoundary: "能够完成对应任务",
          level: "core" as const,
        })),
      ],
    };
    const blueprint = validBlueprint();
    blueprint.prerequisites[0].unlocksLessonKnowledgePointIds = [
      "kp-image-classification",
      "kp-extra-1",
    ];
    blueprint.prerequisites[1].unlocksLessonKnowledgePointIds = [
      "kp-evaluation",
      "kp-extra-2",
    ];

    const issues = validateCourseEntryBlueprint(blueprint, expandedInput);

    expect(issues.some((issue) => issue.includes("至少支撑 5 个"))).toBe(false);
  });

  it("preserves accepted prerequisite node ids when compiling the edited entry package", () => {
    const blueprint = validBlueprint();
    const existingGraph = {
      ...input.knowledgeGraph!,
      nodes: [
        ...input.knowledgeGraph!.nodes,
        {
          id: "prereq-stable-data",
          label: "数据集与样本标签",
          description: "已审校先修",
          instructionalRole: "prerequisite" as const,
        },
      ],
    };

    const result = compileCourseEntryPackage(
      { ...input, knowledgeGraph: existingGraph },
      blueprint,
      "独立审校通过",
      "2026-08-12T00:00:00.000Z",
    );

    expect(result.knowledgeGraph.nodes.some((node) => node.id === "prereq-stable-data")).toBe(true);
  });
});
