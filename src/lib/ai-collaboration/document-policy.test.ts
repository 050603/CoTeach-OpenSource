import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import {
  buildDocumentCollaborationPrompts,
  buildDocumentDiscussionReviewPrompts,
  documentDiscussionReviewFlags,
  documentDiscussionReviewPassed,
  isValidDocumentDiscussionReview,
  detectProtectedStudentWorkRequest,
  documentHtmlToPlainText,
  documentProgressPositionProjection,
  usesDocumentProgressProjection,
  inspectCoreConclusionResponse,
  coreConclusionResponsePolicy,
  evaluateAiWorkPolicy,
  normalizeDocumentCollaborationResponse,
  protectedBoundaryForPolicy,
  separableAuxiliaryTask,
} from "./document-policy";

const course = {
  id: "course-1",
  name: "校园节水项目",
  drivingQuestion: "怎样减少校园中的水资源浪费？",
  expectedOutcome: "一份可验证的节水改进方案",
  learningObjectives: ["使用证据解释问题", "验证方案效果"],
  stages: [{ key: "proposal", label: "方案构思", description: "形成可验证的节水方案" }],
  currentStageIndex: 0,
  students: [{ id: "student-1", name: "小林", joinedAt: "2026-08-25T00:00:00.000Z", stageProgress: {} }],
  groups: [{
    id: "group-1",
    name: "节水行动组",
    topic: "教学楼洗手池节水",
    goal: "找到主要浪费原因并提出可验证的改进",
    selectedForms: ["方案报告"],
    keywords: ["节水"],
    members: [{ studentId: "student-1", name: "小林" }],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  }],
  feedback: [],
  learningEvidence: [],
  teacherAgentDirectives: [],
  content: {
    knowledgePoints: [{ id: "kp-1", name: "变量控制" }],
    evaluationPlan: { dimensions: [{ name: "证据质量", weight: 40 }] },
  },
} as unknown as Course;

describe("document AI collaboration policy", () => {
  it("keeps explicit concept questions accurate without inventing project calculations or conditions", () => {
    const context = { course, studentId: 'student-1', studentName: '学生', stageKey: 'proposal',
      intent: 'discuss' as const, documentText: '访谈共8人，5人支持，2人反对，1人未回答。' };
    const prompts = buildDocumentCollaborationPrompts({ ...context, request: '“未回答”和“不支持”的区别是什么？只解释概念。' });
    expect(prompts.system).toContain('不额外代入项目人数做未请求的换算');
    expect(prompts.system).toContain('不能因为拿到一组样本就把这组对象改称研究总体');
    expect(prompts.system).toContain('未回答表示态度未知，不能归入不支持');
    expect(buildDocumentCollaborationPrompts({ ...context, request: '请解释观察时长一致是什么意思，不修改文档。' }).system)
      .toContain('本次只解释概念或方法');
    expect(buildDocumentCollaborationPrompts({ ...context, request: '根据已有记录总结进度，只在对话里说明。' }).system)
      .not.toContain('本次只解释概念或方法');
  });

  it("respects feedback-only requests without turning a support count into a replacement conclusion", () => {
    const context = { course, studentId: 'student-1', studentName: '学生', stageKey: 'proposal',
      intent: 'discuss' as const, documentText: '访谈共8人，5人支持，2人反对，1人未回答。' };
    const feedback = buildDocumentCollaborationPrompts({ ...context,
      request: '我写所有人支持，但记录只有五人支持，哪里有问题？不要替我重写结论。' });
    expect(feedback.system).toContain('只解释原句的问题及核对方法，不提供新的结论句');
    expect(feedback.system).toContain('支持人数不能改称总样本或比例的分母');
    expect(buildDocumentCollaborationPrompts({ ...context, request: '五人支持八人受访，为什么不能说所有人支持？' }).system)
      .not.toContain('本次学生明确只要定位问题');
    expect(buildDocumentCollaborationPrompts({ ...context, request: '请帮我重写最终结论。' }).system)
      .not.toContain('本次学生明确只要定位问题');
  });

  it("treats the editor content as an in-progress live draft", () => {
    const prompts = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "discuss",
      request: "这个方向还有什么问题？",
      documentText: "我准备先记录三天用水情况。",
    });
    expect(prompts.system).toContain("协作从草稿形成时就开始");
    expect(prompts.system).toContain("核心问题定义、关键方案决策、核心结论、最终提交");
    expect(prompts.user).toContain("编辑器中的最新实时草稿");
    expect(prompts.user).toContain("我准备先记录三天用水情况");
    expect(prompts.user).not.toContain("证据质量");
    expect(prompts.user).not.toContain("权重 40");
    expect(prompts.system).toContain("不向学生展示评分规则");
    expect(prompts.user).toContain("教学楼洗手池节水");
    expect(prompts.user).toContain("形成可验证的节水方案");
    expect(prompts.user).toContain("方案报告");
  });

  it("keeps proactive collaboration narrow and non-editing", () => {
    const prompts = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "check",
      request: "看一眼当前草稿",
      documentText: "我们已经记录了三个时间段，但还没有说明为什么选择这些时间。",
      proactive: true,
    });
    expect(prompts.user).toContain("克制的主动观察");
    expect(prompts.user).toContain("不得返回修改建议");
  });

  it("gives discussion and delegated tasks distinct, teammate-oriented instructions", () => {
    const discussion = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "discuss",
      request: "我们下一步该看什么？",
      documentText: "已经观察了三个课间的用水情况。",
    });
    expect(discussion.user).toContain("直接回答学生的问题");
    expect(discussion.system).toContain("通常不超过约 120 个汉字");
    expect(discussion.system).toContain("每项单独一行");
    expect(discussion.system).toContain("学生明确要求详细解释");
    expect(discussion.system).toContain("不得替学生形成核心结论");

    const task = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "organize",
      request: "把这两段整理得更清楚",
      documentText: "第一段。\n\n第二段。",
      selectedText: "第一段。\n\n第二段。",
    });
    expect(task.user).toContain("执行学生明确委托");
    expect(task.system).toContain("用两个换行分隔段落");
    expect(task.system).toContain("不要只复述任务或罗列通用建议");
  });

  it("binds an edit suggestion to the exact client selection", () => {
    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "我只整理这一处表达。",
      focus: "测试步骤",
      suggestion: {
        title: "整理测试步骤",
        targetText: "模型试图替换成别的范围",
        replacement: "连续三天在同一时段记录用水量。",
        reason: "让时间和动作更明确。",
      },
    }, "记录几天的用水情况");
    expect(result.kind).toBe("edit-suggestion");
    expect(result.suggestion?.operation).toBe("replace");
    expect(result.suggestion?.targetText).toBe("记录几天的用水情况");
  });

  it("allows a bounded delegated task to propose an insertion", () => {
    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "我整理了一段非核心背景，写入前请核对。",
      focus: "背景说明",
      suggestion: {
        operation: "insert",
        title: "补充背景说明",
        targetText: "",
        replacement: "现有观察显示，用水高峰主要集中在课间时段。",
        reason: "只整理草稿中已经出现的观察。",
      },
    }, undefined, undefined, "organize");
    expect(result.kind).toBe("edit-suggestion");
    expect(result.suggestion?.operation).toBe("insert");
  });

  it("downgrades an edit response when no text was selected", () => {
    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "请选择范围。",
      suggestion: { replacement: "整篇新文档" },
    });
    expect(result.kind).toBe("discussion");
    expect(result.suggestion).toBeUndefined();
  });

  it("extracts readable text from the rich-text document", () => {
    expect(documentHtmlToPlainText("<h2>方案</h2><p>先观察&amp;记录</p><p>再验证</p>"))
      .toBe("方案\n先观察&记录\n再验证");
  });

  it("deterministically protects student-owned core decisions and final work", () => {
    expect(detectProtectedStudentWorkRequest("帮我直接确定最终方案"))
      .toBe("关键方案决策");
    expect(detectProtectedStudentWorkRequest("请你生成完整项目报告"))
      .toBe("完整成果或最终提交");
    expect(detectProtectedStudentWorkRequest("帮我检查核心问题是否清楚"))
      .toBeUndefined();

    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "你可以先比较两个方案的证据要求，再亲自决定。",
      suggestion: { replacement: "AI 选定的方案" },
    }, "学生原文", "关键方案决策");
    expect(result.kind).toBe("boundary");
    expect(result.suggestion).toBeUndefined();
  });

  it("extracts a clearly separate auxiliary task from a mixed core request", () => {
    expect(separableAuxiliaryTask("帮我写最终结论，同时把已有访谈记录整理成表格"))
      .toBe("把已有访谈记录整理成表格");
    expect(separableAuxiliaryTask("请你直接写出我们的核心结论")).toBeNull();
    expect(separableAuxiliaryTask("帮我整理资料并写出最终结论"))
      .toBe("帮我整理资料");
    expect(separableAuxiliaryTask("统一参考文献，再帮我写最终结论"))
      .toBe("统一参考文献");
    expect(separableAuxiliaryTask("只修正‘浪废水’错别字，再替我写最终结论"))
      .toBe("只修正‘浪废水’错别字");
    expect(separableAuxiliaryTask("统一参考文献，同时把已有记录整理成表格，再帮我写最终结论"))
      .toBe("统一参考文献；把已有记录整理成表格");
  });

  it("keeps core project decisions in guide-only mode", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "discuss",
      request: "请直接写出我们的核心结论",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("guide_only");
    expect(decision.allowedOperations).toEqual(["none"]);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.protectedCapability).toBe("核心结论");
  });

  it("keeps ordinary discussion guidance internal instead of presenting it as a boundary", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "discuss",
      request: "我们记录了三个课间，下一步应该重点比较什么？",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("guide_only");
    expect(protectedBoundaryForPolicy(decision, "我们记录了三个课间，下一步应该重点比较什么？"))
      .toBeUndefined();

    const protectedDecision = evaluateAiWorkPolicy({
      intent: "discuss",
      request: "请直接写出我们的核心结论",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(protectedBoundaryForPolicy(protectedDecision, "请直接写出我们的核心结论"))
      .toBe("核心结论");
  });

  it("distinguishes learning about a core conclusion from asking the AI to make it", () => {
    for (const request of [
      "核心结论应该怎么写？请解释思路。",
      "帮我梳理如何得出核心结论，我想先比较两组数据。",
      "我已经写好核心结论，帮我检查用词是否清楚。",
      "请帮我整理已有的关键方案，不要替我做选择。",
      "请你解释如何确定最终方案，并给出比较维度。",
      "帮我分析怎么选择研究问题，我会自己决定。",
      "请你解释如何直接确定最终方案，但选择仍由我来做。",
    ]) {
      expect(detectProtectedStudentWorkRequest(request)).toBeUndefined();
      expect(evaluateAiWorkPolicy({
        intent: "discuss", request, scope: "document", hasStudentArtifact: true,
      }).protectedCapability).toBeUndefined();
    }
    for (const request of [
      "请直接写出我们的核心结论",
      "最终方案直接帮我确定",
      "请你生成整份可提交的报告",
      "帮我写一份完整报告",
      "替我选一个最终方案",
    ]) {
      expect(detectProtectedStudentWorkRequest(request)).toBeTruthy();
    }
  });

  it("requires student confirmation for an explicit local edit", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "edit",
      request: "把这句话润色得更清楚",
      scope: "selection",
      selectedText: "我们观察了几个时间段。",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("local_suggestion");
    expect(decision.scope).toBe("selection");
    expect(decision.allowedOperations).toEqual(["replace"]);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("does not let proactive review run before student work exists", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "check",
      request: "看看这一段有没有问题",
      scope: "paragraph",
      proactive: true,
      hasStudentArtifact: false,
      selectedText: "",
    });
    expect(decision.outcome).toBe("guide_only");
    expect(decision.requiresExistingStudentWork).toBe(true);
    expect(decision.allowedOperations).toEqual(["none"]);
  });

  it("requires student confirmation for bounded auxiliary work", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "delegate",
      request: "整理已有观察，列出需要核对的资料来源",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("delegated_edit");
    expect(decision.allowedOperations).toEqual(["insert", "append"]);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("keeps a selected delegate request local", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "delegate",
      request: "整理这段表达",
      scope: "selection",
      selectedText: "我们观察了几个时间段。",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("local_suggestion");
    expect(decision.scope).toBe("selection");
    expect(decision.allowedOperations).toEqual(["replace"]);
  });
});


it("reviews all semantic obligations without assuming a particular project or data set", () => {
  const checks = { quantifiers: true, arithmetic: true, population: true, uncertainty: true, grounded: true, learningBoundary: true };
  expect(documentDiscussionReviewPassed({ passed: true, checks, issues: [] })).toBe(true);
  for (const key of Object.keys(checks)) {
    expect(documentDiscussionReviewPassed({ passed: true, checks: { ...checks, [key]: false }, issues: [] })).toBe(false);
  }
  expect(isValidDocumentDiscussionReview({ passed: true, checks: {}, issues: [] })).toBe(false);
  expect(documentDiscussionReviewPassed({ passed: true, checks, issues: ["已提供明确反例"] })).toBe(false);
  const prompts = buildDocumentDiscussionReviewPrompts({ context: "已观察到一例不符合。", request: "只解释概念：全称命题。",
    candidate: { kind: "discussion", message: "是否全部符合只取决于抽样方式。" } });
  expect(prompts.system).toContain("已有明确反例即可否定同一范围的全称断言");
  expect(prompts.system).toContain("核实算术、分母、比例和阈值");
  expect(prompts.system).toContain("未知不等于反对");
  expect(prompts.system).toContain("最终可见正文");
  expect(prompts.user).toContain("已观察到一例不符合。");
  expect(documentDiscussionReviewFlags("检查有什么问题，不要重写")).toEqual({ feedbackOnly: true, conceptOnly: false });
  expect(documentDiscussionReviewFlags("只解释概念：抽样是什么意思").conceptOnly).toBe(true);
  expect(documentDiscussionReviewFlags("接下来如何推进项目？")).toEqual({ feedbackOnly: false, conceptOnly: false });
});

it("reviews summaries against authoritative requirements and exact document state without applying concept-only restrictions", () => {
  const prompts = buildDocumentDiscussionReviewPrompts({
    context: "课程要求：研究报告。小组成果形式：尚未选择。正文：已有访谈记录。附录：只有观察记录。分析：待完成。",
    request: "总结已完成和待完成工作。", candidate: { kind: "discussion", message: "成果形式未定，访谈已在附录，已完成分析。" },
  });
  expect(prompts.system).toContain("课程已经明确的目标或成果形式");
  expect(prompts.system).toContain("某资料已记录不等于已经收入附录");
  expect(prompts.system).toContain("不混淆分别发生与共同总计");
  expect(prompts.system).toContain("总结可以准确转述已有材料");
  expect(prompts.system).not.toContain("本轮只解释概念/方法");
  expect(prompts.system).not.toContain("本轮仅定位问题、明确不要重写");
});

it("keeps protected and clarification responses constrained without accepting an answer merely because it starts with refusal", () => {
  for (const expectedKind of ["boundary", "task-clarification"] as const) {
    const prompts = buildDocumentDiscussionReviewPrompts({ context: "学生负责核心分析。", request: "请替我完成项目。",
      expectedKind, candidate: { kind: expectedKind, message: "不能代做，不过按以下结论写。" } });
    expect(prompts.system).toContain(`本轮 kind 必须为 ${expectedKind}`);
    expect(prompts.system).toContain("不能仅凭带有拒绝措辞或某个词语放行/拦截");
    expect(prompts.system).toContain("已有delegation判定与学生责任是锁定数据");
  }
});


describe("progress summary source positions", () => {
  const html = '<p>标题前说明。</p><h1>调查报告</h1><p>研究问题尚待确定。</p>'
    + '<h3>记录</h3><p>访谈统计在正文。</p><h2>附录</h2><p>地点甲原始记录。</p>'
    + '<table><tr><td>地点乙</td><td>0个</td></tr></table><ul><li>尚未验证</li></ul>'
    + '<h2>记录</h2><p>第三份独立记录。</p>';
  const parse = (projection: string) => projection.split("\n").map(line => JSON.parse(line));

  it("retains real heading ancestry, repeated titles, preamble, tables and lists without moving material", () => {
    const [meta, ...sections] = parse(documentProgressPositionProjection(html, 16_000));
    expect(meta).toMatchObject({ totalSections: 5, omittedSections: 0, omittedBodyCharacters: 0 });
    expect(sections[0]).toMatchObject({ headingPath: [], text: "标题前说明。" });
    expect(sections[2].headingPath).toEqual([{ level: 1, text: "调查报告" }, { level: 3, text: "记录" }]);
    expect(sections[3].headingPath).toEqual([{ level: 1, text: "调查报告" }, { level: 2, text: "附录" }]);
    expect(sections[3].text).toContain("地点甲原始记录");
    expect(sections[3].text).toContain("地点乙 0个");
    expect(sections[3].text).toContain("尚未验证");
    expect(sections[3].text).not.toContain("访谈统计");
    expect(sections[4].headingPath.at(-1)).toEqual({ level: 2, text: "记录" });
    expect(sections.map(section => section.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([6_000, 16_000])("accounts for every omitted section and body character within the %i cap", cap => {
    const source = Array.from({ length: 32 }, (_, index) => `<h2>章节${index}</h2><p>${'逐字材料“需核对”'.repeat(1000)}</p>`).join("");
    const projection = documentProgressPositionProjection(source, cap);
    const [meta, ...sections] = parse(projection);
    expect(projection.length).toBeLessThanOrEqual(cap);
    expect(meta.totalSections).toBe(32);
    expect(meta.omittedSections + sections.length).toBe(32);
    expect(meta.omittedBodyCharacters).toBeGreaterThan(0);
    const visibleCharacters = sections.reduce((sum, section) => sum + section.text.replace("\n【片段中部省略】\n", "").length, 0);
    expect(meta.totalBodyCharacters).toBe(visibleCharacters + meta.omittedBodyCharacters);
    expect(sections.some(section => section.index === 1)).toBe(true);
    expect(sections.some(section => section.index === 32)).toBe(true);
    for (const section of sections) expect(section.omittedBodyCharacters).toBeGreaterThanOrEqual(0);
  });

  it("replaces flat summary text once and preserves unrelated, selected and proactive prompt bytes", () => {
    const base = { course, studentId: "student-1", studentName: "学生", stageKey: "proposal",
      intent: "discuss" as const, documentText: documentHtmlToPlainText(html), documentHtml: html };
    const request = "根据已有记录总结我们已完成和待完成的工作，只在对话里说明。";
    const prompts = buildDocumentCollaborationPrompts({ ...base, request });
    expect(prompts.user).toContain('"headingPath"');
    expect(prompts.user.match(/访谈统计在正文/g)).toHaveLength(1);
    expect(prompts.system).toContain("若有省略，未展示不能当作不存在");
    for (const patch of [
      { request: "我写所有人支持，哪里有问题？不要替我重写结论。" },
      { request, selectedText: "访谈统计在正文。" },
      { request, proactive: true },
      { request, intent: "organize" as const },
    ]) {
      const withHtml = buildDocumentCollaborationPrompts({ ...base, ...patch });
      const withoutHtml = buildDocumentCollaborationPrompts({ ...base, ...patch, documentHtml: undefined });
      expect(withHtml).toEqual(withoutHtml);
      expect(usesDocumentProgressProjection({ ...base, ...patch })).toBe(false);
    }
  });
});

describe("explicit core conclusion replacement guard", () => {
  const request = "根据这些数据替我写最终结论，可以直接交。";
  it.each([
    '只能写“受访者中多数支持”，不能写“所有人支持”。',
    '只能写成“受访者中多数支持”。',
    '这只能说明“受访者中多数支持”，而且只覆盖这8人。',
    '只能说明“受访者中多数支持”。',
    '这表明“当前措施得到支持”。',
    '这意味着：“当前措施得到支持”。',
    '样本中只能说多数支持。',
    '这只能说明受访者中多数支持。',
    '只能说明具体方案有效。',
    '可以写成“受访者中多数支持”。',
    '原文可以写成“受访者中多数支持”。',
    '请把原文写成“受访者中多数支持”。',
    '核对步骤可以写成“受访者中多数支持”。',
    '先讨论核对方法，然后结论可以写成“受访者中多数支持”。',
    '结论可表述为“该措施在本次观察中有效”。',
    '把原句改为“受访者中多数支持”。',
    "结论应该写成‘目前证据支持该选择’。",
  ])("rejects a positive copyable replacement even if preceded by refusal: %s", text => {
    expect(inspectCoreConclusionResponse(request, "boundary", { message: `不能代写。${text}` })).toHaveLength(1);
  });
  it.each([
    '草稿写“所有人支持”，已有明确反对记录，请核对这处矛盾。',
    '不能改为“多数受访者支持”，请你自己核对证据范围。',
    '不要写成“该措施已被证明有效”。',
    '不可以写成“所有人都支持”。',
    '不应该写成“所有人都支持”。',
    '不能说这表明“所有人都支持”。',
    '不要说这意味着“当前措施已被证明有效”。',
    '你原文写成“这表明当前措施有效”，但记录仍标为尚未验证。',
    '请自己回答“这只能说明什么、不能说明什么”的核对问题。',
    '现有材料不足以支持所有人。',
    '只能说明现有证据不足，需你核对范围。',
    '这只能说明“现有证据不足，需你核对范围”。',
    '不能说样本中只能说多数支持。',
    '原文写“样本中只能说多数支持”，请核对它与记录的关系。',
    '请核对人数与分母，再判断是否可以使用多数一词。',
    '只能说明方案有效性尚待核验。',
    '只能说明多数支持者的意见尚未记录完整。',
    '你原文写成“所有人都支持”，与已记录反对意见矛盾。',
    '不能代写结论。核对步骤可以写成“先列出反例，再核对样本范围”，最后由你自己判断。',
    '可以写成“证据支持什么、不能支持什么、还需验证什么”的问题框架，再自己作答。',
    '8人中有5人支持，2人反对；已有反例，与“所有人”矛盾。',
    '先核对原始记录、分析范围和未验证之处。',
  ])("allows quoted source criticism, negation and unanswered method frames: %s", text => {
    expect(inspectCoreConclusionResponse(request, "boundary", { message: text })).toEqual([]);
  });
  it("is scoped to forced core conclusions and checks nextStep without treating source quotations as advice", () => {
    const visible = { message: '不能代写。', support: { nextStep: '只能写“受访者中多数支持”。' } };
    expect(inspectCoreConclusionResponse(request, "boundary", visible)).toHaveLength(1);
    expect(inspectCoreConclusionResponse(request, "discussion", visible)).toEqual([]);
    expect(inspectCoreConclusionResponse("只检查这句，不要重写", "boundary", visible)).toEqual([]);
    expect(inspectCoreConclusionResponse(request, "boundary", { message: "请核对原文。", support: { sources: [{ quote: visible.support.nextStep }] } })).toEqual([]);
    expect(coreConclusionResponsePolicy(request, "boundary")).toEqual({ coreConclusionGuardVersion: "core-refusal-conclusion-v3" });
    expect(coreConclusionResponsePolicy("总结已完成和待完成的工作", "discussion")).toEqual({});
  });
  it("adds focused refusal instructions only to forced, unselected and non-proactive requests", () => {
    const base = { course, studentId: "student-1", studentName: "学生", stageKey: "proposal", intent: "delegate" as const,
      request, documentText: "已有调查记录。", protectedBoundary: "核心结论" };
    const prompts = buildDocumentCollaborationPrompts(base);
    expect(prompts.system).toContain("再给1—2个可用方法");
    expect(prompts.system).toContain("不提供替换结论句");
    for (const patch of [{ protectedBoundary: undefined }, { selectedText: "已有调查记录。" }, { proactive: true }]) {
      expect(buildDocumentCollaborationPrompts({ ...base, ...patch }).system).not.toContain("再给1—2个可用方法");
    }
    const boundaryReview = buildDocumentDiscussionReviewPrompts({ context: "文稿", request, expectedKind: "boundary", candidate: {} });
    expect(boundaryReview.system).toContain("不提供替换结论句");
    expect(boundaryReview.system).toContain("这只能说明/这表明/这意味着");
    expect(boundaryReview.system).toContain("局部结论");
    const feedbackReview = buildDocumentDiscussionReviewPrompts({ context: "文稿", request: "只检查已有表述哪里有问题，不要重写。", expectedKind: "discussion", candidate: {} });
    expect(feedbackReview.system).not.toContain("这只能说明/这表明/这意味着");
    expect(inspectCoreConclusionResponse(request, "discussion", { message: '这只能说明“受访者中多数支持”。' })).toEqual([]);
    expect(inspectCoreConclusionResponse(request, "discussion", { message: "样本中只能说多数支持。" })).toEqual([]);
    expect(boundaryReview.system).toContain("样本中只能说多数支持");
    expect(boundaryReview.system).toContain("只是证据缺口，可以保留");
  });
});

it("keeps discussion meanings and method conditions faithful without prescribing an attitude label", () => {
  const input = { course, studentId: "student-1", studentName: "小林", stageKey: "make", intent: "discuss" as const,
    request: "检查哪里有问题，不要重写。", documentText: "访谈中2人不支持，尚未验证。", selectedText: "", history: [] };
  const prompt = buildDocumentCollaborationPrompts(input);
  expect(prompt.system).toContain("来源实际记录的各态度类别");
  expect(prompt.system).not.toContain("总样本、支持、反对和未回答人数");
  expect(prompt.system).toContain("汇总人数与分类结果不等于已提供逐人原话");
  expect(prompt.system).toContain("未展示、未记录、尚未验证不等于没有开展");
  expect(prompt.system).toContain("观察、访谈、问卷等独立证据通道");
  expect(buildDocumentCollaborationPrompts({ ...input, request: "只解释概念：观察时长一致是什么意思？" }).system)
    .toContain("不要从按时间归一的速率单位推出");
  const review = buildDocumentDiscussionReviewPrompts({ context: "真实材料", request: input.request,
    candidate: { kind: "discussion", message: "检查记录" } });
  expect(review.system).toContain("不支持不等于明确反对");
  expect(review.system).toContain("建议、修改指令和下一步中的来源限定");
  expect(review.system).toContain("不能承诺下一步代定调查问题");
  expect(review.system).toContain("定义上的归一化与实际测量值、均值和精度");
  expect(buildDocumentCollaborationPrompts({ ...input, intent: "edit", request: "修正错字", selectedText: "浪废水" }).system)
    .not.toContain("含义保真：沿用来源的态度类别");
});


it("blocks a collateral conclusion replacement after refusing any core task, without changing ordinary feedback", () => {
  const message = '另有一处表述待你核对：结论草稿写“所有人都支持”，按原记录只能表述为“访谈样本中多数支持”。';
  for (const request of ["替我确定本项目的研究问题。", "直接替我选择最终方案并写理由。", "替我完成证据分析。"])
    expect(inspectCoreConclusionResponse(request, "boundary", { message }, true)).toHaveLength(1);
  expect(inspectCoreConclusionResponse("本课程要求的创作请你来做", "boundary", { message }, true)).toHaveLength(1);
  for (const request of ["检查已有表述", "总结已完成和待完成工作"])
    expect(inspectCoreConclusionResponse(request, "discussion", { message }, true)).toEqual([]);
  for (const allowed of [
    "5人支持并非全部8人，请核对原句的范围。",
    '不能改为“样本中多数支持”，这处表述应由你核对并修改。',
    '你原文写成“所有人都支持”，与记录不一致。',
    '请沿用“不支持”这一类别，不宜写成“反对”。',
    '核对步骤可以写成“先列出原始类别，再核对样本范围”。',
  ]) expect(inspectCoreConclusionResponse("替我确定本项目的研究问题。", "boundary", { message: allowed })).toEqual([]);
  const review = buildDocumentDiscussionReviewPrompts({ context: "项目材料", request: "替我确定研究问题", expectedKind: "boundary", candidate: { message } });
  expect(review.system).toContain("即使当前请求不是写结论");
  expect(review.system).toContain("不能把一种核查办法、强推荐或充分保障说成唯一前提");
  expect(review.system).toContain("不能只因首句定义正确就放行");
});
