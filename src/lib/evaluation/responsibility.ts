import type { EvaluationDimension } from "@/lib/session/types";

const TEACHER_EVIDENCE_PATTERN =
  /汇报|答辩|展示|呈现|表达|沟通|演示|现场|台风|时间控制|回应问题|结构组织|协作表现/;

export const LEGACY_TEACHER_DIMENSIONS: EvaluationDimension[] = [
  {
    id: "teacher-presentation-clarity",
    name: "现场表达与呈现",
    weight: 40,
    description: "汇报是否清晰、重点突出，现场演示是否稳定并便于理解。",
    responsibleRole: "teacher",
  },
  {
    id: "teacher-evidence-response",
    name: "证据组织与现场回应",
    weight: 35,
    description: "能否用恰当证据支持判断，并对现场追问作出有逻辑的回应。",
    responsibleRole: "teacher",
  },
  {
    id: "teacher-general-performance",
    name: "汇报结构与通用表现",
    weight: 25,
    description: "时间控制、内容结构和整体完成度是否符合现场汇报要求。",
    responsibleRole: "teacher",
  },
];

export function resolveDimensionRole(
  dimension: EvaluationDimension,
): "ai" | "teacher" {
  if (dimension.responsibleRole) return dimension.responsibleRole;
  return TEACHER_EVIDENCE_PATTERN.test(`${dimension.name} ${dimension.description}`)
    ? "teacher"
    : "ai";
}

export function getTeacherEvaluationDimensions(
  dimensions: EvaluationDimension[],
): EvaluationDimension[] {
  const teacherDimensions = dimensions.filter(
    (dimension) => resolveDimensionRole(dimension) === "teacher",
  );
  return teacherDimensions.length > 0
    ? teacherDimensions
    : LEGACY_TEACHER_DIMENSIONS.map((dimension) => ({ ...dimension }));
}

export function hasBothScoredRoles(dimensions: EvaluationDimension[]): boolean {
  const roles = new Set(dimensions.map(resolveDimensionRole));
  return roles.has("ai") && roles.has("teacher");
}
