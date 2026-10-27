import type { KnowledgeGraph, KnowledgePoint } from "@/lib/session/types";

export type KnowledgeGraphQuality = {
  ok: boolean;
  issues: string[];
  stats: {
    nodes: number;
    edges: number;
    required: number;
    prerequisites: number;
  };
};

export type KnowledgeGraphQualityOptions = {
  objectiveCount?: number;
  requireSemanticReview?: boolean;
  minimumPrerequisites?: number;
  maximumPrerequisites?: number;
};

export function normalizeKnowledgePointName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function assessKnowledgeGraphQuality(
  graph: KnowledgeGraph | undefined,
  points: readonly KnowledgePoint[],
  requiredPoints: readonly string[] = [],
  options: KnowledgeGraphQualityOptions = {},
): KnowledgeGraphQuality {
  const issues: string[] = [];
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const pointIds = new Set(points.map((point) => point.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const lessonNodes = nodes.filter((node) => pointIds.has(node.id));
  const prerequisiteNodes = nodes.filter((node) => !pointIds.has(node.id));
  if (prerequisiteNodes.length < (options.minimumPrerequisites ?? 0)) {
    issues.push(`课程知识结构至少需要 ${options.minimumPrerequisites} 项真实课前先修；入门、通识、启蒙或无需编程不能作为零先修依据`);
  }
  if (typeof options.maximumPrerequisites === "number" && prerequisiteNodes.length > options.maximumPrerequisites) {
    issues.push(`当前课程入口容量为 ${options.maximumPrerequisites} 项，知识结构包含 ${prerequisiteNodes.length} 项；只保留会直接阻断本课目标的真实先修`);
  }

  if (points.length === 0) issues.push("尚未生成知识点");
  if (new Set(points.map((point) => point.id)).size !== points.length) issues.push("知识点 ID 存在重复");
  if (new Set(points.map((point) => normalizeKnowledgePointName(point.name))).size !== points.length) {
    issues.push("知识点名称存在重复或同义重复");
  }
  if (points.some((point) => !nodeIds.has(point.id))) {
    issues.push("本课知识点没有被图谱节点完整覆盖");
  }
  if (prerequisiteNodes.some((node) => node.instructionalRole !== "prerequisite")) {
    issues.push("本课知识点之外的图谱节点必须明确标记为课前先修");
  }
  if (lessonNodes.some((node) => node.instructionalRole === "prerequisite")) {
    issues.push("本课教学目标不能同时标记为课前先修");
  }
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) issues.push("图谱节点 ID 存在重复");
  if (nodes.some((node) => !node.id.trim())) issues.push("图谱节点 ID 不能为空");
  if (new Set(nodes.map((node) => normalizeKnowledgePointName(node.label))).size !== nodes.length) {
    issues.push("图谱节点名称存在重复或同义重复");
  }
  if (points.some((point) => {
    const node = nodes.find((item) => item.id === point.id);
    return node && normalizeKnowledgePointName(node.label) !== normalizeKnowledgePointName(point.name);
  })) {
    issues.push("图谱节点名称与知识点名称不一致");
  }
  if (points.some((point) => !point.description.trim() || !point.keyInfo?.trim())) {
    issues.push("每个知识点都需要完整说明和本课关键信息");
  }
  if (points.some((point) => !point.level)) issues.push("每个知识点都需要明确教学层级");
  const roleAware = nodes.some((node) => node.instructionalRole !== undefined);
  if (roleAware && points.some((point) => !point.masteryBoundary?.trim())) {
    issues.push("每个本课目标都需要可观察的课后掌握边界");
  }
  if (roleAware && typeof options.objectiveCount === "number" && options.objectiveCount > 0) {
    const objectiveIndexes = new Set(points.flatMap((point) => point.objectiveIndexes ?? []));
    const invalid = [...objectiveIndexes].some((index) => index < 0 || index >= options.objectiveCount!);
    if (invalid) issues.push("本课知识点引用了不存在的课程目标");
    for (let index = 0; index < options.objectiveCount; index += 1) {
      if (!objectiveIndexes.has(index)) issues.push(`课程目标 ${index + 1} 没有对应的本课知识点`);
    }
  }
  if (prerequisiteNodes.some((node) =>
    !node.description.trim()
    || !node.keyInfo?.trim()
    || !node.priorKnowledgeEvidence?.trim()
    || !node.diagnosticBoundary?.trim()
  )) {
    issues.push("每个课前先修节点都需要完整说明、课前掌握依据和可诊断边界");
  }

  const pointNames = new Set(points.map((point) => normalizeKnowledgePointName(point.name)));
  const missingRequired = requiredPoints.filter(
    (point) => !pointNames.has(normalizeKnowledgePointName(point)),
  );
  if (missingRequired.length > 0) {
    issues.push(`教师指定知识点未被保留：${missingRequired.join("、")}`);
  }

  const validEdges = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target,
  );
  if (validEdges.length !== edges.length) issues.push("图谱包含无效引用或自环关系");
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) issues.push("图谱关系 ID 存在重复");
  if (edges.some((edge) => !edge.id.trim())) issues.push("图谱关系 ID 不能为空");
  const edgeKeys = validEdges.map((edge) => `${edge.source}\u0000${edge.target}\u0000${edge.label.trim()}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) issues.push("图谱包含重复关系");
  const directedPairs = validEdges.map((edge) => `${edge.source}\u0000${edge.target}`);
  if (new Set(directedPairs).size !== directedPairs.length) {
    issues.push("同一对知识节点存在多条重叠关系；每个方向只保留最准确的一条关系");
  }
  if (validEdges.length > nodes.length * 2) {
    issues.push("图谱关系过密，会产生难以阅读的交叉连线；请删除可由传递路径表达的冗余关系");
  }
  if (validEdges.some((edge) => !edge.label.trim() || /^(关联|相关|关系)$/.test(edge.label.trim()))) {
    issues.push("关系必须说明具体语义，不能只写“关联”或“相关”");
  }
  if (prerequisiteNodes.length > 0 && validEdges.some((edge) =>
    !edge.type || !edge.strength || !edge.rationale?.trim()
  )) {
    issues.push("包含课前先修时，每条关系都需要类型、必要强度和具体依据");
  }
  if (validEdges.some((edge) => edge.type === "required-prerequisite" && edge.strength !== "required")) {
    issues.push("必需先修关系的强度必须为 required");
  }
  if (validEdges.some((edge) => edge.type === "required-prerequisite" && pointIds.has(edge.source))) {
    issues.push("required-prerequisite 只能从课前先修节点指向本课目标；本课目标之间请使用 supports、application 等关系");
  }
  if (validEdges.some((edge) =>
    pointIds.has(edge.source)
    && prerequisiteNodes.some((node) => node.id === edge.target)
  )) {
    issues.push("知识依赖方向错误：本课目标不能指向课前先修节点");
  }
  const levelRank = { foundation: 0, core: 1, application: 2, extension: 3 } as const;
  const lessonNodeById = new Map(lessonNodes.map((node) => [node.id, node]));
  if (validEdges.some((edge) => {
    if (edge.type === "contrast" || edge.type === "required-prerequisite") return false;
    const source = lessonNodeById.get(edge.source);
    const target = lessonNodeById.get(edge.target);
    if (!source?.level || !target?.level) return false;
    return levelRank[source.level] > levelRank[target.level];
  })) {
    issues.push("本课知识关系存在从高阶应用倒指基础概念的逆向进阶，请按基础、核心、应用、拓展方向组织");
  }
  if (validEdges.some((edge) => {
    if (edge.type !== "application" && edge.type !== "transfer") return false;
    const target = lessonNodeById.get(edge.target);
    return Boolean(target?.level && levelRank[target.level] < levelRank.application);
  })) {
    issues.push("application 或 transfer 关系应指向应用层或拓展层节点");
  }

  const requiredPrerequisiteEdges = validEdges.filter((edge) =>
    edge.type === "required-prerequisite" && edge.strength === "required",
  );
  for (const node of prerequisiteNodes) {
    if (!hasPathToLessonTarget(node.id, requiredPrerequisiteEdges, pointIds)) {
      issues.push(`课前先修“${node.label}”没有指向本课目标的必需先修路径`);
    }
  }
  if (options.requireSemanticReview && !isKnowledgeStructureReviewCurrent(graph, points)) {
    issues.push("知识结构尚未通过独立语义审校，或审校结果已因内容变化而失效");
  }

  // Legacy graphs relied on global connectivity as their only structural guard.
  // Role-aware graphs may contain genuinely independent objective branches; forcing
  // them to connect encourages fabricated causal edges, so only validate cycles.
  if (nodes.length > 1) {
    if (!roleAware) {
      const adjacent = new Map(nodes.map((node) => [node.id, new Set<string>()]));
      validEdges.forEach((edge) => {
        adjacent.get(edge.source)?.add(edge.target);
        adjacent.get(edge.target)?.add(edge.source);
      });
      const visited = new Set<string>();
      const queue = nodes[0] ? [nodes[0].id] : [];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        adjacent.get(current)?.forEach((next) => {
          if (!visited.has(next)) queue.push(next);
        });
      }
      if (visited.size !== nodes.length) issues.push("图谱存在孤立节点或不相连的知识分支");
    }
    if (hasDirectedCycle(nodes.map((node) => node.id), validEdges)) {
      issues.push("图谱关系形成循环，无法作为清晰的教学进阶路径");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: { nodes: nodes.length, edges: edges.length, required: requiredPoints.length, prerequisites: prerequisiteNodes.length },
  };
}

export function knowledgeStructureSignature(
  graph: KnowledgeGraph | undefined,
  points: readonly KnowledgePoint[],
): string {
  const canonical = JSON.stringify({
    points: points.map((point) => ({
      id: point.id,
      name: point.name,
      description: point.description,
      keyInfo: point.keyInfo,
      masteryBoundary: point.masteryBoundary,
      objectiveIndexes: [...(point.objectiveIndexes ?? [])].sort((a, b) => a - b),
      level: point.level,
    })),
    nodes: (graph?.nodes ?? []).map((node) => ({
      id: node.id,
      label: node.label,
      description: node.description,
      keyInfo: node.keyInfo,
      level: node.level,
      instructionalRole: node.instructionalRole,
      objectiveIndexes: [...(node.objectiveIndexes ?? [])].sort((a, b) => a - b),
      masteryBoundary: node.masteryBoundary,
      priorKnowledgeEvidence: node.priorKnowledgeEvidence,
      diagnosticBoundary: node.diagnosticBoundary,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: (graph?.edges ?? []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: edge.type,
      strength: edge.strength,
      rationale: edge.rationale,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `kgs-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function isKnowledgeStructureReviewCurrent(
  graph: KnowledgeGraph | undefined,
  points: readonly KnowledgePoint[],
): boolean {
  const review = graph?.semanticReview;
  if (!graph || review?.status !== "passed"
    || review.sourceSignature !== knowledgeStructureSignature(graph, points)) {
    return false;
  }
  const lessonIds = new Set(points.map((point) => point.id));
  const prerequisiteIds = new Set(
    graph.nodes
      .filter((node) => node.instructionalRole === "prerequisite")
      .map((node) => node.id),
  );
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  return hasExactAcceptedDecisions(
    lessonIds,
    review.lessonDecisions,
    (decision) => decision.knowledgePointId,
  ) && hasExactAcceptedDecisions(
    prerequisiteIds,
    review.prerequisiteDecisions,
    (decision) => decision.nodeId,
  ) && hasExactAcceptedDecisions(
    edgeIds,
    review.relationshipDecisions,
    (decision) => decision.edgeId,
  );
}

function hasExactAcceptedDecisions<T extends { verdict: "accept" | "reject" }>(
  expectedIds: ReadonlySet<string>,
  decisions: readonly T[],
  getId: (decision: T) => string,
): boolean {
  if (decisions.length !== expectedIds.size) return false;
  const reviewedIds = new Set(decisions.map(getId));
  return reviewedIds.size === expectedIds.size
    && decisions.every((decision) =>
      decision.verdict === "accept" && expectedIds.has(getId(decision)),
    );
}

function hasPathToLessonTarget(
  startId: string,
  edges: ReadonlyArray<KnowledgeGraph["edges"][number]>,
  lessonIds: ReadonlySet<string>,
): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const queue = [...(outgoing.get(startId) ?? [])];
  const visited = new Set<string>([startId]);
  while (queue.length) {
    const current = queue.shift()!;
    if (lessonIds.has(current)) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

function hasDirectedCycle(
  nodeIds: readonly string[],
  edges: ReadonlyArray<KnowledgeGraph["edges"][number]>,
): boolean {
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  edges.forEach((edge) => {
    outgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  });
  const queue = nodeIds.filter((id) => indegree.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    outgoing.get(current)?.forEach((target) => {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    });
  }
  return visited !== nodeIds.length;
}
