import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("prompt quality policy adoption", () => {
  it.each([
    ["课程生成", "src/lib/llm/prompts.ts", "JSON_TEACHER_PROMPT_CONTRACT"],
    ["教师支架", "src/lib/teaching-ai/support-engine.ts", "JSON_TEACHER_PROMPT_CONTRACT"],
    ["学生伴学", "src/lib/ai-companions.ts", "STUDENT_CONVERSATION_PROMPT_CONTRACT"],
    ["课程入口学习包", "src/lib/course-entry-generation.ts", "JSON_TEACHER_PROMPT_CONTRACT"],
    ["微课判断", "src/app/api/adaptive-learning/micro-lesson/route.ts", "JSON_STUDENT_PROMPT_CONTRACT"],
    ["课堂主持", "src/app/api/teaching-ai/facilitation-scaffold/route.ts", "TEACHER_FACING_PROMPT_CONTRACT"],
    ["学生聊天", "src/app/api/chat/student/route.ts", "STUDENT_CONVERSATION_PROMPT_CONTRACT"],
  ])("keeps the shared contract in the %s prompt path", (_name, path, marker) => {
    expect(source(path)).toContain(marker);
  });

  it("keeps internal PBL vocabulary out of generated display copy", () => {
    const template = source("src/lib/openmaic/prompts/templates/pbl-course/system.md");
    expect(template).toContain("Internal routing vocabulary is never display copy");
    expect(template).toContain("Missing learner-profile fields mean unknown or not supplied");
    expect(template).toContain("silently check");
  });
});
