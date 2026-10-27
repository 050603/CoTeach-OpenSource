import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparationPlanFixture } from "@/lib/collaborative-preparation/fixtures.test-support";
import { PreparationPlanReview } from "./preparation-plan-review";

describe("PreparationPlanReview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("groups the complete plan and distinguishes teacher statements from proposed content", () => {
    const plan = preparationPlanFixture();
    render(<PreparationPlanReview plan={plan} fieldOrigins={{ courseName: "teacher-stated", grade: "teacher-stated", learningObjectives: "ai-proposed" }} />);
    const review = screen.getByLabelText("完整课程方案");
    expect(within(review).getByRole("heading", { name: plan.courseName })).toBeVisible();
    const overview = within(review).getByRole("region", { name: "课程概况" });
    expect(overview).toHaveTextContent("科学");
    expect(overview).toHaveTextContent("四年级");
    expect(overview).toHaveTextContent("45 分钟");
    expect(overview).toHaveTextContent("1 课次");
    expect(within(overview).getAllByText("教师已明确")).toHaveLength(2);
    expect(within(review).getByRole("region", { name: "学习目标" })).toHaveTextContent("AI 建议 · 待确认");
    expect(within(review).getByRole("region", { name: "学情与教学方式" })).toHaveTextContent(plan.learnerContext);
    expect(within(review).getByRole("region", { name: "知识范围与深度" })).toHaveTextContent(plan.knowledgePoints[0].depth);
    expect(within(review).getByRole("region", { name: "成果与评价" })).toHaveTextContent("实验记录");
    expect(review).toHaveTextContent(plan.stagePlan.evaluationCriteria);
    expect(review).toHaveTextContent(plan.stagePlan.reflectionQuestions[0]);
    expect(review).toHaveTextContent(plan.teacherRequirements[0]);
  });

  it("shows one stage at a time and switches all stage details without mutating the plan", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const plan = preparationPlanFixture();
    plan.stagePlan.stages[2] = { ...plan.stagePlan.stages[2], requirements: "设计对照实验", outputs: "实验变量对照表", teacherActions: "检查变量控制", aiActions: "提醒记录观察时间", checkpoints: ["仅改变通风条件"], observationPoints: ["学生混淆变量时及时介入"] };
    const before = structuredClone(plan);
    render(<PreparationPlanReview plan={plan} />);
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByRole("tab", { name: "项目启动" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "项目实践" }));
    const panel = screen.getByRole("tabpanel", { name: "项目实践" });
    expect(screen.queryByRole("tabpanel", { name: "项目启动" })).toBeNull();
    expect(panel).toHaveTextContent("设计对照实验");
    expect(panel).toHaveTextContent("实验变量对照表");
    expect(panel).toHaveTextContent("检查变量控制");
    expect(panel).toHaveTextContent("提醒记录观察时间");
    expect(panel).toHaveTextContent("仅改变通风条件");
    expect(panel).toHaveTextContent("学生混淆变量时及时介入");
    expect(fetch).not.toHaveBeenCalled();
    expect(plan).toEqual(before);
    expect(screen.queryByRole("button", { name: /确认|生成/ })).toBeNull();
  });

  it("supports keyboard stage navigation and recovers when a selected stage is no longer available", () => {
    const plan = preparationPlanFixture();
    const { rerender } = render(<PreparationPlanReview plan={plan} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "项目启动" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "知识讲授" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "知识讲授" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("tab", { name: "知识讲授" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "反思评价" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "反思评价" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "项目启动" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "项目启动" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "反思评价" })).toHaveFocus();
    rerender(<PreparationPlanReview plan={{ ...plan, stagePlan: { ...plan.stagePlan, stages: plan.stagePlan.stages.slice(0, 2) } }} />);
    expect(screen.getByRole("tab", { name: "项目启动" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "项目启动" })).toBeVisible();
  });

  it("retains detailed deliverables, rubric, required reflection, AI boundaries and showcase logistics", () => {
    const plan = preparationPlanFixture();
    plan.stagePlan.evaluationRubric = { id: "rubric", version: 1, sourceWeights: { teacher: 70, ai: 30 }, dimensions: [{ id: "evidence", name: "证据解释", weight: 100, description: "以观察记录支持结论" }] };
    plan.stagePlan.reflectionQuestionSet = { id: "reflection", version: 1, questions: [{ id: "r1", prompt: "下次如何改进实验？", required: true }] };
    plan.stagePlan.aiUsagePolicy = "AI 仅协助记录，不代替学生提出假设。";
    plan.stagePlan.showcasePlan = { presenterCount: 3, presentationSec: 60, discussionSec: 30, transitionSec: 0 };
    const { rerender } = render(<PreparationPlanReview plan={plan} confirmed />);
    expect(screen.getByLabelText("完整课程方案")).toHaveTextContent("教师已确认");
    expect(screen.queryByText("AI 建议 · 待确认")).toBeNull();
    expect(screen.getByText("评价分工：教师 70% · AI 30%")).toBeVisible();
    expect(screen.getByText("以观察记录支持结论")).toBeVisible();
    expect(screen.getByText("下次如何改进实验？（必答）")).toBeVisible();
    expect(screen.getByRole("region", { name: "AI 使用边界" })).toHaveTextContent(plan.stagePlan.aiUsagePolicy);
    expect(screen.getByText("选取 3 人汇报")).toBeVisible();
    expect(screen.getByText("每人汇报 60 秒")).toBeVisible();
    expect(screen.getByText("讨论 30 秒")).toBeVisible();
    expect(screen.getByText("衔接 0 秒")).toBeVisible();
    rerender(<PreparationPlanReview plan={{ ...plan, stagePlan: { ...plan.stagePlan, evaluationRubric: { ...plan.stagePlan.evaluationRubric, scoringMode: "teacher-final" } } }} />);
    expect(screen.getByText("教师终审 · AI 提供评价建议")).toBeVisible();
    expect(screen.queryByText("评价分工：教师 70% · AI 30%")).toBeNull();
  });

  it("shows honest empty and partial states without invented stages or requirements", () => {
    const { rerender } = render(<PreparationPlanReview plan={{}} />);
    expect(screen.getByLabelText("完整课程方案")).toHaveTextContent("课程方案尚未形成");
    expect(screen.queryByRole("tablist")).toBeNull();
    rerender(<PreparationPlanReview plan={{ courseName: "待讨论的主题" }} />);
    expect(screen.getByText("教学阶段尚待明确。")).toBeVisible();
    expect(screen.getByText("教师特别要求待明确。")).toBeVisible();
    rerender(<PreparationPlanReview plan={{ courseName: "待讨论的主题", teacherRequirements: [] }} />);
    expect(screen.getByText("暂无特别要求。")).toBeVisible();
  });
});
