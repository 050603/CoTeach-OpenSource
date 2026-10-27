import type { Course } from "@/lib/session/types";
import type { GenerateInput } from "@/lib/llm/types";

type CourseGenerationSource = Pick<
  Course,
  | "name"
  | "subject"
  | "grade"
  | "hours"
  | "summary"
  | "drivingQuestion"
  | "learningObjectives"
  | "learnerProfile"
  | "pblConfig"
> & {
  stages: Array<Pick<Course["stages"][number], "key" | "label" | "description">>;
};

export function buildCourseGenerationInput(course: CourseGenerationSource): GenerateInput {
  return {
    name: course.name,
    subject: course.subject,
    grade: course.grade,
    hours: course.hours,
    summary: course.summary,
    drivingQuestion: course.drivingQuestion,
    learningObjectives: course.learningObjectives ?? [],
    learnerProfile: course.learnerProfile,
    stages: course.stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      description: stage.description,
    })),
    pblConfig: course.pblConfig,
  };
}
