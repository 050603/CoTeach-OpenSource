import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AdaptiveLearningPlanEditor } from "@/components/teacher/adaptive-learning-plan-editor";
import { createDefaultAdaptiveLearningPlan } from "@/lib/adaptive-learning";
import type { AdaptiveLearningPlan } from "@/lib/session/types";

function addOptionalVariableExtension(plan: AdaptiveLearningPlan): AdaptiveLearningPlan {
  return {
    ...plan,
    branches: [...plan.branches, {
      id: "resource-module-scene-1",
      enabled: true,
      kind: "application",
      title: "变量 · 模块拓展",
      objective: "在新的数据记录情境中选择和使用变量",
      keyPoints: ["新数据情境", "变量选择依据"],
      anchorKnowledgePointIds: ["kp-1"],
      prerequisiteKnowledgePointIds: [],
      noveltyStatement: "新增一份主课未出现的数据记录任务和变量选择边界。",
      mainCourseOverlapSceneIds: [],
      sceneType: "interactive",
      targetDurationSec: 180,
      generationGuidance: "使用新的数据记录任务，不复述主课定义。",
      trigger: { placement: "after-module", assessmentSceneIds: ["scene-1"], evidenceRule: "module-mastery", answerRule: "score-at-least", scoreThreshold: 80, minimumRemainingSec: 180 },
      defaultTrigger: { placement: "after-module", assessmentSceneIds: ["scene-1"], evidenceRule: "module-mastery", answerRule: "score-at-least", scoreThreshold: 80, minimumRemainingSec: 180 },
      status: "draft",
    }],
  };
}

describe("AdaptiveLearningPlanEditor", () => {
  it("returns the independently repaired knowledge graph with a regenerated adaptive plan", async () => {
    const point = { id: "kp-cv", name: "图像分类", description: "理解图像分类", keyInfo: "特征支撑判断" };
    const plan = createDefaultAdaptiveLearningPlan({ knowledgePoints: [point] });
    const knowledgeGraph = {
      nodes: [{ id: "kp-cv", label: "图像分类", description: "理解图像分类", keyInfo: "特征支撑判断", instructionalRole: "lesson" as const }],
      edges: [],
    };
    const onChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plan, knowledgeGraph, persisted: true, reviewSummary: "独立审校通过" }),
    }));
    render(<AdaptiveLearningPlanEditor courseId="course-cv" knowledgePoints={[point]} onChange={onChange} plan={plan} />);

    fireEvent.click(screen.getByRole("button", { name: "按当前主课重新建模" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(plan, knowledgeGraph));
    vi.unstubAllGlobals();
  });

  it("shows the complete nested course path and edits resources inside the map", () => {
    const point = { id: "kp-1", name: "变量", description: "变量表示可变化的数据" };
    const mainScenes = [{
      id: "scene-1",
      title: "变量节点小测",
      type: "quiz" as const,
      order: 1,
      stageKey: "ai-learning",
      audience: "student" as const,
      knowledgePointIds: ["kp-1"],
    }];
    const plan = addOptionalVariableExtension(createDefaultAdaptiveLearningPlan({
      knowledgePoints: [point],
      mainScenes,
      now: "2026-07-23T00:00:00.000Z",
    }));
    const onChange = vi.fn();
    render(
      <AdaptiveLearningPlanEditor
        courseId="course-1"
        knowledgePoints={[point]}
        mainScenes={mainScenes}
        onChange={onChange}
        plan={plan}
      />,
    );

    expect(screen.getByText("个性化学习路径")).not.toBeNull();
    expect(screen.queryByText("一张图查看主课、互动与个性化拓展")).toBeNull();
    expect(screen.getByText("必经课程")).not.toBeNull();
    expect(screen.getByText("按条件插入")).not.toBeNull();
    expect(screen.getByText("诊断题 1")).not.toBeNull();
    expect(screen.getByText("主题模块 01")).not.toBeNull();
    expect(screen.getByText("步骤 01 · 主课达标测")).not.toBeNull();
    expect(screen.queryByText("个性化内容已嵌入")).toBeNull();
    expect(screen.getByText("2/2 已使用")).not.toBeNull();
    expect(screen.getByRole("button", { name: "自动分配" })).not.toBeNull();
    expect(screen.queryByText("资源插入主线")).toBeNull();
    expect(screen.queryByText("课前测题目")).toBeNull();
    expect(screen.queryByText("课前先决知识资源")).toBeNull();
    expect(screen.queryByText("模块后拓展资源")).toBeNull();
    expect(screen.getByText("先决覆盖 1/1")).not.toBeNull();
    expect(screen.getByText("可选拓展 1 处")).not.toBeNull();
    expect(screen.getAllByText("变量节点小测").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "确认资源方案" })).toBeNull();
    expect(screen.queryByText(/自动保存/)).toBeNull();

    expect(screen.getByLabelText("个性化资源工作台")).not.toBeNull();
    const resourceBlock = screen.getByRole("button", { name: /变量 · 模块拓展/ });
    let draggedId = "";
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "all",
      getData: () => draggedId,
      setData: (_type: string, value: string) => { draggedId = value; },
    };
    fireEvent.dragStart(resourceBlock, { dataTransfer });
    const pretestSlot = screen.getByLabelText("资源插入槽：课前诊断之后、主题模块 01 之前");
    fireEvent.dragEnter(pretestSlot, { dataTransfer });
    expect(pretestSlot.className).toContain("border-cyan-600");
    fireEvent.drop(pretestSlot, { dataTransfer });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      branches: expect.arrayContaining([
        expect.objectContaining({
          id: "resource-module-scene-1",
          kind: "prerequisite",
          trigger: expect.objectContaining({ placement: "before-main-course" }),
        }),
      ]),
    }));

    fireEvent.click(resourceBlock);
    expect(document.getElementById("adaptive-resource-resource-module-scene-1")?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("当前资源完整设置")).not.toBeNull();
    expect(screen.getByText("相对主课新增价值（必填）")).not.toBeNull();
    expect(screen.getByText("关联主课达标测")).not.toBeNull();

    fireEvent.change(screen.getByDisplayValue("变量 · 模块拓展"), {
      target: { value: "变量 · 新应用" },
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: "draft" }));

    fireEvent.click(screen.getByRole("button", { name: "自动分配" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      branches: expect.arrayContaining([
        expect.objectContaining({ id: "resource-module-scene-1", enabled: true }),
      ]),
    }));

    fireEvent.dragStart(resourceBlock, { dataTransfer });
    fireEvent.drop(screen.getByLabelText("个性化资源工作台"), { dataTransfer });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      branches: expect.arrayContaining([
        expect.objectContaining({ id: "resource-module-scene-1", enabled: false }),
      ]),
    }));
  });

  it("removes assigned resources from the workbench and restores generated defaults", () => {
    const point = { id: "kp-1", name: "变量", description: "变量表示可变化的数据" };
    const mainScenes = [{
      id: "scene-1",
      title: "变量节点小测",
      type: "quiz" as const,
      order: 1,
      stageKey: "ai-learning",
      audience: "student" as const,
      knowledgePointIds: ["kp-1"],
    }];
    const initialPlan = addOptionalVariableExtension(createDefaultAdaptiveLearningPlan({ knowledgePoints: [point], mainScenes }));
    function Harness() {
      const [plan, setPlan] = useState(initialPlan);
      return <AdaptiveLearningPlanEditor courseId="course-1" knowledgePoints={[point]} mainScenes={mainScenes} onChange={setPlan} plan={plan} />;
    }
    render(<Harness />);

    const inserted = screen.getByRole("button", { name: /变量 · 模块拓展，已用于本课/ });
    let draggedId = "";
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "all",
      getData: () => draggedId,
      setData: (_type: string, value: string) => { draggedId = value; },
    };
    fireEvent.dragStart(inserted, { dataTransfer });
    fireEvent.drop(screen.getByLabelText("个性化资源工作台"), { dataTransfer });

    expect(screen.queryByRole("button", { name: /变量 · 模块拓展，已用于本课/ })).toBeNull();
    expect(screen.getByRole("button", { name: /变量 · 模块拓展，暂未使用/ })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "自动分配" }));
    expect(screen.getByRole("button", { name: /变量 · 模块拓展，已用于本课/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /变量 · 模块拓展，暂未使用/ })).toBeNull();
  });

  it("opens a prepared adaptive resource through the course preview instead of a missing classroom route", () => {
    const point = { id: "kp-1", name: "变量", description: "变量表示可变化的数据" };
    const mainScenes = [{
      id: "scene-1",
      title: "变量节点小测",
      type: "quiz" as const,
      order: 1,
      stageKey: "ai-learning",
      audience: "student" as const,
      knowledgePointIds: ["kp-1"],
    }];
    const plan = createDefaultAdaptiveLearningPlan({ knowledgePoints: [point], mainScenes });
    plan.branches[0].preparedResource = { status: "ready", classroomId: "classroom-1", scenesCount: 1 };
    render(
      <AdaptiveLearningPlanEditor
        courseId="course-1"
        knowledgePoints={[point]}
        mainScenes={mainScenes}
        onChange={vi.fn()}
        plan={plan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /变量 · 课前补缺/ }));
    expect(screen.getByRole("link", { name: /预览成品/ }).getAttribute("href"))
      .toBe("/teacher/prepare/course-1/preview?adaptiveBranchId=resource-prerequisite-kp-1");
  });

  it("keeps the previous classroom preview after an edit and offers branch-only regeneration", () => {
    const point = { id: "kp-1", name: "变量", description: "变量表示可变化的数据" };
    const mainScenes = [{
      id: "scene-1",
      title: "变量节点小测",
      type: "quiz" as const,
      order: 1,
      stageKey: "ai-learning",
      audience: "student" as const,
      knowledgePointIds: ["kp-1"],
    }];
    const initialPlan = createDefaultAdaptiveLearningPlan({ knowledgePoints: [point], mainScenes });
    initialPlan.branches[0].preparedResource = { status: "ready", classroomId: "classroom-old", scenesCount: 1 };
    function Harness() {
      const [plan, setPlan] = useState(initialPlan);
      return <AdaptiveLearningPlanEditor courseId="course-1" courseName="变量课程" knowledgePoints={[point]} mainScenes={mainScenes} onChange={setPlan} plan={plan} />;
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: /变量 · 课前补缺/ }));
    fireEvent.change(screen.getByDisplayValue("变量 · 课前补缺"), {
      target: { value: "变量读取 · 课前补缺" },
    });

    expect(screen.getByRole("link", { name: /预览旧版本/ }).getAttribute("href"))
      .toBe("/teacher/prepare/course-1/preview?adaptiveBranchId=resource-prerequisite-kp-1");
    expect(screen.getByRole("button", { name: "重新生成本资源" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "仅生成已修改资源（1）" })).not.toBeNull();
  });

  it("always provides a design preview before a classroom resource exists", () => {
    const point = { id: "kp-1", name: "变量", description: "变量表示可变化的数据" };
    const mainScenes = [{ id: "scene-1", title: "变量节点小测", type: "quiz" as const, order: 1, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: ["kp-1"] }];
    const plan = createDefaultAdaptiveLearningPlan({ knowledgePoints: [point], mainScenes });
    render(<AdaptiveLearningPlanEditor courseId="course-1" knowledgePoints={[point]} mainScenes={mainScenes} onChange={vi.fn()} plan={plan} />);

    fireEvent.click(screen.getByRole("button", { name: /变量 · 课前补缺/ }));
    fireEvent.click(screen.getByRole("button", { name: "预览设计内容" }));
    expect(screen.getByLabelText(/变量 · 课前补缺设计内容预览/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "生成本资源" })).not.toBeNull();
  });
});
