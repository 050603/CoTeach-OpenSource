import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShowcaseData } from "@/lib/showcase/types";
import { ShowcaseSelectionPanel } from "./showcase-selection-panel";

function data() { return { courseId: "course", queueConfig: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: ["s2"], presenterCount: 5, presentationSec: 80, discussionSec: 25, transitionSec: 10 }, students: [{ studentId: "s1", name: "甲", artifacts: [] }, { studentId: "s2", name: "乙", artifacts: [] }], queue: [{ studentId: "s1", status: "completed" }, { studentId: "s2", status: "waiting" }], budget: { stageRemainingSec: 130, plannedRemainingSec: 90, overrunSec: 0 } } as unknown as ShowcaseData; }
describe("showcase timing settings", () => {
  it("preserves the selected and completed roster and legacy notes while excluding discussion from time", async () => {
    const save = vi.fn(async () => undefined);
    render(<ShowcaseSelectionPanel data={data()} busy={false} save={save} />);
    expect(screen.queryByLabelText("讨论与点评秒数")).toBeNull();
    expect(screen.queryByLabelText("选择甲现场汇报")).toBeNull();
    expect(screen.getByText(/每人汇报与衔接 90 秒/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存人数与时间" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ selectedStudentIds: ["s2", "s1"], orderedStudentIds: ["s1", "s2"], presenterCount: 5, presentationSec: 80, discussionSec: 25, transitionSec: 10, minutesPerStudent: 2 }));
    await screen.findByText("人数与时间已保存");
  });
  it("keeps an unsaved legacy roster empty when changing only timing", async () => {
    const save = vi.fn(async () => undefined);
    const unsaved = { ...data(), queueConfig: undefined, queue: data().queue.map((item) => ({ ...item, status: "waiting" as const })) };
    render(<ShowcaseSelectionPanel data={unsaved} busy={false} save={save} />);
    expect(screen.getByText(/已选 0 人/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("汇报秒数"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人数与时间" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ selectedStudentIds: [], orderedStudentIds: [], presentationSec: 90 }));
    await screen.findByText("人数与时间已保存");
  });
  it("allows target changes and retains entered values after a failed save", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("连接中断")).mockResolvedValueOnce(undefined);
    render(<ShowcaseSelectionPanel data={data()} busy={false} save={save} />);
    fireEvent.change(screen.getByLabelText("目标汇报人数"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("汇报秒数"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人数与时间" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("连接中断");
    expect(screen.getByLabelText("目标汇报人数")).toHaveValue(4);
    expect(screen.getByLabelText("汇报秒数")).toHaveValue(90);
    fireEvent.click(screen.getByRole("button", { name: "保存人数与时间" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ presenterCount: 4, presentationSec: 90 }));
  });
});
