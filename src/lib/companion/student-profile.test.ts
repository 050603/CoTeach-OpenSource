import { describe, expect, it } from "vitest";
import { DEFAULT_STAGES, type Course } from "@/lib/session/types";
import { LEARNING_EVIDENCE_SCHEMA_VERSION } from "@/lib/learning-evidence/types";
import { deriveStudentLearningProfile, studentProfilePrompt } from "./student-profile";

const now = "2026-07-31T00:00:00.000Z";

function course(overrides: Partial<Course> = {}): Course {
  return {
    id: "c1",
    name: "课",
    subject: "科学",
    grade: "六年级",
    hours: 2,
    summary: "",
    drivingQuestion: "问题",
    status: "teaching",
    stages: DEFAULT_STAGES,
    currentStageIndex: 2,
    content: {
      pblOutline: "",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
    },
    students: [{ id: "s1", name: "小林", joinedAt: now, stageProgress: {} }],
    learningEvidence: [],
    artifactSnapshots: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("student learning profile", () => {
  it("does not treat chat frequency as learning quality or a score", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      id: `m-${index}`,
      role: "student" as const,
      content: "我还在想",
      createdAt: now,
      visibility: "student-and-teacher" as const,
    }));
    const profile = deriveStudentLearningProfile({
      course: course({
        companionThreads: [{
          id: "thread-1",
          courseId: "c1",
          studentId: "s1",
          stageKey: "proposal",
          messages,
          createdAt: now,
          updatedAt: now,
        }],
      }),
      studentId: "s1",
      stageKey: "proposal",
    });

    expect(profile.collaborationHealth).toBe("insufficient-evidence");
    expect(profile.collaborationScore).toBeNull();
    expect(studentProfilePrompt(profile)).toContain("不参与评分");
  });

  it("uses canonical student evidence for support observations and ignores legacy submissions", () => {
    const profile = deriveStudentLearningProfile({
      course: course({
        learningEvidence: [{
          id: "plan-v1",
          schemaVersion: LEARNING_EVIDENCE_SCHEMA_VERSION,
          courseId: "c1",
          studentId: "s1",
          stageKey: "proposal",
          kind: "plan-version",
          title: "方案 V1",
          summary: "学生比较后形成验证计划",
          payload: {
            versionLabel: "V1",
            nextActions: ["制作样例"],
            validationMethod: "比较两个班级的测试结果",
            risks: ["保护隐私"],
            aiBoundary: "AI 只检查遗漏",
          },
          status: "submitted",
          source: "student",
          countsTowardReadiness: true,
          evidenceRefs: [],
          artifactSnapshotIds: [],
          createdAt: now,
          updatedAt: now,
        }],
        submissions: [{
          id: "legacy-submission",
          courseId: "c1",
          studentId: "s1",
          stageKey: "proposal",
          type: "document",
          title: "旧方案",
          content: "旧提交不应作为独立进展",
          createdAt: now,
          updatedAt: now,
        }],
        companionThreads: [{
          id: "thread-1",
          courseId: "c1",
          studentId: "s1",
          stageKey: "proposal",
          messages: [{
            id: "m-1",
            role: "student",
            content: "我会先核对来源并比较两个方案，再决定采用哪一个。",
            createdAt: now,
            visibility: "student-and-teacher",
          }],
          createdAt: now,
          updatedAt: now,
        }],
      }),
      studentId: "s1",
      stageKey: "proposal",
    });

    expect(profile.collaborationHealth).toBe("support-observation");
    expect(profile.collaborationScore).toBeNull();
    expect(profile.supportStrategy).not.toBe("verification-first");
  });
});
