// @vitest-environment node
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
import { mergeShowcaseRequestFacts } from "./recommendation-facts";
import type { AiInteractionEvent } from "@/lib/session/types";
const event = (id: string, requestId?: string): AiInteractionEvent => ({ id, requestId, studentId: "s", courseId: "c", conversationId: "thread", stageKey: "make", eventType: "request", actorRole: "student", source: "sidebar", content: "请帮我解释实验结果", createdAt: "2026-10-20T00:00:00Z" });
it("incrementally deduplicates requests and replaces historical fallback when audit arrives later", () => {
  const first = mergeShowcaseRequestFacts({ audited: {}, historical: {} }, [], [event("thread:message")]);
  expect(first.counts.s).toBe(1);
  const second = mergeShowcaseRequestFacts(first, [event("audit", "r1"), event("retry", "r1")]);
  expect(second.counts.s).toBe(1);
  const third = mergeShowcaseRequestFacts(second, [event("audit2", "r2"), { ...event("system"), source: "system" }, { ...event("other-stage"), stageKey: "launch" }]);
  expect(third.counts.s).toBe(2);
  expect(JSON.stringify(third)).not.toContain("请帮我解释");
});
