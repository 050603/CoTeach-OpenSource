export type CourseEntryPolicyInput = {
  hours?: number;
  grade?: string;
  lessonTargetCount: number;
  foundationTargetCount?: number;
  acceptedPrerequisiteCount?: number;
  courseMode?: string;
};

export type CourseEntryPolicy = {
  minimumPrerequisites: number;
  recommendedPrerequisites: { min: number; max: number };
  maximumPrerequisites: number;
  pretestTimeBudgetMin: number;
  remediationTimeBudgetMin: number;
  estimatedMinutesPerQuestion: number;
  estimatedMinutesPerRemediation: number;
  rationale: string;
};

function normalizedHours(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : 1;
}

function gradeProfile(grade: string | undefined) {
  const value = grade?.trim() ?? "";
  if (/小学低段|一年级|二年级|三年级/.test(value)) {
    return { earlyFoundation: true, questionMinutes: 1.25 };
  }
  if (/小学|四年级|五年级|六年级/.test(value)) {
    return { earlyFoundation: false, questionMinutes: 1.05 };
  }
  if (/初中|七年级|八年级|九年级/.test(value)) {
    return { earlyFoundation: false, questionMinutes: 0.9 };
  }
  return { earlyFoundation: false, questionMinutes: 0.75 };
}

/**
 * One source of truth for course-entry size and time constraints.
 *
 * The result is derived from the actual course instead of a global item cap:
 * course duration owns the available diagnostic/remediation time, grade owns
 * the expected response pace, the lesson graph owns the useful coverage, and
 * already-reviewed prerequisite nodes are never invalidated by a later stage.
 */
export function deriveCourseEntryPolicy(input: CourseEntryPolicyInput): CourseEntryPolicy {
  const hours = normalizedHours(input.hours);
  const totalMinutes = Math.max(1, Math.round(hours * 60));
  const lessonTargetCount = Math.max(1, Math.round(input.lessonTargetCount));
  const acceptedCount = Math.max(0, Math.round(input.acceptedPrerequisiteCount ?? 0));
  const grade = gradeProfile(input.grade);
  const isProjectCourse = input.courseMode === "pbl-six-stage";
  const pretestRatio = isProjectCourse ? 0.08 : 0.12;
  const remediationRatio = isProjectCourse ? 0.15 : 0.2;
  const pretestTimeBudgetMin = Math.max(
    Math.ceil(grade.questionMinutes),
    Math.round(totalMinutes * pretestRatio),
  );
  const remediationTimeBudgetMin = Math.max(3, Math.round(totalMinutes * remediationRatio));
  const estimatedMinutesPerRemediation = 3;
  const diagnosticCapacity = Math.max(1, Math.floor(pretestTimeBudgetMin / grade.questionMinutes));
  const remediationCapacity = Math.max(1, Math.floor(remediationTimeBudgetMin / estimatedMinutesPerRemediation));
  const derivedCapacity = Math.max(
    acceptedCount,
    Math.min(lessonTargetCount, diagnosticCapacity, remediationCapacity),
  );
  const allTargetsAreFoundation = (input.foundationTargetCount ?? 0) >= lessonTargetCount;
  const minimumPrerequisites = acceptedCount > 0
    ? acceptedCount
    : grade.earlyFoundation && allTargetsAreFoundation ? 0 : 1;
  const recommendedMin = Math.min(
    derivedCapacity,
    Math.max(minimumPrerequisites, lessonTargetCount >= 4 ? 2 : minimumPrerequisites),
  );
  const recommendedMax = Math.max(
    recommendedMin,
    Math.min(derivedCapacity, Math.ceil(lessonTargetCount * 0.6)),
  );

  return {
    minimumPrerequisites,
    recommendedPrerequisites: { min: recommendedMin, max: recommendedMax },
    maximumPrerequisites: derivedCapacity,
    pretestTimeBudgetMin,
    remediationTimeBudgetMin,
    estimatedMinutesPerQuestion: grade.questionMinutes,
    estimatedMinutesPerRemediation,
    rationale: `依据 ${hours} 课时、${input.grade?.trim() || "未明确学段"}、${lessonTargetCount} 个本课目标、${acceptedCount} 个已审校先修节点${isProjectCourse ? "及六阶段项目课程模式" : ""}计算；入口诊断约占 ${pretestTimeBudgetMin} 分钟，按缺口补学预算约 ${remediationTimeBudgetMin} 分钟。`,
  };
}

export function formatCourseEntryPolicy(policy: CourseEntryPolicy): string {
  const minimum = policy.minimumPrerequisites === 0
    ? "允许在确属低龄基础起点且无真实先修时不设前测"
    : `至少 ${policy.minimumPrerequisites} 项`;
  return `${minimum}，建议 ${policy.recommendedPrerequisites.min}-${policy.recommendedPrerequisites.max} 项，课程容量上限 ${policy.maximumPrerequisites} 项；前测预算 ${policy.pretestTimeBudgetMin} 分钟，按缺口补学预算 ${policy.remediationTimeBudgetMin} 分钟。${policy.rationale}`;
}
