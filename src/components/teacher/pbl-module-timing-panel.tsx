"use client";

import { useCallback, useMemo, useRef } from "react";
import { CheckCircle2, Clock3, Gauge, LockKeyhole, WandSparkles } from "lucide-react";
import {
  buildPblModuleTimingPlan,
  classifyPblActivityKind,
  isPblModuleTimingPlanConfirmed,
  PBL_MODULE_DEFINITIONS,
  type PblModuleTimingPlan,
  type PblTimeActivity,
  type PblTimeActivityKind,
  type PblTimeModelContext,
} from "@/lib/pbl-time-model";
import { cn } from "@/lib/utils";
import { localizeGeneratedNarrative } from "@/lib/llm/generated-language";

function moduleLabel(kind: PblTimeActivityKind, fallback?: string): string {
  return PBL_MODULE_DEFINITIONS.find((definition) => definition.kind === kind)?.label
    ?? fallback
    ?? "其他课程模块";
}

function recommendationSourceLabel(plan: PblModuleTimingPlan): string {
  if (plan.recommendationSource === "llm") return "大模型分析";
  if (plan.recommendationSource === "deterministic-fallback") return "确定性降级建议";
  if (plan.recommendationSource === "teacher") return "教师设定";
  return "历史建议";
}

function confidenceLabel(plan: PblModuleTimingPlan): string {
  if (plan.confidence === "high") return "高置信度";
  if (plan.confidence === "low") return "低置信度";
  return "中等置信度";
}

// 协调色板：色相均匀分布，饱和度/明度相近，搭配美观
const MODULE_COLORS = [
  "bg-indigo-500",
  "bg-sky-500",
  "bg-teal-500",
  "bg-amber-500",
  "bg-rose-400",
  "bg-violet-500",
];

function TimeBar({
  activities,
  totalMinutes,
  readOnly,
  onChangeDurations,
}: {
  activities: ReadonlyArray<{ id: string; kind: PblTimeActivityKind; durationMin: number; label: string }>;
  totalMinutes: number;
  readOnly: boolean;
  onChangeDurations: (durations: Record<string, number>) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ index: number; barWidth: number; barLeft: number; leftId: string; rightId: string; pairTotal: number; precedingMinutes: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (readOnly || !barRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = barRef.current.getBoundingClientRect();
    const leftActivity = activities[index];
    const rightActivity = activities[index + 1];
    if (!leftActivity || !rightActivity) return;
    // 计算拖动分隔线左侧所有模块的总分钟数（不含当前 leftActivity）
    let precedingMinutes = 0;
    for (let i = 0; i < index; i++) {
      precedingMinutes += activities[i].durationMin;
    }
    dragRef.current = {
      index,
      barWidth: rect.width,
      barLeft: rect.left,
      leftId: leftActivity.id,
      rightId: rightActivity.id,
      pairTotal: leftActivity.durationMin + rightActivity.durationMin,
      precedingMinutes,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [readOnly, activities]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.max(0, Math.min(drag.barWidth, e.clientX - drag.barLeft));
    const ratio = x / drag.barWidth;
    // 鼠标位置对应的总分钟数，减去前面模块的分钟数，才是当前 leftActivity 的目标分钟数
    const mouseTotalMinutes = ratio * totalMinutes;
    const newMinutes = Math.round(mouseTotalMinutes - drag.precedingMinutes);

    const minEach = 5;
    const clampedLeft = Math.max(minEach, Math.min(drag.pairTotal - minEach, newMinutes));
    const remainder = drag.pairTotal - clampedLeft;

    onChangeDurations({
      [drag.leftId]: clampedLeft,
      [drag.rightId]: Math.max(minEach, remainder),
    });
  }, [totalMinutes, onChangeDurations]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }, []);

  // 计算每个模块的累计偏移量（百分比）
  const segments = activities.map((activity, index) => {
    const pct = totalMinutes > 0 ? (activity.durationMin / totalMinutes) * 100 : 0;
    const precedingMinutes = activities
      .slice(0, index)
      .reduce((sum, item) => sum + item.durationMin, 0);
    const left = totalMinutes > 0 ? (precedingMinutes / totalMinutes) * 100 : 0;
    return { activity, left, width: pct };
  });

  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-semibold text-stone-500">拖动分隔线调整模块时间比重，或在下方输入精确分钟数</p>
      <div
        ref={barRef}
        className="relative h-14 w-full overflow-hidden rounded-[6px] border border-stone-200 select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {segments.map((seg, index) => {
          const color = MODULE_COLORS[index % MODULE_COLORS.length];
          return (
            <div
              key={seg.activity.id}
              className={cn("absolute top-0 flex h-full flex-col items-center justify-center text-white", color)}
              style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
            >
              <span className="truncate px-1 text-[11px] font-bold leading-tight">{seg.activity.label}</span>
              <span className="text-[10px] tabular-nums opacity-90">{seg.activity.durationMin}分</span>
              {!readOnly && index < segments.length - 1 ? (
                <div
                  onPointerDown={(e) => handlePointerDown(e, index)}
                  className="absolute -right-1 top-0 z-10 flex h-full w-2 cursor-ew-resize items-center justify-center bg-white/50 hover:bg-white/90 hover:w-2.5 transition-all"
                >
                  <div className="h-6 w-0.5 bg-white/80" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-stone-400">
        <span>0 分钟</span>
        <span>{totalMinutes} 分钟</span>
      </div>
    </div>
  );
}

export function PblModuleTimingPanel({
  compact = false,
  moduleActivities,
  totalMinutes,
  timeContext,
  timingPlan,
  readOnly = false,
  onChangeModuleDuration,
  onBatchChangeDurations,
  onApplyRecommendation,
  onConfirm,
}: {
  compact?: boolean;
  moduleActivities: ReadonlyArray<PblTimeActivity>;
  totalMinutes: number;
  timeContext?: PblTimeModelContext;
  timingPlan?: PblModuleTimingPlan;
  readOnly?: boolean;
  onChangeModuleDuration?: (
    kind: Exclude<PblTimeActivityKind, "other">,
    targetMinutes: number,
  ) => void;
  /** 批量更新多个模块时长，不触发全局重分配。TimeBar 拖动时优先使用此回调。 */
  onBatchChangeDurations?: (durations: Record<string, number>) => void;
  onApplyRecommendation?: (allocations: Readonly<Record<string, number>>) => void;
  onConfirm?: () => void;
}) {
  const safeTotalMinutes = Math.max(0, Math.round(totalMinutes));
  const hasModules = moduleActivities.length > 0;
  const displayPlan = useMemo(
    () => timingPlan ?? buildPblModuleTimingPlan(safeTotalMinutes, moduleActivities, timeContext),
    [moduleActivities, safeTotalMinutes, timeContext, timingPlan],
  );
  const recommendations = useMemo(
    () => new Map(displayPlan.allocations.map((activity) => [activity.id, activity.recommendedDurationMin])),
    [displayPlan.allocations],
  );
  const currentTotalMinutes = moduleActivities.reduce(
    (sum, activity) => sum + Math.max(0, Math.round(Number(activity.durationMin) || 0)),
    0,
  );
  const allocationDelta = currentTotalMinutes - safeTotalMinutes;
  const planConfirmed = displayPlan.status === "confirmed"
    && isPblModuleTimingPlanConfirmed(displayPlan);
  const hasAllCanonicalModules = PBL_MODULE_DEFINITIONS.every((definition) =>
    moduleActivities.some((activity) => classifyPblActivityKind(activity) === definition.kind),
  );
  const canConfirm = !readOnly
    && !planConfirmed
    && hasAllCanonicalModules
    && allocationDelta === 0
    && Boolean(onConfirm);
  const visibleKnowledgePoints = timeContext?.knowledgePoints?.flatMap((point) =>
    point.id && point.name ? [{ id: point.id, name: point.name }] : [],
  ) ?? [];
  const visibleEvidence = displayPlan.evidence?.map((item) =>
    localizeGeneratedNarrative(item, visibleKnowledgePoints),
  );
  const visibleAssumptions = displayPlan.assumptions?.map((item) =>
    localizeGeneratedNarrative(item, visibleKnowledgePoints),
  );

  if (!hasModules) {
    return (
      <section className="rounded-[var(--radius-sm)] border border-dashed border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/40 p-5">
        <div className="flex items-center gap-2 text-[var(--pbl-teacher)]">
          <Gauge size={17} />
          <p className="text-xs font-bold uppercase tracking-[0.12em]">课程模块时间安排</p>
        </div>
        <p className="mt-2 text-sm leading-6 text-stone-500">
          时间安排尚未生成。点击“生成时间安排”后，系统会根据课程难度、知识点复杂度、年级和总课时给出六个阶段的时间建议。
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--pbl-teacher-border)] bg-white shadow-[0_8px_24px_rgba(71,58,42,0.06)]">
      <div className="border-b border-[var(--pbl-teacher-border)] bg-[linear-gradient(110deg,var(--pbl-teacher-soft),#fff_68%)] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[var(--pbl-teacher)]">
              <Gauge size={17} />
              <p className="text-xs font-bold uppercase tracking-[0.12em]">课程模块时间安排</p>
            </div>
          </div>
          <div className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold",
            planConfirmed
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700",
          )}>
            {planConfirmed ? <LockKeyhole size={13} /> : <WandSparkles size={13} />}
            {planConfirmed
              ? `教师已确认 · ${recommendationSourceLabel(displayPlan)}`
              : `${recommendationSourceLabel(displayPlan)} · ${confidenceLabel(displayPlan)}`}
          </div>
        </div>
        <div className={cn("mt-4 grid gap-2", compact ? "grid-cols-2" : "sm:grid-cols-3")}>
          <div className="rounded-[6px] bg-white/80 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs text-stone-500"><Clock3 size={13} /> 课程总时长</div>
            <p className="mt-1 text-lg font-bold tabular-nums text-stone-800">{safeTotalMinutes} 分钟</p>
          </div>
          <div className="rounded-[6px] bg-white/80 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs text-stone-500"><Gauge size={13} /> 当前模块合计</div>
            <p className="mt-1 text-lg font-bold tabular-nums text-stone-800">{currentTotalMinutes} 分钟</p>
          </div>
          <div className={cn(
            "rounded-[6px] px-3 py-2",
            compact && "col-span-2",
            allocationDelta === 0 ? "bg-emerald-50" : "bg-amber-50",
          )}>
            <div className="text-xs text-stone-500">分配状态</div>
            <p className={cn(
              "mt-1 text-sm font-bold",
              allocationDelta === 0 ? "text-emerald-700" : "text-amber-700",
            )}>
              {allocationDelta === 0 ? "已与课程总时长对齐" : `相差 ${Math.abs(allocationDelta)} 分钟`}
            </p>
          </div>
        </div>
        {(displayPlan.evidence?.length ||
          displayPlan.assumptions?.length ||
          displayPlan.rationaleByStage) ? (
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-[6px] border border-white/80 bg-white/70 px-3 py-2">
              <p className="font-bold text-stone-700">本次建议实际使用的依据</p>
              <p className="mt-1 leading-5 text-stone-500">
                {visibleEvidence?.length
                  ? visibleEvidence.join("；")
                  : "模型未返回可核验依据，请教师重点复核。"}
              </p>
            </div>
            <div className={cn(
              "rounded-[6px] border px-3 py-2",
              displayPlan.recommendationSource === "deterministic-fallback"
                ? "border-amber-200 bg-amber-50"
                : "border-white/80 bg-white/70",
            )}>
              <p className="font-bold text-stone-700">假设与边界</p>
              <p className="mt-1 leading-5 text-stone-500">
                {visibleAssumptions?.length
                  ? visibleAssumptions.join("；")
                  : "未声明额外假设。"}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--pbl-teacher)]">六模块分配</p>
          </div>
          {!readOnly && onApplyRecommendation ? (
            <button
              type="button"
              onClick={() => onApplyRecommendation(
                Object.fromEntries(moduleActivities.map((activity) => [
                  activity.id,
                  recommendations.get(activity.id) ?? activity.durationMin,
                ])),
              )}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--pbl-teacher-border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--pbl-teacher)] hover:bg-[var(--pbl-teacher-soft)]"
            >
              <WandSparkles size={13} /> 应用 AI 建议
            </button>
          ) : null}
        </div>

        {!readOnly && (onChangeModuleDuration || onBatchChangeDurations) ? (
          <TimeBar
            activities={moduleActivities.map((activity) => {
              const kind = classifyPblActivityKind(activity);
              return {
                id: activity.id,
                kind,
                durationMin: activity.durationMin,
                label: moduleLabel(kind, activity.title),
              };
            })}
            totalMinutes={safeTotalMinutes}
            readOnly={readOnly}
            onChangeDurations={(durations) => {
              // 优先使用批量更新，避免逐个调用 onChangeModuleDuration 触发全局重分配
              if (onBatchChangeDurations) {
                onBatchChangeDurations(durations);
                return;
              }
              Object.entries(durations).forEach(([id, minutes]) => {
                const activity = moduleActivities.find((a) => a.id === id);
                if (activity) {
                  const kind = classifyPblActivityKind(activity);
                  if (kind !== "other") onChangeModuleDuration?.(kind, minutes);
                }
              });
            }}
          />
        ) : null}

        <div className={cn(
          "grid gap-2",
          compact ? "sm:grid-cols-2 xl:grid-cols-1" : "md:grid-cols-2 xl:grid-cols-3",
        )}>
          {moduleActivities.map((activity) => {
            const kind = classifyPblActivityKind(activity);
            const recommended = recommendations.get(activity.id) ?? activity.durationMin;
            const definition = PBL_MODULE_DEFINITIONS.find((item) => item.kind === kind);
            const stageRationale = definition
              ? displayPlan.rationaleByStage?.[definition.stageKey]
              : undefined;
            return (
              <div className="rounded-[6px] border border-stone-100 bg-stone-50/70 px-3 py-2.5" key={activity.id}>
                <div className={cn("flex justify-between gap-2", compact ? "items-start" : "items-center")}>
                  <div className="min-w-0">
                    <p className={cn(
                      "font-semibold text-stone-700",
                      compact ? "break-words text-sm leading-5" : "truncate text-xs",
                    )}>
                      {moduleLabel(kind, activity.title ?? definition?.label)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-stone-400">AI 建议 {recommended} 分钟</p>
                  </div>
                  {readOnly ? (
                    <span className="shrink-0 text-sm font-bold tabular-nums text-[var(--pbl-teacher)]">
                      {activity.durationMin} 分钟
                    </span>
                  ) : (
                    <label className="flex shrink-0 items-center gap-1 text-xs text-stone-500">
                      <input
                        aria-label={`${activity.title ?? definition?.label ?? "未命名课程活动"}目标时长`}
                        className="h-8 w-16 rounded-[4px] border border-stone-200 px-1.5 text-right text-sm font-semibold tabular-nums text-stone-700 outline-none focus:border-[var(--pbl-teacher)]"
                        defaultValue={activity.durationMin}
                        key={`${activity.id}-${activity.durationMin}`}
                        min={1}
                        onBlur={(event) => {
                          const nextValue = Number(event.currentTarget.value);
                          if (
                            Number.isFinite(nextValue)
                            && kind !== "other"
                            && onChangeModuleDuration
                          ) {
                            onChangeModuleDuration(kind, Math.max(1, Math.round(nextValue)));
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        type="number"
                      />
                      <span>分钟</span>
                    </label>
                  )}
                </div>
                {stageRationale ? (
                  <p className="mt-2 border-t border-stone-100 pt-2 text-[11px] leading-5 text-stone-500">
                    {localizeGeneratedNarrative(stageRationale, visibleKnowledgePoints)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {!hasAllCanonicalModules ? (
          <p className="mt-3 text-xs font-semibold text-amber-800">
            六个标准模块尚未完整生成，暂不能确认时间。
          </p>
        ) : allocationDelta !== 0 ? (
          <p className="mt-3 text-xs font-semibold text-amber-800">
            当前模块合计必须等于课程总时长，调整后才能确认并生成项目主线。
          </p>
        ) : null}

        {!readOnly && onConfirm ? (
          <div className="mt-4 flex justify-end border-t border-stone-100 pt-4">
            <button
              type="button"
              disabled={planConfirmed || !canConfirm}
              onClick={onConfirm}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[6px] px-4 py-2 text-sm font-semibold transition",
                planConfirmed
                  ? "cursor-default border border-emerald-200 bg-emerald-50 text-emerald-700"
                  : canConfirm
                  ? "bg-[var(--pbl-teacher)] text-white hover:opacity-90"
                  : "cursor-not-allowed bg-stone-100 text-stone-400",
              )}
            >
              <CheckCircle2 size={15} />
              {planConfirmed ? "时间已确认 · 项目主线已生成" : "确认时间并生成项目主线"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
