import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const motionPreference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", () => ({ useReducedMotion: () => motionPreference.reduced }));

import { StageGenerationCardStack, type StageGenerationCardData } from "./stage-generation-card-stack";

function cards(ids: string[]): StageGenerationCardData[] {
  return ids.map((id) => ({
    id,
    eyebrow: "正在生成",
    title: id,
    detail: `${id} 的真实生成信息`,
    items: ["质量检查"],
  }));
}

describe("StageGenerationCardStack", () => {
  it("keeps keys unique while live job cards change", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<StageGenerationCardStack cards={cards(["stage-base", "stage-evaluationPlan"])} kind="quickCourse" />);

    view.rerender(<StageGenerationCardStack cards={cards(["stage-evaluationPlan", "stage-lessonOutline"])} kind="quickCourse" />);
    await act(async () => Promise.resolve());

    expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
    expect(view.getAllByRole("article", { hidden: true })).toHaveLength(2);
    error.mockRestore();
  });

  it("deduplicates repeated stage ids from transient polling payloads", async () => {
    const view = render(
      <StageGenerationCardStack
        cards={cards(["stage-lessonOutline", "stage-lessonOutline", "stage-adaptiveLearning"])}
        kind="quickCourse"
      />,
    );
    await act(async () => Promise.resolve());

    expect(view.getAllByRole("article", { hidden: true })).toHaveLength(2);
  });

  it("cycles the visible card while preserving one usable action and pauses when stopped", () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const props = { cards: cards(["first", "second"]), kind: "quickCourse" as const, actionLabel: "查看", onAction: action };
    const view = render(<StageGenerationCardStack {...props} />);
    try {
      expect(view.getByRole("article").textContent).toContain("second");
      expect(view.getAllByRole("button", { hidden: true })).toHaveLength(1);
      fireEvent.click(view.getByRole("button", { name: "查看" }));
      expect(action).toHaveBeenCalledOnce();
      act(() => vi.advanceTimersByTime(5_600));
      expect(view.getByRole("article").textContent).toContain("first");
      view.rerender(<StageGenerationCardStack {...props} running={false} />);
      act(() => vi.advanceTimersByTime(11_200));
      expect(view.getByRole("article").textContent).toContain("first");
      expect(view.getByRole("button", { name: "查看" })).toBeEnabled();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("keeps reduced-motion cards still and does not lose an action", () => {
    vi.useFakeTimers(); motionPreference.reduced = true;
    const view = render(<StageGenerationCardStack cards={cards(["first", "second"])} kind="quickCourse"
      actionLabel="查看" onAction={() => undefined} />);
    try {
      act(() => vi.advanceTimersByTime(16_800));
      expect(view.getByRole("article").textContent).toContain("second");
      expect(view.getByRole("button", { name: "查看" })).toBeEnabled();
      expect(view.container.querySelector('.stage-card-scan')).toBeNull();
    } finally { view.unmount(); motionPreference.reduced = false; vi.useRealTimers(); }
  });

});
