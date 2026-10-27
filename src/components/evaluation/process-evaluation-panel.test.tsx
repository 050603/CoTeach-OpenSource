import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { DEFAULT_PBL_RUBRIC, type PblEvaluationSnapshot } from "@/lib/evaluation/pbl-contract";
import type { ProcessEvaluationSnapshot, RawPblProcessReport } from "@/lib/evaluation/process-contract";
import { ProcessEvaluationPanel } from "./process-evaluation-panel";

const mocks = vi.hoisted(() => ({ hook: vi.fn(), fetch: vi.fn() }));
vi.mock("./use-evaluation", () => ({ useEvaluation: mocks.hook }));
vi.mock("@/lib/browser/bounded-fetch", () => ({ boundedFetch: mocks.fetch }));
vi.mock("@/components/teacher/rich-document-preview", () => ({ RichDocumentPreview: () => null }));
const now = "2026-10-25T03:00:00Z";
const report: RawPblProcessReport = { schemaVersion: 1, id: "r1", instanceId: "class", participationId: "p1", studentId: "s1", stageKey: "make", generatedAt: now, snapshotAt: now, evidenceThrough: now, fingerprint: "f1", summary: "旧报告保留", dimensions: [{ dimensionId: "iteration", name: "迭代", score: null, rationale: "仅发现一次保存", evidenceIds: ["edit"], evidenceGaps: [], improvements: [] }], evidence: [{ id: "edit", kind: "saved-version", stageKey: "make", occurredAt: now, title: "作品第二版", actor: "student", content: "增加对照条件", relatedEvidenceIds: ["dialogue"], limitations: [] }, { id: "dialogue", kind: "practice-dialogue", stageKey: "make", occurredAt: "2026-10-25T02:00:00Z", title: "AI 协作建议", actor: "ai", content: "建议比较同一时段", relatedEvidenceIds: [], limitations: ["AI 建议本身不代表学生掌握"] }], evidenceGaps: ["缺少知识测验记录"], confidence: "low", source: "insufficient-evidence" };
function authorizedSnapshot(): PblEvaluationSnapshot {
  return { contractVersion: 2, role: "teacher", instanceId: "class", stage: "make", canWrite: true, canConfigureRubric: false, canPublish: false,
    config: { version: 0, rubric: DEFAULT_PBL_RUBRIC, peerMode: "off", reviewsPerStudent: 1, anonymous: true }, assignments: [],
    completion: { total: 1, selfSubmitted: 0, peerAssigned: 0, peerSubmitted: 0, teacherSubmitted: 0, published: 0 },
    participants: [{ participationId: "p1", studentId: "s1", name: "小林", artifacts: [], selfEvaluation: null, peerEvaluations: [], teacherEvaluation: null, published: null,
      processReport: { id: "r1", generatedAt: now, summary: report.summary, dimensions: [], evidenceThrough: now, evidenceGaps: report.evidenceGaps, confidence: report.confidence, source: report.source } }] };
}
describe("teacher process evaluation status and evidence", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.hook.mockReturnValue({ snapshot: authorizedSnapshot(), refresh: vi.fn().mockResolvedValue(undefined) }); });
  it("shows global gaps, preserves the report on failure and retries with teacher authorization", async () => {
    let status = "FAILED";
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") { status = "PENDING"; return Response.json({ queued: 1 }); }
      return Response.json({ reports: [report], jobs: [{ id: "job", participationId: "p1", status, error: "MODEL_TIMEOUT", updatedAt: now }], participants: [] } satisfies ProcessEvaluationSnapshot);
    });
    render(<ProcessEvaluationPanel course={{ id: "class" } as Course} />);
    await screen.findByRole("button", { name: "重试此人报告" });
    expect(screen.getByText("旧报告保留")).toBeTruthy();
    expect(screen.getByText("缺少知识测验记录")).toBeTruthy();
    expect(screen.getByText("证据支持程度：有限")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试此人报告" }));
    await screen.findByText("已排队，等待生成过程报告…");
    expect(screen.getByRole("button", { name: "生成或更新此人报告" })).toBeDisabled();
    const post = mocks.fetch.mock.calls.find(([, init]) => init.method === "POST")!;
    expect(post[1].headers["x-auth-role"]).toBe("teacher");
    expect(JSON.parse(post[1].body)).toEqual({ participationId: "p1" });
    expect(screen.getByText("旧报告保留")).toBeTruthy();
  });
  it("expands the timeline and verified source association with their limitations", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ reports: [report], jobs: [], participants: [] }));
    render(<ProcessEvaluationPanel course={{ id: "class" } as Course} />);
    fireEvent.click(await screen.findByText("过程证据时间线（2）"));
    fireEvent.click(screen.getByText("作品第二版", { exact: true }));
    fireEvent.click(screen.getByText("关联依据：AI 协作建议"));
    expect(screen.getAllByText("建议比较同一时段")).toHaveLength(2);
    expect(screen.getByText(/ · 实践 · 作品修改 · 学生$/)).toBeTruthy();
    expect(screen.getByText("AI 建议本身不代表学生掌握", { exact: true })).toBeTruthy();
    await waitFor(() => expect(mocks.hook.mock.results[0].value.refresh).toHaveBeenCalled());
  });
  it("summarizes class evidence gaps and concrete suggestions in roster order and opens the selected dossier", async () => {
    const snapshot = authorizedSnapshot();
    snapshot.participants.push({ ...snapshot.participants[0], participationId: "p2", studentId: "s2", name: "小陈", processReport: { id: "r2", generatedAt: now, summary: "小陈的过程反馈", confidence: "high", dimensions: [{ id: "iteration", name: "迭代", score: 90, judgment: "有迭代证据", evidence: [], gaps: [], suggestion: "补充控制条件的解释" }] } }, { ...snapshot.participants[0], participationId: "p3", studentId: "s3", name: "小张", processReport: null });
    mocks.hook.mockReturnValue({ snapshot, refresh: vi.fn().mockResolvedValue(undefined) });
    mocks.fetch.mockResolvedValue(Response.json({ reports: [], jobs: [], participants: [] }));
    render(<ProcessEvaluationPanel course={{ id: "class" } as Course} />);
    const focus = screen.getByRole("region", { name: "班级关注点" });
    expect(within(focus).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["查看 小林 的过程报告", "查看 小陈 的过程报告"]);
    expect(within(focus).getByText("尚无报告或未使用 AI 均不代表能力不足，也不作为低分依据。")).toBeTruthy();
    expect(within(focus).getByText("迭代：补充控制条件的解释")).toBeTruthy();
    fireEvent.click(within(focus).getByRole("button", { name: "查看 小陈 的过程报告" }));
    expect(screen.getByLabelText("查看学生")).toHaveValue("p2");
    expect(screen.getByText("小陈的过程反馈")).toBeTruthy();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  });
});
