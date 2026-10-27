// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AiInteractionEvent, CompanionThread } from "@/lib/session/types";
import type { ShowcaseRecommendationCandidate } from "./recommendation-types";
import { DEFAULT_SHOWCASE_DIMENSIONS, rankShowcaseCandidates, showcaseAiRequestCounts, showcaseArtifactDimensions, showcaseRecommendationTarget, validateShowcaseQualityAnalysis } from "./recommendations";

const candidate = (studentId: string, score?: number, options: Partial<ShowcaseRecommendationCandidate> = {}): ShowcaseRecommendationCandidate => ({
  studentId, studentName: studentId, artifactVersionId: `v-${studentId}`, artifactKind: "document", analysisStatus: score === undefined ? "pending" : "complete",
  qualityScore: score, reasons: [], aiRequestCount: 0, ...options,
});

describe("showcase recommendations", () => {
  it("uses teacher target, then confirmed plan, then the explicit three-person default", () => {
    expect(showcaseRecommendationTarget(4, 8)).toEqual({ targetCount: 4, targetSource: "teacher" });
    expect(showcaseRecommendationTarget(null, 8)).toEqual({ targetCount: 8, targetSource: "plan" });
    expect(showcaseRecommendationTarget(0, undefined)).toEqual({ targetCount: 3, targetSource: "default" });
  });

  it("excludes unavailable oral and collaboration evidence and renormalizes artifact weights", () => {
    expect(showcaseArtifactDimensions([{ id: "work", name: "作品内容", description: "证据", weight: 30 }, { id: "oral", name: "现场答辩", description: "", weight: 70 }]))
      .toEqual([{ id: "work", name: "作品内容", description: "证据", weight: 100 }]);
    expect(showcaseArtifactDimensions([{ id: "oral", name: "口头表达", description: "", weight: 100 }])).toEqual(DEFAULT_SHOWCASE_DIMENSIONS);
  });

  it("keeps quality buckets ahead of traits and adds uncovered traits within the same bucket", () => {
    const ranked = rankShowcaseCandidates([
      candidate("highest", 96), candidate("early", 90, { firstSubmittedAt: "2026-10-20T01:00:00Z" }),
      candidate("late", 94, { firstSubmittedAt: "2026-10-20T03:00:00Z" }), candidate("ai", 93, { aiRequestCount: 18 }),
      candidate("unread", undefined, { aiRequestCount: 100 }),
    ]);
    expect(ranked.map(item => item.studentId)).toEqual(["highest", "early", "late", "ai", "unread"]);
    expect(ranked.find(item => item.studentId === "unread")?.reasons).toEqual([{ kind: "ai-interactions", text: "AI 协作请求 100 次" }]);
    expect(ranked.find(item => item.studentId === "early")?.reasons.map(item => item.kind)).toContain("earliest");
  });

  it("covers selected students' traits and never emits duplicate students for multiple reasons", () => {
    const ranked = rankShowcaseCandidates([candidate("selected", 91, { firstSubmittedAt: "2026-10-20T01:00:00Z", aiRequestCount: 7 }),
      candidate("late", 90, { firstSubmittedAt: "2026-10-20T02:00:00Z" }), candidate("plain", 94)], ["selected"]);
    expect(ranked[0].studentId).toBe("late");
    expect(new Set(ranked.map(item => item.studentId)).size).toBe(3);
    expect(ranked.find(item => item.studentId === "selected")?.reasons).toHaveLength(2);
  });

  it("keeps submission and interaction superlatives relative to the whole classroom after earlier presenters finish", () => {
    const current = candidate("middle", 90, { firstSubmittedAt: "2026-10-20T02:00:00Z", aiRequestCount: 5 });
    const ranked = rankShowcaseCandidates([current], [], [current,
      { firstSubmittedAt: "2026-10-20T01:00:00Z", aiRequestCount: 20 }, { firstSubmittedAt: "2026-10-20T03:00:00Z", aiRequestCount: 1 }]);
    expect(ranked[0].reasons).toEqual([]);
  });

  it("counts unique student requests and fills historical conversations without counting retries or system events", () => {
    const event = { courseId: "course", studentId: "s", stageKey: "make", source: "sidebar", actorRole: "student", eventType: "request", conversationId: "conversation", content: "请检查推理", createdAt: "2026-10-20T00:00:00Z" } as AiInteractionEvent;
    const events = [{ ...event, id: "one", requestId: "request" }, { ...event, id: "retry", requestId: "request" },
      { ...event, id: "system", actorRole: "system" as const }, { ...event, id: "other-stage", stageKey: "ai-learning" },
      { ...event, id: "comment", requestId: "reply", source: "proactive-comment" as const }];
    const threads = [{ id: "old", courseId: "course", studentId: "s", stageKey: "ai-collaboration:make", messages: [
      { id: "saved", role: "student", conversationId: "conversation", content: event.content, createdAt: event.createdAt },
      { id: "legacy", role: "student", content: "旧的学生请求", createdAt: event.createdAt },
      { id: "response", role: "agent", content: "AI回答", createdAt: event.createdAt },
    ] }] as CompanionThread[];
    expect(showcaseAiRequestCounts(events, threads).get("s")).toBe(3);
  });

  it("requires all dimension scores and verified quotes before calling a result quality analysis", () => {
    const blocks = [{ location: "第 2 页", text: "结论由三次实验数据支持。" }];
    const dimensions = [{ id: "work", name: "作品", description: "", weight: 100 }];
    const raw = { dimensionScores: { work: 87 }, reasons: [{ text: "实验与结论关联清楚", location: "第 2 页", quote: "三次实验数据" }] };
    expect(validateShowcaseQualityAnalysis(raw, dimensions, blocks)).toMatchObject({ qualityScore: 87, reasons: [{ location: "第 2 页" }] });
    expect(() => validateShowcaseQualityAnalysis({ ...raw, reasons: [{ text: "高质量", location: "第 2 页", quote: "不存在的引文" }] }, dimensions, blocks)).toThrow("QUALITY_EVIDENCE_REQUIRED");
    expect(() => validateShowcaseQualityAnalysis({ ...raw, dimensionScores: {} }, dimensions, blocks)).toThrow("QUALITY_INVALID_SCORES");
  });

});
