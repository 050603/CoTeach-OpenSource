"use client";

import Link from "next/link";
import { useState, type ReactNode, type Ref } from "react";
import { Popover, Tooltip } from "radix-ui";
import { BarChart3, BookOpenCheck, ChevronDown, ChevronLeft, ChevronRight, Clock3, FileText, Maximize2, Minimize2, MonitorUp, PanelTop, Pause, Play, RotateCcw, Users, Wrench, X } from "lucide-react";
import type { Course } from "@/lib/session/types";
import type { TeacherPresentationView } from "@/lib/classroom/presentation";
import type { ClassroomTimingSnapshot } from "@/lib/classroom/timing";
import { formatClock } from "@/lib/classroom/format-clock";
import styles from "./teacher-presentation.module.css";

export function TeacherPresentationHeader({ course, degraded, onlineCount, fullscreen, onFullscreen, fullscreenNotice, saveStatus, timing, onTogglePause, onResetTimer }: {
  course: Course; degraded: boolean; onlineCount: number; fullscreen: boolean; onFullscreen: () => void; fullscreenNotice?: string; saveStatus: ReactNode;
  timing?: ClassroomTimingSnapshot; onTogglePause: () => void; onResetTimer: () => void;
}) {
  const stage = course.stages[course.currentStageIndex];
  const stagePosition = course.currentStageIndex / Math.max(1, course.stages.length - 1) * 100;
  return <header className={styles.heading}>
    <div className={styles.identity}>
      <h1 title={course.name}>{course.name}</h1>
      <div className={styles.stageProgress} role="progressbar" aria-label="教学阶段" aria-valuemin={1} aria-valuemax={course.stages.length} aria-valuenow={course.currentStageIndex + 1} aria-valuetext={stage?.label ?? "当前课堂"}>
        <span aria-hidden="true" className={styles.stageName} style={{ left: `${stagePosition}%`, transform: `translateX(-${stagePosition}%)` }}>{stage?.label ?? "当前课堂"}</span>
        <div aria-hidden="true" className={styles.progress}>
          {course.stages.map((item, index) => <i key={item.key} data-state={index < course.currentStageIndex ? "complete" : index === course.currentStageIndex ? "current" : "pending"} />)}
        </div>
      </div>
    </div>
    <PresentationTimer key={`${course.id}:${stage?.key}`} onReset={onResetTimer} onTogglePause={onTogglePause} timing={timing} />
    <div className={styles.status}>
      <div className={styles.save}>{saveStatus}</div>
      {fullscreenNotice ? <small role="status">{fullscreenNotice}</small> : null}
      <p><Users size={18} /> 教学班 {course.classroomPopulation?.enrolledCount ?? "—"} · 已进入 {course.students.length} · 在线 {onlineCount}{degraded ? <em>同步延迟</em> : null}</p>
    </div>
    <div className={styles.headerActions}>
      <Link aria-label="返回教学工作台" className={styles.exit} href={`/teacher/teach/${encodeURIComponent(course.id)}/setup`} title="返回教学工作台"><ChevronLeft size={20} /></Link>
      <button className={styles.exit} data-teacher-presentation-trigger onClick={onFullscreen} type="button">{fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}<span>{fullscreen ? "退出全屏" : "全屏授课"}</span></button>
    </div>
  </header>;
}

function PresentationTimer({ timing, onTogglePause, onReset }: {
  timing?: ClassroomTimingSnapshot; onTogglePause: () => void; onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = timing?.activeStage;
  const overtime = (active?.overrunSec ?? 0) > 0;
  const paused = timing?.status === "paused";
  const stageClock = active ? `${overtime ? "+" : ""}${formatClock(overtime ? active.overrunSec : active.remainingSec)}` : "--:--";
  return <Popover.Root onOpenChange={setOpen} open={open}>
    <div className={styles.timing} role="group" aria-label="课堂时间">
      <Popover.Trigger asChild>
        <button aria-label="课堂计时控制" className={styles.timingTrigger} disabled={!timing} type="button">
          <Clock3 aria-hidden="true" size={16} />
          <span className={styles.timingValues}>
            <span data-overtime={overtime}><span>{overtime ? "阶段超时" : "阶段剩余"}</span><strong>{stageClock}</strong></span>
            <span><span>累计授课</span><strong>{timing ? formatClock(timing.courseElapsedSec) : "--:--"}</strong></span>
          </span>
          {paused ? <span className={styles.timingState}>已暂停</span> : null}
          <ChevronDown aria-hidden="true" size={12} />
        </button>
      </Popover.Trigger>
    </div>
    <Popover.Portal container={open && typeof document !== "undefined" ? document.fullscreenElement : undefined}>
      <Popover.Content align="end" aria-label="课堂计时控制" className={styles.timerPopover} collisionPadding={12} side="bottom" sideOffset={10}>
        <div className={styles.timerPopoverHeading}><strong>课堂计时</strong><Popover.Close aria-label="关闭计时控制"><X aria-hidden="true" size={16} /></Popover.Close></div>
        <p>{active?.label} · {overtime ? "阶段超时" : "阶段剩余"} <strong>{stageClock}</strong></p>
        <p>累计授课 <strong>{timing ? formatClock(timing.courseElapsedSec) : "--:--"}</strong></p>
        <div className={styles.timerActions}>
          <button disabled={!active || timing?.status === "completed"} onClick={onTogglePause} type="button">{paused ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}{paused ? "继续" : "暂停"}</button>
          <button disabled={!active || timing?.status === "completed"} onClick={onReset} type="button"><RotateCcw aria-hidden="true" size={16} />重计本阶段</button>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export function TeacherPresentationControls({ course, view, details, discussion, onView, onWorkspace, onDetailsClose, onStage, onTools, onEnd, stageActionsRef, leadingActionsRef, stageTransitionPending = false }: {
  course: Course; view: TeacherPresentationView; details: boolean; discussion: boolean;
  onView: (view: TeacherPresentationView) => void; onWorkspace: () => void; onDetailsClose: () => void;
  onStage: (index: number) => void; onTools: () => void; onEnd: () => void;
  stageActionsRef?: Ref<HTMLDivElement>;
  leadingActionsRef?: Ref<HTMLDivElement>;
  stageTransitionPending?: boolean;
}) {
  const isReflection = course.stages[course.currentStageIndex]?.key === "reflection";
  const stage = course.stages[course.currentStageIndex];
  const previousStage = course.stages[course.currentStageIndex - 1];
  const nextStage = course.stages[course.currentStageIndex + 1];
  const isLastStage = course.currentStageIndex === course.stages.length - 1;
  return <footer aria-label="课堂操作栏" className={styles.controls} data-layout="responsive">
    <div className={styles.controlsLeft} role="group" aria-label="左侧展示操作">
      {!isReflection ? <div className={styles.views} aria-label="课堂视图">
        <button aria-pressed={!discussion && view === "teaching"} onClick={() => onView("teaching")} type="button"><MonitorUp size={20} />授课展示</button>
        <button aria-pressed={!discussion && view === "analytics"} onClick={() => onView("analytics")} type="button"><BarChart3 size={20} />班级学情</button>
        {course.stages[course.currentStageIndex]?.key === "ai-learning" ? <button aria-pressed={!discussion && !details && view === "classroom-review"} onClick={() => onView("classroom-review")} type="button"><BookOpenCheck size={20} />课堂讲解</button> : null}
        {course.stages[course.currentStageIndex]?.view === "ai-collaboration" ? <button aria-pressed={!discussion && view === "student-work"} onClick={() => onView("student-work")} type="button"><FileText size={20} />学生成果</button> : null}
      </div> : null}
      <div className={styles.stageActions} ref={leadingActionsRef} role="group" aria-label="当前阶段资料操作" />
    </div>
    <div className={styles.controlsRight} role="group" aria-label="右侧课堂操作">
      <div className={styles.stageActions} ref={stageActionsRef} role="group" aria-label="当前阶段常用操作" />
      {(stage?.key === "launch" || stage?.key === "ai-learning" || stage?.key === "make" || stage?.key === "showcase") ? null : details ? <button onClick={onDetailsClose} type="button"><ChevronLeft size={18} />{view === "analytics" ? "返回汇总" : view === "student-work" ? "返回成果" : "返回展示"}</button> : <button onClick={onWorkspace} type="button"><PanelTop size={20} />课堂操作</button>}
      {isLastStage ? <button className={styles.end} disabled={stageTransitionPending} onClick={onEnd} type="button">结束课堂</button> : null}
      <button onClick={onTools} type="button"><Wrench size={20} />工具</button>
      <Tooltip.Provider delayDuration={250} disableHoverableContent>
      <div className={styles.stageControls} role="group" aria-label="教学阶段切换">
        <StageNavigationButton direction="previous" disabled={stageTransitionPending || !previousStage} hint={stageTransitionPending ? "正在切换教学阶段，请稍候" : previousStage ? `上一阶段：${previousStage.label}` : "已是第一个教学阶段"} onClick={() => onStage(course.currentStageIndex - 1)} />
        <select aria-label="当前教学阶段" disabled={stageTransitionPending} onChange={(event) => onStage(Number(event.target.value))} value={course.currentStageIndex}>
          {course.stages.map((stage, index) => <option key={stage.key} value={index}>{index + 1}. {stage.label}</option>)}
        </select>
        <StageNavigationButton direction="next" disabled={stageTransitionPending || !nextStage} hint={stageTransitionPending ? "正在切换教学阶段，请稍候" : nextStage ? `下一阶段：${nextStage.label}` : "已是最后一个教学阶段"} onClick={() => onStage(course.currentStageIndex + 1)} />
      </div>
      </Tooltip.Provider>
    </div>
  </footer>;
}

function StageNavigationButton({ direction, disabled, hint, onClick }: {
  direction: "previous" | "next"; disabled: boolean; hint: string; onClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger asChild>
      <button aria-label={direction === "previous" ? "上一教学阶段" : "下一教学阶段"} disabled={disabled} onClick={onClick} type="button">
        {direction === "previous" ? <ChevronLeft aria-hidden="true" size={20} /> : <ChevronRight aria-hidden="true" size={20} />}
      </button>
    </Tooltip.Trigger>
    <Tooltip.Portal container={open && typeof document !== "undefined" ? document.fullscreenElement : undefined}>
      <Tooltip.Content className={styles.stageHint} side="top" sideOffset={8} collisionPadding={12}>
        {hint}
        <Tooltip.Arrow />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
