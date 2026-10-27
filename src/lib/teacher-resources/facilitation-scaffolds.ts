import type { DynamicFacilitationScaffold } from "@/lib/session/types";

const DYNAMIC_PATTERNS: Array<{ pattern: RegExp; kind: DynamicFacilitationScaffold["kind"] }> = [
  { pattern: /方案.*(点评|校准|总结)|点评.*方案/i, kind: "proposal-critique" },
  { pattern: /作品.*(点评|总结)|成果.*点评/i, kind: "artifact-critique" },
  { pattern: /共性问题|全班问题/i, kind: "common-issue" },
  { pattern: /汇报.*总结|答辩.*总结|展示.*总结/i, kind: "presentation-summary" },
];

export function classifyTeacherResourceGeneration(title: string):
  | { mode: "predictable" }
  | { mode: "dynamic-scaffold"; kind: DynamicFacilitationScaffold["kind"] } {
  const match = DYNAMIC_PATTERNS.find((item) => item.pattern.test(title));
  return match ? { mode: "dynamic-scaffold", kind: match.kind } : { mode: "predictable" };
}

export function buildFacilitationScaffold(input: {
  courseId: string;
  stageKey: string;
  title: string;
  kind: DynamicFacilitationScaffold["kind"];
}): DynamicFacilitationScaffold {
  const now = new Date().toISOString();
  const sectionTitles = input.kind === "presentation-summary"
    ? ["汇报事实", "代表性亮点", "待解决问题", "迁移与提升"]
    : ["观察到的事实", "证据与差距", "追问清单", "下一步行动"];
  return {
    id: facilitationScaffoldId(input.courseId, input.stageKey, input.kind),
    courseId: input.courseId,
    stageKey: input.stageKey,
    kind: input.kind,
    title: input.title,
    sections: sectionTitles.map((title, index) => ({
      id: `section-${index + 1}`,
      title,
      prompt: `课堂中依据真实学生数据填写“${title}”，备课阶段不得预设结论。`,
      evidenceSlots: ["学生产物或对话证据", "教师现场观察"],
    })),
    status: "template",
    evidenceIds: [],
    generatedAt: now,
    updatedAt: now,
  };
}

export function facilitationScaffoldId(
  courseId: string,
  stageKey: string,
  kind: DynamicFacilitationScaffold["kind"],
): string {
  return `${courseId}:facilitation:${stageKey}:${kind}`;
}

/**
 * A stage has at most one scaffold of a given kind. Canonicalising here also
 * upgrades old deterministic IDs that omitted courseId and collided globally
 * in PostgreSQL. When duplicate generated resources describe the same
 * scaffold, retain the most recently updated version.
 */
export function normalizeFacilitationScaffolds(
  scaffolds: readonly DynamicFacilitationScaffold[],
): DynamicFacilitationScaffold[] {
  const byId = new Map<string, DynamicFacilitationScaffold>();
  for (const scaffold of scaffolds) {
    const id = facilitationScaffoldId(
      scaffold.courseId,
      scaffold.stageKey,
      scaffold.kind,
    );
    const normalized = { ...scaffold, id };
    const existing = byId.get(id);
    if (
      !existing ||
      Date.parse(normalized.updatedAt) >= Date.parse(existing.updatedAt)
    ) {
      byId.set(id, normalized);
    }
  }
  return [...byId.values()];
}
