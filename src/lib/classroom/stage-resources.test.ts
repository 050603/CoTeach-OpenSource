import { describe, expect, it } from "vitest";
import { resourcesForStage } from "./stage-resources";

describe("stage resources", () => {
  const base = { type: "PDF", size: "1 MB", downloadedBy: [] };

  it("treats historical unscoped files as launch resources", () => {
    const resources = [
      { ...base, id: "old", title: "旧资源" },
      { ...base, id: "reflection", title: "反思", stageKey: "reflection" },
    ];
    expect(resourcesForStage(resources, "launch").map((item) => item.id)).toEqual(["old"]);
    expect(resourcesForStage(resources, "reflection").map((item) => item.id)).toEqual(["reflection"]);
  });
});
