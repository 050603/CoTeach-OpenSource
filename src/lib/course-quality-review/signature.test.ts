import { describe, expect, it } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";
import { computeCourseQualitySignature } from "./signature";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";

const classroom = {
  id: "classroom",
  revision: 1,
  createdAt: "2026-09-21T00:00:00.000Z",
  stage: { id: "stage" },
  scenes: [],
} as unknown as PersistedClassroomData;

describe("course quality signature", () => {
  it("preserves teaching review when content monitoring defaults change, including older snapshots", () => {
    const course = createPblTemplateCourse("course");
    const { documentPasteMonitoringEnabled: _monitoring, ...olderConfig } = course.pblConfig!;
    void _monitoring;
    const baseline = computeCourseQualitySignature({ ...course, pblConfig: olderConfig as typeof course.pblConfig }, classroom);
    expect(computeCourseQualitySignature(course, classroom)).toBe(baseline);
    course.pblConfig!.documentPasteMonitoringEnabled = true;
    expect(computeCourseQualitySignature(course, classroom)).toBe(baseline);
    course.pblConfig!.difficultyLevel = "advanced";
    expect(computeCourseQualitySignature(course, classroom)).not.toBe(baseline);
  });
  it("binds collaborative review to the confirmed plan and ignores retained inactive package changes", () => {
    const course = createPblTemplateCourse("course");
    const draft = emptyResourcePackageDraft();
    course.content.resourcePackage = { schemaVersion: 2, id: "old-package", revision: 1,
      source: { id: "zip", fileName: "old.zip", url: "/api/uploads/zip" }, documents: {}, draft };
    course.content.preparationSource = "collaborative-preparation";
    course.content.confirmedPreparation = {
      sessionId: "preparation", revision: 2, confirmedAt: "2026-10-23T00:00:00Z", confirmedBy: "teacher",
      referenceIds: [], textbookSelections: [],
      plan: { courseName: "样本评估", subject: "信息科技", grade: "本科一年级", totalMinutes: 45,
        learnerContext: "已了解训练与测试", learningObjectives: ["区分训练与评估"], knowledgePoints: [],
        teachingApproach: "对比案例", teacherRequirements: [],
        stagePlan: { schemaVersion: 2, source: "collaborative-preparation", totalMinutes: 45, lessonCount: 1,
          minutesPerLesson: 45, stages: draft.stages.map((stage) => ({ ...stage, durationMin: 9 })),
          evaluationCriteria: "解释正确", reflectionQuestions: [] } },
    };
    const baseline = computeCourseQualitySignature(course, classroom);
    course.content.resourcePackage.revision += 1;
    course.content.resourcePackage.draft.grade = "旧交接包的新编辑";
    expect(computeCourseQualitySignature(course, classroom)).toBe(baseline);
    course.content.confirmedPreparation.plan.teacherRequirements.push("解释独立测试的边界");
    expect(computeCourseQualitySignature(course, classroom)).not.toBe(baseline);
    course.content.confirmedPreparation.plan.teacherRequirements = [];
    course.content.confirmedPreparation = undefined;
    expect(computeCourseQualitySignature(course, classroom)).not.toBe(baseline);
  });

  it("invalidates a review when textbook mapping or evidence identity changes", () => {
    const course = createPblTemplateCourse("course");
    course.content.knowledgePoints = [{ id: "target", name: "教材概念", description: "教材解释", sourceKnowledgePointIds: ["source"] }];
    course.content.knowledgeScopePlan = {
      schemaVersion: 1, planningDurationMin: 30, durationRangeMin: 30, durationRangeMax: 30,
      durationSource: "resource-package", assessmentReserveMin: 4, explanationAndActivityMin: 26,
      sourcePointCount: 1, targetPointCount: 1, rationale: "教材映射",
      decisions: [{ sourceKnowledgePointId: "source", sourceKnowledgePointName: "教师要求", disposition: "mapped", targetKnowledgePointId: "target", targetKnowledgePointIds: ["target"], rationale: "教材化改写" }],
    };
    course.content.courseEvidence = {
      schemaVersion: 2, version: 1, fingerprint: "evidence-v1", createdAt: "2026-09-21T00:00:00.000Z", retrievalMode: "hybrid",
      selections: [], items: [], warnings: [],
      mappings: [{ sourceKnowledgePointId: "source", sourceKnowledgePointName: "教师要求", status: "direct", evidenceItemIds: ["evidence"], rationale: "教材支持" }],
    };
    const baseline = computeCourseQualitySignature(course, classroom);
    const changedPlan = structuredClone(course);
    changedPlan.content.knowledgeScopePlan!.decisions[0]!.rationale = "教师调整了映射理由";
    const changedEvidence = structuredClone(course);
    changedEvidence.content.courseEvidence!.fingerprint = "evidence-v2";
    expect(computeCourseQualitySignature(changedPlan, classroom)).not.toBe(baseline);
    expect(computeCourseQualitySignature(changedEvidence, classroom)).not.toBe(baseline);
  });
});
