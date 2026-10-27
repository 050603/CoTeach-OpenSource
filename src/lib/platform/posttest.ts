import { z } from "zod";
import { EXPERIMENT_QUESTION_LIMIT, ExperimentQuestionSchema, composeExperimentForms, type ExperimentQuestionGroup } from "./experiment";
import { createCoTeachAssessmentTemplate } from "./experiment-templates";

export const PostTestConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  content: z.string().max(1000).default(""),
  questions: z.array(ExperimentQuestionSchema).min(1).max(EXPERIMENT_QUESTION_LIMIT),
  minutes: z.number().int().min(1).max(120).optional(),
  skipReasonPrompt: z.string().max(300).optional(),
}).strict().superRefine((config, context) => {
  if (new Set(config.questions.map((question) => question.id)).size !== config.questions.length) {
    context.addIssue({ code: "custom", message: "题目编号不能重复", path: ["questions"] });
  }
  const groups = new Map<string, ExperimentQuestionGroup>();
  for (const question of config.questions) {
    if (!question.group) continue;
    const previous = groups.get(question.group.id);
    if (previous && (previous.title !== question.group.title || (previous.instruction ?? "") !== (question.group.instruction ?? "") || (previous.referenceNote ?? "") !== (question.group.referenceNote ?? ""))) {
      context.addIssue({ code: "custom", message: "同一题组的标题、作答说明和指代说明必须一致", path: ["questions"] });
    }
    groups.set(question.group.id, question.group);
  }
});

export type PostTestConfig = z.infer<typeof PostTestConfigSchema>;

export const COTEACH_POSTTEST_TEMPLATE = {
  title: "CoTeach 教学理解与学习体验后测",
  description: "9 道知识题、34 道课程学习体验题（CoI）、10 道系统使用体验题（C-SUS），以及 1 道选填意见题。保留原有题组、指代说明和题序。",
} as const;

export function createCoTeachPostTestTemplate(): PostTestConfig {
  const template = createCoTeachAssessmentTemplate();
  return PostTestConfigSchema.parse({
    schemaVersion: 1,
    content: template.posttestIntroduction,
    questions: composeExperimentForms(template, "none", () => 0).posttest,
  });
}

export function createEmptyPostTest(): PostTestConfig {
  return { schemaVersion: 1, content: "", questions: [] };
}
