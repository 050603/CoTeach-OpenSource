import { describe, expect, it } from "vitest";
import { courseGenerationDraftKey, readCourseGenerationDraft, type CourseGenerationInputDraft } from "./course-generation-draft";

const draft: CourseGenerationInputDraft = {
  sourceKey: "package-1:3", jobId: "failed-job", brief: "保留教师未提交的要求",
  generationMode: "deep-interaction", generationScope: "test-lesson", assessmentMode: "constructed-response",
  options: { enableImageGeneration: true, enableTTS: false, enableVideoGeneration: false },
  referenceMaterials: [{ id: "reference-1", fileName: "案例.md" }],
  textbookSelections: [{ revisionId: "revision-1", primary: true, sectionIds: ["section-1"] }],
};

describe("generation input draft ownership", () => {
  it("restores the full unsubmitted input only for the same teacher, course, source and task", () => {
    const key = courseGenerationDraftKey("teacher-a", "course-a");
    const storage = { getItem: (candidate: string) => candidate === key ? JSON.stringify(draft) : null };
    expect(readCourseGenerationDraft(storage, key, "package-1:3", "failed-job")).toEqual(draft);
    expect(readCourseGenerationDraft(storage, courseGenerationDraftKey("teacher-b", "course-a"), "package-1:3", "failed-job")).toBeNull();
    expect(readCourseGenerationDraft(storage, courseGenerationDraftKey("teacher-a", "course-b"), "package-1:3", "failed-job")).toBeNull();
    expect(readCourseGenerationDraft(storage, key, "package-1:4", "failed-job")).toBeNull();
    expect(readCourseGenerationDraft(storage, key, "package-1:3", "new-job")).toBeNull();
  });

  it("ignores unreadable or incomplete drafts", () => {
    expect(readCourseGenerationDraft({ getItem: () => "{" }, "key", "package-1:3", "failed-job")).toBeNull();
    expect(readCourseGenerationDraft({ getItem: () => JSON.stringify({ ...draft, options: null }) }, "key", "package-1:3", "failed-job")).toBeNull();
    expect(readCourseGenerationDraft({ getItem: () => { throw new Error("storage unavailable"); } }, "key", "package-1:3", "failed-job")).toBeNull();
  });
});
