import type {
  CourseContent,
} from "../session/types";
import type { PblCourseConfig } from "../pbl-course-config";
import type { LearnerProfileInput } from "@/lib/openmaic/pedagogy/teaching-constraints";

export type GenerateInput = {
  name: string;
  subject: string;
  grade: string;
  hours: number;
  summary: string;
  drivingQuestion: string;
  learningObjectives?: string[];
  learnerProfile?: LearnerProfileInput;
  stages: { key: string; label: string; description: string }[];
  pblConfig?: PblCourseConfig;
};

// Re-exported from errors.ts so existing imports from "./types" keep working.
// The canonical definition lives in errors.ts alongside the rest of the
// LLM error hierarchy.
export { LlmNotConfiguredError } from "./errors";

export type LlmCallRequest = {
  action:
      | "pblOutline"
      | "knowledgeGraph"
      | "moduleTimingPlan"
      | "teachingOutline"
    | "lessonOutline"
    | "evaluationPlan"
    | "fullCourse";
  input: GenerateInput;
  context?: Partial<
    Pick<
      CourseContent,
      | "pblOutline"
      | "teacherRequiredKnowledgePoints"
      | "knowledgePoints"
      | "knowledgeGraph"
      | "projectMainline"
      | "moduleTimingPlan"
      | "teachingOutline"
      | "lessonOutline"
    >
  >;
};

export type LlmCallResponse = {
  content: CourseContent;
  source: "llm";
};
