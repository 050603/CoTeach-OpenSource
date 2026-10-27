import { PBL_STAGE_LABELS } from "@/lib/prompt-quality/policy";

const FEEDBACK_KIND_LABELS: Record<string, string> = {
  comment: "教师评语",
  question: "教师提问",
  "ai-support": "AI 学习支持",
  revision: "修改建议",
  praise: "肯定与鼓励",
};

const SUBMISSION_TYPE_LABELS: Record<string, string> = {
  idea: "项目想法",
  plan: "项目方案",
  document: "项目文档",
  code: "代码成果",
  resource: "学习资料",
  showcase: "成果展示",
  reflection: "学习反思",
  evidence: "学习证据",
};

const ACTOR_ROLE_LABELS: Record<string, string> = {
  user: "学生",
  student: "学生",
  assistant: "AI 伙伴",
  agent: "AI 伙伴",
  teacher: "教师",
  peer: "同伴",
  self: "学生本人",
  "system-trigger": "系统提醒",
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  pdf: "PDF",
  "application/pdf": "PDF",
  doc: "Word",
  docx: "Word",
  "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  ppt: "PPT",
  pptx: "PPT",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPT",
  xls: "Excel",
  xlsx: "Excel",
  "application/vnd.ms-excel": "Excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  mp4: "视频",
  "video/mp4": "视频",
  png: "图片",
  jpg: "图片",
  jpeg: "图片",
  webp: "图片",
  "image/png": "图片",
  "image/jpeg": "图片",
  "image/webp": "图片",
};

export function isOpaqueInternalId(value: string): boolean {
  const normalized = value.trim();
  return /^(?:re_|prereq-|kp-|scene-|outline-|branch-|trigger-|evaluation-|resource-|evidence-|student-|group-|grp-)/i.test(normalized)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(normalized)
    || (/^[A-Za-z0-9_-]{20,}$/.test(normalized) && /\d/.test(normalized));
}

export function userFacingName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && !isOpaqueInternalId(normalized) ? normalized : fallback;
}

export function userFacingStageLabel(stageKey?: string, fallback?: string): string {
  if (stageKey && PBL_STAGE_LABELS[stageKey]) return PBL_STAGE_LABELS[stageKey];
  const safeFallback = fallback?.trim();
  return safeFallback && !isOpaqueInternalId(safeFallback) ? safeFallback : "课程学习阶段";
}

export function feedbackKindLabel(kind?: string): string {
  return (kind && FEEDBACK_KIND_LABELS[kind]) || "教师反馈";
}

export function submissionTypeLabel(type?: string): string {
  return (type && SUBMISSION_TYPE_LABELS[type]) || "学习成果";
}

export function actorRoleLabel(role?: string): string {
  return (role && ACTOR_ROLE_LABELS[role]) || "课程参与者";
}

export function courseResourceTypeLabel(type?: string): string {
  if (!type?.trim()) return "文件";
  const normalized = type.trim().toLowerCase().replace(/^\./, "");
  return RESOURCE_TYPE_LABELS[normalized] ?? "文件";
}
