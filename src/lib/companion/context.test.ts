import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAGES,
  type Course,
  type LearningEvidence,
} from "@/lib/session/types";
import {
  LEARNING_EVIDENCE_SCHEMA_VERSION,
  type LearningEvidenceKind,
  type LearningEvidencePayloadByKind,
} from "@/lib/learning-evidence/types";
import { buildCompanionContext } from "./context";

const now = "2026-07-31T00:00:00.000Z";

function evidence<Kind extends LearningEvidenceKind>(
  id: string,
  kind: Kind,
  stageKey: string,
  summary: string,
  payload: LearningEvidencePayloadByKind[Kind],
  overrides: Partial<LearningEvidence<Kind>> = {},
): LearningEvidence<Kind> {
  return {
    id,
    schemaVersion: LEARNING_EVIDENCE_SCHEMA_VERSION,
    courseId: "course-1",
    studentId: "student-1",
    stageKey,
    kind,
    title: id,
    summary,
    payload,
    status: "submitted",
    source: "student",
    countsTowardReadiness: true,
    evidenceRefs: [],
    artifactSnapshotIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeCourse(): Course {
  return {
    id: "course-1",
    name: "校园节能",
    subject: "科学",
    grade: "六年级",
    hours: 8,
    summary: "调查校园用电并提出改进方案",
    drivingQuestion: "怎样让校园用电更节约？",
    learningObjectives: ["理解能耗数据", "根据证据提出改进"],
    status: "teaching",
    stages: DEFAULT_STAGES,
    currentStageIndex: 5,
    content: {
      pblOutline: "",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: {
        dimensions: [{ id: "evidence", name: "证据", weight: 40, description: "使用证据" }],
        overallRubric: "",
      },
    },
    students: [{
      id: "student-1",
      name: "小林",
      joinedAt: now,
      stageProgress: { reflection: 100 },
    }],
    groups: [{
      id: "grp-student-1",
      name: "小林的个人项目",
      topic: "旧项目字段不得进入上下文",
      keywords: [],
      selectedForms: [],
      members: [{ studentId: "student-1", name: "小林" }],
      createdAt: now,
      updatedAt: now,
    }],
    learningEvidence: [
      evidence("intent-1", "project-intent", "launch", "关注设备待机浪费", {
        concern: "设备待机浪费",
        affectedPeople: "全校师生",
        importance: "减少能源浪费",
        successIndicator: "待机耗电下降",
        personalQuestion: "怎样减少教室设备待机浪费？",
      }, { status: "teacher-confirmed" }),
      evidence("test-1", "test-result", "make", "午休时段待机设备最多", {
        iterationId: "round-1",
        method: "两个时段现场观察",
        target: "教室设备",
        observation: "午休时段待机设备较多",
        result: "提示设计应优先覆盖午休",
      }),
      evidence("reflection-1", "reflection-chain", "reflection", "先记录数据再判断更可靠", {
        selectedEvidenceIds: ["test-1"],
        choice: "先比较时段",
        action: "记录设备状态",
        result: "发现午休问题更明显",
        learning: "主张必须由数据支持",
      }, { teacherFeedback: "请补充样本限制后再形成最终认识。" }),
      evidence("transfer-1", "transfer-response", "reflection", "迁移到教室照明管理", {
        scenario: "图书馆照明浪费",
        response: "先分时段观察再设计提示",
        rationale: "新情境同样需要用数据定位问题",
      }),
    ],
    artifactSnapshots: [{
      id: "snapshot-1",
      courseId: "course-1",
      studentId: "student-1",
      stageKey: "make",
      title: "测试数据表",
      fileType: "text/csv",
      inspectionStatus: "student-annotated",
      studentExcerpt: "午休：8 台；放学：3 台",
      createdAt: now,
    }],
    rubricScores: [{
      id: "score-1",
      courseId: "course-1",
      groupId: "grp-student-1",
      stageKey: "showcase",
      dimensionScores: { evidence: 82 },
      teacherTotal: 82,
      finalTotal: 80,
      comment: "现场答辩已完成",
      total: 80,
      status: "submitted",
      createdAt: now,
      updatedAt: now,
    }],
    aiAssessmentSuggestions: [{
      id: "assessment-1",
      courseId: "course-1",
      studentId: "student-1",
      stageKey: "showcase",
      dimensions: [],
      evidenceIds: ["test-1"],
      evidenceGaps: [],
      confidence: "medium",
      suggestedTotal: 76,
      teacherScore: 78,
      status: "adjusted",
      teacherName: "王老师",
      createdAt: now,
      reviewedAt: now,
    }],
    aiContributions: [{
      id: "contribution-1",
      courseId: "course-1",
      studentId: "student-1",
      stageKey: "make",
      companionId: "reviewer",
      impact: "high",
      request: "检查我的测试解释",
      suggestion: "补充样本限制",
      sourceEvidenceIds: ["test-1"],
      status: "decided",
      createdAt: now,
    }],
    studentAiDecisions: [{
      id: "decision-1",
      courseId: "course-1",
      studentId: "student-1",
      stageKey: "make",
      contributionId: "contribution-1",
      decision: "modified",
      reason: "原建议适合，但要保留真实样本范围",
      appliedChangeSummary: "在解释中增加样本限制",
      resultingEvidenceIds: ["test-1"],
      decidedAt: now,
    }],
    // These records deliberately prove that the upgraded context does not
    // fall back to legacy tasks, uploads, feedback or AI-support summaries.
    submissions: [{ id: "old-sub", courseId: "course-1", studentId: "student-1", stageKey: "make", type: "document", title: "旧提交", content: "旧提交内容不得进入上下文", createdAt: now, updatedAt: now }],
    feedback: [{ id: "old-feedback", courseId: "course-1", targetType: "student", targetId: "student-1", stageKey: "make", kind: "comment", content: "旧反馈不得进入上下文", createdAt: now }],
    aiSupports: [{ id: "old-ai", courseId: "course-1", stageKey: "make", targetType: "student", targetId: "student-1", studentId: "student-1", kind: "artifact-diagnosis", trigger: "旧AI", inputSummary: "", diagnosis: "旧AI支持不得进入上下文", suggestions: [], evidence: [], status: "draft", createdAt: now, updatedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
}

describe("companion context", () => {
  it("uses canonical evidence and excludes every legacy task record", () => {
    const context = buildCompanionContext(makeCourse(), "student-1", "reflection");

    expect(context.prompt).toContain("午休时段待机设备最多");
    expect(context.prompt).toContain("教师现场分=82");
    expect(context.prompt).toContain("教师确认分=78");
    expect(context.prompt).toContain("请补充样本限制后再形成最终认识");
    expect(context.prompt).toContain("先记录数据再判断更可靠");
    expect(context.prompt).toContain("在解释中增加样本限制");
    expect(context.prompt).not.toContain("旧项目字段不得进入上下文");
    expect(context.prompt).not.toContain("旧提交内容不得进入上下文");
    expect(context.prompt).not.toContain("旧反馈不得进入上下文");
    expect(context.prompt).not.toContain("旧AI支持不得进入上下文");
  });
});
