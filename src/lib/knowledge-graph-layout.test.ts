import { describe, expect, it } from "vitest";
import type { KnowledgeGraphEdge, KnowledgeGraphNode } from "@/lib/session/types";
import {
  KNOWLEDGE_GRAPH_NODE_HEIGHT,
  KNOWLEDGE_GRAPH_NODE_WIDTH,
  layoutKnowledgeGraph,
} from "@/lib/knowledge-graph-layout";

function node(id: string, level: KnowledgeGraphNode["level"] = "core"): KnowledgeGraphNode {
  return { id, label: id, description: id, level };
}

function edge(source: string, target: string): KnowledgeGraphEdge {
  return { id: `${source}-${target}`, source, target, label: "支持" };
}

describe("layoutKnowledgeGraph", () => {
  it("derives a stable left-to-right learning path from relationships instead of semantic tiers", () => {
    const nodes = [
      node("observe", "application"),
      node("model", "foundation"),
      node("explain", "extension"),
      node("compare", "core"),
    ];
    const edges = [edge("observe", "model"), edge("model", "compare"), edge("compare", "explain")];

    const first = layoutKnowledgeGraph(nodes, edges);
    const second = layoutKnowledgeGraph(nodes, edges);
    const positions = new Map(first.map((item) => [item.id, item.position]));

    expect(second).toEqual(first);
    expect(positions.get("observe")!.x).toBeLessThan(positions.get("model")!.x);
    expect(positions.get("model")!.x).toBeLessThan(positions.get("compare")!.x);
    expect(positions.get("compare")!.x).toBeLessThan(positions.get("explain")!.x);
  });

  it("keeps nodes collision-free across branching and disconnected paths", () => {
    const nodes = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => node(id));
    const layout = layoutKnowledgeGraph(nodes, [
      edge("a", "c"),
      edge("b", "c"),
      edge("c", "d"),
      edge("c", "e"),
      edge("f", "g"),
    ]);

    for (let leftIndex = 0; leftIndex < layout.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < layout.length; rightIndex += 1) {
        const left = layout[leftIndex].position;
        const right = layout[rightIndex].position;
        const overlapsX = Math.abs(left.x - right.x) < KNOWLEDGE_GRAPH_NODE_WIDTH;
        const overlapsY = Math.abs(left.y - right.y) < KNOWLEDGE_GRAPH_NODE_HEIGHT;
        expect(overlapsX && overlapsY, `${layout[leftIndex].id} overlaps ${layout[rightIndex].id}`).toBe(false);
      }
    }
  });

  it("does not force unconnected semantic levels into fixed columns", () => {
    const layout = layoutKnowledgeGraph([
      node("foundation", "foundation"),
      node("core", "core"),
      node("application", "application"),
      node("extension", "extension"),
    ], []);

    expect(new Set(layout.map((item) => item.position.x))).toEqual(new Set([0]));
  });

  it("remains usable for invalid cyclic input", () => {
    const layout = layoutKnowledgeGraph(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    );

    expect(layout).toHaveLength(3);
    expect(layout.every((item) => Number.isFinite(item.position.x) && Number.isFinite(item.position.y))).toBe(true);
  });
});
