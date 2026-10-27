"use client";

import { useMemo, useState } from "react";
import { Network } from "lucide-react";
import type { KnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgePoint } from "@/lib/session/types";
import { KnowledgeGraphFlow } from "@/components/knowledge-graph-flow";
import { normalizeKnowledgeGraphForDisplay } from "@/lib/knowledge-graph-display";

export { normalizeKnowledgeGraphForDisplay } from "@/lib/knowledge-graph-display";

const EMPTY_POINTS: KnowledgePoint[] = [];

export function KnowledgeGraphView({
  graph,
  points = EMPTY_POINTS,
  title = "知识图谱",
  height = 360,
  showDetails = true,
}: {
  graph?: KnowledgeGraph;
  points?: KnowledgePoint[];
  title?: string;
  height?: number;
  showDetails?: boolean;
}) {
  const normalized = useMemo(
    () => normalizeKnowledgeGraphForDisplay(graph, points),
    [graph, points],
  );
  const [selectedId, setSelectedId] = useState(normalized.nodes[0]?.id ?? "");
  const selected = normalized.nodes.find((node) => node.id === selectedId) ?? normalized.nodes[0];

  if (normalized.nodes.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-stone-200 bg-stone-50 p-5 text-sm text-stone-500">
        暂无知识图谱。请先生成或添加知识点。
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[8px] border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
        <div className="flex items-center gap-2 font-bold text-stone-900">
          <Network size={18} className="text-blue-700" />
          {title}
        </div>
        <div className="text-xs font-semibold text-stone-400">
          {normalized.nodes.length} 节点 · {normalized.edges.length} 关系
        </div>
      </div>
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="relative bg-stone-50" style={{ height }}>
          <KnowledgeGraphFlow
            graph={normalized}
            height={height}
            onNodeSelect={(nodeId) => setSelectedId(nodeId ?? normalized.nodes[0]?.id ?? "")}
            points={points}
            showMiniMap={normalized.nodes.length > 6}
          />
        </div>
        {showDetails ? (
          <div className="border-t border-stone-100 p-4 lg:border-l lg:border-t-0">
            {selected ? (
              <div>
                <div className="text-xs font-bold text-stone-400">当前知识节点</div>
                <h3 className="mt-1 text-base font-bold text-stone-900">{selected.label}</h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">{selected.description || "暂无描述"}</p>
                {selected.keyInfo ? (
                  <div className="mt-3 rounded-[6px] border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-800">
                    <span className="font-bold">本课关键：</span>
                    {selected.keyInfo}
                  </div>
                ) : null}
                {selected.instructionalRole === "prerequisite" ? (
                  <div className="mt-3 space-y-2 rounded-[6px] border border-orange-100 bg-orange-50 p-3 text-xs leading-5 text-orange-900">
                    <p><span className="font-bold">课前应会依据：</span>{selected.priorKnowledgeEvidence || "尚未填写"}</p>
                    <p><span className="font-bold">前测边界：</span>{selected.diagnosticBoundary || "尚未填写"}</p>
                  </div>
                ) : selected.masteryBoundary ? (
                  <div className="mt-3 rounded-[6px] border border-emerald-100 bg-emerald-50 p-3 text-xs leading-5 text-emerald-900">
                    <span className="font-bold">课后掌握边界：</span>{selected.masteryBoundary}
                  </div>
                ) : null}
                <RelatedEdges nodeId={selected.id} edges={normalized.edges} nodes={normalized.nodes} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RelatedEdges({
  nodeId,
  edges,
  nodes,
}: {
  nodeId: string;
  edges: KnowledgeGraphEdge[];
  nodes: KnowledgeGraphNode[];
}) {
  const related = edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
  if (related.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs font-bold text-stone-400">关联关系</div>
      <ul className="space-y-1.5">
        {related.map((edge) => {
          const otherId = edge.source === nodeId ? edge.target : edge.source;
          const other = nodes.find((node) => node.id === otherId);
          return (
            <li key={edge.id} className="rounded-[6px] bg-stone-50 px-2.5 py-2 text-xs text-stone-600">
              <span className="font-bold text-stone-800">{edge.label}</span>
              <span className="mx-1 text-stone-300">→</span>
              {other?.label ?? "关联知识节点"}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
