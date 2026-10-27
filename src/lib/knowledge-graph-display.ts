import type { KnowledgeGraph, KnowledgeGraphNode, KnowledgePoint } from "@/lib/session/types";
import { isOpaqueInternalId } from "@/lib/user-facing-labels";

export function normalizeKnowledgeGraphForDisplay(
  graph: KnowledgeGraph | undefined,
  points: KnowledgePoint[],
): KnowledgeGraph {
  const pointNames = new Map(points.map((point) => [point.id, point.name]));
  const nodes: KnowledgeGraphNode[] = graph?.nodes?.length
    ? graph.nodes.map((node) => ({
        ...node,
        label: !node.label?.trim() || isOpaqueInternalId(node.label)
          ? pointNames.get(node.id)?.trim() || "未命名知识点"
          : node.label,
      }))
    : points.map((point, index) => ({
        id: point.id,
        label: point.name,
        description: point.description,
        keyInfo: point.keyInfo,
        level: (point.level ?? (index < 2 ? "foundation" : index < 4 ? "core" : "application")) as KnowledgeGraphNode["level"],
      }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (graph?.edges ?? []).filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target,
  );
  return { ...(graph ?? {}), nodes, edges };
}
