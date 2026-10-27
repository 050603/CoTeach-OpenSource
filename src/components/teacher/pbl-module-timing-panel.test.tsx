import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PblModuleTimingPanel } from "./pbl-module-timing-panel";
import { buildPblModelTimingPlan } from "@/lib/pbl-time-model";

const modules = [
  { id: "launch", stageKey: "launch", durationMin: 1 },
  { id: "knowledge", stageKey: "ai-learning", durationMin: 1 },
  { id: "proposal", stageKey: "proposal", durationMin: 1 },
  { id: "practice", stageKey: "make", durationMin: 1 },
  { id: "showcase", stageKey: "showcase", durationMin: 1 },
  { id: "reflection", stageKey: "reflection", durationMin: 1 },
];

describe("PblModuleTimingPanel", () => {
  it("shows a completed action after the teacher confirms the timing plan", () => {
    const suggestedPlan = buildPblModelTimingPlan(6, modules, {
      allocations: modules.map((module) => ({
        stageKey: module.stageKey,
        durationMin: 1,
        rationale: "已确认",
      })),
      evidence: [],
      assumptions: [],
      confidence: "high",
    });
    const plan = {
      ...suggestedPlan,
      status: "confirmed" as const,
      confirmedAt: "2026-08-09T00:00:00.000Z",
    };

    render(
      <PblModuleTimingPanel
        moduleActivities={modules}
        onConfirm={() => undefined}
        timingPlan={plan}
        totalMinutes={6}
      />,
    );

    const completedAction = screen.getByRole("button", { name: "时间已确认 · 项目主线已生成" });
    expect(completedAction.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "确认时间并生成项目主线" })).toBeNull();
  });

  it("discloses the model source, confidence, evidence, assumptions, and stage rationale", () => {
    const plan = buildPblModelTimingPlan(60, modules, {
      allocations: [
        { stageKey: "launch", durationMin: 6, rationale: "用校园案例建立驱动问题。" },
        { stageKey: "ai-learning", durationMin: 14, rationale: "两个核心知识点存在先修依赖。" },
        { stageKey: "proposal", durationMin: 6, rationale: "需要比较两种方案。" },
        { stageKey: "make", durationMin: 24, rationale: "保留制作与迭代时间。" },
        { stageKey: "showcase", durationMin: 7, rationale: "完成展示和反馈。" },
        { stageKey: "reflection", durationMin: 3, rationale: "形成迁移计划。" },
      ],
      evidence: ["八年级", "学生需要分步案例"],
      assumptions: ["按常规班额估算"],
      confidence: "high",
    });
    const plannedModules = modules.map((module) => ({
      ...module,
      durationMin: plan.allocations.find((item) => item.id === module.id)?.durationMin ?? 1,
    }));

    render(
      <PblModuleTimingPanel
        moduleActivities={plannedModules}
        readOnly
        timingPlan={plan}
        totalMinutes={60}
      />,
    );

    expect(screen.getByText(/大模型分析 · 高置信度/)).toBeTruthy();
    expect(screen.getByText(/学生需要分步案例/)).toBeTruthy();
    expect(screen.getByText(/按常规班额估算/)).toBeTruthy();
    expect(screen.getByText(/两个核心知识点存在先修依赖/)).toBeTruthy();
  });

  it("localizes internal vocabulary in previously saved timing plans", () => {
    const plan = buildPblModelTimingPlan(60, modules, {
      allocations: [
        { stageKey: "launch", durationMin: 6, rationale: "难度standard，priorKnowledge为空。" },
        { stageKey: "ai-learning", durationMin: 14, rationale: "foundation（kp-1）需在ai-learning阶段学习。" },
        { stageKey: "proposal", durationMin: 6, rationale: "proposal阶段比较方案。" },
        { stageKey: "make", durationMin: 24, rationale: "make阶段完成制作。" },
        { stageKey: "showcase", durationMin: 7, rationale: "showcase阶段汇报。" },
        { stageKey: "reflection", durationMin: 3, rationale: "reflection阶段迁移。" },
      ],
      evidence: ["knowledgeGraph包含kp-1"],
      assumptions: ["learningNeeds为空"],
      confidence: "medium",
    });
    const plannedModules = modules.map((module) => ({
      ...module,
      durationMin: plan.allocations.find((item) => item.id === module.id)?.durationMin ?? 1,
    }));

    const { container } = render(
      <PblModuleTimingPanel
        moduleActivities={plannedModules}
        readOnly
        timeContext={{ knowledgePoints: [{ id: "kp-1", name: "训练数据" }] }}
        timingPlan={plan}
        totalMinutes={60}
      />,
    );

    expect(container.textContent).toContain("标准难度");
    expect(container.textContent).toContain("已有知识基础为空");
    expect(container.textContent).toContain("基础层（训练数据）需在知识讲授阶段学习");
    expect(container.textContent).not.toMatch(/priorKnowledge|learningNeeds|knowledgeGraph|foundation|standard|ai-learning|proposal|make|showcase|reflection|kp-\d+/i);
  });
});
