import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PBL_RUBRIC, emptyPblAnswers, type PblEvaluationRecord, type PblEvaluationSnapshot } from "@/lib/evaluation/pbl-contract";
import { EvaluationForm } from "./evaluation-form";
import { EvaluationRequestError } from "./use-evaluation";

vi.mock("@/components/teacher/rich-document-preview", () => ({ RichDocumentPreview: () => <div>作品正文</div> }));
const rubric = DEFAULT_PBL_RUBRIC;
const record = (version = 1): PblEvaluationRecord => ({ id: "evaluation", participationId: "p1", source: "self", assignmentId: null, version, status: "draft", rubric, answers: emptyPblAnswers(rubric), suggestedScore: null, score: null, submittedAt: null, returnedReason: null, updatedAt: "2026-10-25T00:00:00Z", history: [] });
const snapshot = (evaluation: PblEvaluationRecord): PblEvaluationSnapshot => ({ contractVersion: 2, role: "student", instanceId: "class", stage: "reflection", canWrite: true, canConfigureRubric: false, canPublish: false, config: { version: 0, rubric, peerMode: "off", reviewsPerStudent: 2, anonymous: true }, participants: [{ participationId: "p1", studentId: "s1", name: "小明", artifacts: [], selfEvaluation: evaluation, peerEvaluations: [], teacherEvaluation: null, processReport: null, published: null }], assignments: [], completion: { total: 1, selfSubmitted: 0, peerAssigned: 0, peerSubmitted: 0, teacherSubmitted: 0, published: 0 } });

describe("PBL evaluation draft lifecycle", () => {
  beforeEach(() => { sessionStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("autosaves personal reflection with null scores and submits the acknowledged version", async () => {
    vi.useFakeTimers();
    const command = vi.fn(async input => snapshot({ ...record(input.version + 1), answers: input.answers, status: input.action === "submit" ? "submitted" : "draft" }));
    render(<EvaluationForm instanceId="class" participationId="p1" source="self" record={null} rubric={rubric} canWrite command={command} refresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("我的作品与过程证据"), { target: { value: "比较了两个原型的测试结果" } });
    fireEvent.change(screen.getByLabelText("我学会了什么"), { target: { value: "理解验证与修订" } });
    fireEvent.change(screen.getByLabelText("下次准备如何改进"), { target: { value: "增加不同条件的测试" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(950); });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0][0]).toMatchObject({ action: "save", version: 0, answers: { dimensionScores: { knowledge: null }, evidence: "比较了两个原型的测试结果" } });
    expect(screen.getByRole("status").textContent).toContain("草稿已保存");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "提交自评" })); });
    expect(command.mock.calls[1][0]).toMatchObject({ action: "submit", version: 1 });
  });

  it("keeps local answers after a version conflict until the student explicitly reloads", async () => {
    const command = vi.fn().mockRejectedValue(new EvaluationRequestError("其他窗口已有修改", 409));
    const latest = record(4); latest.answers.learning = "服务器中的收获";
    const refresh = vi.fn().mockResolvedValue(snapshot(latest));
    render(<EvaluationForm instanceId="class" participationId="p1" source="self" record={record()} rubric={rubric} canWrite command={command} refresh={refresh} />);
    fireEvent.change(screen.getByLabelText("我学会了什么"), { target: { value: "本页尚未保存的想法" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("本页输入已保留"));
    expect((screen.getByLabelText("我学会了什么") as HTMLTextAreaElement).value).toBe("本页尚未保存的想法");
    expect((screen.getByRole("button", { name: "提交自评" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "放弃本页改动并载入最新版本" }));
    await waitFor(() => expect((screen.getByLabelText("我学会了什么") as HTMLTextAreaElement).value).toBe("服务器中的收获"));
  });

  it("locks submitted records and preserves unknown scores as unjudged", () => {
    render(<EvaluationForm instanceId="class" participationId="p1" source="self" record={{ ...record(), status: "submitted" }} rubric={rubric} canWrite command={vi.fn()} refresh={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "提交自评" })).toBeNull();
    expect(screen.getAllByText("无法判断")).toHaveLength(rubric.length);
    expect(screen.getByText("量规参考分：暂不计分")).toBeTruthy();
  });
});
