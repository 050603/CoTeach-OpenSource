import { learningEvidenceRecordId } from "@/lib/learning-evidence/ids";
import {
  LEARNING_EVIDENCE_SCHEMA_VERSION,
  type LearningEvidence,
  type LearningEvidenceKind,
} from "@/lib/learning-evidence/types";
import type { AiCompanionId } from "@/lib/ai-companions";
import type { Course } from "@/lib/session/types";
import { buildStageBoundaryInstruction } from "./stage-policy";

export const COMPANION_WORKSPACE_TARGETS = [
  "proposal.concept",
  "proposal.actions",
  "proposal.validation",
  "proposal.risks",
  "proposal.aiBoundary",
  "proposal.sources",
  "make.processDraft",
  "make.testMethod",
  "make.testTarget",
  "make.observation",
  "make.result",
  "make.limitation",
  "make.interpretation",
  "make.reason",
  "make.plannedChange",
  "make.nextGoal",
] as const;

export type CompanionWorkspaceTarget = (typeof COMPANION_WORKSPACE_TARGETS)[number];

export type CompanionWorkspacePatch = {
  mode: "append" | "replace";
  target: CompanionWorkspaceTarget;
  title: string;
  content: string;
  reviewInstruction: string;
  reason?: string;
};

export type WorkspaceTargetDefinition = {
  stageKey: "proposal" | "make";
  evidenceKind: Extract<LearningEvidenceKind, "plan-version" | "test-result" | "revision-decision">;
  payloadKey: string;
  valueKind: "text" | "list";
  label: string;
  /** Legacy fields remain parseable so archived edits can still be undone. */
  assistantEditable?: boolean;
};

export type CompanionWorkspaceOperation = {
  kind: "direct-workspace-edit";
  operationId: string;
  evidenceId: string;
  evidenceKind: WorkspaceTargetDefinition["evidenceKind"];
  target: CompanionWorkspaceTarget;
  payloadKey: string;
  label: string;
  mode: CompanionWorkspacePatch["mode"];
  beforeValue: string | string[];
  afterValue: string | string[];
  afterUpdatedAt: string;
  companionId: AiCompanionId;
  taskId: string;
  reviewInstruction: string;
  reason?: string;
};

export type WorkspaceEditResult =
  | { status: "applied"; evidence: LearningEvidence; operation: CompanionWorkspaceOperation }
  | { status: "conflict" | "invalid"; reason: string };

const TARGET_DEFINITIONS: Record<CompanionWorkspaceTarget, WorkspaceTargetDefinition> = {
  "proposal.concept": { stageKey: "proposal", evidenceKind: "plan-version", payloadKey: "changeSummary", valueKind: "text", label: "方案构想" },
  "proposal.actions": { stageKey: "proposal", evidenceKind: "plan-version", payloadKey: "nextActions", valueKind: "list", label: "实现步骤" },
  "proposal.validation": { stageKey: "proposal", evidenceKind: "plan-version", payloadKey: "validationMethod", valueKind: "text", label: "验证方法" },
  "proposal.risks": { stageKey: "proposal", evidenceKind: "plan-version", payloadKey: "risks", valueKind: "list", label: "风险与应对" },
  "proposal.aiBoundary": { stageKey: "proposal", evidenceKind: "plan-version", payloadKey: "aiBoundary", valueKind: "text", label: "AI 分工边界" },
  "proposal.sources": { stageKey: "proposal", evidenceKind: "plan-version", payloadKey: "sources", valueKind: "list", label: "资料来源" },
  "make.processDraft": { stageKey: "make", evidenceKind: "revision-decision", payloadKey: "processDraft", valueKind: "text", label: "作品工作稿" },
  "make.testMethod": { stageKey: "make", evidenceKind: "test-result", payloadKey: "method", valueKind: "text", label: "测试对象与方法", assistantEditable: false },
  "make.testTarget": { stageKey: "make", evidenceKind: "test-result", payloadKey: "target", valueKind: "text", label: "测试对象", assistantEditable: false },
  "make.observation": { stageKey: "make", evidenceKind: "test-result", payloadKey: "observation", valueKind: "text", label: "观察记录", assistantEditable: false },
  "make.result": { stageKey: "make", evidenceKind: "test-result", payloadKey: "result", valueKind: "text", label: "测试结果", assistantEditable: false },
  "make.limitation": { stageKey: "make", evidenceKind: "test-result", payloadKey: "limitation", valueKind: "text", label: "测试局限", assistantEditable: false },
  "make.interpretation": { stageKey: "make", evidenceKind: "revision-decision", payloadKey: "interpretation", valueKind: "text", label: "结果解释", assistantEditable: false },
  "make.reason": { stageKey: "make", evidenceKind: "revision-decision", payloadKey: "reason", valueKind: "text", label: "修订理由", assistantEditable: false },
  "make.plannedChange": { stageKey: "make", evidenceKind: "revision-decision", payloadKey: "plannedChange", valueKind: "text", label: "计划修改", assistantEditable: false },
  "make.nextGoal": { stageKey: "make", evidenceKind: "revision-decision", payloadKey: "nextGoal", valueKind: "text", label: "下一轮目标", assistantEditable: false },
};

const EDITABLE_TARGET = /(方案|构想|步骤|风险|边界|测试|观察|结果|修订|下一步|文档|报告|材料|记录|工作台)/;
const EDIT_INTENT = /(补充|追加|添加|加入|写入|整理到|放到|放进|更新|完善|修改|改写|编辑)/;

export function requestsWorkspaceEdit(message: string): boolean {
  return EDITABLE_TARGET.test(message) && EDIT_INTENT.test(message);
}

export function getWorkspaceTargetDefinition(
  target: CompanionWorkspaceTarget,
): WorkspaceTargetDefinition {
  return TARGET_DEFINITIONS[target];
}

export function workspaceTargetsForStage(stageKey: string): CompanionWorkspaceTarget[] {
  return COMPANION_WORKSPACE_TARGETS.filter(
    (target) =>
      TARGET_DEFINITIONS[target].stageKey === stageKey
      && TARGET_DEFINITIONS[target].assistantEditable !== false,
  );
}

export function buildWorkspaceEditInstruction(stageKey: string, message: string): string | undefined {
  if (message.includes("只输出纯文本工作结果")) return undefined;
  if (!requestsWorkspaceEdit(message)) return undefined;
  if (buildStageBoundaryInstruction(stageKey, message)) return undefined;
  const targets = workspaceTargetsForStage(stageKey);
  if (!targets.length) return undefined;

  return [
    "学生明确要求你直接协作编辑项目工作台。你只能修改当前阶段白名单中的一个草稿字段，不得触发提交、教师确认或阶段完成。",
    "先用正常口语说明你准备修改什么；如果信息不足或会臆造事实，不要输出补丁，只向学生追问一个必要事实。",
    `当前阶段可编辑字段：${targets.map((target) => `${target}（${TARGET_DEFINITIONS[target].label}）`).join("；")}`,
    "回复末尾必须追加且只追加一个机器可读块，块内是严格 JSON，不要使用 Markdown。mode 优先使用 append；只有学生明确要求改写现有字段时才用 replace。",
    '<workspace_patch>{"mode":"append","target":"proposal.risks","title":"不超过20字的编辑说明","content":"只包含本次写入内容，不超过600字","reviewInstruction":"学生需要核验的一件事","reason":"为什么修改这个字段"}</workspace_patch>',
    "机器可读块不会被朗读。不得输出白名单外的 target，不得把学生未提供的测试结果、经历、来源或事实写入工作台。",
  ].join("\n");
}

function plainText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function isWorkspaceTarget(value: unknown): value is CompanionWorkspaceTarget {
  return typeof value === "string"
    && COMPANION_WORKSPACE_TARGETS.includes(value as CompanionWorkspaceTarget);
}

export function extractWorkspacePatch(response: string): {
  speech: string;
  patch?: CompanionWorkspacePatch;
} {
  const match = response.match(/<workspace_patch>\s*([\s\S]*?)\s*<\/workspace_patch>/i);
  const speech = response.replace(/<workspace_patch>[\s\S]*?<\/workspace_patch>/gi, "").trim();
  if (!match) return { speech };

  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    const title = plainText(parsed.title, 40);
    const content = plainText(parsed.content, 800);
    const reviewInstruction = plainText(parsed.reviewInstruction, 160);
    const reason = plainText(parsed.reason, 240);
    if (
      !["append", "replace"].includes(String(parsed.mode))
      || !isWorkspaceTarget(parsed.target)
      || !title
      || !content
      || !reviewInstruction
    ) return { speech };
    return {
      speech,
      patch: {
        mode: parsed.mode as CompanionWorkspacePatch["mode"],
        target: parsed.target,
        title,
        content,
        reviewInstruction,
        ...(reason ? { reason } : {}),
      },
    };
  } catch {
    return { speech };
  }
}

function splitPatchLines(value: string): string[] {
  return value
    .split(/\r?\n|；|;/)
    .map((item) => item.replace(/^[-•\d.、)）\s]+/, "").trim())
    .filter(Boolean);
}

export function applyWorkspacePatchToPayload(input: {
  payload: Record<string, unknown>;
  patch: CompanionWorkspacePatch;
}): {
  payload: Record<string, unknown>;
  payloadKey: string;
  label: string;
  beforeValue: string | string[];
  afterValue: string | string[];
} {
  const definition = getWorkspaceTargetDefinition(input.patch.target);
  const previous = input.payload[definition.payloadKey];
  const beforeValue = definition.valueKind === "list"
    ? Array.isArray(previous) ? previous.filter((item): item is string => typeof item === "string") : []
    : typeof previous === "string" ? previous : "";
  const afterValue = definition.valueKind === "list"
    ? input.patch.mode === "replace"
      ? splitPatchLines(input.patch.content)
      : [...new Set([...beforeValue as string[], ...splitPatchLines(input.patch.content)])]
    : input.patch.mode === "replace" || !beforeValue
      ? input.patch.content
      : `${beforeValue as string}\n${input.patch.content}`;

  return {
    payload: { ...input.payload, [definition.payloadKey]: afterValue },
    payloadKey: definition.payloadKey,
    label: definition.label,
    beforeValue,
    afterValue,
  };
}

function summarizePayload(payload: Record<string, unknown>): string {
  const values: string[] = [];
  Object.values(payload).forEach((value) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === "string" && item.trim()) values.push(item.trim());
      });
    }
  });
  return values.join("；").slice(0, 500);
}

export function activeMakeIterationId(course: Course, studentId: string): string {
  const projectId = course.groups?.find((group) =>
    group.members.some((member) => member.studentId === studentId))?.id;
  const versionCount = (course.uploads ?? []).filter((item) =>
    item.stageKey === "make"
    && (item.studentId === studentId || Boolean(projectId && item.groupId === projectId)))
    .length;
  return `cycle-${versionCount + 1}`;
}

function initialPayload(
  kind: WorkspaceTargetDefinition["evidenceKind"],
  iterationId: string,
): Record<string, unknown> {
  if (kind === "plan-version") {
    return {
      versionLabel: "v1",
      changeSummary: "",
      nextActions: [],
      validationMethod: "",
      risks: [],
      aiBoundary: "",
    };
  }
  if (kind === "test-result") {
    return {
      iterationId,
      method: "",
      target: "",
      observation: "",
      result: "",
      limitation: "",
    };
  }
  return {
    iterationId,
    interpretation: "",
    decision: "revise",
    reason: "",
    plannedChange: "",
    nextGoal: "",
    processDraft: "",
  };
}

export function applyCompanionWorkspacePatch(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  patch: CompanionWorkspacePatch;
  companionId: AiCompanionId;
  taskId: string;
  taskCreatedAt: string;
  now?: string;
}): WorkspaceEditResult {
  const definition = getWorkspaceTargetDefinition(input.patch.target);
  if (definition.stageKey !== input.stageKey) {
    return { status: "invalid", reason: "AI 返回的编辑字段不属于当前阶段。" };
  }

  const iterationId = definition.stageKey === "make"
    ? activeMakeIterationId(input.course, input.studentId)
    : "plan-v1";
  const suffix = definition.evidenceKind === "plan-version" ? undefined : iterationId;
  const evidenceId = learningEvidenceRecordId({
    courseId: input.course.id,
    studentId: input.studentId,
    kind: definition.evidenceKind,
    suffix,
  });
  const existing = (input.course.learningEvidence ?? []).find((item) => item.id === evidenceId);
  if (
    input.patch.mode === "replace"
    && existing
    && Date.parse(existing.updatedAt) > Date.parse(input.taskCreatedAt)
  ) {
    return {
      status: "conflict",
      reason: `你在 AI 思考期间更新了“${definition.label}”，为避免覆盖，本次改写没有自动应用。`,
    };
  }

  const applied = applyWorkspacePatchToPayload({
    payload: (existing?.payload as Record<string, unknown> | undefined)
      ?? initialPayload(definition.evidenceKind, iterationId),
    patch: input.patch,
  });
  const timestamp = input.now ?? new Date().toISOString();
  const evidence: LearningEvidence = {
    id: evidenceId,
    schemaVersion: LEARNING_EVIDENCE_SCHEMA_VERSION,
    courseId: input.course.id,
    studentId: input.studentId,
    stageKey: input.stageKey,
    kind: definition.evidenceKind,
    title: existing?.title ?? (
      definition.evidenceKind === "plan-version"
        ? "项目方案 v1"
        : definition.evidenceKind === "test-result"
          ? `测试记录 ${iterationId.replace("cycle-", "#")}`
          : `作品工作稿 ${iterationId.replace("cycle-", "#")}`
    ),
    summary: summarizePayload(applied.payload),
    payload: applied.payload as LearningEvidence["payload"],
    status: "draft",
    source: "system",
    countsTowardReadiness: true,
    evidenceRefs: existing?.evidenceRefs ?? [],
    artifactSnapshotIds: existing?.artifactSnapshotIds ?? [],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  return {
    status: "applied",
    evidence,
    operation: {
      kind: "direct-workspace-edit",
      operationId: `workspace-edit-${input.taskId}-${input.patch.target}`,
      evidenceId,
      evidenceKind: definition.evidenceKind,
      target: input.patch.target,
      payloadKey: applied.payloadKey,
      label: applied.label,
      mode: input.patch.mode,
      beforeValue: applied.beforeValue,
      afterValue: applied.afterValue,
      afterUpdatedAt: timestamp,
      companionId: input.companionId,
      taskId: input.taskId,
      reviewInstruction: input.patch.reviewInstruction,
      ...(input.patch.reason ? { reason: input.patch.reason } : {}),
    },
  };
}

export function parseWorkspaceOperation(
  payload: Record<string, unknown> | undefined,
): CompanionWorkspaceOperation | undefined {
  if (!payload || payload.kind !== "direct-workspace-edit") return undefined;
  if (
    typeof payload.operationId !== "string"
    || typeof payload.evidenceId !== "string"
    || typeof payload.evidenceKind !== "string"
    || !isWorkspaceTarget(payload.target)
    || typeof payload.payloadKey !== "string"
    || typeof payload.label !== "string"
    || !["append", "replace"].includes(String(payload.mode))
    || !(typeof payload.beforeValue === "string" || Array.isArray(payload.beforeValue))
    || !(typeof payload.afterValue === "string" || Array.isArray(payload.afterValue))
    || typeof payload.afterUpdatedAt !== "string"
    || typeof payload.companionId !== "string"
    || typeof payload.taskId !== "string"
    || typeof payload.reviewInstruction !== "string"
  ) return undefined;
  return payload as unknown as CompanionWorkspaceOperation;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function revertCompanionWorkspaceOperation(input: {
  course: Course;
  operation: CompanionWorkspaceOperation;
  now?: string;
}): WorkspaceEditResult {
  const existing = (input.course.learningEvidence ?? []).find(
    (item) => item.id === input.operation.evidenceId,
  );
  if (!existing) {
    return { status: "conflict", reason: "对应的工作区草稿已经不存在，无法直接撤销。" };
  }
  const currentValue = (existing.payload as unknown as Record<string, unknown>)[input.operation.payloadKey];
  if (!valuesEqual(currentValue, input.operation.afterValue)) {
    return {
      status: "conflict",
      reason: `“${input.operation.label}”在本次 AI 编辑后又有新修改，为避免覆盖，不能直接撤销。`,
    };
  }
  const timestamp = input.now ?? new Date().toISOString();
  const payload = {
    ...(existing.payload as unknown as Record<string, unknown>),
    [input.operation.payloadKey]: input.operation.beforeValue,
  };
  return {
    status: "applied",
    evidence: {
      ...existing,
      payload: payload as LearningEvidence["payload"],
      summary: summarizePayload(payload),
      status: "draft",
      source: "student",
      updatedAt: timestamp,
      submittedAt: undefined,
      confirmedAt: undefined,
    },
    operation: {
      ...input.operation,
      afterValue: input.operation.beforeValue,
      afterUpdatedAt: timestamp,
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function appendCompanionContribution(input: {
  existingContent: string;
  patch: CompanionWorkspacePatch;
  companionId: string;
  companionName: string;
  taskId: string;
}): string {
  const contribution = [
    `<section data-companion-contribution="${escapeHtml(input.companionId)}" data-task-id="${escapeHtml(input.taskId)}" data-target="${escapeHtml(input.patch.target)}">`,
    `<h3>${escapeHtml(input.patch.title)}</h3>`,
    `<p>${escapeHtml(input.patch.content).replace(/\n/g, "<br>")}</p>`,
    `<p><em>${escapeHtml(input.companionName)}提醒：${escapeHtml(input.patch.reviewInstruction)}</em></p>`,
    "</section>",
  ].join("");
  return [input.existingContent, contribution].filter(Boolean).join("\n");
}
