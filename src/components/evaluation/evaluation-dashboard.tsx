"use client";

import type { Course } from "@/lib/session/types";
import { useEvaluation } from "./use-evaluation";
import styles from "./evaluation.module.css";

export function EvaluationDashboard({ course }: { course: Course }) {
  const { snapshot, error, refresh } = useEvaluation(course.id);
  const completion = snapshot?.completion;
  return <section className={`${styles.root} p-3`} aria-label="项目评价进度">
    <h3 className="font-semibold">项目评价进度</h3>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!completion ? <p className={styles.empty}>正在加载评价进度…</p> : <>
      <div className={styles.metrics}>{[
        ["自评已提交", `${completion.selfSubmitted}/${completion.total}`],
        ["互评已提交", `${completion.peerSubmitted}/${completion.peerAssigned}`],
        ["教师已定评", `${completion.teacherSubmitted}/${completion.total}`],
        ["结果已发布", `${completion.published}/${completion.total}`],
      ].map(([label, value]) => <div className={styles.metric} key={label}><strong>{value}</strong><span className={styles.muted}>{label}</span></div>)}</div>
      <p className={styles.muted}>自评、互评和 AI 过程报告分别呈现，由教师综合定评。缺少证据不记为低分。</p>
    </>}
    <button className={styles.button} type="button" onClick={() => void refresh()}>刷新进度</button>
  </section>;
}
