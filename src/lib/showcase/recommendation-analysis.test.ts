// @vitest-environment node
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/llm/client", () => ({ callLLM: vi.fn(), parseLLMJson: (value: string) => JSON.parse(value) }));
vi.mock("@/lib/llm/classroom-capacity", () => ({ withBackgroundAiPriority: (fn: () => unknown) => fn() }));
vi.mock("@/lib/observability/classroom-ai", () => ({ withClassroomAiUsage: (_scope: unknown, fn: () => unknown) => fn() }));
vi.mock("./recommendation-service", () => ({ showcaseAnalysisContext: vi.fn() }));
vi.mock("./persistence", () => ({ showcaseStore: {} }));
import { analyzeShowcaseEvidence, showcaseHtmlEvidence } from "./recommendation-analysis";
const dimensions = [{ id: "work", name: "作品", description: "", weight: 100 }];

it("extracts readable paragraph evidence without scripts or markup instructions", () => {
  expect(showcaseHtmlEvidence('<h1>实验结果</h1><p>三次 &amp; 对照实验</p><script>ignored()</script><p>温度&#x4E3A;20℃</p>')).toEqual([
    { location: "段落 1", text: "实验结果", heading: true }, { location: "段落 2", text: "三次 & 对照实验" }, { location: "段落 3", text: "温度为20℃" },
  ]);
});

it("does not fabricate quality results for unreadable works or unsupported model evidence", async () => {
  const generate = vi.fn();
  await expect(analyzeShowcaseEvidence({ blocks: [], requirements: "", dimensions }, new AbortController().signal, generate)).rejects.toThrow("QUALITY_TEXT_INSUFFICIENT");
  expect(generate).not.toHaveBeenCalled();
  generate.mockResolvedValue(JSON.stringify({ dimensionScores: { d1: 90 }, reasons: [{ text: "结果可靠", location: "段落 1", quote: "伪造的引用原文" }] }));
  await expect(analyzeShowcaseEvidence({ blocks: [{ location: "段落 1", text: "实际实验数据至少包含二十个字符，结论已经记录。" }], requirements: "", dimensions }, new AbortController().signal, generate)).rejects.toThrow("QUALITY_EVIDENCE_REQUIRED");
});

it("makes one bounded screening call and validates reasons only against supplied excerpts", async () => {
  const quote = "这里是最后一段的实验结论";
  const blocks = [{ location: "段落 1", text: "数据".repeat(12_000) }, { location: "段落 2", text: quote }];
  const generate = vi.fn(async (messages: Array<{ content: string }>) => {
    const request = JSON.parse(messages[1].content);
    if (request.part) return JSON.stringify({ summary: `完整分段${request.part}`, evidence: request.content.map((item: { location: string; text: string }) => ({ location: item.location, quote: item.text.slice(0, 20) })) });
    return JSON.stringify({ dimensionScores: { d1: 88 }, reasons: [{ text: "结论清楚", location: "段落 2", quote }] });
  });
  const result = await analyzeShowcaseEvidence({ blocks, requirements: "保留实验结论", dimensions }, new AbortController().signal, generate);
  expect(generate).toHaveBeenCalledTimes(1);
  const request = JSON.parse(generate.mock.calls[0][0][1].content);
  expect(request.content.reduce((n: number, b: { text: string }) => n + b.text.length, 0)).toBeLessThanOrEqual(8000);
  expect(request.coverage.mode).toBe("sampled");
  expect(result).toMatchObject({ qualityScore: 88, reasons: [{ quote, location: "段落 2" }] });
});

it("uses short model ids and maps scores back to the original rubric without fuzzy id matching", async () => {
  const rubric = [40, 30, 20, 10].map((weight, i) => ({ id: `dimension-hash${i}`, name: `量规${i}`, weight, description: "作品内容" }));
  const generate = vi.fn(async (messages: Array<{ content: string }>) => {
    const request = JSON.parse(messages[1].content);
    expect(request.dimensions.map((d: { id: string }) => d.id)).toEqual(["d1", "d2", "d3", "d4"]);
    return JSON.stringify({ dimensionScores: { d1: 80, d2: 70, d3: 60, d4: 50 }, reasons: [{ text: "证据对应", location: "段落 1", quote: "实验有对照组" }] });
  });
  const result = await analyzeShowcaseEvidence({ blocks: [{ location: "段落 1", text: "实验有对照组，三次结果一致，结论基于可核实的数据。" }], requirements: "任务", dimensions: rubric }, new AbortController().signal, generate);
  expect(result.dimensionScores).toEqual({ "dimension-hash0": 80, "dimension-hash1": 70, "dimension-hash2": 60, "dimension-hash3": 50 });
  expect(result.qualityScore).toBe(70);
});
