import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { summarizeCourseGenerationInput } from "./generation-input-summary";

const referenceId = "123e4567-e89b-42d3-a456-426614174001";
function course(source: "resource-package" | "collaborative-preparation" = "collaborative-preparation") {
  return { content: {
    preparationSource: source,
    confirmedPreparation: { sessionId: "session", revision: 3, confirmedAt: "2026-10-23T00:00:00Z" },
    resourcePackage: { id: "old-package", revision: 2 },
  } } as Pick<Course, "content">;
}
function job(revision = 3) {
  return { status: "completed", request: {
    confirmedPreparation: { sessionId: "session", revision, plan: { private: "教师讨论内容" } },
    teacherBrief: "采用身边的数据进行比较。",
    referenceMaterials: [{ id: referenceId, fileName: "校园数据.md", content: "私有全文", storageKey: "private-storage" }],
  } };
}

describe("summarizeCourseGenerationInput collaborative sources", () => {
  it("shows matching collaborative input metadata without requiring a package", () => {
    const summary = summarizeCourseGenerationInput(course(), job());
    expect(summary).toMatchObject({ source: "collaborative-preparation", sourceStatus: "current", preparationSessionId: "session", preparationRevision: 3,
      teacherBrief: "采用身边的数据进行比较。", referenceMaterials: [{ id: referenceId, fileName: "校园数据.md" }] });
    expect(JSON.stringify(summary)).not.toMatch(/教师讨论内容|私有全文|private-storage/);
  });

  it.each(["changed-revision", "switched-to-package"])("hides inputs after %s", (change) => {
    const summary = summarizeCourseGenerationInput(course(change === "switched-to-package" ? "resource-package" : "collaborative-preparation"), job(change === "changed-revision" ? 2 : 3));
    expect(summary).toMatchObject({ sourceStatus: "stale", teacherBrief: "", referenceMaterials: [] });
  });

  it("does not treat a retained package as the active source after switching to collaboration", () => {
    const summary = summarizeCourseGenerationInput(course(), { status: "completed", request: { resourcePackage: { id: "old-package", revision: 2 }, teacherBrief: "旧交接包补充要求" } });
    expect(summary).toMatchObject({ sourceStatus: "stale", teacherBrief: "", referenceMaterials: [] });
  });
});
