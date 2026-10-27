import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/llm/client", () => ({ callLLM: vi.fn(), parseLLMJson: JSON.parse }));
vi.mock("@/lib/llm/classroom-capacity", () => ({ withBackgroundAiPriority: (operation: () => Promise<unknown>) => operation() }));
import { analyzeProcessEvidence, validateProcessAnalysis, type ProcessEvidenceSnapshot } from "./process-analysis";
import { PROCESS_DIMENSIONS, type PblProcessEvidence } from "./process-contract";

const evidence: PblProcessEvidence = { id: "save:1", kind: "saved-version", stageKey: "make", occurredAt: "2026-10-25T10:00:00Z",
  title: "已保存修改", actor: "student", content: "修改前没有测试；修改后补充了测试数据。", relatedEvidenceIds: [], limitations: [] };
function output() { return { summary: "根据记录，作品增加了验证依据。", confidence: "medium", evidenceGaps: [], dimensions: PROCESS_DIMENSIONS.map(d => ({
  dimensionId: d.id, score: 80, rationale: "保存记录包含修改前后的依据。", evidenceIds: [evidence.id], evidenceGaps: [], improvements: ["补充重复验证"] })) }; }
function snapshot(items: PblProcessEvidence[]): ProcessEvidenceSnapshot { return { participationId: "p", instanceId: "i", studentId: "s", offeringId: "o", name: "学生",
  snapshotAt: "2026-10-25T10:00:00Z", context: { name: "项目", drivingQuestion: "如何验证", learningObjectives: [] }, stageKey: "make", contractVersion: 2, status: "TEACHING", evidence: items, gaps: [],
  evidenceThrough: items.at(-1)?.occurredAt ?? null, fingerprint: "fingerprint" }; }
describe("PBL process analysis", () => {
  it("never invents scores or calls a model without student evidence", async () => {
    const generate = vi.fn();
    const report = await analyzeProcessEvidence(snapshot([]), "r", new AbortController().signal, generate);
    expect(generate).not.toHaveBeenCalled();
    expect(report.dimensions.map(d => d.score)).toEqual([null, null, null, null]);
    expect(report.source).toBe("insufficient-evidence");
  });
  it("rejects fabricated citations rather than retaining unsupported positive scores", () => {
    const result = output(); result.dimensions[0].evidenceIds = ["other-student:1"];
    expect(() => validateProcessAnalysis(result, [evidence])).toThrow("PROCESS_EVIDENCE_REFERENCE_INVALID");
  });
  it("AI output and presentation attendance alone do not establish learner competence", () => {
    const analysis = validateProcessAnalysis(output(), [{ ...evidence, actor: "ai" }]);
    expect(analysis.dimensions.every(d => d.score === null)).toBe(true);
  });
  it("does not infer iteration or AI competence from a final product or one saved draft", () => {
    const analysis = validateProcessAnalysis(output(), [evidence]);
    expect(analysis.dimensions[2].score).toBeNull();
    expect(analysis.dimensions[3].score).toBeNull();
  });
  it("preserves a supported zero and an explicitly unknown AI collaboration dimension", () => {
    const result = output(); result.dimensions[0].score = 0;
    const raw = { ...result, dimensions: result.dimensions.map((d, index) => index === 3 ? { ...d, score: null, evidenceIds: [], evidenceGaps: ["未使用AI"] } : d) };
    const analysis = validateProcessAnalysis(raw, [evidence]);
    expect(analysis.dimensions[0].score).toBe(0);
    expect(analysis.dimensions[3].score).toBeNull();
  });
  it("passes real changes as untrusted evidence and retains the evidence snapshot", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify(output()));
    const report = await analyzeProcessEvidence(snapshot([evidence]), "r", new AbortController().signal, generate);
    expect(report.evidence[0].id).toBe("save:1");
    expect(report.fingerprint).toBe("fingerprint");
    expect(generate.mock.calls[0][0][0].content).toContain("不可信数据");
    expect(generate.mock.calls[0][0][1].content).toContain("修改后补充了测试数据");
  });
});
