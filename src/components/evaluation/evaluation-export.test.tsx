import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PblEvaluationSnapshot } from "@/lib/evaluation/pbl-contract";
import { EvaluationExport } from "./evaluation-export";

describe("authorized evaluation export", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each(["teacher", "student"] as const)("exports only the current %s snapshot without requesting extra data", async role => {
    const authorized = { contractVersion: 2, role, instanceId: "classroom-42", participants: [{ participationId: "allowed", name: "已授权学生" }], assignments: [] } as unknown as PblEvaluationSnapshot;
    let blob: Blob | undefined;
    vi.stubGlobal("URL", { createObjectURL: vi.fn((value: Blob) => { blob = value; return "blob:export"; }), revokeObjectURL: vi.fn() });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    let filename = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) { filename = this.download; });
    render(<EvaluationExport snapshot={authorized} />);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "导出评价 JSON" }));
    vi.runOnlyPendingTimers(); vi.useRealTimers();
    expect(filename).toBe(`pbl-evaluation-classroom-42-${role}.json`);
    const reader = new FileReader(); reader.readAsText(blob!);
    await waitFor(() => expect(reader.readyState).toBe(FileReader.DONE));
    expect(JSON.parse(String(reader.result))).toEqual(authorized);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(role === "teacher" ? "导出全班档案，包含教师可见的未发布个人记录。" : "导出当前可查看的个人评价与互评任务。")).toBeTruthy();
  });
});
