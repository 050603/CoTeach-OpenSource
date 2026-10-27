export type PblDrivingQuestionQuality = {
  passed: boolean;
  issues: string[];
};

/**
 * A PBL driving question is the single challenge that gives the whole project
 * its purpose. Technical and knowledge questions belong in later inquiry
 * scaffolds, not in this course-level field.
 */
export function evaluatePblDrivingQuestion(value: string): PblDrivingQuestionQuality {
  const question = value.trim();
  const questionMarkCount = (question.match(/[？?]/g) ?? []).length;
  const issues = [
    question.length >= 16 && question.length <= 140
      ? ""
      : "项目驱动问题应当清晰、聚焦，并保持在 16 至 140 个字符以内",
    questionMarkCount === 1 && /[？?]$/.test(question)
      ? ""
      : "项目驱动问题必须是统领整项任务的一个核心问题，不能拼接多个知识点追问",
    /如何|怎样|什么样/.test(question) && !/是否|是不是|能不能/.test(question)
      ? ""
      : "项目驱动问题应当开放，允许学生形成不同但有依据的方案",
    /为|面向|帮助|改善|解决|服务|学校|校园|社区|家庭|公众|图书馆|同学|居民|用户|客户/.test(question)
      ? ""
      : "项目驱动问题需要包含真实对象、使用者或现实情境",
    /设计|提出|制定|制作|开发|改进|解决|创建|形成|建造|策划|减少|提升|优化|方案|作品|建议|模型|报告|指南|手册|广播稿|宣传|展览|演示|网页|故事|剧本|地图|装置|产品|提案|原型|系统|计划|行动/.test(question)
      ? ""
      : "项目驱动问题需要指向可实施的项目行动或成果，而不是知识回忆与方法比较",
  ].filter(Boolean);
  return { passed: issues.length === 0, issues };
}

export function isStrongPblDrivingQuestion(value: string): boolean {
  return evaluatePblDrivingQuestion(value).passed;
}
