"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Crosshair,
  Minus,
  MousePointer2,
  PanelsTopLeft,
  Presentation,
} from "lucide-react";
import type { Scene } from "@/lib/openmaic/types/stage";
import type {
  TeachingToolKind,
  TeachingToolPlanItem,
} from "@/lib/openmaic/types/generation";
import {
  normalizeTeachingToolPlan,
  summarizeActualTeachingTools,
  type ActualTeachingToolSummary,
} from "@/lib/openmaic/generation/teaching-tool-plan";
import { cn } from "@/lib/utils";

type ToolPlanOutline = {
  id: string;
  title: string;
  type?: string;
  audience?: "student" | "teacher";
  teachingToolPlan?: TeachingToolPlanItem[];
};

type LoadState = "idle" | "loading" | "ready" | "error";

const TOOL_LABELS: Record<TeachingToolKind, string> = {
  whiteboard: "AI 白板",
  spotlight: "聚光标注",
  "laser-pointer": "激光指示",
  "interactive-widget": "互动组件",
};

function ToolIcon({ tool, size = 14 }: { tool: TeachingToolKind; size?: number }) {
  if (tool === "whiteboard") return <Presentation size={size} />;
  if (tool === "interactive-widget") return <PanelsTopLeft size={size} />;
  if (tool === "laser-pointer") return <Crosshair size={size} />;
  return <MousePointer2 size={size} />;
}

function actualByOutlineId(scenes: Scene[]): Map<string, ActualTeachingToolSummary[]> {
  return new Map(scenes.map((scene) => [
    scene.outlineId?.trim() || scene.id,
    summarizeActualTeachingTools(scene.actions),
  ]));
}

export function TeachingToolRunbook({
  classroomId,
  className,
  outlines,
  title = "AI 教学工具运行表",
  description = "逐页确认是否调用白板或互动组件，以及触发时机和学生实际会看到的内容。",
}: {
  classroomId?: string;
  className?: string;
  outlines: ReadonlyArray<ToolPlanOutline>;
  title?: string;
  description?: string;
}) {
  const [loadState, setLoadState] = useState<LoadState>(classroomId ? "loading" : "idle");
  const [scenes, setScenes] = useState<Scene[]>([]);

  useEffect(() => {
    if (!classroomId) return;
    const controller = new AbortController();
    void (async () => {
      setLoadState("loading");
      try {
        const response = await fetch(
          `/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as {
          success?: boolean;
          classroom?: { scenes?: Scene[] };
        };
        if (!payload.success || !payload.classroom?.scenes) throw new Error("课堂数据不完整");
        setScenes(payload.classroom.scenes);
        setLoadState("ready");
      } catch {
        if (controller.signal.aborted) return;
        setLoadState("error");
      }
    })();
    return () => controller.abort();
  }, [classroomId]);

  const actualMap = useMemo(() => actualByOutlineId(scenes), [scenes]);
  const rows = outlines
    .filter((outline) => outline.audience !== "teacher")
    .map((outline, index) => ({
      outline,
      index,
      planned: normalizeTeachingToolPlan(outline.teachingToolPlan),
      actual: actualMap.get(outline.id) ?? [],
    }));
  const plannedPageCount = rows.filter((row) => row.planned.length > 0).length;
  const actualPageCount = rows.filter((row) => row.actual.length > 0).length;

  return (
    <section className={cn("overflow-hidden rounded-[10px] border border-stone-200 bg-white", className)}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 bg-stone-50/70 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-[7px] bg-cyan-100 text-cyan-800">
              <Presentation size={16} />
            </span>
            <h3 className="text-sm font-black text-stone-950">{title}</h3>
          </div>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-stone-500">{description}</p>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-bold">
          <span className="rounded-full border border-cyan-200 bg-white px-2.5 py-1 text-cyan-800">
            计划 {plannedPageCount} 页
          </span>
          {classroomId ? (
            <span className={cn(
              "rounded-full border bg-white px-2.5 py-1",
              loadState === "error" ? "border-amber-200 text-amber-700" : "border-emerald-200 text-emerald-700",
            )}>
              {loadState === "loading" ? "正在核对实际动作" : loadState === "error" ? "实际动作读取失败" : `实际 ${actualPageCount} 页`}
            </span>
          ) : (
            <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-stone-500">生成前计划</span>
          )}
        </div>
      </header>

      <div className="divide-y divide-stone-100">
        {rows.map(({ outline, index, planned, actual }) => {
          const displayTools = actual.length > 0 ? actual : planned;
          const generatedMissing = loadState === "ready" && planned.length > 0 && actual.length === 0;
          return (
            <article className="grid gap-3 px-5 py-4 lg:grid-cols-[56px_minmax(180px,0.75fr)_minmax(0,1.6fr)]" key={outline.id}>
              <div className="flex items-start gap-2 text-[11px] font-bold tabular-nums text-stone-400">
                <span className="grid size-7 place-items-center rounded-full bg-stone-100 text-stone-600">{index + 1}</span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-stone-900">{outline.title}</p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold">
                  {generatedMissing ? (
                    <span className="inline-flex items-center gap-1 text-rose-700"><AlertTriangle size={12} /> 计划动作未生成</span>
                  ) : actual.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> 已核对实际动作</span>
                  ) : planned.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-cyan-800"><CheckCircle2 size={12} /> 生成时必须执行</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-stone-400"><Minus size={12} /> 本页不额外调用工具</span>
                  )}
                </div>
              </div>

              {displayTools.length > 0 ? (
                <div className="space-y-2">
                  {displayTools.map((tool, toolIndex) => {
                    const item = tool as TeachingToolPlanItem & ActualTeachingToolSummary;
                    return (
                      <div className="rounded-[7px] border border-cyan-100 bg-cyan-50/45 px-3 py-2.5" key={`${outline.id}-${item.tool}-${toolIndex}`}>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="inline-flex items-center gap-1.5 font-black text-cyan-900">
                            <ToolIcon tool={item.tool} /> {TOOL_LABELS[item.tool]}
                          </span>
                          {"actionCount" in item ? (
                            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-100">
                              {item.actionCount} 个实际动作
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-2 text-xs leading-5 text-stone-700"><strong>触发：</strong>{item.trigger}</p>
                        {"purpose" in item && item.purpose ? <p className="mt-1 text-xs leading-5 text-stone-600"><strong>作用：</strong>{item.purpose}</p> : null}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.content.map((content) => (
                            <span className="rounded-[5px] border border-white bg-white px-2 py-1 text-[11px] text-stone-700 shadow-sm" key={content}>{content}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="self-center text-xs leading-5 text-stone-400">本页未配置额外教学工具，课堂内容由主页面直接呈现。</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
