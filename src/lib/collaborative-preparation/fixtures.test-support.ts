import type { PreparationPlan } from "./types";

export function preparationPlanFixture(): PreparationPlan {
  return {
    courseName: "水的蒸发", subject: "科学", grade: "四年级", totalMinutes: 45, learnerContext: "知道水有不同状态，尚不能区分蒸发和沸腾。",
    learningObjectives: ["通过实验比较蒸发快慢并说明控制变量的方法"],
    knowledgePoints: [{ id: "k1", name: "蒸发", depth: "知道常温也会蒸发，不要求粒子运动解释", teachingApproach: "比较湿手帕在通风与静置环境的变化" }],
    teachingApproach: "生活观察、提出假设、控制变量实验", teacherRequirements: ["保留湿手帕案例"],
    stagePlan: { schemaVersion: 2, source: "collaborative-preparation", drivingQuestion: "怎样让湿手帕更快变干？", projectTask: "设计并解释一项对照实验", totalMinutes: 45, lessonCount: 1, minutesPerLesson: 45,
      stages: ["launch", "ai-learning", "make", "showcase", "reflection"].map((key, index) => ({ key: key as PreparationPlan["stagePlan"]["stages"][number]["key"], title: ["项目启动", "知识讲授", "项目实践", "成果展示", "反思评价"][index], durationMin: [5, 15, 15, 5, 5][index], requirements: "围绕蒸发完成本阶段任务", outputs: "记录观察结果", teacherActions: "引导学生明确变量", aiActions: "帮助记录证据" })),
      evaluationCriteria: "能识别自变量并保持其他条件一致", reflectionQuestions: ["如何排除其他因素的影响？"],
      finalDeliverables: [{ id: "d1", name: "实验记录", format: "文字与表格", requirements: "包含变量、观察与解释", required: true }] },
  };
}
