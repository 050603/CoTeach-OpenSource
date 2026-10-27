import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import type { Course, TeachingBlueprint } from "@/lib/session/types";
import type { CourseTextbookFigureResource } from "@/lib/textbook/course-evidence-types";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  load: vi.fn(),
  updateCourse: vi.fn(),
  designJob: vi.fn(),
  contentJob: vi.fn(),
  publication: vi.fn(),
  figures: vi.fn(),
  hydrate: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({
  loadPblTemplateCourse: mocks.load,
  getPblTemplatePublicationState: mocks.publication,
}));
vi.mock("@/lib/session/server-store", () => ({ updateCourse: mocks.updateCourse }));
vi.mock("@/lib/course-generation/job-storage", () => ({
  designGenerationJobs: { findUnique: mocks.designJob },
  contentGenerationJobs: { findUnique: mocks.contentJob, replace: vi.fn() },
}));
vi.mock("@/lib/course-generation/job-runner", () => ({
  estimatePersistedCourseGenerationSeconds: vi.fn(() => 10),
  runQueuedCourseGenerationToCompletion: vi.fn(),
}));
vi.mock("@/lib/course-generation/capability", () => ({ isBackgroundCourseGenerationEnabled: vi.fn(() => true) }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({ readClassroom: vi.fn(), updatePersistedClassroomForEditing: vi.fn() }));
vi.mock("@/lib/course-generation/teacher-review-items", () => ({ collectGeneratedTeacherReviewItems: vi.fn(() => []), teacherReviewSummary: vi.fn(() => "") }));
vi.mock("@/lib/openmaic/server/classroom-asset-generation", () => ({ summarizeTeachingTimingAudit: vi.fn() }));
vi.mock("@/lib/textbook/course-evidence", () => ({
  resolveCourseTextbookFigures: mocks.figures,
  hydrateCourseEvidenceFigureReferences: mocks.hydrate,
}));

import { GET, PATCH } from "./route";
import { runQueuedCourseGenerationToCompletion } from "@/lib/course-generation/job-runner";
import { bindTeachingManuscript, teachingManuscripts } from "@/lib/course-design/teaching-manuscript";
import { PPT_PAGE_PLANNING_VERSION } from "@/lib/course-design/ppt-page-planning-contract";

function fixture(): Course {
  const course = createPblTemplateCourse("course-1", {
    name: "原课程",
    subject: "科学",
    grade: "七年级",
    hours: 1,
    learningObjectives: ["原目标"],
  });
  course.version = 10;
  course.status = "ready";
  course.aiLearningClassroomId = "classroom-1";
  course.content._openmaicClassroomId = "classroom-1";
  course.content.knowledgePoints = [{ id: "kp-1", name: "知识", description: "说明" }];
  return course;
}

function spokenBlueprint(): TeachingBlueprint {
  return {
    schemaVersion: 3, inputFingerprint: "accepted-source", assessmentMode: "adaptive", createdAt: "2026-10-03",
    budget: { totalDurationSec: 600, teachingDurationSec: 480, learnerActivityDurationSec: 0, assessmentDurationSec: 120, teachingRatio: 0.8, assessmentRatio: 0.2 },
    sections: [{ id: "section-1", contentMode: "spoken", title: "过程", order: 0, knowledgePointIds: ["kp-1"],
      learningObjective: "解释过程", assessmentFocus: ["过程"],
      sharedContext: { learningPurpose: "理解过程", caseId: "", caseFacts: [], stableTerms: [], fixedWording: [], conceptBoundaries: [] },
      understandingCriteria: { goals: ["理解过程"], answerEssentials: ["说明关系"], misconceptions: [], supportingUnitIds: ["unit-1"] },
      teachingDurationSec: 480, learnerActivityDurationSec: 0, assessmentDurationSec: 120,
      units: [{ id: "unit-1", title: "过程", knowledgePointIds: ["kp-1"], learningOutcome: "理解过程",
        explanation: "旧解释副本", mechanism: "旧推理副本", workedExample: "旧案例副本", conditions: [], misconceptions: [],
        sourceKind: "course-source", evidenceQuotes: [], explanationNodes: [{ id: "node-1", kind: "concept", content: "原始讲稿。",
          knowledgePointIds: ["kp-1"], prerequisiteNodeIds: [], provenance: "course-source", sourceBindings: [] }] }],
      pages: [{ id: "page-1", title: "过程", type: "slide", unitIds: ["unit-1"], knowledgePointIds: ["kp-1"],
        description: "说明过程", keyPoints: ["旧页面要点"], teachingObjective: "解释过程", introducesNodeIds: ["node-1"],
        presentationItems: [{ text: "屏幕简述", nodeIds: ["node-1"], role: "key-point" }] }],
    }],
  };
}

describe("course design workspace route", () => {
  let course: Course;
  beforeEach(() => {
    vi.clearAllMocks();
    course = fixture();
    mocks.authorize.mockResolvedValue("teacher-1");
    mocks.load.mockImplementation(async () => course);
    mocks.designJob.mockResolvedValue(null);
    mocks.contentJob.mockResolvedValue(null);
    mocks.publication.mockResolvedValue({ latestVersion: 2, publishedVersion: 1, draftVersion: 2 });
    mocks.figures.mockResolvedValue([]);
    mocks.hydrate.mockImplementation(async (items) => items);
    mocks.updateCourse.mockImplementation(async (_id: string, updater: (value: Course) => Course) => {
      course = { ...updater(course), version: (course.version ?? 0) + 1 };
      return { courses: [course] };
    });
  });

  it("reads only supplemental input metadata from a failed task without writing or starting generation", async () => {
    const packageFileId = "123e4567-e89b-42d3-a456-426614174000";
    const referenceId = "123e4567-e89b-42d3-a456-426614174001";
    const source = { id: "package-current", revision: 3, documents: { knowledge: { id: packageFileId } } };
    course.content.resourcePackage = source as NonNullable<Course["content"]["resourcePackage"]>;
    mocks.designJob.mockResolvedValue({ status: "failed", step: "knowledge", message: "失败草稿", progress: 5,
      request: { resourcePackage: { ...source, draft: { confidential: "资料正文" } }, teacherBrief: "保留本地案例。", options: { provider: "private" }, referenceMaterials: [
        { id: packageFileId, fileName: "knowledge.docx", content: "包内正文" },
        { id: `${packageFileId}:part-1`, fileName: "knowledge-part.docx", content: "包内分片正文" },
        { id: referenceId, fileName: "补充案例.pdf", mimeType: "application/pdf", content: "私有资料全文", storageKey: "private-key" },
        { id: referenceId, fileName: "重复文件.pdf", content: "私有正文" },
      ] } });
    const response = await GET(new Request("http://localhost/api/courses/course-1/design-workspace"), { params: Promise.resolve({ courseId: course.id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json();
    expect(payload.generationInput).toEqual({ sourceStatus: "current", resourcePackageId: source.id, resourcePackageRevision: 3,
      taskStatus: "failed", teacherBrief: "保留本地案例。", referenceMaterials: [{ id: referenceId, fileName: "补充案例.pdf", mimeType: "application/pdf" }] });
    expect(JSON.stringify(payload.generationInput)).not.toMatch(/content|storageKey|options|私有资料全文|资料正文/);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect(runQueuedCourseGenerationToCompletion).not.toHaveBeenCalled();
  });

  it.each(["different-package", "different-revision", "missing-source"])("does not present inputs from %s as current course materials", async (mismatch) => {
    course.content.resourcePackage = { id: "package-current", revision: 3 } as NonNullable<Course["content"]["resourcePackage"]>;
    mocks.designJob.mockResolvedValue({ status: "completed", step: "completed", message: "已完成", progress: 100,
      request: { resourcePackage: mismatch === "missing-source" ? undefined : { id: mismatch === "different-package" ? "package-old" : "package-current", revision: mismatch === "different-revision" ? 2 : 3 },
        teacherBrief: "另一版课程的要求", referenceMaterials: [{ id: "123e4567-e89b-42d3-a456-426614174001", fileName: "旧版资料.pdf" }] } });
    const response = await GET(new Request("http://localhost/api/courses/course-1/design-workspace"), { params: Promise.resolve({ courseId: course.id }) });
    expect((await response.json()).generationInput).toMatchObject({ sourceStatus: mismatch === "missing-source" ? "unavailable" : "stale", teacherBrief: "", referenceMaterials: [] });
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it.each([403, 409])("retains the existing permission and archive guard before reading supplemental files (%s)", async (status) => {
    mocks.authorize.mockResolvedValue(Response.json({ error: "ACCESS_DENIED" }, { status }));
    const response = await GET(new Request("http://localhost/api/courses/course-1/design-workspace"), { params: Promise.resolve({ courseId: course.id }) });
    expect(response.status).toBe(status);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.designJob).not.toHaveBeenCalled();
  });

  it.each([false, true])("saves independent textbook lists with a retained diagnostic for a missing adopted item (missing=%s)", async (missing) => {
    const figureLabels = ["图流程甲", "图流程乙", "图流程丙", "图流程丁", "图流程戊", "图流程己"];
    const sourceLabels = ["正文步骤甲", "正文步骤乙", "正文步骤丙", "正文步骤丁", "正文步骤戊"];
    const visible = [`图流程有6个环节：${figureLabels.join("、")}`, `正文流程有5个环节：${(missing ? sourceLabels.slice(0, -1) : sourceLabels).join("、")}`];
    course.content.courseEvidence = { items: [{ id: "e-source", content: "正文流程", source: { sectionPath: ["操作步骤"] },
      sourceSequences: [{ anchorSourceBlockId: "source-first", kind: "ordered-steps",
        steps: sourceLabels.map((label, index) => ({ label, sourceBlockId: `source-${index}` })) }] }], mappings: [] } as unknown as NonNullable<Course["content"]["courseEvidence"]>;
    course.content.knowledgePoints[0]!.evidenceItemIds = ["e-source"];
    const figure: CourseTextbookFigureResource = {
      id: "figure-resource", figureId: "figure-id", assetId: "figure-asset", src: "/api/uploads/figure-asset",
      status: "available", relation: "direct", required: true, pageNumber: 1, evidenceItemIds: [],
      knowledgePointIds: ["kp-1"], sourceTitle: "教材",
      orderedSteps: figureLabels.map((label, index) => ({ label, sourceBlockId: `figure-${index}` })),
    };
    mocks.figures.mockResolvedValue([figure]);
    const blueprint: TeachingBlueprint = {
      schemaVersion: 3, inputFingerprint: "accepted", assessmentMode: "adaptive", createdAt: "2026-09-30",
      budget: { totalDurationSec: 600, teachingDurationSec: 480, learnerActivityDurationSec: 0, assessmentDurationSec: 120, teachingRatio: 0.8, assessmentRatio: 0.2 },
      sections: [{ id: "section-1", title: "两类流程", order: 0, knowledgePointIds: ["kp-1"],
        learningObjective: "分别说明两类流程", assessmentFocus: ["分别说明两类流程"],
        sharedContext: { learningPurpose: "分别说明流程", caseId: "", caseFacts: [], stableTerms: [], fixedWording: [], conceptBoundaries: [] },
        understandingCriteria: { goals: ["分别说明流程"], answerEssentials: ["各自步骤完整"], misconceptions: ["混合数量"], supportingUnitIds: ["unit-1"] },
        teachingDurationSec: 480, learnerActivityDurationSec: 0, assessmentDurationSec: 120,
        units: [{ id: "unit-1", title: "两类流程", knowledgePointIds: ["kp-1"], learningOutcome: "分别说明流程",
          explanation: visible.join("。"), mechanism: "两类流程各有独立步骤。", workedExample: "分别执行两类流程。",
          conditions: [], misconceptions: [], sourceKind: "course-source", evidenceQuotes: [] }],
        pages: [{ id: "page-1", title: "两类流程", type: "slide", unitIds: ["unit-1"], knowledgePointIds: ["kp-1"],
          description: visible.join("。"), keyPoints: visible, teachingObjective: "分别说明两类流程" }],
      }],
    };
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", section: "blueprint", expectedVersion: 10, data: blueprint }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(200);
    if (missing) expect(course.content.teachingBlueprint?.qualityDiagnostics?.join('\n')).toContain("正文步骤戊");
    expect(course.content.teachingBlueprint?.sections[0]?.pages[0]?.keyPoints).toEqual(visible);
  });

  it.each([false, true])('round-trips native page duties without requiring or adopting a legacy projection (stale=%s)', async (staleProjection) => {
    course.content.teachingBlueprint = spokenBlueprint();
    course.content.teachingBlueprint.sections[0]!.pptPlanningVersion = PPT_PAGE_PLANNING_VERSION;
    delete course.content.teachingBlueprint.sections[0]!.pages[0]!.presentationItems;
    const nodes = structuredClone(course.content.teachingBlueprint.sections[0]!.units);
    for (let round = 0; round < 2; round++) {
      const edited = structuredClone(course.content.teachingBlueprint);
      const page = edited.sections[0]!.pages[0]!;
      page.description = `第${round + 1}次编辑：定义和案例共同说明过程`;
      page.keyPoints = ['共同认识', '成立条件与观察依据'];
      if (staleProjection) page.presentationItems = [{ text: '过时投影不能覆盖职责', role: 'key-point', nodeIds: ['node-1'] }];
      const response = await PATCH(new Request('http://localhost/api/courses/course-1/design-workspace', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', section: 'blueprint', expectedVersion: course.version, data: edited }),
      }), { params: Promise.resolve({ courseId: 'course-1' }) });
      expect(response.status).toBe(200);
      const saved = course.content.teachingBlueprint.sections[0]!;
      expect(saved.pptPlanningVersion).toBe(PPT_PAGE_PLANNING_VERSION);
      expect(saved.pages[0]!).toMatchObject({ description: page.description, keyPoints: page.keyPoints });
      expect(saved.pages[0]!.presentationItems).toBeUndefined();
      expect(saved.units).toEqual(nodes);
      expect(course.content._openmaicSceneOutlines?.[0]).toMatchObject({ description: page.description,
        keyPoints: page.keyPoints, teachingBrief: { pptPlanningVersion: PPT_PAGE_PLANNING_VERSION } });
      expect(bindTeachingManuscript(course.content._openmaicSceneOutlines![0]! as SceneOutline,
        teachingManuscripts(course.content.teachingBlueprint)).segments[0]?.text).toBe('原始讲稿。');
    }
  });

  it.each(['remove', 'change', 'upgrade'] as const)('rejects a client-side native planning contract %s', async (change) => {
    course.content.teachingBlueprint = spokenBlueprint();
    if (change !== 'upgrade') course.content.teachingBlueprint.sections[0]!.pptPlanningVersion = PPT_PAGE_PLANNING_VERSION;
    const original = structuredClone(course.content.teachingBlueprint);
    const edited = structuredClone(original);
    if (change === 'remove') delete edited.sections[0]!.pptPlanningVersion;
    else if (change === 'upgrade') edited.sections[0]!.pptPlanningVersion = PPT_PAGE_PLANNING_VERSION;
    else Object.assign(edited.sections[0]!, { pptPlanningVersion: 'different-policy' });
    const response = await PATCH(new Request('http://localhost/api/courses/course-1/design-workspace', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', section: 'blueprint', expectedVersion: course.version, data: edited }),
    }), { params: Promise.resolve({ courseId: 'course-1' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'BLUEPRINT_SOURCE_CONFLICT' });
    expect(course.content.teachingBlueprint).toEqual(original);
  });

  it("saves the teacher's canonical lecture and independently derives display points", async () => {
    course.content.teachingBlueprint = spokenBlueprint();
    const edited = structuredClone(course.content.teachingBlueprint);
    edited.sections[0]!.units[0]!.explanationNodes![0]!.content = "教师说明：在这些条件下，先观察，再比较结果。";
    edited.sections[0]!.pages[0]!.presentationItems![0]!.text = "先观察，再比较";
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", section: "blueprint", expectedVersion: 10, data: edited }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(200);
    expect(course.content.teachingBlueprint?.sections[0]?.units[0]?.explanationNodes?.[0]?.content)
      .toBe("教师说明：在这些条件下，先观察，再比较结果。");
    expect(course.content.teachingBlueprint?.sections[0]?.pages[0]?.keyPoints).toEqual(["先观察，再比较"]);
    expect(course.content._openmaicSceneOutlines?.[0]?.keyPoints).toEqual(["先观察，再比较"]);
    expect(course.content._openmaicSceneOutlines?.[0]?.teachingBrief?.manuscript).toMatchObject({ segmentIds: ["node-1"] });
    expect(bindTeachingManuscript(course.content._openmaicSceneOutlines![0]! as SceneOutline, teachingManuscripts(course.content.teachingBlueprint)).segments[0]?.text)
      .toBe("教师说明：在这些条件下，先观察，再比较结果。");
    expect(course.aiLearningClassroomId).toBe("classroom-1");
  });

  it.each(["source", "mode", "identity", "empty", "unassigned", "duplicate"] as const)("rejects invalid spoken edits (%s) without replacing the saved lecture", async (change) => {
    course.content.teachingBlueprint = spokenBlueprint();
    const edited = structuredClone(course.content.teachingBlueprint);
    const section = edited.sections[0]!;
    const node = section.units[0]!.explanationNodes![0]!;
    if (change === "source") node.provenance = "constructed";
    if (change === "mode") delete section.contentMode;
    if (change === "identity") node.id = "forged-node";
    if (change === "empty") node.content = " ";
    if (change === "unassigned") section.pages[0]!.introducesNodeIds = [];
    if (change === "duplicate") section.pages[0]!.introducesNodeIds = [node.id, node.id];
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", section: "blueprint", expectedVersion: 10, data: edited }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(change === "source" || change === "mode" ? 409 : 400);
    expect(course.content.teachingBlueprint).toEqual(spokenBlueprint());
  });

  it("saves teacher edits as a draft while preserving generated classroom data", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save",
        section: "materials",
        expectedVersion: 10,
        data: {
          name: "更新课程",
          subject: "科学",
          grade: "七年级",
          hours: 1,
          summary: "简介",
          drivingQuestion: "为什么？",
          expectedOutcome: "研究报告",
          learningObjectives: ["更新目标"],
        },
      }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(200);
    expect(course.name).toBe("更新课程");
    expect(course.status).toBe("preparing");
    expect(course.aiLearningClassroomId).toBe("classroom-1");
    expect(course.content.designWorkspaceRevision?.pendingUpdates.some((item) => item.target === "classroom")).toBe(true);
  });

  it("rejects a stale browser version before applying the edit", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm-current", target: "classroom", expectedVersion: 9 }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "VERSION_CONFLICT" });
  });

  it("requires every write to carry the course version", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm-current", target: "classroom" }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(400);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
});
