import { describe, expect, it } from "vitest";
import type { ReflectionRecord } from "@/lib/session/types";
import {
  latestReflectionByStudent,
  normalizeReflectionContent,
  normalizeReflectionSurvey,
  reflectionCsvCell,
  reflectionSurveyAverage,
  reflectionSurveyDistribution,
} from "./reflection-survey";

function record(
  studentId: string,
  updatedAt: string,
  survey?: ReflectionRecord["survey"],
): ReflectionRecord {
  return {
    id: `${studentId}-${updatedAt}`,
    courseId: "course-1",
    studentId,
    studentName: studentId,
    content: "",
    survey,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("reflection survey data helpers", () => {
  it("reads raw legacy strings, legacy objects, and survey objects", () => {
    expect(normalizeReflectionContent("一段旧版反思")).toEqual({ content: "一段旧版反思" });
    expect(normalizeReflectionContent({ content: "旧正文", improvementPlan: "下一步" })).toEqual({
      content: "旧正文",
      improvementPlan: "下一步",
      survey: undefined,
    });
    expect(normalizeReflectionContent({
      content: "新版兼容正文",
      survey: {
        schemaVersion: 1,
        learningReflection: "收获",
        systemReflection: "体验",
        aiHelpfulness: 3,
        systemUsability: 4,
        reuseIntention: 5,
      },
    }).survey?.systemUsability).toBe(4);
    expect(normalizeReflectionContent({
      schemaVersion: 1,
      learningReflection: "直接存储的收获",
      systemReflection: "直接存储的体验",
      aiHelpfulness: 3,
      systemUsability: 4,
      reuseIntention: 5,
    }).content).toContain("直接存储的收获");
  });

  it("normalizes a complete response and rejects malformed responses", () => {
    expect(normalizeReflectionSurvey({
      schemaVersion: 1,
      learningReflection: "  学会了用证据修改方案  ",
      systemReflection: "AI 的提问很有帮助",
      aiHelpfulness: 4,
      systemUsability: 5,
      reuseIntention: 4,
    })).toEqual({
      schemaVersion: 1,
      learningReflection: "学会了用证据修改方案",
      systemReflection: "AI 的提问很有帮助",
      aiHelpfulness: 4,
      systemUsability: 5,
      reuseIntention: 4,
    });
    expect(normalizeReflectionSurvey({
      schemaVersion: 1,
      learningReflection: "",
      systemReflection: "体验",
      aiHelpfulness: 4,
      systemUsability: 5,
      reuseIntention: 4,
    })).toBeUndefined();
    expect(normalizeReflectionSurvey({
      schemaVersion: 1,
      learningReflection: "收获",
      systemReflection: "体验",
      aiHelpfulness: 6,
      systemUsability: 5,
      reuseIntention: 4,
    })).toBeUndefined();
    expect(normalizeReflectionSurvey({
      schemaVersion: 2,
      learningReflection: "收获",
      systemReflection: "体验",
      aiHelpfulness: 4,
      systemUsability: 5,
      reuseIntention: 4,
    })).toBeUndefined();
  });

  it("keeps only the latest record per student and ignores missing scores", () => {
    const old = record("s1", "2026-08-01T00:00:00.000Z", {
      schemaVersion: 1,
      learningReflection: "旧",
      systemReflection: "旧",
      aiHelpfulness: 1,
      systemUsability: 1,
      reuseIntention: 1,
    });
    const latest = record("s1", "2026-08-02T00:00:00.000Z", {
      schemaVersion: 1,
      learningReflection: "新",
      systemReflection: "新",
      aiHelpfulness: 5,
      systemUsability: 4,
      reuseIntention: 3,
    });
    const second = record("s2", "2026-08-02T00:00:00.000Z", {
      schemaVersion: 1,
      learningReflection: "二",
      systemReflection: "二",
      aiHelpfulness: 3,
      systemUsability: 4,
      reuseIntention: 5,
    });
    const map = latestReflectionByStudent([old, latest, second]);
    expect(map.get("s1")?.id).toBe(latest.id);
    expect(reflectionSurveyAverage(map.values(), "aiHelpfulness")).toBe(4);
    expect(reflectionSurveyAverage(map.values(), "systemUsability")).toBe(4);
    expect(reflectionSurveyDistribution(map.values(), "reuseIntention")).toEqual({
      1: 0,
      2: 0,
      3: 1,
      4: 0,
      5: 1,
    });
  });

  it("escapes CSV cells and protects formula-like text", () => {
    expect(reflectionCsvCell("带,逗号\n和\"引号")).toBe('"带,逗号\n和""引号"');
    expect(reflectionCsvCell("=HYPERLINK(\"https://example.com\")")).toBe("\"'=HYPERLINK(\"\"https://example.com\"\")\"");
    expect(reflectionCsvCell("  +SUM(A1:A2)")).toBe("'  +SUM(A1:A2)");
  });
});
