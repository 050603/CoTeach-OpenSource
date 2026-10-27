import { describe, expect, it } from "vitest";
import { resolveLatestCompletedArtifactId } from "@/lib/course-design/active-artifact";

describe("resolveLatestCompletedArtifactId", () => {
  it("keeps showing the latest completed course artifact while the next step runs", () => {
    const artifacts = [
      { id: "course-positioning" },
      { id: "knowledge-graph" },
    ];

    expect(resolveLatestCompletedArtifactId(artifacts)).toBe("knowledge-graph");
  });

  it("returns no synthetic card before the first stage has completed", () => {
    expect(resolveLatestCompletedArtifactId([])).toBeUndefined();
  });
});
