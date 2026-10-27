import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import {
  assessmentToBoundaryResponse,
  headingNumberingAssessmentPolicy,
  buildDelegatedWorkAssessmentPrompts,
  buildDelegatedWorkExecutionPrompts,
  buildDelegatedWorkDeliveryReviewPrompts,
  isValidDelegatedWorkAssessment,
  inspectDelegatedWorkPlacement,
  isValidDelegatedWorkDeliveryReview,
  inspectDelegatedWorkDelivery,
  normalizeDelegatedWorkDeliveryReview,
  buildDelegatedWorkStarterReviewPrompts,
  buildDelegatedWorkStarterPrompts,
  generateDelegatedDeliveryWithRepair,
  normalizeDelegatedWorkAssessment,
  normalizeDelegatedWorkDelivery,
  normalizeDelegatedWorkStarters,
} from "./delegated-work-policy";

const course = {
  id: "course-1",
  name: "校园节水研究",
  drivingQuestion: "怎样用可靠证据找到校园浪费水的主要原因？",
  expectedOutcome: "基于实地数据形成并验证节水方案",
  learningObjectives: ["自主采集数据", "分析证据并形成结论"],
  stages: [{ key: "make", label: "项目实践", description: "完成实地调查、分析并验证方案" }],
  currentStageIndex: 0,
  students: [{ id: "student-1", name: "小林" }],
  groups: [{
    id: "group-1",
    name: "节水组",
    topic: "教学楼用水调查",
    goal: "识别浪费原因并提出可验证方案",
    selectedForms: ["研究报告"],
    members: [{ studentId: "student-1", name: "小林" }],
  }],
  feedback: [],
  learningEvidence: [],
  teacherAgentDirectives: [],
  content: {
    knowledgePoints: [],
    evaluationPlan: {
      overallRubric: "重视学生自主调查与证据分析过程",
      dimensions: [{ name: "证据质量", weight: 45, description: "数据由学生可靠采集并解释" }],
    },
  },
} as unknown as Course;

const acceptedFields = {
  reason: "仅整理学生已有内容，不替代证据分析。",
  requirementAnchor: { source: "document" as const, quote: "我们记录了八人的意见。" },
  intendedUse: "将已有记录放入报告附录，便于查阅原始资料。",
  availableMaterials: "学生已经提供的八人记录。",
  materialQuotes: ["我们记录了八人的意见。"],
  proposedScope: "忠实整理现有记录，不添加分析。",
  protectedLearningWork: "证据分析与结论形成",
  studentResponsibility: "亲自完成证据分析与结论",
  documentPlacement: "document" as const,
};
const passingReview = {
  passed: true,
  checks: { relevant: true, withinScope: true, faithful: true, complete: true, placement: true },
  issues: [],
};

describe("delegated work policy", () => {
  it("gives combined intake one conditional response contract without pre-accepting the task", () => {
    const prompts = buildDelegatedWorkAssessmentPrompts({
      course, studentId: "student-1", studentName: "小林", stageKey: "make",
      request: "请按已经确定的问题制作空白记录表，不替我回答。",
      documentText: "你是否支持张贴关水提醒？理由是什么？你愿意参与巡视吗？",
      includeDelivery: true,
    });
    expect(prompts.system).not.toContain("任务协调员已经确认");
    expect(prompts.system).not.toContain("studentMessage 是唯一");
    expect(prompts.system.match(/只返回严格 JSON/gu)).toHaveLength(1);
    const shape = JSON.parse(prompts.system.split("\n").at(-1)!);
    expect(shape).toMatchObject({
      decision: "accepted|protected|clarify",
      requirementAnchor: { source: "course|document|request" },
      deliverable: { documentActions: [expect.objectContaining({ operation: expect.stringContaining("replace") })] },
    });
    expect(prompts.system).toContain("protected/clarify 时省略 message、focus、deliverable");
    expect(prompts.system).toContain("未要求时不额外添加问题编号、答案分类、统计或人数汇总表");
  });

  it("distinguishes authorized heading counters from facts without bypassing course learning", () => {
    const input = {
      course, studentId: "student-1", studentName: "小林", stageKey: "make",
      request: "统一现有标题层级和编号，不改正文。",
      documentText: "研究报告\n2 调查方法\n4月10日观察10分钟。",
      documentHeadings: [{ text: "研究报告", level: 1 }, { text: "2 调查方法", level: 3 }],
    };
    const prompts = buildDelegatedWorkAssessmentPrompts(input);
    expect(prompts.system).toContain("标题序号是结构标记，不是调查数量或日期");
    expect(prompts.system).toContain("所有字段包括 reason、availableMaterials、studentResponsibility");
    expect(prompts.system).toContain("区分文稿未展示原件与现实未采集");
    expect(prompts.system).toContain("孤立旧号或原先缺号本身不构成材料不足");
    expect(prompts.system).toContain("不改标题正文、事实数值、日期或段落正文");
    expect(headingNumberingAssessmentPolicy(input.request)).toEqual({ headingNumberingPolicyVersion: "heading-numbering-intake-v1" });
    const coreCourse = { ...course, learningObjectives: ["亲自设置标题层级与编号"] };
    const protectedPrompts = buildDelegatedWorkAssessmentPrompts({ ...input, course: coreCourse });
    expect(protectedPrompts.system).toContain("若标题层级、编号或排版本身是本课核心学习，仍须 protected");
    expect(protectedPrompts.user).toContain("亲自设置标题层级与编号");
  });

  it.each([
    "统一现有标题层级和编号，保留现有编号，不改正文。",
    "统一现有标题层级和编号，从3开始，不改正文。",
    "统一现有标题层级和编号，并统一参考文献格式，不改正文。",
    "统一现有标题层级，不改正文。",
    "把已有观察记录排成表格，原始数值不变。",
  ])("does not default to renumbering outside its exact standalone scope: %s", request => {
    const prompts = buildDelegatedWorkAssessmentPrompts({
      course, studentId: "student-1", studentName: "小林", stageKey: "make", request,
      documentText: "2 调查方法：4月10日观察10分钟。",
    });
    expect(prompts.system).not.toContain("本轮是明确的现有标题编号整理");
    expect(prompts.user).toContain(request);
    expect(headingNumberingAssessmentPolicy(request)).toEqual({});
  });

  it("repairs malformed or empty delivery output only once", async () => {
    const generate = vi.fn().mockResolvedValueOnce("not JSON")
      .mockResolvedValueOnce(JSON.stringify({ deliverable: { content: "可审阅的术语表" } }));
    const repaired = await generateDelegatedDeliveryWithRepair(generate);
    expect((repaired.deliverable as { content: string }).content).toBe("可审阅的术语表");
    expect(generate.mock.calls[0]).toEqual([false]);
    expect(generate.mock.calls[1]).toEqual([true, [expect.stringContaining("交付结构无效")]]);

    const empty = vi.fn().mockResolvedValue(JSON.stringify({ deliverable: { content: "" } }));
    expect(await generateDelegatedDeliveryWithRepair(empty)).toEqual({});
    expect(empty).toHaveBeenCalledTimes(2);
  });

  it("keeps upstream model failures distinct from malformed output", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
    await expect(generateDelegatedDeliveryWithRepair(generate)).rejects.toThrow("upstream unavailable");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("requires contextual judgment instead of a static task blacklist", () => {
    const prompts = buildDelegatedWorkAssessmentPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "make",
      request: "帮我搜集校园用水数据并汇总结论",
      documentText: "我们准备调查教学楼洗手池。",
    });
    expect(prompts.system).toContain("同一项工作在不同项目中结论可以不同");
    expect(prompts.system).toContain("搜集资料并汇总");
    expect(prompts.system).toContain("只接受该部分");
    expect(prompts.system).toContain("连续布置边缘小任务");
    expect(prompts.user).toContain("自主采集数据");
    expect(prompts.user).not.toContain("证据质量（权重 45）");
    expect(prompts.user).not.toContain("重视学生自主调查与证据分析过程");
    expect(prompts.system).not.toContain("评价维度");
  });

  it("conservatively normalizes malformed assessments to clarification", () => {
    const assessment = normalizeDelegatedWorkAssessment({ decision: "maybe" });
    expect(assessment.decision).toBe("clarify");
    expect(assessment.studentResponsibility).toBeTruthy();
  });

  it("asks the student directly instead of exposing internal assessment language", () => {
    const response = assessmentToBoundaryResponse(normalizeDelegatedWorkAssessment({
      decision: "clarify",
      taskTitle: "搜集资料",
      reason: "任务描述过于模糊，需要学生澄清。",
      studentMessage: "我还不确定你想先补哪类资料。你希望我先找背景数据、案例，还是表达范例？",
      protectedLearningWork: "学生选择研究方向",
      studentResponsibility: "学生需要选择主题",
      proposedScope: "AI 可以先整理三个资料方向",
    }));
    expect(response.message).toContain("我还不确定你想先补哪类资料");
    expect(response.message).not.toContain("学生");
    expect(response.message).not.toContain("任务描述过于模糊");
  });

  it("turns protected core learning into a refusal with an auxiliary alternative", () => {
    const response = assessmentToBoundaryResponse(normalizeDelegatedWorkAssessment({
      decision: "protected",
      taskTitle: "完成实地数据调查",
      reason: "自主采集与解释数据正是本项目的核心学习目标。",
      protectedLearningWork: "学生亲自采集并解释数据",
      studentResponsibility: "规划调查、采集数据并形成结论",
      proposedScope: "帮你设计一个空白记录表和核验清单",
      needsWebResearch: false,
      searchQuery: "",
    }));
    expect(response.kind).toBe("boundary");
    expect(response.message).toContain("需要由你亲自完成");
    expect(response.message).toContain("空白记录表");
  });

  it("returns an auditable detached delivery instead of an edit suggestion", () => {
    const assessment = normalizeDelegatedWorkAssessment({
      ...acceptedFields,
      decision: "accepted",
      taskTitle: "整理术语表",
      reason: "术语整理是辅助工作。",
      protectedLearningWork: "证据分析",
      studentResponsibility: "核验术语并完成分析",
      proposedScope: "基于现有文档整理术语表",
      needsWebResearch: false,
      searchQuery: "",
    });
    const response = normalizeDelegatedWorkDelivery({
      assessment,
      researchMode: "model",
      raw: {
        message: "我完成了术语表，请你审阅。",
        deliverable: {
          title: "术语表",
          summary: "统一三个术语。",
          content: "| 术语 | 含义 |\n|---|---|\n| 流量 | 单位时间用水量 |",
          documentActions: [{
            operation: "insert-before",
            targetText: "研究方法",
            content: "| 术语 | 含义 |\n|---|---|\n| 流量 | 单位时间用水量 |",
            description: "在“研究方法”前加入术语表",
          }],
        },
      },
    });
    expect(response.kind).toBe("work-delivery");
    expect(response.suggestion).toBeUndefined();
    expect(response.message).toContain("具体改动已准备好");
    expect(response.message).not.toContain("确认后");
    expect(response.message).not.toContain("已经插入");
    expect(response.deliverable?.content).toContain("| 术语 | 含义 |");
    expect(response.deliverable?.documentActions[0]).toMatchObject({
      operation: "insert-before",
      targetText: "研究方法",
    });
  });

  it("keeps delivery as review-only when the model targets a partial or missing paragraph", () => {
    const assessment = normalizeDelegatedWorkAssessment({
      ...acceptedFields,
      decision: "accepted",
      taskTitle: "整理术语表",
      proposedScope: "整理已有术语",
    });
    const result = normalizeDelegatedWorkDelivery({
      assessment,
      researchMode: "model",
      documentText: "研究方法与对象\n我们记录了八人的意见。",
      raw: {
        deliverable: {
          content: "| 术语 | 说明 |\n|---|---|\n| 样本 | 八人 |",
          documentActions: [{
            operation: "replace",
            targetText: "研究方法",
            content: "术语表",
          }],
        },
      },
    });
    expect(result.deliverable?.documentActions).toEqual([{
      operation: "none",
      targetText: "",
      content: "",
      description: "本次只提交资料，不修改文档",
    }]);
  });

  it("does not blame an empty model delivery on the student's scope", () => {
    const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", taskTitle: "整理术语表" });
    const result = normalizeDelegatedWorkDelivery({ raw: { deliverable: { content: "" } }, assessment, researchMode: "model" });
    expect(result.message).toBe("这次内容生成未完成，请重试。");
    expect(result.delegation?.decision).toBe("unavailable");
  });

  it("keeps only cited textbook sources in a delivery", () => {
    const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", taskTitle: "整理术语表" });
    const sources = [
      { id: "textbook:one", type: "textbook" as const, title: "教材一", note: "定义", locator: "第一章" },
      { id: "textbook:two", type: "textbook" as const, title: "教材二", note: "其他内容" },
    ];
    const result = normalizeDelegatedWorkDelivery({
      raw: { deliverable: { content: "术语定义", sourceIds: ["textbook:one", "fake"] } },
      assessment, sources, researchMode: "textbook",
    });
    expect(result.deliverable?.sources).toEqual([sources[0]]);
    expect(result.deliverable?.researchMode).toBe("textbook");
  });

  it("generates contextual quick tasks from the current document", () => {
    const prompts = buildDelegatedWorkStarterPrompts({
      course,
      studentId: "student-1",
      stageKey: "make",
      documentText: "我们已经记录了三处洗手池漏水现象，但还没有统一记录单位。",
    });
    expect(prompts.user).toContain("三处洗手池漏水现象");
    expect(prompts.system).toContain("不能使用固定通用模板");
    expect(normalizeDelegatedWorkStarters({
      starters: [
        "把文稿里已有的漏水现象整理成统一字段的记录表。",
        "根据当前记录整理一份单位和术语对照表。",
        "把当前文稿中的待补信息整理成资料搜集清单。",
      ],
    })).toHaveLength(3);
    const review = buildDelegatedWorkStarterReviewPrompts({
      course,
      studentId: "student-1",
      stageKey: "make",
      documentText: "我们准备调查教学楼洗手池。",
      candidates: ["替我采集所有数据并得出最终结论。"],
    });
    expect(review.system).toContain("必须改写为边缘性支持工作");
    expect(review.user).toContain("替我采集所有数据并得出最终结论");
  });

  it("requires a real task anchor, useful purpose and sufficient materials before acceptance", () => {
    const raw = { ...acceptedFields, decision: "accepted" };
    const context = { courseText: "基于实地数据形成并验证节水方案", documentText: "我们记录了八人的意见。", request: "整理记录" };
    expect(isValidDelegatedWorkAssessment(raw, context)).toBe(true);
    expect(isValidDelegatedWorkAssessment({ ...raw, availableMaterials: "" }, context)).toBe(false);
    expect(isValidDelegatedWorkAssessment({ ...raw, intendedUse: "" }, context)).toBe(false);
    expect(isValidDelegatedWorkAssessment({ ...raw, requirementAnchor: { source: "course", quote: "并不存在的附录要求" } }, context)).toBe(false);
    expect(isValidDelegatedWorkAssessment({ ...raw, requirementAnchor: { source: "request", quote: "整理记录" } }, context)).toBe(true);
    expect(normalizeDelegatedWorkAssessment({ decision: "accepted" })).toMatchObject({ decision: "clarify", documentPlacement: "none" });
  });

  it("distinguishes unrelated work and missing inputs from protected learning", () => {
    for (const reasonCode of ["irrelevant", "missing_material", "scope_unclear"] as const) {
      const response = assessmentToBoundaryResponse(normalizeDelegatedWorkAssessment({
        decision: "clarify", reasonCode, reason: "需要明确项目用途或提供已有材料。",
        studentMessage: "请把要整理的已有记录发给我。",
      }));
      expect(response.kind).toBe("task-clarification");
      expect(response.delegation?.reasonCode).toBe(reasonCode);
      expect(response.message).not.toContain("核心学习目标");
    }
    expect(normalizeDelegatedWorkAssessment({ decision: "protected" }).reasonCode).toBe("core_learning");
  });

  it("keeps reference-only deliveries out of the document even when the model proposes append", () => {
    const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", documentPlacement: "none" });
    const response = normalizeDelegatedWorkDelivery({
      assessment, researchMode: "model", documentText: "原始报告正文",
      raw: { deliverable: { content: "只供自查的要求清单", documentActions: [{ operation: "append", content: "只供自查的要求清单" }] } },
    });
    expect(response.kind).toBe("work-delivery");
    expect(response.deliverable?.documentActions).toEqual([{ operation: "none", targetText: "", content: "", description: "本次只提交资料，不修改文档" }]);
    expect(response.message).toContain("不会改动当前文档");
  });

  it("never invents append when a document plan is missing, including older callers without document text", () => {
    const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" });
    const response = normalizeDelegatedWorkDelivery({ assessment, researchMode: "model", raw: { deliverable: { content: "已整理内容" } } });
    expect(response.deliverable?.documentActions[0].operation).toBe("none");
  });

  it("does not turn an unaccepted assessment into a deliverable", () => {
    const response = normalizeDelegatedWorkDelivery({
      assessment: normalizeDelegatedWorkAssessment({ decision: "protected" }),
      researchMode: "model", raw: { deliverable: { content: "越界结论" } },
    });
    expect(response.kind).toBe("boundary");
    expect(response.deliverable).toBeUndefined();
  });

  it("carries cross-conversation delivery scope into assessment, execution and review", () => {
    const input = { course, studentId: "student-1", studentName: "小林", stageKey: "make", request: "整理记录", documentText: "我们记录了八人的意见。", deliveredWorkSummary: "已交付：访谈记录附录；已采用：参考文献格式整理" };
    const assessment = buildDelegatedWorkAssessmentPrompts(input);
    const executionInput = { ...input, assessment: normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }) };
    const execution = buildDelegatedWorkExecutionPrompts(executionInput);
    const review = buildDelegatedWorkDeliveryReviewPrompts({ ...executionInput, delivery: { deliverable: { content: "候选表格" } } });
    for (const prompts of [assessment, execution, review]) expect(prompts.user).toContain(input.deliveredWorkSummary);
    expect(execution.system).toContain("找不到目标不能用 none 声称完成");
    expect(execution.system).toContain("禁止将定位失败降级为文末追加");
    expect(review.user).toContain("候选表格");
  });

  it("requires all semantic checks and rejects a contradictory passed flag", () => {
    expect(isValidDelegatedWorkDeliveryReview(passingReview)).toBe(true);
    expect(normalizeDelegatedWorkDeliveryReview(passingReview)).toEqual({ passed: true, issues: [] });
    expect(normalizeDelegatedWorkDeliveryReview({ passed: true }).passed).toBe(false);
    expect(normalizeDelegatedWorkDeliveryReview({ ...passingReview, checks: { ...passingReview.checks, withinScope: false } }).passed).toBe(false);
    expect(normalizeDelegatedWorkDeliveryReview({ ...passingReview, issues: ["把访谈记录改成了无关清单"] }).passed).toBe(false);
  });

  it("repairs an unrelated delivery using the review issues before exposing it", async () => {
    const first = JSON.stringify({ deliverable: { content: "通用清单" } });
    const corrected = JSON.stringify({ deliverable: { content: "所需的原始记录表" } });
    const generate = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(corrected);
    const review = vi.fn().mockResolvedValueOnce({ passed: false, issues: ["需要记录表，不能用清单替代"] }).mockResolvedValueOnce({ passed: true, issues: [] });
    const result = await generateDelegatedDeliveryWithRepair(generate, undefined, review);
    expect(result).toEqual(JSON.parse(corrected));
    expect(generate.mock.calls).toEqual([[false], [true, ["需要记录表，不能用清单替代"]]]);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("shares one repair between malformed structure and semantic failure", async () => {
    const generate = vi.fn().mockResolvedValueOnce("not JSON").mockResolvedValueOnce(JSON.stringify({ deliverable: { content: "替学生写的最终结论" } }));
    const review = vi.fn().mockResolvedValue({ passed: false, issues: ["超出批准范围"] });
    expect(await generateDelegatedDeliveryWithRepair(generate, undefined, review)).toEqual({});
    expect(generate).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("does not silently accept or regenerate after a review transport failure", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ deliverable: { content: "记录表" } }));
    const review = vi.fn().mockRejectedValue(new Error("review upstream unavailable"));
    await expect(generateDelegatedDeliveryWithRepair(generate, undefined, review)).rejects.toThrow("review upstream unavailable");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not start repair after the shared deadline expires during review", async () => {
    const controller = new AbortController();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ deliverable: { content: "记录表" } }));
    const review = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { passed: false, issues: ["超出范围"] };
    });
    await expect(generateDelegatedDeliveryWithRepair(generate, controller.signal, review)).rejects.toMatchObject({ name: "AbortError" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("checks raw locations and placement before the normalizer can drop operations", () => {
    const context = { assessment: normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), documentText: "我们记录了八人的意见。\n重复段落\n重复段落", request: "整理记录" };
    for (const targetText of ["不存在的段落", "重复段落", "我们记录了"]) {
      const result = inspectDelegatedWorkDelivery({ deliverable: { content: "我们记录了八人的意见。", documentActions: [{ operation: "replace", targetText, content: "我们记录了八人的意见。" }] } }, context);
      expect(result.passed).toBe(false);
      expect(result.issues.join(" ")).toContain("唯一完整段落");
    }
    const forbidden = inspectDelegatedWorkDelivery({ deliverable: { content: "我们记录了八人的意见。", documentActions: [{ operation: "append", content: "我们记录了八人的意见。" }] } }, { ...context, assessment: { ...context.assessment, documentPlacement: "none" } });
    expect(forbidden.issues).toContain("本次只批准对话交付，不允许文档写入操作。");
  });

  it("preserves numeric facts and source URLs in both the visible delivery and actual write", () => {
    const original = "周一记录 3.5 升，周二记录 8 升；来源 https://example.org/data";
    const context = { assessment: { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: [original] }, documentText: original, request: "将记录排成表格" };
    const table = "| 日期 | 水量 |\n|---|---|\n| 周一 | 3.5 升 |\n| 周二 | 8 升 |\n来源 https://example.org/data";
    const delivery = (content: string, write = content) => ({ deliverable: { content, documentActions: [{ operation: "replace", targetText: original, content: write }] } });
    expect(inspectDelegatedWorkDelivery(delivery(table), context).passed).toBe(true);
    expect(inspectDelegatedWorkDelivery(delivery(table.replace("3.5", "35")), context).issues.join(" ")).toContain("遗漏原始数字：3.5");
    expect(inspectDelegatedWorkDelivery(delivery(table.replace("https://example.org/data", "https://invented.example/data")), context).issues.join(" ")).toContain("原始来源链接");
    expect(inspectDelegatedWorkDelivery(delivery(table, table.replace("8 升", "9 升")), context).issues.join(" ")).toContain("文档操作计划引入材料中没有的数字：9");
  });

  it("rejects missing plans, mixed none operations, oversized content and forged material quotes", () => {
    const context = { assessment: normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), documentText: "我们记录了八人的意见。", request: "整理记录" };
    expect(inspectDelegatedWorkDelivery({ deliverable: { content: "我们记录了八人的意见。" } }, context).issues.join(" ")).toContain("不得遗漏操作计划");
    expect(inspectDelegatedWorkDelivery({ deliverable: { content: "我们记录了八人的意见。", documentActions: [{ operation: "none" }, { operation: "append", content: "我们记录了八人的意见。" }] } }, context).issues).toContain("none 不得与文档写入操作混合。");
    expect(inspectDelegatedWorkDelivery({ deliverable: { content: "我们记录了八人的意见。" + "长".repeat(8_000), documentActions: [{ operation: "none" }] } }, context).issues.join(" ")).toContain("不能截断内容");
    expect(isValidDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: ["虚构的记录"] }, { ...context, courseText: "" })).toBe(false);
  });

  it("uses the one shared repair for deterministic rejection before semantic review", async () => {
    const original = "记录 3.5 升";
    const context = { assessment: { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: [original], documentPlacement: "none" as const }, documentText: original, request: "整理记录" };
    const output = (content: string) => JSON.stringify({ deliverable: { content, documentActions: [{ operation: "none" }] } });
    const generate = vi.fn().mockResolvedValueOnce(output("记录 35 升")).mockResolvedValueOnce(output(original));
    const review = vi.fn().mockResolvedValue({ passed: true, issues: [] });
    expect((await generateDelegatedDeliveryWithRepair(generate, undefined, review, context)).deliverable).toEqual({ content: original, documentActions: [{ operation: "none" }] });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[1][1]).toContain("交付内容遗漏原始数字：3.5");
  });

  it("allows authorized heading numbering changes while retaining all seven document operations", () => {
    const names = ["项目简介", "观察问题", "记录方法", "已有数据", "学生分析", "学生结论", "参考资料"];
    const numbers = ["一", "二", "三", "四", "五", "六", "七"];
    const originals = names.map((name, index) => `# ${index + 1} ${name}`);
    const replacements = names.map((name, index) => `# ${numbers[index]}、 ${name}`);
    const assessment = { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: originals };
    const context = { assessment, documentText: originals.join("\n"), request: "请统一这七个标题的编号格式，正文不动。" };
    const raw = { deliverable: { content: replacements.join("\n"), documentActions: originals.map((targetText, index) => ({ operation: "replace", targetText, content: replacements[index] })) } };
    expect(inspectDelegatedWorkDelivery(raw, context)).toEqual({ passed: true, issues: [] });
    const response = normalizeDelegatedWorkDelivery({ raw, assessment, researchMode: "model", documentText: context.documentText });
    expect(response.deliverable?.documentActions).toHaveLength(7);
    expect(response.deliverable?.documentActions.map(action => action.content)).toEqual(replacements);
    expect(inspectDelegatedWorkDelivery(raw, { ...context, request: "只纠正错字" }).passed).toBe(false);
  });

  it("accepts reference numbering as formatting while checking publication years and URLs", () => {
    const source = "甲资料，2024，https://example.org/one\n乙资料，2025，https://example.org/two";
    const output = "[1] 甲资料，2024，https://example.org/one\n[2] 乙资料，2025，https://example.org/two";
    const context = { assessment: { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: [source], documentPlacement: "none" as const }, documentText: source, request: "请统一参考文献格式并添加引用编号。" };
    const raw = (content: string) => ({ deliverable: { content, documentActions: [{ operation: "none" }] } });
    expect(inspectDelegatedWorkDelivery(raw(output), context).passed).toBe(true);
    expect(inspectDelegatedWorkDelivery(raw(output.replace("2024", "2026")), context).passed).toBe(false);
    expect(inspectDelegatedWorkDelivery(raw(output.replace("https://example.org/one", "https://example.org/fake")), context).passed).toBe(false);
  });

  it("permits a clearly labelled row-number column without ignoring measured values", () => {
    const source = "周一 8 升；周二 5 升。";
    const table = "| 序号 | 日期 | 水量 |\n|---|---|---|\n| 1 | 周一 | 8 升 |\n| 2 | 周二 | 5 升 |";
    const context = { assessment: { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: [source], documentPlacement: "none" as const }, documentText: source, request: "把已有记录排成表格。" };
    const raw = (content: string) => ({ deliverable: { content, documentActions: [{ operation: "none" }] } });
    expect(inspectDelegatedWorkDelivery(raw(table), context).passed).toBe(true);
    expect(inspectDelegatedWorkDelivery(raw(table.replace("8 升", "9 升")), context).passed).toBe(false);
    expect(inspectDelegatedWorkDelivery(raw(table.replace("5 升", "6 升")), context).passed).toBe(false);
    expect(inspectDelegatedWorkDelivery(raw(table.replace("序号", "样本编号")), context).passed).toBe(false);
  });

  it("does not exempt quantities or dates that appear at the start of headings or ordinary lines", () => {
    const source = "# 2024 年观察记录\n8 升用水\n5 分钟观察";
    const context = { assessment: { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: [source], documentPlacement: "none" as const }, documentText: source, request: "统一标题编号格式。" };
    for (const content of [source.replace("2024", "2025"), source.replace("8 升", "9 升"), source.replace("5 分钟", "6 分钟")]) {
      expect(inspectDelegatedWorkDelivery({ deliverable: { content, documentActions: [{ operation: "none" }] } }, context).passed).toBe(false);
    }
  });

  it("permits merging two source paragraphs into one table and deleting the relocated original", () => {
    const first = "A 点：8 升；来源 https://example.org/a";
    const second = "B 点：0 升；来源 https://example.org/b";
    const table = "| 地点 | 水量 | 来源 |\n|---|---|---|\n| A 点 | 8 升 | https://example.org/a |\n| B 点 | 0 升 | https://example.org/b |";
    const context = { assessment: { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: [first, second] }, documentText: `${first}\n${second}`, request: "合并这两段记录为表格，删除重复原段，保留数值和来源。" };
    const raw = (content: string) => ({ deliverable: { content: table, documentActions: [
      { operation: "replace", targetText: first, content },
      { operation: "delete", targetText: second, content: "" },
    ] } });
    expect(inspectDelegatedWorkDelivery(raw(table), context)).toEqual({ passed: true, issues: [] });
    const missingSecond = "| 地点 | 水量 | 来源 |\n|---|---|---|\n| A 点 | 8 升 | https://example.org/a |";
    const missing = inspectDelegatedWorkDelivery(raw(missingSecond), context);
    expect(missing.passed).toBe(false);
    expect(missing.issues).toContain("文档操作计划遗漏原始数字：0");
    expect(missing.issues).toContain("文档操作计划遗漏原始来源链接：https://example.org/b");
    expect(inspectDelegatedWorkDelivery(raw(table.replace("0 升", "5 升")), context).issues).toContain("文档操作计划引入材料中没有的数字：5");
  });

  it("uses authoritative course materials only for explicitly requested reference-only requirement checklists", () => {
    const requirement = "报告包含原始记录附录与参考文献；学生亲自完成证据分析和结论。";
    const raw = { ...acceptedFields, decision: "accepted", materialQuotes: [requirement],
      requirementAnchor: { source: "course" as const, quote: requirement }, documentPlacement: "none" as const };
    const context = { courseText: `预期成果：${requirement}`, documentText: "我的记录仍在整理中。", request: "把项目要求整理成自查清单给我，只在对话里，不要写入报告。" };
    expect(isValidDelegatedWorkAssessment(raw, context)).toBe(true);
    const assessment = normalizeDelegatedWorkAssessment(raw);
    const delivery = { deliverable: { content: "- [ ] 报告附有原始记录与参考文献。\n- [ ] 我亲自完成证据分析和结论。", documentActions: [{ operation: "none" }] } };
    expect(inspectDelegatedWorkDelivery(delivery, { ...context, assessment }).passed).toBe(true);
    expect(normalizeDelegatedWorkDelivery({ raw: delivery, assessment, researchMode: "model", documentText: context.documentText }).deliverable?.documentActions[0].operation).toBe("none");
    expect(isValidDelegatedWorkAssessment({ ...raw, materialQuotes: ["并不存在的课程要求"] }, context)).toBe(false);
    expect(inspectDelegatedWorkDelivery(delivery, { ...context, assessment: { ...assessment, materialQuotes: ["并不存在的课程要求"] } }).passed).toBe(false);
    // Having a course requirement must not supply fictitious student observations or authorize new prose.
    expect(isValidDelegatedWorkAssessment(raw, { ...context, request: "把我的原始观察记录排成表格。" })).toBe(false);
    expect(isValidDelegatedWorkAssessment({ ...raw, documentPlacement: "document" }, context)).toBe(false);
    expect(inspectDelegatedWorkDelivery(delivery, { ...context, request: "把我的原始观察记录排成表格。", assessment }).passed).toBe(false);
  });

  it("allows an adjacent Markdown section counter only under an explicit heading-numbering request", () => {
    const source = "2 调查方法";
    const context = { assessment: { ...normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted" }), materialQuotes: [source] }, documentText: source, request: "统一现有标题层级和编号，不改正文。" };
    const raw = { deliverable: { content: "## 2.1调查方法", documentActions: [{ operation: "replace", targetText: source, content: "## 2.1调查方法" }] } };
    expect(inspectDelegatedWorkDelivery(raw, context).passed).toBe(true);
    expect(inspectDelegatedWorkDelivery(raw, { ...context, request: "纠正错别字。" }).passed).toBe(false);
    for (const sourceText of ["# 2024年记录", "# 8升用水", "# 5分钟记录"]) {
      const changed = sourceText.replace(/2024|8|5/u, "9");
      const check = inspectDelegatedWorkDelivery({ deliverable: { content: changed, documentActions: [{ operation: "none" }] } }, { ...context, documentText: sourceText, assessment: { ...context.assessment, materialQuotes: [sourceText] } });
      expect(check.passed).toBe(false);
    }
  });

});

it('keeps recent cumulative work and marks incomplete history instead of silently removing it', () => {
  const deliveredWorkSummary = `最早委派不应占满上下文。${'较早记录。'.repeat(2_000)}\n最新已交付：关键证据分析，不能继续代写结论。`;
  const prompts = buildDelegatedWorkAssessmentPrompts({ course, studentId: 'student-1', studentName: '小林', stageKey: 'make',
    request: '整理已有资料', documentText: '已有记录', deliveredWorkSummary });
  expect(prompts.user).toContain('最新已交付：关键证据分析，不能继续代写结论。');
  expect(prompts.user).toContain('累计记录未完整展开');
  expect(prompts.user).not.toContain('最早委派不应占满上下文。');
});

it("keeps the full request separate from the permitted auxiliary scope in all three model steps", () => {
    const request = "统一参考文献，不要写入报告，不改变原链接，再帮我写最终结论。";
    const auxiliaryRequest = "统一参考文献";
    const input = { course, studentId: "student-1", studentName: "小林", stageKey: "make", request, auxiliaryRequest,
      documentText: "甲，2025，https://example.org/reference", assessment: normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", documentPlacement: "none" }) };
    const prompts = [buildDelegatedWorkAssessmentPrompts(input), buildDelegatedWorkExecutionPrompts(input),
      buildDelegatedWorkDeliveryReviewPrompts({ ...input, delivery: { deliverable: { content: input.documentText, documentActions: [{ operation: "none" }] } } })];
    for (const step of prompts) {
      expect(step.user).toContain(`【组长原始完整安排（所有限制均有效）】\n${request}`);
      expect(step.user).toContain(`辅助范围】\n${auxiliaryRequest}`);
    }
    expect(prompts[0].system).toContain("原文的其他限制不能因拆分而丢失");
    expect(prompts[1].system).toContain("不入文、保留链接等限制");
    expect(prompts[2].system).toContain("原始完整请求及其全部限制");
  });

it("accepts a complete reference-formatting delivery with an unchanged item without repair, while rejecting altered facts", async () => {
  const originals = [
    "1. 校园后勤组：《用水设备说明》，2025年，第3页。",
    "2. 李明. 节水观察记录方法. 2024。",
    "3. 学生项目组，校园用水观察原始记录，2026年4月10日。",
  ];
  const formatted = [
    "1. 校园后勤组. 用水设备说明. 2025年. 第3页。",
    originals[1],
    "3. 学生项目组. 校园用水观察原始记录. 2026年4月10日。",
  ];
  const request = "统一报告末尾这三条参考文献的格式，不增添来源，不核验链接。";
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: originals });
  const context = { assessment, request, documentText: originals.join("\n") };
  const delivery = { deliverable: { content: formatted.join("\n"), documentActions: originals.map((targetText, index) => ({
    operation: "replace", targetText, content: formatted[index],
  })) } };
  expect(delivery.deliverable.documentActions[1].targetText).toBe(delivery.deliverable.documentActions[1].content);
  expect(inspectDelegatedWorkDelivery(delivery, context)).toEqual({ passed: true, issues: [] });
  const generate = vi.fn().mockResolvedValue(JSON.stringify(delivery));
  const review = vi.fn().mockResolvedValue({ passed: true, issues: [] });
  expect(await generateDelegatedDeliveryWithRepair(generate, undefined, review, context)).toEqual(delivery);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(review).toHaveBeenCalledExactlyOnceWith(delivery);

  const corrupted = structuredClone(delivery);
  corrupted.deliverable.content = corrupted.deliverable.content.replace("2024", "2027");
  corrupted.deliverable.documentActions[1].content = corrupted.deliverable.documentActions[1].content.replace("2024", "2027");
  expect(inspectDelegatedWorkDelivery(corrupted, context).issues).toContain("交付内容引入材料中没有的数字：2027");
  expect(inspectDelegatedWorkDelivery(delivery, { ...context, assessment: { ...assessment, documentPlacement: "none" } }).passed).toBe(false);

  const input = { ...context, course, studentId: "student-1", studentName: "小林", stageKey: "make" };
  expect(buildDelegatedWorkAssessmentPrompts(input).system).toContain("materialQuotes 仍须完整逐字保留");
  expect(buildDelegatedWorkExecutionPrompts(input).system).toContain("不附加‘格式说明’‘改动位置’‘保持原样’");
  const reviewer = buildDelegatedWorkDeliveryReviewPrompts({ ...input, delivery });
  expect(reviewer.system).toContain("targetText 与 content 相同不改变文稿");
  expect(reviewer.system).toContain("不能用原样保留掩盖未完成的必要修改");
});

it("requires the complete affected text rather than untouched evidence for a local typo correction", () => {
  const original = "这可能改善浪废水的情况。我们尚未验证。";
  const corrected = original.replace("浪废", "浪费");
  const evidence = "访谈共8人，5人支持提醒，2人不支持，1人未回答；来源 https://example.org/interviews。";
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: [original, evidence] });
  const context = { assessment, documentText: `${original}\n${evidence}`, request: "只纠正结论中的错别字，不改变任何观点和数据。" };
  const raw = { deliverable: { content: corrected, documentActions: [{ operation: "replace", targetText: original, content: corrected }] } };
  expect(inspectDelegatedWorkDelivery(raw, context)).toEqual({ passed: true, issues: [] });
  // No model-supplied "background" flag can excuse material that is actually replaced or deleted.
  const deletedEvidence = { deliverable: { ...raw.deliverable, documentActions: [...raw.deliverable.documentActions, { operation: "delete", targetText: evidence, content: "" }] } };
  expect(inspectDelegatedWorkDelivery(deletedEvidence, context).issues).toContain("文档操作计划遗漏原始数字：8");
  expect(inspectDelegatedWorkDelivery(deletedEvidence, context).issues).toContain("交付内容遗漏原始来源链接：https://example.org/interviews");
  const invented = { deliverable: { ...raw.deliverable, content: `${corrected} 2027年验证。` } };
  expect(inspectDelegatedWorkDelivery(invented, context).issues).toContain("交付内容引入材料中没有的数字：2027");
});

it("retains all approved transcription material for conversation, new writes and mixed replacement/insertion plans", () => {
  const typo = "浪废水记录";
  const records = "A点8升，B点5升；来源 https://example.org/records。";
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: [typo, records] });
  const context = { assessment, documentText: `${typo}\n${records}`, request: "修正标题错字，将全部已有记录另排成表格。" };
  const complete = "浪费水记录\n| 地点 | 水量 |\n|---|---|\n| A点 | 8升 |\n| B点 | 5升 |\n来源 https://example.org/records";
  const incomplete = complete.replace("| B点 | 5升 |\n", "");
  for (const operation of ["none", "append", "insert-after"]) {
    const action = { operation, targetText: operation === "insert-after" ? typo : "", content: operation === "none" ? "" : incomplete };
    const result = inspectDelegatedWorkDelivery({ deliverable: { content: incomplete, documentActions: [action] } }, context);
    expect(result.issues).toContain("交付内容遗漏原始数字：5");
  }
  const mixed = (insert: string) => ({ deliverable: { content: complete, documentActions: [
    { operation: "replace", targetText: typo, content: "浪费水记录" },
    { operation: "insert-after", targetText: records, content: insert },
  ] } });
  expect(inspectDelegatedWorkDelivery(mixed(complete), context).passed).toBe(true);
  expect(inspectDelegatedWorkDelivery(mixed(incomplete), context).issues).toContain("文档操作计划遗漏原始数字：5");
  expect(inspectDelegatedWorkDelivery(mixed(complete.replace("8升", "9升")), context).issues).toContain("文档操作计划引入材料中没有的数字：9");
});

it("recognizes full inline-code heading examples without exempting body quantities or publication years", () => {
  const originals = ["调查方法", "证据分析", "方案比较", "结论草稿", "附录原始记录", "参考文献", "项目说明"];
  const headings = originals.map((text, index) => `## ${index + 1} ${text}`);
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: originals });
  const context = { assessment, documentText: originals.join("\n"), request: "统一现有标题层级和编号，不改正文。" };
  const content = headings.map(heading => `- \`${heading}\``).join("\n");
  const raw = { deliverable: { content, documentActions: originals.map((targetText, index) => ({ operation: "replace", targetText, content: headings[index] })) } };
  expect(inspectDelegatedWorkDelivery(raw, context)).toEqual({ passed: true, issues: [] });
  expect(normalizeDelegatedWorkDelivery({ raw, assessment, researchMode: "model", documentText: context.documentText }).deliverable?.documentActions).toHaveLength(7);
  for (const added of ["\n- `## 8升用水`", "\n- `## 2027年文献`", "\n标题1共测得9升", "\n第1条：9升"]) {
    expect(inspectDelegatedWorkDelivery({ deliverable: { ...raw.deliverable, content: content + added } }, context).passed).toBe(false);
  }
  expect(inspectDelegatedWorkDelivery(raw, { ...context, request: "只纠正错字" }).passed).toBe(false);
});

it("uses original heading metadata in every step and blocks promoting prose under a heading-only request", () => {
  const heading = "2 调查方法";
  const paragraph = "研究问题由我们确定：两处洗手点的用水情况有什么不同？";
  const documentHeadings = [{ text: heading, level: 3 }];
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: [heading, paragraph] });
  const context = { assessment, documentHeadings, documentText: `${heading}\n${paragraph}`, request: "统一现有标题层级和编号，不改正文。" };
  const raw = (targetText: string, content: string, operation = "replace") => ({ deliverable: { content, documentActions: [{ operation, targetText, content }] } });
  expect(inspectDelegatedWorkDelivery(raw(heading, "## 1 调查方法"), context).passed).toBe(true);
  for (const candidate of [raw(paragraph, `## 1 ${paragraph}`), raw(paragraph, `## 1 研究问题\n\n${paragraph}`),
    raw(heading, "## 1 新的研究方法"), raw(heading, "## 1 调查方法", "insert-before"),
    { deliverable: { content: "不再使用标题。", documentActions: [{ operation: "delete", targetText: heading, content: "" }] } }]) {
    expect(inspectDelegatedWorkDelivery(candidate, context).issues).toContain("仅统一现有标题时，只能替换真实标题的层级与编号并保留标题文字，不能新增、删除标题或改动正文。");
  }
  expect(inspectDelegatedWorkDelivery(raw(heading, "## 1 调查方法"), { ...context, documentHeadings: [] }).passed).toBe(false);
  const input = { ...context, course, studentId: "student-1", studentName: "小林", stageKey: "make" };
  for (const prompts of [buildDelegatedWorkAssessmentPrompts(input), buildDelegatedWorkExecutionPrompts(input),
    buildDelegatedWorkDeliveryReviewPrompts({ ...input, delivery: raw(heading, "## 1 调查方法") })]) {
    expect(prompts.user).toContain(JSON.stringify(documentHeadings));
    expect(prompts.user).toContain("未列出的段落不是标题");
  }
});

it("does not apply the whole-plan heading-only guard to separately requested reference formatting", () => {
  const heading = "2 调查方法";
  const reference = "校园后勤组：《用水设备说明》，2025年。";
  const formatted = "校园后勤组. 用水设备说明. 2025年。";
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: [heading, reference] });
  const context = { assessment, documentHeadings: [{ text: heading, level: 3 }], documentText: `${heading}\n${reference}`,
    request: "统一现有标题层级和编号，不改正文，同时统一参考文献格式。" };
  const raw = { deliverable: { content: `## 1 调查方法\n${formatted}`, documentActions: [
    { operation: "replace", targetText: heading, content: "## 1 调查方法" },
    { operation: "replace", targetText: reference, content: formatted },
  ] } };
  expect(inspectDelegatedWorkDelivery(raw, context)).toEqual({ passed: true, issues: [] });
});

describe("whole-document heading numbering", () => {
  function fixture(headings: Array<{ text: string; level: number }>, replacements: string[], request = "统一现有标题层级和编号，不改正文。") {
    const documentText = [...headings.map(item => item.text), "正文记录：2025年测得8升，2人未回答。"].join("\n");
    const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: headings.map(item => item.text) });
    const context = { assessment, documentHeadings: headings, documentText, request };
    const raw = { deliverable: { content: replacements.join("\n"), documentActions: headings.map((heading, index) => ({
      operation: "replace", targetText: heading.text, content: replacements[index],
    })) } };
    return { context, raw };
  }
  const names = ["调查报告", "调查方法", "证据分析", "方案比较", "结论草稿", "原始记录", "参考文献"];
  const headings = names.map((text, index) => ({ text, level: index ? 2 : 1 }));
  const numbered = (start: number) => names.map((text, index) => index ? `## ${start + index - 1} ${text}` : `# ${text}`);

  it("rejects sections 2–7 below an unnumbered report title and accepts 1–6 without changing body facts", () => {
    const bad = fixture(headings, numbered(2));
    const good = fixture(headings, numbered(1));
    expect(inspectDelegatedWorkDelivery(bad.raw, bad.context).issues.join(" ")).toContain("从1连续编号");
    expect(inspectDelegatedWorkDelivery(good.raw, good.context)).toEqual({ passed: true, issues: [] });
    expect(good.raw.deliverable.documentActions.some(action => action.targetText.includes("正文记录"))).toBe(false);
  });

  it("uses the existing single repair and sends the numbering issue to the model", async () => {
    const bad = fixture(headings, numbered(2));
    const good = fixture(headings, numbered(1));
    const generate = vi.fn().mockResolvedValueOnce(JSON.stringify(bad.raw)).mockResolvedValueOnce(JSON.stringify(good.raw));
    const review = vi.fn().mockResolvedValue({ passed: true, issues: [] });
    expect(await generateDelegatedDeliveryWithRepair(generate, undefined, review, bad.context)).toEqual(good.raw);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][1].join(" ")).toContain("从1连续编号");
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("merges untouched headings in original order rather than numbering the action list", () => {
    const originals = [{ text: "调查报告", level: 1 }, { text: "1 调查方法", level: 2 }, { text: "2 证据分析", level: 2 }, { text: "3 方案比较", level: 2 }];
    const { context, raw } = fixture(originals, ["# 调查报告", "## 1 调查方法", "## 2 证据分析", "## 3 方案比较"]);
    raw.deliverable.documentActions = [raw.deliverable.documentActions[3], raw.deliverable.documentActions[1]];
    raw.deliverable.content = raw.deliverable.documentActions.map(action => action.content).join("\n");
    expect(inspectDelegatedWorkDelivery(raw, context).passed).toBe(true);
    raw.deliverable.documentActions[0].content = "## 4 方案比较";
    expect(inspectDelegatedWorkDelivery(raw, context).issues.join(" ")).toContain("从1连续编号");
  });

  it("checks nested prefixes and resets children for each parent", () => {
    const nested = ["调查报告", "方法", "抽样", "访谈", "结果", "观察"].map((text, index) => ({ text, level: [1, 2, 3, 3, 2, 3][index] }));
    const replacements = ["# 调查报告", "## 1 方法", "### 1.1 抽样", "### 1.2 访谈", "## 2 结果", "### 2.1 观察"];
    const good = fixture(nested, replacements);
    expect(inspectDelegatedWorkDelivery(good.raw, good.context).passed).toBe(true);
    for (const last of ["### 1.1 观察", "### 2.2 观察"]) {
      const bad = fixture(nested, [...replacements.slice(0, -1), last]);
      expect(inspectDelegatedWorkDelivery(bad.raw, bad.context).passed).toBe(false);
    }
    const mixed = fixture(nested, replacements.map((text, index) => index === 3 ? "### 2 访谈" : text));
    expect(inspectDelegatedWorkDelivery(mixed.raw, mixed.context).issues.join(" ")).toContain("编号层次须一致");
  });

  it("preserves heading years and measurements and leaves unsupported numbering styles to semantic review", () => {
    for (const titles of [["2025年调查", "8升用水记录"], ["I. 调查方法", "II. 调查结果"], ["一、 调查方法", "二、 调查结果"]]) {
      const sample = fixture(titles.map(text => ({ text, level: 2 })), titles.map(text => `## ${text}`));
      expect(inspectDelegatedWorkDelivery(sample.raw, sample.context)).toEqual({ passed: true, issues: [] });
    }
    const sample = fixture([{ text: "2025年调查", level: 2 }, { text: "8升用水记录", level: 2 }], ["## 1 2025年调查", "## 2 8升用水记录"]);
    expect(inspectDelegatedWorkDelivery(sample.raw, sample.context).passed).toBe(true);
    sample.raw.deliverable.documentActions[1].content = "## 2 9升用水记录";
    expect(inspectDelegatedWorkDelivery(sample.raw, sample.context).passed).toBe(false);
    const unsupportedParent = fixture([{ text: "一、 调查方法", level: 2 }, { text: "抽样", level: 3 }], ["## 一、 调查方法", "### 1.1 抽样"]);
    expect(inspectDelegatedWorkDelivery(unsupportedParent.raw, unsupportedParent.context).passed).toBe(true);
  });

  it("does not infer a numbering mandate for level-only, preserved numbers, explicit starts or mixed requests", () => {
    const originals = headings.map((heading, index) => ({ ...heading, text: index ? `${index + 1} ${heading.text}` : heading.text }));
    for (const request of ["统一现有标题层级，不改正文。", "统一现有标题层级和编号，保留原编号。", "统一现有标题编号，从第二章开始。", "统一现有标题编号，同时统一参考文献格式。"] ) {
      const sample = fixture(originals, numbered(2), request);
      expect(inspectDelegatedWorkDelivery(sample.raw, sample.context)).toEqual({ passed: true, issues: [] });
    }
  });
});

it("scopes an explicitly requested requirement checklist to actionable requirements in all model steps", () => {
  // Minimal regression from the synthetic case-15-2 delivery: system defaults
  // were misreported as missing student work despite an existing interview draft.
  const request = "明确把项目要求整理成自查清单给我，留在对话里，报告不需要这个章节，不要建议插入报告。";
  const requirements = "学习目标：学生自主设计和实施调查，保留原始记录；学生自主分析证据及适用范围。";
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: [requirements], documentPlacement: "none" });
  const documentText = "访谈共8人，5人支持提醒，2人不支持，1人未回答。";
  const input = { course, studentId: "student-1", studentName: "小林", stageKey: "make", request, documentText, assessment };
  const erroneous = { deliverable: { content: "当前任务：make。项目主题尚未明确；学生已有过程证据：无记录。", documentActions: [{ operation: "none" }] } };
  const prompts = [buildDelegatedWorkAssessmentPrompts(input), buildDelegatedWorkExecutionPrompts(input), buildDelegatedWorkDeliveryReviewPrompts({ ...input, delivery: erroneous })];
  for (const prompt of prompts) {
    expect(prompt.system).toContain("materialQuotes 仅逐字选取这些实际要求");
    expect(prompt.system).toContain("不能据此断言学生没有开展调查或没有过程证据");
    expect(prompt.system).toContain("不附加当前文稿事实表、标题目录或缺省状态盘点");
    expect(prompt.system).toContain("学生已有文稿的事实、访谈人数和完成进度只是核对背景，不能归为课程要求");
    expect(prompt.system).toContain("relevant/withinScope 不通过");
  }
  const unrelated = { ...input, request: "把我的访谈记录整理成表格。" };
  expect(buildDelegatedWorkAssessmentPrompts(unrelated).system).not.toContain("本次明确要求的是课程/项目要求自查清单");
  expect(buildDelegatedWorkExecutionPrompts(unrelated).system).not.toContain("本次明确要求的是课程/项目要求自查清单");
  expect(buildDelegatedWorkDeliveryReviewPrompts({ ...unrelated, delivery: erroneous }).system).not.toContain("本次明确要求的是课程/项目要求自查清单");
});

it("preserves every factual requirement without requiring unrelated document evidence in a checklist", () => {
  const request = "把项目要求整理成自查清单，只在对话交付。";
  const requirement = "教师要求：提交2份观察记录，截止2026年4月10日，依据 https://example.org/task。";
  const documentText = "访谈共8人，5人支持提醒，2人不支持，1人未回答。";
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", materialQuotes: [requirement], documentPlacement: "none" });
  const context = { request, assessment, documentText, courseText: `课程：校园节水研究\n学段：七年级\n当前任务：make\n学生已有过程证据：无记录\n${requirement}` };
  const content = "- [ ] 提交2份观察记录，截止2026年4月10日，依据 https://example.org/task。";
  const raw = (text: string) => ({ deliverable: { content: text, documentActions: [{ operation: "none" }] } });
  expect(inspectDelegatedWorkDelivery(raw(content), context)).toEqual({ passed: true, issues: [] });
  for (const corrupted of [content.replace("2份", "3份"), content.replace("2026年4月10日", "2027年4月10日"), content.replace("https://example.org/task", "")]) {
    expect(inspectDelegatedWorkDelivery(raw(corrupted), context).passed).toBe(false);
  }
  expect(inspectDelegatedWorkDelivery(raw(`${content}\n${documentText}`), context).issues).toContain("交付内容引入材料中没有的数字：8");
});


describe("accepted placement matches the original request and approved auxiliary scope", () => {
  const request = "请替我修正当前文稿中的错别字“浪废水”为“浪费水”，其他文字、观点和不确定程度逐字保持原样。这是明确委派的辅助编辑，请交付可审阅的段落替换。";
  const original = "我们尚未验证，这可能改善浪废水的情况。";
  const corrected = "我们尚未验证，这可能改善浪费水的情况。";
  const assessment = normalizeDelegatedWorkAssessment({ ...acceptedFields, decision: "accepted", documentPlacement: "none",
    materialQuotes: [original], proposedScope: "仅修正当前句中的错别字，交付可审阅的段落替换。", intendedUse: "用于当前文稿措辞修正的审阅。" });
  const context = { request, documentText: original };
  it.each([
    "帮我把当前这句话润色得通顺一点，顺便修正错别字。",
    "请润色这段文字，保留原意。",
    "能不能帮我把这段改通顺？",
    "请精简原句，保留观点。",
  ])("requires document operations for natural references to existing text: %s", request => {
    const local = { ...assessment, proposedScope: "局部润色与纠错，保持原意", intendedUse: "提供可读版本" };
    expect(inspectDelegatedWorkPlacement(local, { ...context, request }).join(" ")).toContain("documentPlacement 应为 document");
    expect(inspectDelegatedWorkPlacement({ ...local, documentPlacement: "document" }, { ...context, request })).toEqual([]);
    expect(inspectDelegatedWorkPlacement(local, { ...context, request: request + "只在对话中给我，不要入文。" })).toEqual([]);
    expect(inspectDelegatedWorkPlacement(local, { ...context, request, documentText: "" }).join(" ")).toContain("真实目标");
  });
  it.each(["", "先不要应用。", "未经我确认不得应用。", "只改错字，不改观点和其他文字。"])("requires a plan for a real current-document edit while retaining review gates: %s", constraint => {
    expect(inspectDelegatedWorkPlacement(assessment, { ...context, request: request + constraint }).join(" ")).toContain("documentPlacement 应为 document");
    expect(inspectDelegatedWorkPlacement({ ...assessment, documentPlacement: "document" }, { ...context, request: request + constraint })).toEqual([]);
  });
  it.each(["只在对话中给我修正版本。", "不要入文。", "不要建议插入报告。", "不要建议插入。", "格式整理只给我在对话中看，绝不要安排文档修改。"])("retains explicit conversation-only constraints from the full mixed request: %s", constraint => {
    const mixed = { ...context, request: request + "再替我写最终结论。" + constraint, auxiliaryRequest: "修正当前文稿中的错别字，交付可审阅的段落替换" };
    expect(inspectDelegatedWorkPlacement(assessment, mixed)).toEqual([]);
    expect(inspectDelegatedWorkPlacement({ ...assessment, documentPlacement: "document" }, mixed).join(" ")).toContain("必须为 none");
  });
  it.each([
    "怎么修正当前文稿中的错别字？只讨论方法。",
    "不要修正当前文稿。只解释错别字的意思。",
    "按已经确定的问题制作空白记录表。",
    "这段是否需要润色？",
    "怎么润色这句话？",
    "不要润色这句话。",
  ])("does not create an editing requirement for discussion, negation or a new form: %s", otherRequest => {
    expect(inspectDelegatedWorkPlacement({ ...assessment, proposedScope: "解释方法或制作空白记录表", intendedUse: "对话中参考" }, { ...context, request: otherRequest })).toEqual([]);
  });
  it.each([
    "确认前不要修改当前文稿，只生成可审阅段落替换计划，待我确认后应用。",
    "先别修改当前文稿，请给我可审阅段落替换，确认后应用。",
    "确认前不要写入当前文稿，只生成可审阅段落替换计划，待我确认后应用。",
    "未经我确认不得插入当前文档，请给我可审阅段落替换，确认后应用。",
  ])("retains reviewable plans behind a temporary document-application gate: %s", request => {
    expect(inspectDelegatedWorkPlacement(assessment, { ...context, request }).join(" ")).toContain("documentPlacement 应为 document");
    expect(inspectDelegatedWorkPlacement({ ...assessment, documentPlacement: "document" }, { ...context, request })).toEqual([]);
    for (const permanent of ["不要入文。", "只在对话给我。", "不要建议插入。", "不要写入报告。"])
      expect(inspectDelegatedWorkPlacement(assessment, { ...context, request: request + permanent })).toEqual([]);
  });
  it("does not inherit a core task's document destination into a separate reference-only auxiliary task", () => {
    expect(inspectDelegatedWorkPlacement({ ...assessment, proposedScope: "统一所给参考文献格式", intendedUse: "对话中查阅引用" }, {
      ...context, request: "统一参考文献，再把最终结论写入当前文稿。", auxiliaryRequest: "统一参考文献",
    })).toEqual([]);
  });
  it("requires real target material without overriding protected course work", () => {
    expect(inspectDelegatedWorkPlacement({ ...assessment, documentPlacement: "document" }, { ...context, documentText: "" }).join(" ")).toContain("真实目标");
    expect(inspectDelegatedWorkPlacement({ ...assessment, decision: "protected", protectedLearningWork: "本课亲自进行文档排版" }, { ...context, documentText: "" })).toEqual([]);
  });
  it("requires actual reliable operations for approved document delivery and never substitutes append", () => {
    const documentContext = { ...context, assessment: { ...assessment, documentPlacement: "document" as const } };
    const delivery = (documentActions: unknown[]) => ({ deliverable: { content: corrected, documentActions } });
    expect(inspectDelegatedWorkDelivery(delivery([{ operation: "none" }]), documentContext).issues.join(" ")).toContain("必须包含可靠文档修改操作");
    expect(inspectDelegatedWorkDelivery(delivery([{ operation: "append", content: corrected }]), documentContext).issues.join(" ")).toContain("不能以追加");
    expect(inspectDelegatedWorkDelivery(delivery([{ operation: "replace", targetText: "不存在的段落", content: corrected }]), documentContext).passed).toBe(false);
    expect(inspectDelegatedWorkDelivery(delivery([{ operation: "replace", targetText: original, content: corrected }]), documentContext).passed).toBe(true);
    expect(inspectDelegatedWorkDelivery(delivery([{ operation: "none" }]), { ...context, request: request + "只在对话中交付，不要入文。", assessment }).passed).toBe(true);
  });
});
