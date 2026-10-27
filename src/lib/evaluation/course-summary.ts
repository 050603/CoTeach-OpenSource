import type { Course, CourseSummaryPresentation } from "@/lib/session/types";

type SummaryEvaluation = {
  summary: string;
  dimensions: Array<{
    name: string;
    score?: number | null;
    evidenceIds: string[];
    evidenceGaps: string[];
  }>;
  highlights: string[];
  improvements: string[];
};

export function buildCourseSummaryPresentation(
  course: Course,
  evaluation?: SummaryEvaluation | null,
): CourseSummaryPresentation {
  const now = new Date().toISOString();
  const evidenceIds = evaluation?.dimensions
    .flatMap((dimension) => dimension.evidenceIds)
    .filter(Boolean) ?? [];
  const highlights = evaluation?.highlights.length ? evaluation.highlights : ["课堂过程亮点：待教师根据真实学生产物补充。"];
  const improvements = evaluation?.improvements.length ? evaluation.improvements : ["下一步改进：待教师结合班级共性问题补充。"];
  const dimensions = evaluation?.dimensions.length
    ? evaluation.dimensions.map((dimension) =>
        `${dimension.name}：${
          typeof dimension.score === "number"
            ? `${dimension.score} 分`
            : "证据不足，无法判断"
        }`)
    : ["过程推进：待填充", "证据与迭代：待填充", "方案专业性：待填充"];
  const slides = [
    {
      id: "summary-overview",
      title: "本课程解决了什么问题",
      bullets: [course.drivingQuestion || "驱动问题：待补充", course.expectedOutcome || "预期成果：待补充"],
      speakerNotes: "先回到驱动问题，说明本课程的真实情境、学生承担的任务和预期成果。这里不预设学生最终结论。",
      evidenceIds: [],
    },
    {
      id: "summary-process",
      title: "班级如何推进与迭代",
      bullets: highlights,
      speakerNotes: evaluation?.summary || "结合学习轨迹、伴学对话和作品迭代，补充班级过程中的真实亮点。",
      evidenceIds,
    },
    {
      id: "summary-quality",
      title: "成果质量与专业性",
      bullets: dimensions,
      speakerNotes: "展示班级综合评价的证据来源，区分 AI 负责的过程与专业性评价，以及教师负责的现场汇报表现。",
      evidenceIds,
    },
    {
      id: "summary-next-steps",
      title: "下一步如何迁移",
      bullets: improvements,
      speakerNotes: `${improvements.join("；")}。将这些改进建议转成下一次项目或真实场景中可以继续验证的行动。`,
      evidenceIds,
    },
  ];
  return {
    id: `course-summary-${course.id}`,
    title: `${course.name} · 课程总结演示`,
    generatedAt: course.content.courseSummaryPresentation?.generatedAt ?? now,
    updatedAt: now,
    status: "draft",
    slides,
    script: slides.map((slide, index) => `${index + 1}. ${slide.title}\n${slide.speakerNotes}`).join("\n\n"),
    evidenceIds: [...new Set(evidenceIds)],
  };
}
