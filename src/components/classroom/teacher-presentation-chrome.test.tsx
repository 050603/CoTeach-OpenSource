import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getStagesForSystemMode } from "@/lib/system-mode";
import type { Course } from "@/lib/session/types";
import { TeacherPresentationControls } from "./teacher-presentation-chrome";

function controls(index = 0, stages = getStagesForSystemMode(), pending = false) {
  const onStage = vi.fn();
  const onEnd = vi.fn();
  render(<TeacherPresentationControls
    course={{ stages, currentStageIndex: index } as Course}
    view="teaching" details={false} discussion={false}
    onView={vi.fn()} onWorkspace={vi.fn()} onDetailsClose={vi.fn()}
    onTools={vi.fn()} onStage={onStage} onEnd={onEnd}
    stageTransitionPending={pending}
  />);
  return { onStage, onEnd };
}

describe("teacher classroom stage controls", () => {
  it.each([0, 1, 2, 3, 4])("keeps stage navigation last, with tools and stage actions to its left in stage %i", index => {
    controls(index);
    const left = screen.getByRole("group", { name: "左侧展示操作" });
    const right = screen.getByRole("group", { name: "右侧课堂操作" });
    const actions = within(right).getByRole("group", { name: "当前阶段常用操作" });
    const tools = within(right).getByRole("button", { name: "工具" });
    const navigation = within(right).getByRole("group", { name: "教学阶段切换" });
    expect(within(left).getByRole("group", { name: "当前阶段资料操作" })).toBeInTheDocument();
    expect(actions.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tools.nextElementSibling).toBe(navigation);
    expect(right.lastElementChild).toBe(navigation);
  });

  it("groups stage selection and both arrows in an accessible navigation group", () => {
    const { onStage } = controls(1);
    const navigation = within(screen.getByRole("group", { name: "教学阶段切换" }));
    expect(navigation.getByRole("combobox", { name: "当前教学阶段" })).toHaveValue("1");
    fireEvent.click(navigation.getByRole("button", { name: "上一教学阶段" }));
    fireEvent.click(navigation.getByRole("button", { name: "下一教学阶段" }));
    fireEvent.change(navigation.getByRole("combobox"), { target: { value: "3" } });
    expect(onStage.mock.calls).toEqual([[0], [2], [3]]);
  });

  it("disables backward navigation at the first stage and keeps ending out of the footer", () => {
    controls();
    expect(screen.getByRole("button", { name: "上一教学阶段" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一教学阶段" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "结束课堂" })).toBeNull();
  });

  it.each([1, 4, 5])("uses the actual last stage in a %i-stage classroom for the end button", count => {
    const stages = getStagesForSystemMode().slice(0, count);
    const { onEnd } = controls(count - 1, stages);
    expect(screen.getByRole("button", { name: "下一教学阶段" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "结束课堂" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("blocks stage changes and ending while the final transition is pending", () => {
    const { onStage, onEnd } = controls(4, getStagesForSystemMode(), true);
    expect(screen.getByRole("combobox", { name: "当前教学阶段" })).toBeDisabled();
    for (const name of ["上一教学阶段", "下一教学阶段", "结束课堂"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onStage).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

it.each(["teaching", "analytics", "student-work"] as const)("removes practice workspace controls in %s", view => {
  render(<TeacherPresentationControls course={{ stages: getStagesForSystemMode(), currentStageIndex: 2 } as Course} view={view} details={true} discussion={false} onView={vi.fn()} onWorkspace={vi.fn()} onDetailsClose={vi.fn()} onTools={vi.fn()} onStage={vi.fn()} onEnd={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "课堂操作" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^返回/ })).toBeNull();
  for (const name of ["授课展示", "班级学情", "学生成果"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
});

it.each(["teaching", "analytics"] as const)("keeps showcase on its default interface without workspace controls in %s", view => {
  render(<TeacherPresentationControls course={{ stages: getStagesForSystemMode(), currentStageIndex: 3 } as Course} view={view} details={true} discussion={false} onView={vi.fn()} onWorkspace={vi.fn()} onDetailsClose={vi.fn()} onTools={vi.fn()} onStage={vi.fn()} onEnd={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "课堂操作" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^返回/ })).toBeNull();
  for (const name of ["授课展示", "班级学情", "工具", "下一教学阶段"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
});
