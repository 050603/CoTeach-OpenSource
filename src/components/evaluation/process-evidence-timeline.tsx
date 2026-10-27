"use client";

import type { PblProcessEvidence, RawPblProcessReport } from "@/lib/evaluation/process-contract";
import styles from "./evaluation.module.css";

const actors = { student: "学生", ai: "AI", system: "系统" };
const kinds: Record<PblProcessEvidence["kind"], string> = { quiz: "知识测验", "learning-dialogue": "学习问答", "practice-dialogue": "实践协作", "saved-version": "作品修改", artifact: "提交作品", presentation: "汇报", reflection: "反思" };
const stages: Record<string, string> = { launch: "导入", "ai-learning": "学习", make: "实践", showcase: "汇报", reflection: "评价", overview: "导入", learning: "学习", practice: "实践" };

/** Teacher-only raw evidence, including associations verified by the server. */
export function ProcessEvidenceTimeline({ report }: { report: RawPblProcessReport }) {
  return <details className={styles.listItem}>
    <summary className="min-h-11 cursor-pointer font-semibold">过程证据时间线（{report.evidence.length}）</summary>
    <p className={styles.muted}>此份报告采用的记录，按发生时间排列。关联依据只展示已核实的记录关系。</p>
    {!report.evidence.length ? <p className={styles.empty}>本次报告没有可归因到该学生的过程记录。</p> : <ol className={styles.list}>{[...report.evidence].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).map(item => <li key={item.id}>
      <details className={styles.listItem}>
        <summary className="min-h-11 cursor-pointer font-semibold">{item.title}</summary>
        <p className={styles.muted}>{new Date(item.occurredAt).toLocaleString("zh-CN")} · {stages[item.stageKey] ?? item.stageKey} · {kinds[item.kind]} · {actors[item.actor]}</p>
        <p className={styles.result}>{item.content}</p>
        {item.limitations.length ? <p className={styles.notice}>记录限制：{item.limitations.join("；")}</p> : null}
        {report.dimensions.some(dimension => dimension.evidenceIds.includes(item.id)) ? <p className={styles.muted}>用于：{report.dimensions.filter(dimension => dimension.evidenceIds.includes(item.id)).map(dimension => dimension.name).join("、")}</p> : null}
        {item.relatedEvidenceIds.map(id => {
          const related = report.evidence.find(evidence => evidence.id === id);
          return related ? <details className={`${styles.listItem} mt-3`} key={id}><summary className="min-h-11 cursor-pointer font-semibold">关联依据：{related.title}</summary><p className={styles.muted}>{new Date(related.occurredAt).toLocaleString("zh-CN")} · {actors[related.actor]}</p><p className={styles.result}>{related.content}</p>{related.limitations.length ? <p className={styles.notice}>{related.limitations.join("；")}</p> : null}</details> : <p className={styles.muted} key={id}>关联记录未纳入本次报告快照。</p>;
        })}
      </details>
    </li>)}</ol>}
  </details>;
}
