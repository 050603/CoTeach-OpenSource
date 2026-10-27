"use client";

/**
 * KnowledgeGraphFlow — 基于 @xyflow/react (React Flow v12) 的知识图谱可视化组件
 *
 * 特性：
 * - 节点拖拽、画布平移、滚轮缩放
 * - 路径高亮：选中节点时高亮其相邻节点与连边，其余节点淡化
 * - 外部联动：通过 activeNodeId 高亮当前讲解的知识点（与 OpenMAIC 场景联动）
 * - 自适应路径布局：根据真实关系生成稳定的横向学习路径，不再固定语义层级
 * - 全屏模式：支持 isFullscreen 切换
 * - 节点选中回调：onNodeSelect 返回选中节点 ID
 */

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnMoveEnd,
} from "@xyflow/react";
import { Handle } from "@xyflow/react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeGraph, KnowledgeGraphNode, KnowledgePoint } from "@/lib/session/types";
import { normalizeKnowledgeGraphForDisplay } from "@/lib/knowledge-graph-display";
import {
  KNOWLEDGE_GRAPH_NODE_HEIGHT,
  KNOWLEDGE_GRAPH_NODE_WIDTH,
  layoutKnowledgeGraph,
} from "@/lib/knowledge-graph-layout";
import { cn } from "@/lib/utils";

// ===== 层级配色 =====
type Level = NonNullable<KnowledgeGraphNode["level"]>;

const LEVEL_LABEL: Record<Level, string> = {
  foundation: "基础",
  core: "核心",
  application: "应用",
  extension: "拓展",
};

const LEVEL_STYLE: Record<Level, { bg: string; border: string; text: string; dot: string }> = {
  foundation: { bg: "#f0f9ff", border: "#7dd3fc", text: "#075985", dot: "#0ea5e9" },
  core: { bg: "#eff6ff", border: "#93c5fd", text: "#1e40af", dot: "#3b82f6" },
  application: { bg: "#ecfdf5", border: "#6ee7b7", text: "#065f46", dot: "#10b981" },
  extension: { bg: "#f5f3ff", border: "#c4b5fd", text: "#5b21b6", dot: "#8b5cf6" },
};

const ZERO_POSITION = { x: 0, y: 0 };
const EMPTY_POINTS: KnowledgePoint[] = [];
type GraphAppearance = "default" | "teaching-rail";
export const KNOWLEDGE_GRAPH_AUTO_RESTORE_MS = 5_000;

// ===== 自定义节点 =====
type KgNodeData = {
  label: string;
  level: Level;
  instructionalRole?: KnowledgeGraphNode["instructionalRole"];
  description?: string;
  keyInfo?: string;
  isActive?: boolean;
  isDimmed?: boolean;
  appearance?: GraphAppearance;
};

function KnowledgeNode({ data }: NodeProps) {
  const d = data as KgNodeData;
  const style = LEVEL_STYLE[d.level];
  const prerequisite = d.instructionalRole === "prerequisite";
  const isTeachingRail = d.appearance === "teaching-rail";
  return (
    <div
      aria-label={`${d.label}，${prerequisite ? "课前先修" : LEVEL_LABEL[d.level]}`}
      className={cn(
        "flex flex-col justify-center gap-1.5 border px-3.5 py-2.5 transition-[border-color,background-color,box-shadow,opacity,transform] duration-300",
        isTeachingRail ? "rounded-[16px]" : "rounded-[14px]",
      )}
      style={{
        width: KNOWLEDGE_GRAPH_NODE_WIDTH,
        minHeight: KNOWLEDGE_GRAPH_NODE_HEIGHT,
        background: prerequisite
          ? "#fff7ed"
          : isTeachingRail
          ? d.isActive ? "rgba(231, 246, 240, 0.98)" : "rgba(255, 255, 255, 0.94)"
          : d.isActive ? "#fffdf4" : "rgba(255, 255, 255, 0.96)",
        borderColor: prerequisite
          ? "#fb923c"
          : isTeachingRail
          ? d.isActive ? "#3f8174" : "rgba(148, 163, 184, 0.34)"
          : d.isActive ? "#f59e0b" : style.border,
        color: prerequisite ? "#9a3412" : isTeachingRail ? (d.isActive ? "#17473f" : "#52645f") : style.text,
        opacity: d.isDimmed ? (isTeachingRail ? 0.22 : 0.3) : 1,
        boxShadow: isTeachingRail
          ? d.isActive
            ? "0 8px 24px rgba(39, 99, 86, 0.14), 0 0 0 3px rgba(79, 143, 130, 0.1)"
            : "0 4px 16px rgba(15, 23, 42, 0.055)"
          : d.isActive
            ? "0 0 0 4px rgba(245, 158, 11, 0.14), 0 10px 28px rgba(71, 52, 20, 0.14)"
            : "0 5px 18px rgba(15, 23, 42, 0.07)",
        transform: d.isActive ? `scale(${isTeachingRail ? 1.025 : 1.045})` : "scale(1)",
      }}
      title={[d.label, d.description, d.keyInfo].filter(Boolean).join("\n")}
    >
      <Handle position={Position.Left} type="target" style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: prerequisite ? "#f97316" : isTeachingRail ? (d.isActive ? "#3f8174" : "#9fb5af") : d.isActive ? "#f59e0b" : style.dot }}
        />
        <span className="line-clamp-2 text-[13px] font-bold leading-[1.35]">{d.label}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold opacity-65">
        <span>{prerequisite ? "课前先修" : LEVEL_LABEL[d.level]}</span>
        {!prerequisite ? <><span aria-hidden="true">·</span><span>本课目标</span></> : null}
      </div>
      <Handle position={Position.Right} type="source" style={{ opacity: 0 }} />
    </div>
  );
}

// ===== 自定义边 =====
type KgEdgeData = {
  label?: string;
  isActive?: boolean;
  isDimmed?: boolean;
  appearance?: GraphAppearance;
};

function KnowledgeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
}: EdgeProps) {
  const d = (data ?? {}) as KgEdgeData;
  const isTeachingRail = d.appearance === "teaching-rail";
  const stroke = isTeachingRail
    ? d.isActive ? "#5b9a8d" : d.isDimmed ? "#e4ece9" : "#c5d5d1"
    : d.isActive ? "#f59e0b" : d.isDimmed ? "#cbd5e1" : "#94a3b8";
  const strokeWidth = d.isActive ? (isTeachingRail ? 2 : 2.5) : 1.5;

  const curve = Math.max(54, Math.abs(targetX - sourceX) * 0.42);
  const path = `M ${sourceX},${sourceY} C ${sourceX + curve},${sourceY} ${targetX - curve},${targetY} ${targetX},${targetY}`;
  const visibleLabel = d.label && d.isActive && !isTeachingRail
    ? (d.label.length > 18 ? `${d.label.slice(0, 18)}…` : d.label)
    : null;

  return (
    <g>
      <path
        d={path}
        fill="none"
        id={id}
        stroke={stroke}
        strokeWidth={strokeWidth}
        markerEnd={markerEnd}
        opacity={d.isDimmed ? 0.32 : 1}
        style={{ transition: "stroke 0.2s, stroke-width 0.2s, opacity 0.2s" }}
      />
      <title>{d.label}</title>
      {visibleLabel ? (
        <text
          x={(sourceX + targetX) / 2}
          y={(sourceY + targetY) / 2}
          dy={-7}
          textAnchor="middle"
          fontSize={10}
          fontWeight={600}
          fill={d.isActive ? "#b45309" : "#64748b"}
          style={{ paintOrder: "stroke", stroke: "rgba(255,255,255,0.96)", strokeWidth: 5 }}
        >
          {visibleLabel}
        </text>
      ) : null}
    </g>
  );
}

const nodeTypes = { kgNode: KnowledgeNode };
const edgeTypes = { kgEdge: KnowledgeEdge };

function ActiveNodeFocus({ nodeId, zoom }: { nodeId?: string | null; zoom: number }) {
  const { getInternalNode, getViewport, setCenter, setViewport } = useReactFlow();
  const previousNodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!nodeId) return;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const prepareTimer = setTimeout(() => {
      const node = getInternalNode(nodeId);
      if (!node) return;
      const width = node.measured?.width ?? node.width ?? 140;
      const height = node.measured?.height ?? node.height ?? 56;
      const position = node.internals.positionAbsolute;
      const centerX = position.x + width / 2;
      const centerY = position.y + height / 2;

      if (previousNodeRef.current && previousNodeRef.current !== nodeId) {
        const viewport = getViewport();
        void setViewport(
          { ...viewport, zoom: Math.max(0.42, viewport.zoom * 0.76) },
          { duration: 420 },
        );
        focusTimer = setTimeout(() => {
          void setCenter(centerX, centerY, { duration: 900, zoom });
        }, 420);
      } else {
        void setCenter(centerX, centerY, { duration: 700, zoom });
      }
      previousNodeRef.current = nodeId;
    }, 180);

    return () => {
      clearTimeout(prepareTimer);
      if (focusTimer) clearTimeout(focusTimer);
    };
  }, [getInternalNode, getViewport, nodeId, setCenter, setViewport, zoom]);

  return null;
}

function DelayedViewportRestore({
  activeNodeId,
  activeZoom,
  enabled,
  focusActiveNode,
  onRestoreLayout,
  restoreSignal,
}: {
  activeNodeId?: string | null;
  activeZoom: number;
  enabled: boolean;
  focusActiveNode: boolean;
  onRestoreLayout: () => void;
  restoreSignal: number;
}) {
  const { fitView, getInternalNode, setCenter } = useReactFlow();

  useEffect(() => {
    if (!enabled || restoreSignal === 0) return;
    const timer = setTimeout(() => {
      onRestoreLayout();
      requestAnimationFrame(() => {
        if (focusActiveNode && activeNodeId) {
          const node = getInternalNode(activeNodeId);
          if (node) {
            const width = node.measured?.width ?? node.width ?? KNOWLEDGE_GRAPH_NODE_WIDTH;
            const height = node.measured?.height ?? node.height ?? KNOWLEDGE_GRAPH_NODE_HEIGHT;
            const position = node.internals.positionAbsolute;
            void setCenter(position.x + width / 2, position.y + height / 2, {
              duration: 700,
              zoom: activeZoom,
            });
            return;
          }
        }
        void fitView({ duration: 700, padding: 0.2 });
      });
    }, KNOWLEDGE_GRAPH_AUTO_RESTORE_MS);

    return () => clearTimeout(timer);
  }, [
    activeNodeId,
    activeZoom,
    enabled,
    fitView,
    focusActiveNode,
    getInternalNode,
    onRestoreLayout,
    restoreSignal,
    setCenter,
  ]);

  return null;
}

// ===== 工具：判断节点是否为高亮节点的邻居 =====
function isNeighbor(
  nodeId: string,
  highlightId: string,
  edges: { source: string; target: string }[],
): boolean {
  return edges.some(
    (e) =>
      (e.source === nodeId && e.target === highlightId) ||
      (e.target === nodeId && e.source === highlightId),
  );
}

// ===== 主组件 =====
export function KnowledgeGraphFlow({
  graph,
  points = EMPTY_POINTS,
  activeNodeId,
  height = 360,
  fillAvailableHeight = false,
  showMiniMap = true,
  showControls = true,
  focusActiveNode = false,
  autoRestoreView = false,
  activeZoom = 0.72,
  appearance = "default",
  isFullscreen = false,
  onToggleFullscreen,
  onNodeSelect,
  onNodePositionChange,
}: {
  graph?: KnowledgeGraph;
  points?: KnowledgePoint[];
  activeNodeId?: string | null;
  height?: number;
  /** Fill a parent-sized region instead of imposing a fixed minimum height. */
  fillAvailableHeight?: boolean;
  showMiniMap?: boolean;
  showControls?: boolean;
  /** Keep the externally active node centered; intended for compact previews. */
  focusActiveNode?: boolean;
  /** Restore the initial layout and viewport after student pan/zoom/drag inactivity. */
  autoRestoreView?: boolean;
  activeZoom?: number;
  appearance?: GraphAppearance;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** 节点选中回调，返回选中的节点 ID（再次点击同一节点返回 null） */
  onNodeSelect?: (nodeId: string | null) => void;
  onNodePositionChange?: (nodeId: string, position: { x: number; y: number }) => void;
}) {
  const normalized = useMemo(
    () => normalizeKnowledgeGraphForDisplay(graph, points),
    [graph, points],
  );

  const topologyKey = useMemo(
    () => [
      normalized.nodes.map((node) => node.id).join("\u0001"),
      normalized.edges.map((edge) => `${edge.source}\u0002${edge.target}`).join("\u0001"),
    ].join("\u0003"),
    [normalized.edges, normalized.nodes],
  );
  const layout = useMemo(
    () => layoutKnowledgeGraph(normalized.nodes, normalized.edges),
    // Names, descriptions and manually dragged positions do not change topology.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topologyKey],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const highlightId = activeNodeId ?? selectedId;
  // ref 暂存待通知的 nodeId，在 effect 中回调 onNodeSelect，
  // 避免在 setState updater 中触发父组件渲染
  const pendingSelectRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (pendingSelectRef.current !== undefined) {
      onNodeSelect?.(pendingSelectRef.current);
      pendingSelectRef.current = undefined;
    }
  });

  const baseNodes: Node[] = useMemo(() => {
    return normalized.nodes.map((node) => {
      const position = layout.find((p) => p.id === node.id)?.position ?? ZERO_POSITION;
      const level = (node.level ?? "core") as Level;
      return {
        id: node.id,
        type: "kgNode",
        position,
        data: {
          label: node.label,
          level,
          description: node.description,
          keyInfo: node.keyInfo,
          instructionalRole: node.instructionalRole,
          isActive: false,
          isDimmed: false,
          appearance,
        } as KgNodeData,
      };
    });
  }, [normalized.nodes, layout, appearance]);

  const baseEdges: Edge[] = useMemo(() => {
    return normalized.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "kgEdge",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: appearance === "teaching-rail" ? "#b7cbc5" : "#94a3b8",
      },
      data: {
        label: edge.label,
        isActive: false,
        isDimmed: false,
        appearance,
      } as KgEdgeData,
    }));
  }, [normalized.edges, appearance]);

  const [nodes, setNodes, onNodesChange] = useNodesState(baseNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(baseEdges);
  const previousTopologyKeyRef = useRef(topologyKey);
  const [restoreSignal, setRestoreSignal] = useState(0);

  useEffect(() => {
    const topologyChanged = previousTopologyKeyRef.current !== topologyKey;
    setNodes((currentNodes) => {
      if (topologyChanged) return baseNodes;
      const currentPositions = new Map(currentNodes.map((node) => [node.id, node.position]));
      return baseNodes.map((node) => ({
        ...node,
        position: currentPositions.get(node.id) ?? node.position,
      }));
    });
    setEdges(baseEdges);
    previousTopologyKeyRef.current = topologyKey;
  }, [baseNodes, baseEdges, setNodes, setEdges, topologyKey]);

  // 外部 activeNodeId 或数据变化时同步节点/边的样式
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        const isActive = highlightId === node.id;
        const isDimmed =
          highlightId && highlightId !== node.id
            ? !isNeighbor(node.id, highlightId, normalized.edges)
            : false;
        return {
          ...node,
          data: { ...(node.data as KgNodeData), isActive, isDimmed },
        };
      }),
    );
    setEdges((prev) =>
      prev.map((edge) => {
        const isActive =
          highlightId && (edge.source === highlightId || edge.target === highlightId)
            ? true
            : false;
        const isDimmed =
          highlightId && edge.source !== highlightId && edge.target !== highlightId ? true : false;
        return {
          ...edge,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: appearance === "teaching-rail"
              ? isActive ? "#5b9a8d" : "#b7cbc5"
              : isActive ? "#f59e0b" : "#94a3b8",
          },
          data: { ...(edge.data as KgEdgeData), isActive, isDimmed },
        };
      }),
    );
  }, [appearance, highlightId, normalized.edges, setNodes, setEdges]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId((prev) => {
      const next = prev === node.id ? null : node.id;
      pendingSelectRef.current = next;
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    onNodeSelect?.(null);
  }, [onNodeSelect]);

  const scheduleRestore = useCallback(() => {
    if (autoRestoreView) setRestoreSignal((current) => current + 1);
  }, [autoRestoreView]);

  const restoreLayout = useCallback(() => {
    const defaultPositions = new Map(baseNodes.map((node) => [node.id, node.position]));
    setNodes((currentNodes) => currentNodes.map((node) => ({
      ...node,
      position: defaultPositions.get(node.id) ?? node.position,
    })));
  }, [baseNodes, setNodes]);

  const handleMoveEnd = useCallback<OnMoveEnd>((event) => {
    // React Flow passes null for programmatic viewport animations. Only a real
    // pointer/wheel interaction should restart the inactivity timer.
    if (event) scheduleRestore();
  }, [scheduleRestore]);

  if (normalized.nodes.length === 0) {
    return (
      <div className="grid h-full place-items-center rounded-[8px] border border-dashed border-stone-200 bg-stone-50 p-5 text-sm text-stone-500">
        暂无知识图谱。请先生成或添加知识点。
      </div>
    );
  }

  return (
    <div
      className={cn(
        "knowledge-graph-canvas relative h-full w-full overflow-hidden",
        appearance === "teaching-rail"
          ? "bg-transparent"
          : "bg-[radial-gradient(circle_at_48%_42%,rgba(239,246,255,0.9),rgba(255,255,255,0.96)_54%,rgba(240,253,250,0.72)_100%)]",
        isFullscreen && "fixed inset-0 z-50 bg-white",
      )}
      data-auto-restore-view={autoRestoreView || undefined}
      style={isFullscreen
        ? { minHeight: "100vh" }
        : fillAvailableHeight
          ? undefined
          : { minHeight: height }}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={clearSelection}
          onMoveEnd={handleMoveEnd}
          onNodeDragStop={(_, node) => {
            onNodePositionChange?.(node.id, node.position);
            scheduleRestore();
          }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView={!focusActiveNode || !activeNodeId}
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.24}
          maxZoom={1.8}
          nodesDraggable={appearance !== "teaching-rail"}
          nodesFocusable={appearance !== "teaching-rail"}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: appearance === "teaching-rail" ? "#b7cbc5" : "#94a3b8",
            },
          }}
        >
          <DelayedViewportRestore
            activeNodeId={activeNodeId}
            activeZoom={activeZoom}
            enabled={autoRestoreView}
            focusActiveNode={focusActiveNode}
            onRestoreLayout={restoreLayout}
            restoreSignal={restoreSignal}
          />
          {focusActiveNode ? <ActiveNodeFocus nodeId={activeNodeId} zoom={activeZoom} /> : null}
          <Background
            color={appearance === "teaching-rail" ? "#cfe0db" : "#e2e8f0"}
            gap={appearance === "teaching-rail" ? 24 : 20}
            size={appearance === "teaching-rail" ? 0.8 : 1.1}
            variant={BackgroundVariant.Dots}
          />
          {showControls ? <Controls position="bottom-right" showInteractive={false} /> : null}
          {showMiniMap && normalized.nodes.length > 4 ? (
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              nodeColor={(node) => {
                const data = node.data as KgNodeData;
                return data.isActive ? "#f59e0b" : LEVEL_STYLE[data.level]?.dot ?? "#94a3b8";
              }}
              maskColor="rgba(241, 245, 249, 0.68)"
              className="!overflow-hidden !rounded-xl !border !border-slate-200 !bg-white/90 !shadow-sm"
            />
          ) : null}
        </ReactFlow>
      </ReactFlowProvider>
      {appearance !== "teaching-rail" ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full border border-white/80 bg-white/85 px-3 py-1.5 text-[10px] font-semibold text-slate-500 shadow-sm backdrop-blur-md">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
          依赖方向
          <span aria-hidden="true" className="text-slate-300">→</span>
          <span className="text-slate-700">学习进阶</span>
        </div>
      ) : null}
      {onToggleFullscreen && (
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-md border border-stone-200 bg-white text-stone-500 shadow-sm transition-colors hover:bg-stone-50 hover:text-stone-700"
          title={isFullscreen ? "退出全屏" : "全屏显示"}
        >
          {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      )}
    </div>
  );
}
