import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
import { processVersionChange, selectProcessEvidence } from "./process-evidence";
import type { PblProcessEvidence } from "./process-contract";
const row = (index: number): PblProcessEvidence => ({ id: `save:${index}`, kind: "saved-version", stageKey: "make",
  occurredAt: new Date(index * 1000).toISOString(), title: "已保存版本", actor: "student", content: `${index}`, relatedEvidenceIds: [], limitations: [] });
describe("process evidence", () => {
  it("samples through the timeline and discloses omitted records", () => {
    const selected = selectProcessEvidence(Array.from({ length: 100 }, (_, i) => row(i)), 6);
    expect(selected).toHaveLength(6);
    expect(selected[0].id).toBe("save:0"); expect(selected.at(-1)?.id).toBe("save:99");
    expect(selected[0].limitations[0]).toContain("抽取 6 条");
  });
  it("exposes the actual modification, and does not call unchanged saves an iteration", () => {
    expect(processVersionChange("原有内容", "原有内容")).toContain("未变化");
    expect(processVersionChange("证据：猜测", "证据：三次实测")).toContain("三次实测");
    expect(processVersionChange("证据：猜测", "证据：三次实测")).toContain("猜测");
  });
});
