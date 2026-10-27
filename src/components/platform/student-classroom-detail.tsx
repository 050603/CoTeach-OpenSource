"use client";

import Link from "next/link";
import { ArrowRight, BookOpen, Check, ChevronDown, Circle, Clock3, History, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ResilientImage } from "@/components/resilient-image";
import { studentClassroomHref } from "@/lib/platform/classroom-entry";
import { studentExperimentHref } from "@/lib/platform/experiment-entry";
import { classroomExperiment, type StudentClassroomActivity, type StudentClassroomInstance } from "./student-classroom-detail.types";
import { useStudentClassroomDetail } from "./use-student-classroom-detail";
import styles from "./student-classroom-detail.module.css";

type Phase = "pretest" | "posttest";

function assessmentState(activity: StudentClassroomActivity, instance: StudentClassroomInstance, phase: Phase) {
  const experiment = classroomExperiment(activity, instance);
  const questions = experiment?.enabled ? experiment[phase] : [];
  const submitted = Boolean(phase === "pretest" ? instance.pretestSubmitted : instance.posttestSubmitted);
  const available = activity.isOpen && (phase === "pretest"
    ? activity.offering.status === "open" && ["scheduled", "teaching"].includes(instance.status)
    : activity.offering.status === "open" && instance.status === "finished" && Boolean(instance.posttestAvailable));
  return { count: questions?.length ?? 0, submitted, available, visible: submitted || Boolean(experiment?.enabled && (phase === "posttest" || questions?.length)) };
}

function CoverArt() {
  return <svg className={styles.coverArt} aria-hidden="true" viewBox="0 0 800 450" fill="none" preserveAspectRatio="xMidYMid slice">
    <rect width="800" height="450" fill="#E2EEEB" />
    <circle cx="711" cy="66" r="225" fill="#D2E5DF" />
    <circle cx="91" cy="430" r="191" fill="#D6E7E2" />
    <path d="M0 350C146 256 226 436 402 318S654 231 800 271" stroke="#B3D3C8" strokeWidth="1.5" />
    <path d="M0 372C146 278 226 458 402 340S654 253 800 293" stroke="#B3D3C8" strokeWidth="1.5" />
    <g transform="translate(265 87) rotate(-10 130 120)">
      <rect x="0" y="24" width="240" height="248" rx="14" fill="#A7C7BB" opacity=".35" />
      <rect x="18" y="0" width="240" height="248" rx="14" fill="#FAFCF9" />
      <path d="M48 65H147M48 82H119M48 199H202" stroke="#A6BDB4" strokeWidth="5" strokeLinecap="round" />
      <path d="M64 162L105 122L147 150L199 97" stroke="#337D6C" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="105" cy="122" r="7" fill="#337D6C" /><circle cx="147" cy="150" r="7" fill="#337D6C" /><circle cx="199" cy="97" r="7" fill="#337D6C" />
    </g>
    <circle cx="563" cy="289" r="38" fill="#7DAF9D" /><path d="M547 289L558 300L580 278" stroke="#F7FBF8" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M200 110V134M188 122H212M607 149V165M599 157H615" stroke="#83AC9E" strokeWidth="3" strokeLinecap="round" />
  </svg>;
}

function instanceDate(instance: StudentClassroomInstance) {
  const value = instance.startedAt || instance.endedAt;
  if (!value) return "授课时间未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "授课时间未记录" : new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function StudentClassroomDetail({ initialActivity }: { initialActivity: StudentClassroomActivity }) {
  const { activity, refreshing, refreshError, accessLost, refresh, suspendRefresh, resumeRefresh } = useStudentClassroomDetail(initialActivity);
  const [entryError, setEntryError] = useState<{ instanceId: string; message: string } | null>(null);
  const [busyInstance, setBusyInstance] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const entering = useRef(false);
  const entryRequest = useRef<AbortController | null>(null);
  useEffect(() => () => entryRequest.current?.abort(), []);
  const instance = activity.instance;
  const pretest = instance ? assessmentState(activity, instance, "pretest") : null;
  const posttest = instance ? assessmentState(activity, instance, "posttest") : null;
  const pretestPending = Boolean(pretest?.count && !pretest.submitted);
  const canEnter = Boolean(instance?.status === "teaching" && instance.canWrite && activity.isOpen && activity.offering.status === "open" && !pretestPending);
  const history = (activity.instances ?? []).filter((item) => item.status === "finished" && item.id !== instance?.id);
  // The API orders by creation time; do not infer an order from missing dates.
  const canReview = Boolean(instance?.status === "finished" && activity.isOpen);
  const mainAction = pretestPending && pretest?.available ? "pretest" : posttest?.count && !posttest.submitted && posttest.available ? "posttest" : canEnter ? "enter" : canReview ? "review" : null;
  const phase = mainAction === "pretest" || mainAction === "posttest" ? mainAction : undefined;
  const closed = activity.offering.status !== "open" && instance?.status !== "finished";
  const entryUnavailable = instance?.status === "teaching" && !canEnter;
  const status = !activity.isOpen ? "尚未开放" : closed ? "课程已结束" : !instance ? "等待安排" : instance.status === "finished" ? "本场已结束" : instance.status === "teaching" ? "正在上课" : "等待开课";
  const heading = !activity.isOpen ? "课堂尚未开放" : closed ? "课程已结束" : !instance ? "等待教师安排课堂" : mainAction === "pretest" ? "先完成课前前测" : mainAction === "posttest" ? "完成本次课堂后测" : canEnter ? "课堂已开始，准备加入" : canReview ? "回顾本次课堂" : entryUnavailable ? "当前无法进入课堂" : "等待教师开始";
  const description = !activity.isOpen ? "教师开放后，即可在这里查看课堂安排并参与学习。" : closed ? "当前课程已结束，可在下方查看已有的课堂记录。" : !instance ? "教师安排好本次课堂后，进入方式会显示在这里。" : mainAction === "pretest" ? `共 ${pretest?.count} 题，请按自己的真实想法作答，完成后即可准备进入课堂。` : mainAction === "posttest" ? `共 ${posttest?.count} 题，记录这次学习后的想法与收获。` : canEnter ? "进入课堂，开始本次学习与实践。" : canReview ? "课堂已结束，你的作品与学习记录保留在本次课堂中。" : entryUnavailable ? "当前课堂暂不允许进入，请确认课程状态或联系教师。" : "开课状态会自动更新。教师开始后，点击进入即可加入课堂。";
  const busy = busyInstance !== null;

  async function enter(target: StudentClassroomInstance) {
    if (entering.current || accessLost || !activity.isOpen) return;
    entering.current = true;
    setBusyInstance(target.id);
    setEntryError(null);
    suspendRefresh();
    const controller = new AbortController();
    entryRequest.current = controller;
    try {
      const response = await fetch(`/api/platform/classroom-instances/${encodeURIComponent(target.id)}/enter`, { method: "POST", signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.message || "无法进入课堂，请重试。");
      if (!data.participation?.id || !data.instance?.id) throw new Error("未能获取课堂入口，请重试。");
      window.location.assign(studentClassroomHref(data.instance.id, data.participation.id, data.instance.templateVersion?.snapshot?.kind, data.instance.status));
    } catch (reason) {
      if (controller.signal.aborted) return;
      setEntryError({ instanceId: target.id, message: reason instanceof Error ? reason.message : "无法进入课堂，请重试。" });
      entering.current = false;
      setBusyInstance(null);
      resumeRefresh();
    }
  }

  function assessment(target: StudentClassroomInstance, assessmentPhase: Phase, isMain = false) {
    const state = assessmentState(activity, target, assessmentPhase);
    if (!state.visible) return null;
    const label = assessmentPhase === "pretest" ? "前测" : "后测";
    const actionable = !accessLost && !busy && activity.isOpen;
    return <div className={styles.assessmentRow} key={assessmentPhase}>
      <span className={state.submitted ? styles.checkIcon : styles.stepIcon} aria-hidden="true">{state.submitted ? <Check size={14} /> : <Circle size={14} />}</span>
      <div className={styles.assessmentCopy}><strong>{label}</strong><span>{state.submitted ? "已提交" : state.available && state.count ? `${state.count} 题 · 待完成` : target.status === "finished" || activity.offering.status !== "open" ? "已关闭" : "尚未开放"}</span></div>
      {state.submitted && actionable ? <Link className={styles.textAction} href={studentExperimentHref(activity.id, target.id, assessmentPhase)}>查看{label}答案</Link>
        : !isMain && state.available && state.count > 0 && actionable ? <Link className={styles.textAction} href={studentExperimentHref(activity.id, target.id, assessmentPhase)}>开始{label}</Link> : null}
    </div>;
  }

  return <div className={styles.page}>
    <div className={styles.layout}>
      <header className={styles.hero}>
        <div className={styles.context}><BookOpen size={15} aria-hidden="true" /><span>{activity.offering.name}</span><span aria-hidden="true">/</span><span>{activity.chapter.title}</span></div>
        <div className={styles.titleRow}><span className={styles.eyebrow}>课堂学习</span><h1>{activity.title}</h1></div>
      </header>
      <div className={styles.cover}>
        {instance?.coverImageUrl ? <ResilientImage src={instance.coverImageUrl} alt={`${activity.title}课堂封面`} fill unoptimized className={styles.coverImage} fallback={<CoverArt />} /> : <CoverArt />}
      </div>

      <aside className={styles.sidebar} aria-label="本次课堂">
        <section className={styles.entryPanel}>
          <div className={styles.entryMeta}><span>本次课堂{instance?.runNo ? ` · 第 ${instance.runNo} 次` : ""}</span><span className={styles.status} data-live={instance?.status === "teaching" && activity.isOpen && !closed && !accessLost}><span aria-hidden="true" />{accessLost ? "访问受限" : status}</span></div>
          <h2 aria-live="polite">{accessLost ? "暂时无法访问课堂" : heading}</h2>
          <p className={styles.entryDescription}>{accessLost ? "登录状态或课堂访问权限已变化，请返回课程重新确认。" : description}</p>
          {accessLost ? <Link className={styles.primary} href={`/student/courses/${activity.offering.id}`}>返回课程<ArrowRight size={17} aria-hidden="true" /></Link>
            : busy ? <button className={styles.primary} disabled type="button"><LoaderCircle size={17} aria-hidden="true" />正在打开课堂…</button>
              : instance && phase ? <Link className={styles.primary} href={studentExperimentHref(activity.id, instance.id, phase)}>开始{phase === "pretest" ? "前测" : "后测"}<ArrowRight size={17} aria-hidden="true" /></Link>
                : instance && (mainAction === "enter" || mainAction === "review") ? <button className={styles.primary} onClick={() => void enter(instance)} type="button">{mainAction === "review" ? "查看课堂记录" : "进入课堂"}<ArrowRight size={17} aria-hidden="true" /></button>
                  : <div className={styles.waiting}><Clock3 size={16} aria-hidden="true" />{!activity.isOpen ? "等待教师开放" : closed || entryUnavailable ? "当前不可进入" : !instance ? "等待课堂安排" : "等待开课"}</div>}
          {!accessLost && !busy && phase === "posttest" && instance && (canEnter || canReview) ? <button className={styles.secondary} onClick={() => void enter(instance)} type="button">{canReview ? "查看课堂记录" : "进入课堂"}<ArrowRight size={15} aria-hidden="true" /></button> : null}
          {entryError && entryError.instanceId === instance?.id ? <p className={styles.error} role="alert">{entryError.message}</p> : null}
          {instance && !accessLost && (pretest?.visible || posttest?.visible) ? <div className={styles.assessments} aria-label="本次课堂测评">{assessment(instance, "pretest", phase === "pretest")}{assessment(instance, "posttest", phase === "posttest")}</div> : null}
          <div className={styles.sync}>
            {refreshError ? <div className={styles.syncError}><p role="alert">{refreshError}</p>{!accessLost ? <button className={styles.textAction} disabled={refreshing || busy} onClick={() => void refresh()} type="button"><RefreshCw size={13} aria-hidden="true" />重试更新</button> : null}</div>
              : <><span className={styles.syncDot} aria-hidden="true" /><span>{refreshing ? "正在更新课堂状态…" : "课堂状态自动更新"}</span></>}
          </div>
        </section>
        <p className={styles.sidebarNote}>学习记录与本次课堂关联，稍后可返回回顾。</p>
      </aside>

      {activity.description ? <section className={styles.introduction} aria-labelledby="classroom-introduction"><div className={styles.sectionHeading}><span aria-hidden="true" /><h2 id="classroom-introduction">课堂介绍</h2></div><p>{activity.description}</p></section> : null}
    </div>

    {history.length > 0 ? <section className={styles.history} aria-label="历史课堂">
      <button className={styles.historyToggle} aria-expanded={historyOpen} aria-controls="classroom-history" onClick={() => setHistoryOpen(!historyOpen)} type="button"><span className={styles.historyTitle}><History size={19} aria-hidden="true" /><strong>历史课堂</strong><span className={styles.historyCount}>{history.length}</span></span><span className={styles.historyHint}>{historyOpen ? "收起记录" : "展开查看"}<ChevronDown size={17} className={historyOpen ? styles.rotated : ""} aria-hidden="true" /></span></button>
      <div id="classroom-history" hidden={!historyOpen}>
        {history.map((item) => <article className={styles.historyItem} key={item.id}>
          <div className={styles.historyItemHeading}><div><h3>{item.runNo ? `第 ${item.runNo} 次课堂` : "已结束课堂"}</h3><p>{instanceDate(item)}</p></div><button className={styles.secondary} disabled={busy || accessLost || !activity.isOpen} onClick={() => void enter(item)} type="button">{busyInstance === item.id ? "正在打开…" : "查看课堂记录"}<ArrowRight size={15} aria-hidden="true" /></button></div>
          <div className={styles.historyAssessments}>{assessment(item, "pretest")}{assessment(item, "posttest")}</div>
          {entryError?.instanceId === item.id ? <p className={styles.error} role="alert">{entryError.message}</p> : null}
        </article>)}
      </div>
    </section> : null}
  </div>;
}

export function StudentClassroomDetailSkeleton() {
  return <div className={styles.page} aria-busy="true" aria-label="正在加载活动"><div className={styles.layout}>
    <div className={styles.hero}><div className={`${styles.skeleton} ${styles.skeletonContext}`} /><div className={`${styles.skeleton} ${styles.skeletonTitle}`} /></div>
    <div className={`${styles.skeleton} ${styles.cover}`} />
    <div className={`${styles.sidebar} ${styles.skeletonPanel}`}><div className={`${styles.skeleton} ${styles.skeletonContext}`} /><div className={`${styles.skeleton} ${styles.skeletonTitle}`} /><div className={`${styles.skeleton} ${styles.skeletonButton}`} /></div>
  </div><p className={styles.loadingText} role="status">正在展开活动…</p></div>;
}
