"use client";

import { useState } from "react";
import type { Course } from "@/lib/session/types";
import { EvaluationForm } from "./evaluation-form";
import { EvaluationArtifact, EvaluationRecord, ProcessReport } from "./evaluation-record";
import { EvaluationExport } from "./evaluation-export";
import { useEvaluation } from "./use-evaluation";
import styles from "./evaluation.module.css";

export function StudentPblEvaluation({ course, initialTab = "self" }: { course: Course; initialTab?: "self" | "peer" | "results" }) {
  const { snapshot, error, loading, refresh, command } = useEvaluation(course.id, true, "student");
  const [tab, setTab] = useState<"self" | "peer" | "results">(initialTab);
  const [assignmentId, setAssignmentId] = useState("");
  const participant = snapshot?.participants[0];
  const assignment = snapshot?.assignments.find(item => item.id === assignmentId) ?? snapshot?.assignments.find(item => item.evaluation?.status !== "submitted") ?? snapshot?.assignments[0];
  return <div className={`${styles.root} ${styles.student} classroom-stage`}>
    <header className={styles.header}><div><h2>项目评价</h2><p className={styles.muted}>回顾自己的作品，为同伴提供有依据的建议，查看教师发布的反馈。</p></div><div className={styles.toolbar}>{snapshot ? <EvaluationExport snapshot={snapshot} /> : null}<button className={styles.button} type="button" onClick={() => void refresh()}>刷新评价</button></div></header>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!snapshot ? <p className={styles.empty}>{loading ? "正在加载评价…" : "暂时无法读取评价，请刷新重试。"}</p> : <>
      <div className={styles.tabs} role="tablist" aria-label="项目评价内容">
        <button className={styles.tab} role="tab" aria-selected={tab === "self"} onClick={() => setTab("self")} type="button">我的自评{participant?.selfEvaluation?.status === "submitted" ? " · 已提交" : ""}</button>
        <button className={styles.tab} role="tab" aria-selected={tab === "peer"} onClick={() => setTab("peer")} type="button">同伴互评 · {snapshot.assignments.filter(item => item.evaluation?.status === "submitted").length}/{snapshot.assignments.length}</button>
        <button className={styles.tab} role="tab" aria-selected={tab === "results"} onClick={() => setTab("results")} type="button">已发布反馈</button>
      </div>
      {tab === "self" ? participant ? <section role="tabpanel" aria-label="我的自评">
        <div className={styles.list}>{participant.artifacts.map(artifact => <EvaluationArtifact artifact={artifact} key={artifact.versionId} />)}</div>
        <EvaluationForm key={`self:${participant.participationId}`} instanceId={course.id} participationId={participant.participationId} source="self" record={participant.selfEvaluation} rubric={snapshot.config.rubric} canWrite={snapshot.canWrite} command={command} refresh={refresh} />
      </section> : <p className={styles.empty}>尚未找到你的课堂记录。</p> : null}
      {tab === "peer" ? <section role="tabpanel" aria-label="同伴互评">
        {!snapshot.assignments.length ? <p className={styles.empty}>{snapshot.config.peerMode === "off" ? "本次未安排同伴互评。" : "教师尚未分配互评任务，请稍后查看。"}</p> : <>
          <label className={styles.field}><span>选择互评任务</span><select value={assignment?.id ?? ""} onChange={event => setAssignmentId(event.target.value)}>{snapshot.assignments.map(item => <option key={item.id} value={item.id}>{item.targetName} · {item.evaluation?.status === "submitted" ? "已提交" : item.evaluation?.status === "returned" ? "待修订" : "待评价"}</option>)}</select></label>
          {assignment ? <><div className="my-4"><EvaluationArtifact artifact={assignment.artifact} /></div><EvaluationForm key={assignment.id} instanceId={course.id} participationId={assignment.targetParticipationId} assignmentId={assignment.id} source="peer" record={assignment.evaluation} rubric={snapshot.config.rubric} canWrite={snapshot.canWrite} command={command} refresh={refresh} /></> : null}
        </>}
      </section> : null}
      {tab === "results" ? <section role="tabpanel" aria-label="已发布反馈">
        {!participant?.published ? <p className={styles.empty}>教师尚未发布评价结果。自评、互评和 AI 过程报告分别呈现，由教师综合定评。</p> : <>
          <p className={styles.muted}>发布于 {new Date(participant.published.at).toLocaleString("zh-CN")}</p>
          <EvaluationRecord record={participant.published.teacherEvaluation} title="教师定评" />
          <ProcessReport report={participant.published.processReport} />
          <section className={styles.section}><h3>收到的同伴反馈</h3>{participant.peerEvaluations.filter(item => item.status === "submitted").length ? participant.peerEvaluations.filter(item => item.status === "submitted").map((record, index) => <EvaluationRecord key={record.id} record={record} title={`同伴反馈 ${index + 1}`} />) : <p className={styles.empty}>暂无已发布的同伴反馈。</p>}</section>
        </>}
      </section> : null}
    </>}
  </div>;
}
