"use client";

import { useState } from "react";
import { RichDocumentPreview } from "@/components/teacher/rich-document-preview";
import type { PblArtifact, PblEvaluationRecord, PblProcessReport } from "@/lib/evaluation/pbl-contract";
import styles from "./evaluation.module.css";

export function EvaluationArtifact({ artifact }: { artifact: PblArtifact }) {
  return <details className={styles.listItem}>
    <summary className="min-h-11 cursor-pointer font-semibold">{artifact.title} · 第 {artifact.sequence} 版</summary>
    {artifact.submittedAt ? <p className={styles.muted}>提交于 {new Date(artifact.submittedAt).toLocaleString("zh-CN")}</p> : null}
    {artifact.sourceHtml ? <RichDocumentPreview className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-white p-4" html={artifact.sourceHtml} minHeight={120} /> : <p className={styles.muted}>此作品通过文件查看。</p>}
    {artifact.fileUrl ? <a className={styles.button} href={artifact.fileUrl} target="_blank" rel="noreferrer">打开作品文件</a> : null}
  </details>;
}

export function EvaluationRecord({ record, title }: { record: PblEvaluationRecord | null; title: string }) {
  if (!record) return <p className={styles.empty}>{title}尚未提交。</p>;
  const score = record.source === "teacher" ? record.score : record.suggestedScore;
  const fields = [
    ["作品与过程证据", record.answers.evidence], ["做得好的地方", record.answers.strengths],
    ["改进建议", record.answers.improvements], ["我的收获", record.answers.learning],
    ["下一步计划", record.answers.plan], ["评语", record.answers.comment],
    ["定评分数说明", record.answers.overrideReason],
  ].filter(([, value]) => Boolean(value));
  return <section className={styles.section}>
    <div className={styles.header}><h3>{title}</h3><span className={styles.badge}>{record.status === "submitted" ? "已提交" : record.status === "returned" ? "已退回修订" : "草稿"}</span></div>
    {record.evaluatorName ? <p className={styles.muted}>评价人：{record.evaluatorName}</p> : null}
    {record.rubric.map(dimension => <div className={styles.dimension} key={dimension.id}><div><strong>{dimension.name}</strong><p className={styles.muted}>{dimension.description}</p></div><span>{record.answers.dimensionScores[dimension.id] == null ? "无法判断" : `${record.answers.dimensionScores[dimension.id]} 分`}</span></div>)}
    <p className="mt-3 font-semibold">{record.source === "teacher" ? "教师定评" : "量规参考分"}：{score == null ? "暂不计分" : `${score} 分`}</p>
    {fields.map(([label, value]) => <div className="mt-4" key={label}><strong>{label}</strong><p className={styles.result}>{value}</p></div>)}
    {record.returnedReason ? <p className={styles.notice}>修订要求：{record.returnedReason}</p> : null}
  </section>;
}

export function ProcessReport({ report }: { report: PblProcessReport | null }) {
  const [expandedEvidence, setExpandedEvidence] = useState<string | null>(null);
  if (!report) return <p className={styles.empty}>尚无 AI 过程报告。未使用 AI、没有记录或证据不足都不会自动记为低分。</p>;
  return <section className={styles.section}>
    <h3>AI 学习过程报告</h3>
    <p className={styles.muted}>更新于 {new Date(report.generatedAt).toLocaleString("zh-CN")} · 独立呈现，教师综合定评</p>
    {report.evidenceThrough ? <p className={styles.muted}>本报告证据截至 {new Date(report.evidenceThrough).toLocaleString("zh-CN")}</p> : null}
    {report.confidence ? <p className={styles.muted}>证据支持程度：{{ low: "有限", medium: "一般", high: "较充分" }[report.confidence]}</p> : null}
    {report.source === "insufficient-evidence" ? <p className={styles.notice}>当前证据不足以形成 AI 判断，各项保留为暂不计分。</p> : null}
    {report.evidenceGaps?.length ? <div className={styles.notice}><strong>整体证据限制</strong><ul className="list-disc pl-5">{report.evidenceGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div> : null}
    <p className={`${styles.result} mt-3`}>{report.summary}</p>
    {report.dimensions.map(dimension => <article className={styles.reportDimension} key={dimension.id}>
      <strong>{dimension.name}</strong><p className={styles.result}>{dimension.judgment}</p>
      {dimension.score != null ? <p>参考分：{dimension.score}</p> : <p className={styles.muted}>本项暂不计分</p>}
      {dimension.gaps.length ? <p className={styles.notice}>证据限制：{dimension.gaps.join("；")}</p> : null}
      {dimension.suggestion ? <p>下一步：{dimension.suggestion}</p> : null}
      {dimension.evidence.length ? <><button className={styles.button} type="button" aria-expanded={expandedEvidence === dimension.id} onClick={() => setExpandedEvidence(old => old === dimension.id ? null : dimension.id)}>查看依据（{dimension.evidence.length}）</button>{expandedEvidence === dimension.id ? <ul className={styles.list}>{dimension.evidence.map(evidence => <li className={styles.listItem} key={evidence.id}><strong>{evidence.label}</strong><p className={styles.result}>{evidence.detail}</p></li>)}</ul> : null}</> : null}
    </article>)}
  </section>;
}
