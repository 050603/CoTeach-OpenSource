import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { DEFAULT_PBL_RUBRIC, type PblEvaluationSnapshot, type PblProcessReport } from "@/lib/evaluation/pbl-contract";
import { StudentPblEvaluation } from "./student-evaluation";

const mocks = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("./use-evaluation", () => ({ useEvaluation: mocks.hook }));
vi.mock("./evaluation-form", () => ({ EvaluationForm: ({ source }: { source: string }) => <div>表单：{source}</div> }));
vi.mock("@/components/teacher/rich-document-preview", () => ({ RichDocumentPreview: () => <div>作品正文</div> }));
const report = (summary: string): PblProcessReport => ({ id: summary, generatedAt: "2026-10-25T00:00:00Z", summary, dimensions: [{ id: "ai", name: "AI 协作与自主判断", judgment: "未使用 AI", score: null, evidence: [], gaps: ["未发现 AI 协作记录"], suggestion: "继续通过作品与解释展示独立思考" }] });
function data(): PblEvaluationSnapshot { return { contractVersion: 2, role: "student", instanceId: "class", stage: "reflection", canWrite: true, canConfigureRubric: false, canPublish: false, config: { version: 0, rubric: DEFAULT_PBL_RUBRIC, peerMode: "off", reviewsPerStudent: 2, anonymous: true }, participants: [{ participationId: "p1", studentId: "s1", name: "小明", artifacts: [], selfEvaluation: null, peerEvaluations: [], teacherEvaluation: null, processReport: report("仅教师可见的后续修订"), published: { at: "2026-10-25T00:00:00Z", teacherEvaluation: null, processReport: report("已发布的过程反馈") } }], assignments: [], completion: { total: 1, selfSubmitted: 0, peerAssigned: 0, peerSubmitted: 0, teacherSubmitted: 0, published: 1 } }; }
describe("student evaluation results", () => {
  beforeEach(() => { sessionStorage.clear(); });
  it("shows the published process snapshot and does not replace it with a newer private report", () => {
    mocks.hook.mockReturnValue({ snapshot: data(), refresh: vi.fn(), command: vi.fn() });
    render(<StudentPblEvaluation course={{ id: "class" } as Course} />);
    fireEvent.click(screen.getByRole("tab", { name: "已发布反馈" }));
    expect(screen.getByText("已发布的过程反馈")).toBeTruthy();
    expect(screen.queryByText("仅教师可见的后续修订")).toBeNull();
    expect(screen.getByText("本项暂不计分")).toBeTruthy();
    expect(screen.queryByText("参考分：0")).toBeNull();
  });
  it("distinguishes disabled peer review from outstanding work", () => {
    mocks.hook.mockReturnValue({ snapshot: data(), refresh: vi.fn(), command: vi.fn() });
    render(<StudentPblEvaluation course={{ id: "class" } as Course} />);
    fireEvent.click(screen.getByRole("tab", { name: /同伴互评/ }));
    expect(screen.getByText("本次未安排同伴互评。")).toBeTruthy();
  });
});
