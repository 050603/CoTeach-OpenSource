"use client";

import { useEffect, useState } from "react";
import {
  StageGenerationCardStack,
  type StageGenerationCardData,
} from "@/components/teacher/stage-generation-card-stack";

/* ============================================================
   AiGenerationOverlay — AI 生成全屏加载动画
   ------------------------------------------------------------
   当教师在备课界面触发 AI 生成（知识图谱、课程模块、教学大纲等）
   长时间任务时，展示全屏遮罩 + 翻卡片动画 + 阶段提示，
   让教师直观感知 AI 正在思考什么。

   动画沿用最终课程资源页的卡片堆叠语言，并为各阶段重绘内容。
   ============================================================ */

export type AiTaskKind =
  | "knowledgeGraph"
  | "teachingOutline"
  | "lessonOutline"
  | "evaluationPlan"
  | "sceneOutlines"
  | "generic";

type Stage = {
  label: string;
  /** 该阶段大致持续秒数（用于滚动节奏，非精确计时） */
  weight: number;
};

const TASK_STAGES: Record<AiTaskKind, { title: string; stages: Stage[] }> = {
  knowledgeGraph: {
    title: "生成知识图谱",
    stages: [
      { label: "解析课程主题与学习目标", weight: 3 },
      { label: "提取核心知识点与关联关系", weight: 4 },
      { label: "构建知识图谱节点与边", weight: 3 },
      { label: "校验知识层级与覆盖度", weight: 2 },
    ],
  },
  teachingOutline: {
    title: "生成 PBL 项目主线与课程模块",
    stages: [
      { label: "解析时间分配与阶段约束", weight: 3 },
      { label: "构建 PBL 项目主线", weight: 4 },
      { label: "生成六个课程模块", weight: 5 },
      { label: "校验模块结构与时间一致性", weight: 3 },
    ],
  },
  lessonOutline: {
    title: "生成课程资源大纲",
    stages: [
      { label: "解析课程模块与知识点对齐", weight: 3 },
      { label: "生成知识讲授与教师授课资源", weight: 5 },
      { label: "关联知识点与课程模块", weight: 3 },
      { label: "校验资源覆盖度", weight: 2 },
    ],
  },
  evaluationPlan: {
    title: "生成评价方案",
    stages: [
      { label: "解析课程目标与 PBL 阶段", weight: 3 },
      { label: "生成评价维度与权重", weight: 4 },
      { label: "分配 AI 与教师评价职责", weight: 2 },
      { label: "校验权重合计", weight: 1 },
    ],
  },
  sceneOutlines: {
    title: "生成授课场景大纲",
    stages: [
      { label: "解析课程模块与教师人设", weight: 3 },
      { label: "生成场景互动与 Agent 对话", weight: 5 },
      { label: "关联知识点与互动组件", weight: 3 },
      { label: "校验场景覆盖度", weight: 2 },
    ],
  },
  generic: {
    title: "AI 思考中",
    stages: [
      { label: "解析输入上下文", weight: 3 },
      { label: "调用大语言模型", weight: 5 },
      { label: "校验输出结构", weight: 2 },
    ],
  },
};

type Props = {
  /** 当前任务类型；传 null/false 时关闭遮罩 */
  kind: AiTaskKind | null;
  /** 可选的自定义提示语，覆盖默认的阶段滚动 */
  hint?: string;
  /** 本次任务的真实课程数据；提供后会替代固定示例卡片。 */
  cards?: StageGenerationCardData[];
};

export function AiGenerationOverlay({ kind, hint, cards }: Props) {
  const visible = kind !== null;
  const config = kind ? TASK_STAGES[kind] : TASK_STAGES.generic;
  const [elapsed, setElapsed] = useState(0);

  // 计时器：每 100ms 更新已用时间
  useEffect(() => {
    if (!visible) return;
    const start = Date.now();
    queueMicrotask(() => setElapsed(0));
    const timer = setInterval(() => {
      setElapsed(Date.now() - start);
    }, 100);
    return () => clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  const formatTime = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0 ? `${min}:${sec.toString().padStart(2, "0")}` : `${sec}s`;
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`AI 正在${config.title}`}
    >
      {/* 毛玻璃遮罩 */}
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-md" />

      {/* 中央卡片 */}
      <div className="ai-card relative z-10 w-[760px] max-w-[94vw] overflow-hidden rounded-[22px] border border-white/30 bg-white/95 shadow-[0_30px_90px_rgba(15,23,42,0.28)]">
        {/* 顶部渐变光带 */}
        <div className="ai-overlay-glow h-1 w-full" />

        <div className="grid gap-6 p-5 md:grid-cols-[1.14fr_0.86fr] md:p-6">
          <StageGenerationCardStack cards={cards} kind={kind ?? "generic"} />

          <div className="flex min-w-0 flex-col py-1">
          <div className="mb-1">
            <h3 className="text-[17px] font-bold text-[var(--pbl-ink)]">
              AI 正在{config.title}
            </h3>
            <p className="mt-1 text-xs leading-5 text-stone-500">卡片展示的是本次课程正在处理的内容。</p>
          </div>

          {/* 已用时间 */}
          <div className="mb-4 mt-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-[12px] font-medium tabular-nums text-stone-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--pbl-teacher)]" />
              已用 {formatTime(elapsed)}
            </span>
          </div>

          <div className="rounded-[12px] border border-stone-200 bg-stone-50/80 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[.15em] text-stone-400">正在处理</p>
            <p className="mt-2 text-sm font-bold text-stone-800">{cards?.[0]?.title ?? config.stages[0]?.label}</p>
            <p className="mt-1 text-xs leading-5 text-stone-500">{cards?.[0]?.detail ?? hint ?? "正在结合课程上下文生成可编辑内容。"}</p>
          </div>

          {/* 自定义提示语 */}
          {hint && (
            <p className="mt-4 border-t border-stone-100 pt-3 text-center text-[12px] leading-relaxed text-stone-500">
              {hint}
            </p>
          )}

          </div>
        </div>
      </div>

      {/* 内联样式：卡片级动画与渐变 */}
      <style jsx>{`
        .ai-overlay-glow {
          background: linear-gradient(
            90deg,
            transparent 0%,
            var(--pbl-teacher) 25%,
            var(--pbl-ai) 50%,
            var(--pbl-teacher) 75%,
            transparent 100%
          );
          background-size: 200% 100%;
          animation: ai-glow-sweep 2.4s linear infinite;
        }
        @keyframes ai-glow-sweep {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .ai-card::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 100%;
          pointer-events: none;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(109, 40, 217, 0.06) 45%,
            rgba(29, 78, 216, 0.10) 50%,
            rgba(109, 40, 217, 0.06) 55%,
            transparent 100%
          );
          background-size: 200% 100%;
          animation: ai-card-sweep 3.6s linear infinite;
        }
        @keyframes ai-card-sweep {
          0% { background-position: -100% 0; }
          100% { background-position: 200% 0; }
        }
        .ai-stage-dot {
          animation: ai-stage-pulse 1.2s ease-in-out infinite;
        }
        @keyframes ai-stage-pulse {
          0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(194, 65, 12, 0.45); }
          50% { transform: scale(1.4); opacity: 0.7; box-shadow: 0 0 0 4px rgba(194, 65, 12, 0); }
        }
        .ai-bar-bounce {
          animation: ai-bar-bounce 0.9s ease-in-out infinite;
        }
        @keyframes ai-bar-bounce {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }
        .ai-progress-fill {
          background: linear-gradient(90deg, var(--pbl-teacher), var(--pbl-ai));
          transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
          animation: ai-progress-shimmer 1.8s linear infinite;
          background-size: 200% 100%;
          position: relative;
        }
        .ai-progress-fill::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255, 255, 255, 0.55) 50%,
            transparent 100%
          );
          background-size: 200% 100%;
          animation: ai-progress-shimmer 1.8s linear infinite;
        }
        @keyframes ai-progress-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
