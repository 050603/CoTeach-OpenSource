import type { KnowledgeGraphEdge, KnowledgeGraphNode } from "@/lib/session/types";

export const KNOWLEDGE_GRAPH_NODE_WIDTH = 188;
export const KNOWLEDGE_GRAPH_NODE_HEIGHT = 72;

const COLUMN_GAP = 132;
const ROW_GAP = 40;

export type KnowledgeGraphLayoutItem = {
  id: string;
  position: { x: number; y: number };
  rank: number;
};

/**
 * Produces a deterministic learning-path layout from the graph's actual
 * relationships. Semantic levels intentionally do not affect positioning:
 * they describe a node, while directed edges describe how ideas progress.
 */
export function layoutKnowledgeGraph(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
): KnowledgeGraphLayoutItem[] {
  if (nodes.length === 0) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const validEdges = edges.filter((edge) =>
    nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target,
  );
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const incoming = new Map(nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of validEdges) {
    if (!outgoing.get(edge.source)!.includes(edge.target)) outgoing.get(edge.source)!.push(edge.target);
    if (!incoming.get(edge.target)!.includes(edge.source)) incoming.get(edge.target)!.push(edge.source);
  }

  const ranks = deriveRanks(nodes, outgoing, incoming, nodeIndex);
  const columns = new Map<number, string[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    columns.set(rank, [...(columns.get(rank) ?? []), node.id]);
  }

  reduceCrossings(columns, ranks, incoming, outgoing, nodeIndex);

  const horizontalStep = KNOWLEDGE_GRAPH_NODE_WIDTH + COLUMN_GAP;
  const verticalStep = KNOWLEDGE_GRAPH_NODE_HEIGHT + ROW_GAP;
  const result = new Map<string, KnowledgeGraphLayoutItem>();

  for (const [rank, column] of [...columns.entries()].sort(([left], [right]) => left - right)) {
    const top = -((column.length - 1) * verticalStep) / 2;
    column.forEach((id, index) => {
      result.set(id, {
        id,
        rank,
        position: { x: rank * horizontalStep, y: top + index * verticalStep },
      });
    });
  }

  return nodes.map((node) => result.get(node.id)!);
}

function deriveRanks(
  nodes: readonly KnowledgeGraphNode[],
  outgoing: ReadonlyMap<string, string[]>,
  incoming: ReadonlyMap<string, string[]>,
  nodeIndex: ReadonlyMap<string, number>,
): Map<string, number> {
  const indegree = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const processed = new Set<string>();

  while (queue.length > 0) {
    queue.sort((left, right) => (nodeIndex.get(left) ?? 0) - (nodeIndex.get(right) ?? 0));
    const current = queue.shift()!;
    processed.add(current);
    for (const target of outgoing.get(current) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(current) ?? 0) + 1));
      const nextIndegree = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }

  // Quality checks reject cycles, but display code should still degrade safely.
  // Put any cyclic remainder in a stable column after the valid acyclic path.
  const lastAcyclicRank = processed.size > 0
    ? Math.max(...[...processed].map((id) => ranks.get(id) ?? 0))
    : -1;
  for (const node of nodes) {
    if (!processed.has(node.id)) ranks.set(node.id, lastAcyclicRank + 1);
  }

  return ranks;
}

function reduceCrossings(
  columns: Map<number, string[]>,
  ranks: ReadonlyMap<string, number>,
  incoming: ReadonlyMap<string, string[]>,
  outgoing: ReadonlyMap<string, string[]>,
  nodeIndex: ReadonlyMap<string, number>,
) {
  const rankList = [...columns.keys()].sort((left, right) => left - right);
  if (rankList.length < 2) return;

  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 1; index < rankList.length; index += 1) {
      sortByNeighborCenter(columns, rankList[index], ranks, incoming, nodeIndex, "before");
    }
    for (let index = rankList.length - 2; index >= 0; index -= 1) {
      sortByNeighborCenter(columns, rankList[index], ranks, outgoing, nodeIndex, "after");
    }
  }
}

function sortByNeighborCenter(
  columns: Map<number, string[]>,
  rank: number,
  ranks: ReadonlyMap<string, number>,
  neighbors: ReadonlyMap<string, string[]>,
  nodeIndex: ReadonlyMap<string, number>,
  direction: "before" | "after",
) {
  const column = columns.get(rank);
  if (!column) return;
  const positions = new Map<string, number>();
  for (const ids of columns.values()) ids.forEach((id, index) => positions.set(id, index));

  column.sort((left, right) => {
    const leftCenter = neighborCenter(left);
    const rightCenter = neighborCenter(right);
    if (leftCenter !== rightCenter) return leftCenter - rightCenter;
    return (nodeIndex.get(left) ?? 0) - (nodeIndex.get(right) ?? 0);
  });

  function neighborCenter(id: string) {
    const relevant = (neighbors.get(id) ?? []).filter((neighborId) => {
      const neighborRank = ranks.get(neighborId) ?? rank;
      return direction === "before" ? neighborRank < rank : neighborRank > rank;
    });
    if (relevant.length === 0) return nodeIndex.get(id) ?? 0;
    return relevant.reduce((sum, neighborId) => sum + (positions.get(neighborId) ?? 0), 0) / relevant.length;
  }
}
