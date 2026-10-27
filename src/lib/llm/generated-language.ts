const GENERATED_TEXT_TERM_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["ai-learning", "知识讲授"],
  ["showcase", "成果汇报与评价"],
  ["reflection", "学习反思与迁移"],
  ["proposal", "方案构思与校准"],
  ["launch", "项目启动"],
  ["make", "项目实践"],
  ["priorKnowledge", "已有知识基础"],
  ["learningNeeds", "学习支持需求"],
  ["familiarContexts", "熟悉情境"],
  ["knowledgePoints", "知识点"],
  ["knowledgeGraph", "知识图谱"],
  ["foundation", "基础层"],
  ["application", "应用层"],
  ["extension", "拓展层"],
  ["core", "核心层"],
  ["introductory", "入门难度"],
  ["standard", "标准难度"],
  ["advanced", "进阶难度"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert leaked implementation vocabulary in model-authored, user-facing
 * prose into the labels teachers see in the product. Structural JSON fields
 * are normalized separately and must never be passed through this function.
 */
export function localizeGeneratedNarrative(
  value: string,
  knowledgePoints: ReadonlyArray<{ id: string; name: string }> = [],
): string {
  let result = value.trim();
  const pointNamesById = [...knowledgePoints]
    .filter((point) => point.id.trim() && point.name.trim())
    .sort((left, right) => right.id.length - left.id.length);
  for (const point of pointNamesById) {
    result = result.replace(new RegExp(escapeRegExp(point.id), "gi"), point.name.trim());
  }
  result = result.replace(/kp-\d+/gi, "对应知识点");
  for (const [token, label] of GENERATED_TEXT_TERM_LABELS) {
    result = result.replace(
      new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(token)}(?![A-Za-z0-9_-])`, "gi"),
      label,
    );
  }
  return result
    .replace(/。；/g, "；")
    .replace(/；。/g, "。")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
