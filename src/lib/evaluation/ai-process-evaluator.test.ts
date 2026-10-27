import { describe, expect, it } from "vitest";
import { evaluateAiCollaborationHealth } from "./ai-process-evaluator";

describe("AI collaboration health", () => {
  it("keeps high usage as a support observation rather than a score", () => {
    const result = evaluateAiCollaborationHealth({ interactionCount: 30, specificContextCount: 8, independentProgressCount: 6, verificationCount: 5, artifactChangeCount: 7, corroborationCount: 3, delegationPatternCount: 0 });
    expect(result.status).toBe("support-observation");
    expect(result.score).toBeNull();
  });

  it("flags direct delegation for support without assigning a low score", () => {
    const result = evaluateAiCollaborationHealth({ interactionCount: 2, specificContextCount: 0, independentProgressCount: 0, verificationCount: 0, artifactChangeCount: 0, corroborationCount: 0, delegationPatternCount: 2 });
    expect(result.status).toBe("support-observation");
    expect(result.score).toBeNull();
    expect(result.reasons.join("")).toContain("即时支援");
  });

  it("returns insufficient evidence instead of a forced low score", () => {
    expect(evaluateAiCollaborationHealth({ interactionCount: 1, specificContextCount: 0, independentProgressCount: 0, verificationCount: 0, artifactChangeCount: 0, corroborationCount: 0, delegationPatternCount: 0 }).status).toBe("insufficient-evidence");
  });
});
