import { DEFAULT_STAGES } from "../../src/lib/session/types";

export function courseDesignDetailsFixture() {
  const courseId = "e2e-course-design-details";
  const timestamp = new Date().toISOString();
  const outlines = Array.from({ length: 12 }, (_, index) => ({
    id: `page-${index + 1}`, type: "slide", title: `训练数据页面 ${index + 1}`,
    description: "比较训练数据和独立验证数据的用途，解释判断依据。", keyPoints: ["训练集用于训练", "验证集检验泛化表现"],
    order: index + 1, lectureSectionId: "section-1", lectureSectionTitle: "训练数据", targetDurationSec: 120,
  }));
  const blueprint = {
    schemaVersion: 3, inputFingerprint: "browser-fixture", createdAt: timestamp, assessmentMode: "adaptive",
    budget: { totalDurationSec: 1500, teachingDurationSec: 1440, learnerActivityDurationSec: 0, assessmentDurationSec: 60, teachingRatio: .96, assessmentRatio: .04 },
    sections: [{
      id: "section-1", title: "训练数据", order: 1, learningObjective: "解释数据划分的理由", knowledgePointIds: ["kp-1"],
      teachingDurationSec: 1440, learnerActivityDurationSec: 0, assessmentDurationSec: 60,
      sharedContext: { learningPurpose: "理解独立验证", caseId: "case-1", caseFacts: ["验证样本不用于训练"], fixedWording: [], stableTerms: ["训练集", "验证集"], conceptBoundaries: ["训练准确率不等于泛化能力"] },
      units: [{ id: "unit-1", title: "数据划分的理由", knowledgePointIds: ["kp-1"], learningOutcome: "区分训练与验证", explanation: "独立验证集用于评估模型的泛化表现。", mechanism: "用未参与训练的数据检验模型。", workedExample: "将样本分别用于训练与验证。", conditions: ["保持验证集独立"], misconceptions: ["训练准确率可以代替验证"], sourceKind: "course-source", evidenceQuotes: ["验证集不得参与模型训练。"] }],
      pages: outlines.map((outline) => ({ ...outline, unitIds: ["unit-1"], knowledgePointIds: ["kp-1"], teachingObjective: "解释数据集用途" })),
      assessmentFocus: ["判断数据是否独立"], understandingCriteria: { goals: ["解释验证的用途"], answerEssentials: ["验证数据不参与训练"], misconceptions: [], supportingUnitIds: ["unit-1"] },
    }],
  };
  const course = {
    id: courseId, version: 1, name: "数据划分教学", subject: "人工智能", grade: "高中", hours: 1, summary: "数据划分", drivingQuestion: "如何评估模型？",
    status: "draft", stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 0, students: [], resources: [], groups: [], inviteCode: "DETAIL", createdAt: timestamp, updatedAt: timestamp,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], teachingOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  };
  return { courseId, timestamp, outlines, blueprint, course };
}
