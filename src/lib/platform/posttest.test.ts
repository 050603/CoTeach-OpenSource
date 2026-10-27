import { describe, expect, it } from "vitest";
import { groupExperimentQuestions, publicActivityConfig } from "./experiment";
import { COTEACH_COMMUNITY_REFERENCE, COTEACH_TEACHER_REFERENCE, COTEACH_SYSTEM_REFERENCE } from "./experiment-templates";
import { PostTestConfigSchema, createCoTeachPostTestTemplate } from "./posttest";

describe("standalone posttest", () => {
  it("keeps the complete posttest, authored groups and reference notes in an independent template draft", () => {
    const template = createCoTeachPostTestTemplate();
    expect(template.questions).toHaveLength(54);
    expect(template.questions.filter((question) => !question.optional)).toHaveLength(53);
    const sections = groupExperimentQuestions(template.questions);
    expect(sections.map((section) => section.questions.length)).toEqual([9, 13, 9, 12, 10, 1]);
    expect(sections[1].group?.referenceNote).toBe(COTEACH_TEACHER_REFERENCE);
    expect(sections[2].group?.referenceNote).toBe(COTEACH_COMMUNITY_REFERENCE);
    expect(sections[4].group?.referenceNote).toBe(COTEACH_SYSTEM_REFERENCE);
    expect(template.questions.at(-1)).toMatchObject({ id: "F01", optional: true });
    template.questions[0].prompt = "编辑后的题干";
    template.questions[0].options![0] = "编辑后的选项";
    expect(createCoTeachPostTestTemplate().questions[0].prompt).not.toBe("编辑后的题干");
    expect(createCoTeachPostTestTemplate().questions[0].options![0]).not.toBe("编辑后的选项");
  });

  it("requires questions with unique ids and consistent group instructions", () => {
    const config = createCoTeachPostTestTemplate();
    expect(PostTestConfigSchema.safeParse({ ...config, questions: [] }).success).toBe(false);
    expect(PostTestConfigSchema.safeParse({ ...config, questions: [config.questions[0], config.questions[0]] }).success).toBe(false);
    config.questions[1].group = { ...config.questions[0].group!, referenceNote: "不同说明" };
    expect(PostTestConfigSchema.safeParse(config).success).toBe(false);
  });

  it("removes standalone reference answers from student activity and course configs", () => {
    const config = createCoTeachPostTestTemplate();
    config.questions[0].correctAnswer = config.questions[0].options![0];
    config.questions.at(-1)!.correctAnswer = "教师参考";
    const publicConfig = publicActivityConfig(config);
    expect(JSON.stringify(publicConfig)).not.toContain("correctAnswer");
    expect(JSON.stringify(publicConfig)).not.toContain("教师参考");
    expect(config.questions[0].correctAnswer).toBeDefined();
  });
});
