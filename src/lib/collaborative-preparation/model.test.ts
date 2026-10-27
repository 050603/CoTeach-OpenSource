import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({ callLLM: mocks.call, parseLLMJson: JSON.parse }));
import { generatePreparationTurn } from "./model";
import type { PreparationSessionSnapshot } from "./types";

const snapshot: PreparationSessionSnapshot = { id: "session", revision: 1, status: "processing", turns: [{ id: "turn:user", role: "user", content: "四年级，45分钟，讨论蒸发", createdAt: "2026-10-23" }], currentQuestion: null, plan: {}, fieldOrigins: {}, readyToConfirm: false, missingFields: [], suggestions: [], referenceIds: [], textbookSelections: [], referenceMaterials: [], confirmed: null, error: null };
describe("collaborative preparation model", () => {
  it("saves raw output before attempting schema validation", async () => {
    const persisted = vi.fn().mockResolvedValue(undefined);
    mocks.call.mockResolvedValue('{"message":"缺少结构"}');
    await expect(generatePreparationTurn({ snapshot, sourceContext: "", onResponse: persisted })).rejects.toThrow();
    expect(persisted).toHaveBeenCalledWith('{"message":"缺少结构"}');
  });
  it("passes teacher history and actual source material without fabricating sources", async () => {
    mocks.call.mockResolvedValue(JSON.stringify({ message: "讨论学生易混淆之处。", plan: { grade: "四年级", totalMinutes: 45 }, question: { id: "depth", prompt: "这节课最想讲清什么？", options: [{ id: "a", label: "区分蒸发与沸腾", description: "比较发生条件" }, { id: "b", label: "蒸发快慢的因素", description: "设计控制变量实验" }] }, fieldOrigins: { grade: "teacher-stated", totalMinutes: "teacher-stated" } }));
    const result = await generatePreparationTurn({ snapshot, sourceContext: "采用教材原文：常温下也可发生蒸发。" });
    expect(result.plan).toMatchObject({ grade: "四年级", totalMinutes: 45 });
    const messages = mocks.call.mock.calls.at(-1)![0];
    expect(messages[1].content).toContain("四年级，45分钟");
    expect(messages[1].content).toContain("采用教材原文");
    expect(messages[0].content).toContain("已经明确的信息不重复问");
  });
});
