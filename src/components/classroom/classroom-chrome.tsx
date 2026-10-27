"use client";

import { useMemo, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, BarChart3, Check, ChevronRight, Circle, ClipboardCheck, Info, MonitorUp, Route, UserRoundCheck } from "lucide-react";
import type { AiSupportRecord, Course, TeacherFeedback } from "@/lib/session/types";
import { detectInterventionSignals, evaluateStageGate, type InterventionSignal } from "@/lib/classroom/stage-gates";
import { defaultTeacherPresentationView } from "@/lib/classroom/presentation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlays";
import gateStyles from "./stage-gate-dialog.module.css";

export function StageProgress({ course, onSelect, readonly = false }: { course: Course; onSelect?: (index: number) => void; readonly?: boolean }) {
  const total = course.stages.length;

  return (
    <nav aria-label="课堂阶段" className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--pbl-border)] bg-white shadow-[0_8px_26px_rgba(15,23,42,0.05)]">
      <div className="flex min-h-[76px] items-center px-2 py-2 md:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {course.stages.map((stage, index) => {
            const current = index === course.currentStageIndex;
            const done = index < course.currentStageIndex;
            return (
              <div className="flex shrink-0 items-center" key={stage.key}>
                <button
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "group flex items-center gap-2 rounded-[12px] text-sm transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-teacher)]",
                    current
                      ? "min-h-14 bg-[var(--pbl-teacher)] px-4 font-bold text-white shadow-[0_8px_20px_rgba(30,64,175,0.22)] ring-1 ring-[var(--pbl-teacher)]"
                      : "min-h-10 px-2.5 text-[var(--pbl-text-muted)]",
                    !readonly && "hover:bg-[var(--pbl-surface-soft)]",
                    !readonly && current && "hover:bg-[var(--pbl-teacher-hover)]",
                  )}
                  disabled={readonly}
                  onClick={() => onSelect?.(index)}
                  type="button"
                >
                  <span
                    className={cn(
                      "grid shrink-0 place-items-center rounded-full font-bold transition-all",
                      done && "bg-[var(--pbl-success)] text-white",
                      current && "h-9 w-9 bg-white text-sm text-[var(--pbl-teacher)] shadow-sm",
                      !current && "h-6 w-6 text-[11px]",
                      !done && !current && "border border-[var(--pbl-border-strong)] text-[var(--pbl-text-muted)]",
                    )}
                  >
                    {done ? <Check aria-hidden="true" size={12} /> : index + 1}
                  </span>
                  <span className="whitespace-nowrap">
                    {current ? <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-white/65">当前阶段</span> : null}
                    <span className={cn("block", current && "text-base leading-5")}>{stage.label}</span>
                  </span>
                </button>
                {index < total - 1 ? (
                  <ChevronRight aria-hidden="true" className="mx-1 shrink-0 text-[var(--pbl-border-strong)]" size={14} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export function StageGateDialog({ course, onOpenChange, onConfirm, open, targetIndex, presentation = false }: { course: Course; onOpenChange: (open: boolean) => void; onConfirm: () => void; open: boolean; targetIndex: number; presentation?: boolean }) {
  const movingForward = targetIndex > course.currentStageIndex;
  const gate = useMemo(() => evaluateStageGate(course), [course]);
  const target = course.stages[targetIndex];
  const blocked = movingForward && !gate.canAdvance;
  const targetView = defaultTeacherPresentationView(target);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className={gateStyles.dialog} data-presentation={presentation}>
        <DialogHeader className={gateStyles.header}>
          <p className={gateStyles.eyebrow}><Route aria-hidden="true" size={18} />课堂进程 <span>共 {course.stages.length} 个阶段</span></p>
          <DialogTitle className={gateStyles.title}>{movingForward ? "切换教学阶段" : "回退教学阶段"}</DialogTitle>
          <DialogDescription className={gateStyles.description}>{movingForward ? "确认后，教师端和学生端将同步进入目标阶段。" : "确认后，教师端和学生端将同步回到目标阶段，已有课堂记录将保留。"}</DialogDescription>
        </DialogHeader>
        <div className={gateStyles.body}>
          <div className={gateStyles.transition} role="group" aria-label="阶段切换方向">
            <div className={gateStyles.stage}>
              <span className={gateStyles.number}>{course.currentStageIndex + 1}</span>
              <div><p>当前阶段</p><h3>{gate.stage.label}</h3></div>
            </div>
            <ArrowRight className={gateStyles.arrow} aria-hidden="true" size={24} />
            <div className={cn(gateStyles.stage, gateStyles.target)}>
              <span className={gateStyles.number}>{targetIndex + 1}</span>
              <div><p>{movingForward ? "即将进入" : "即将回到"}</p><h3>{target?.label ?? "目标阶段"}</h3></div>
            </div>
          </div>
          {presentation ? <p className={gateStyles.view}>{targetView === "analytics" ? <BarChart3 aria-hidden="true" size={20} /> : <MonitorUp aria-hidden="true" size={20} />}<span>接下来显示<strong>{targetView === "analytics" ? "班级学情" : "授课展示"}</strong></span></p> : null}
          {movingForward ? <div className={gateStyles.checks}>
            <h3 className={gateStyles.checksTitle}>本阶段检查</h3>
            {gate.completed.length ? <GateSection icon={<Check size={20} />} items={gate.completed} title="已就绪" tone="success" /> : null}
            {gate.blockers.length ? <GateSection icon={<AlertTriangle size={20} />} items={gate.blockers.map((item) => item.message)} title="待处理事项" tone="danger" /> : null}
            {gate.warnings.length ? <GateSection icon={<Info size={20} />} items={gate.warnings.map((item) => item.message)} title="请留意" tone="warning" /> : null}
            {blocked ? <p className={gateStyles.override}>仍可由教师确认继续，系统将记录本次未完成事项。</p> : null}
          </div> : null}
        </div>
        <DialogFooter className={gateStyles.footer}>
          <Button className={gateStyles.cancel} onClick={() => onOpenChange(false)} variant="secondary">留在当前阶段</Button>
          <Button className={gateStyles.confirm} onClick={onConfirm}>{movingForward ? blocked ? `仍要进入“${target?.label ?? "下一阶段"}”` : `进入“${target?.label ?? "下一阶段"}”` : `确认回退到“${target?.label ?? "上一阶段"}”`}<ArrowRight aria-hidden="true" size={20} /></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GateSection({ icon, items, title, tone }: { icon: ReactNode; items: string[]; title: string; tone: "success" | "warning" | "danger" }) {
  return (
    <section className={gateStyles.check} data-tone={tone}>
      <span className={gateStyles.checkIcon} aria-hidden="true">{icon}</span>
      <div><h4>{title}</h4><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
    </section>
  );
}

export function TeacherInterventionQueue({ course, onSelect }: { course: Course; onSelect?: (signal: InterventionSignal) => void }) {
  const signals = detectInterventionSignals(course);
  if (!signals.length) return <p className="border-y border-[var(--pbl-border)] py-6 text-sm text-[var(--pbl-text-muted)]">当前没有需要教师决策的介入提示。AI 将继续承担常规讲解、支架和过程记录。</p>;
  return (
    <div className="divide-y divide-[var(--pbl-border)] border-y border-[var(--pbl-border)]">
      {signals.map((signal) => (
        <button className="grid w-full gap-2 py-4 text-left hover:bg-[var(--pbl-surface-soft)] sm:grid-cols-[minmax(0,1fr)_auto]" key={signal.id} onClick={() => onSelect?.(signal)} type="button">
          <span>
            <span className="flex items-center gap-2 font-semibold text-[var(--pbl-text-strong)]"><AlertTriangle className="text-[var(--pbl-warning)]" size={16} />{signal.title}</span>
            <span className="mt-1 block text-sm leading-6 text-[var(--pbl-text-muted)]">{signal.whatHappened}</span>
            <span className="mt-2 block text-sm"><strong className="font-semibold">建议：</strong>{signal.suggestedAction}</span>
          </span>
          <span className="self-start text-xs text-[var(--pbl-text-muted)]">{signal.targetIds.length} 个对象 · {signal.confidence === "high" ? "高置信" : "需核查"}</span>
        </button>
      ))}
    </div>
  );
}

export function AiContribution({ record, actions }: { record: AiSupportRecord; actions?: ReactNode }) {
  return (
    <article className="border-l-2 border-[var(--pbl-ai)] pl-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-[var(--pbl-text-strong)]">AI 正在做：{record.trigger}</h3>
        <span className="text-xs text-[var(--pbl-text-muted)]">依据 {record.evidence.length} 条学习证据</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">{record.editedContent ?? record.diagnosis}</p>
      <EvidenceList evidence={record.evidence} />
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </article>
  );
}

export function EvidenceList({ evidence }: { evidence: string[] }) {
  return evidence.length ? <details className="mt-3 text-sm"><summary className="cursor-pointer font-semibold text-[var(--pbl-teacher)]">查看判断依据</summary><ul className="mt-2 space-y-1 text-[var(--pbl-text-muted)]">{evidence.map((item) => <li key={item}>· {item}</li>)}</ul></details> : <p className="mt-2 text-sm text-[var(--pbl-warning)]">尚未关联过程证据</p>;
}

export function FeedbackLanes({ feedback }: { feedback: TeacherFeedback[] }) {
  const lanes = [
    { key: "ai" as const, title: "AI 反馈", icon: <ClipboardCheck size={16} /> },
    { key: "teacher" as const, title: "教师反馈", icon: <UserRoundCheck size={16} /> },
    { key: "peer" as const, title: "同伴反馈", icon: <Circle size={13} /> },
  ];
  return <div className="grid gap-6 lg:grid-cols-3">{lanes.map((lane) => { const items = feedback.filter((item) => (item.sourceRole ?? "teacher") === lane.key); return <section key={lane.key}><h3 className="flex items-center gap-2 border-b border-[var(--pbl-border)] pb-2 font-semibold">{lane.icon}{lane.title}</h3>{items.length ? <div className="divide-y divide-[var(--pbl-border-soft)]">{items.map((item) => <article className="py-3" key={item.id}><p className="text-sm leading-6">{item.content}</p><EvidenceList evidence={item.evidence ?? []} /></article>)}</div> : <p className="py-4 text-sm text-[var(--pbl-text-muted)]">暂无反馈</p>}</section>; })}</div>;
}
