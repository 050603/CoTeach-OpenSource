"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PreparationPlan, PreparationSessionSnapshot } from "@/lib/collaborative-preparation/types";
import styles from "./preparation-plan-review.module.css";

type ReviewProps = {
  plan: Partial<PreparationPlan>;
  fieldOrigins?: PreparationSessionSnapshot["fieldOrigins"];
  confirmed?: boolean;
};

function TextList({ items }: { items: string[] }) {
  return <ul className={styles.list}>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return <div className={styles.detail}><h4>{title}</h4><div>{children || <span className={styles.pending}>待明确</span>}</div></div>;
}

export function PreparationPlanReview({ plan, fieldOrigins = {}, confirmed = false }: ReviewProps) {
  const id = useId();
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const stageButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const stagePlan = plan.stagePlan;
  const stages = stagePlan?.stages ?? [];
  const activeStage = stages.find((stage) => stage.key === selectedStage) ?? stages[0];
  const rubric = stagePlan?.evaluationRubric;
  const showcase = stagePlan?.showcasePlan;
  const reflectionQuestions = stagePlan?.reflectionQuestionSet?.questions.length
    ? stagePlan.reflectionQuestionSet.questions.map((question) => `${question.prompt}${question.required ? "（必答）" : ""}`)
    : stagePlan?.reflectionQuestions ?? [];

  function origin(field: keyof PreparationPlan) {
    return <span className={styles.origin}>{confirmed ? "教师已确认" : fieldOrigins[field] === "teacher-stated" ? "教师已明确" : "AI 建议 · 待确认"}</span>;
  }

  function moveStage(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % stages.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + stages.length) % stages.length
        : event.key === "Home" ? 0 : event.key === "End" ? stages.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    setSelectedStage(stages[target].key);
    stageButtons.current[target]?.focus();
  }

  if (!Object.values(plan).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))) {
    return <div aria-label="完整课程方案" className={styles.review}><p className={styles.pending}>课程方案尚未形成，请返回讨论补充课程想法。</p></div>;
  }

  return <div aria-label="完整课程方案" className={styles.review}>
    <section className={styles.overview} aria-label="课程概况">
      <div className={styles.titleRow}><div><p className={styles.eyebrow}>课程主题</p><h2>{plan.courseName || "课程主题待明确"}</h2></div>{plan.courseName && origin("courseName")}</div>
      <dl className={styles.facts}>
        <div><dt>学科</dt><dd>{plan.subject || "待明确"}{plan.subject && origin("subject")}</dd></div>
        <div><dt>教学对象</dt><dd>{plan.grade || "待明确"}{plan.grade && origin("grade")}</dd></div>
        <div><dt>课程总时长</dt><dd>{plan.totalMinutes ? `${plan.totalMinutes} 分钟` : "待明确"}{plan.totalMinutes ? origin("totalMinutes") : null}</dd></div>
        <div><dt>课次安排</dt><dd>{stagePlan?.lessonCount ? `${stagePlan.lessonCount} 课次` : "待明确"}{stagePlan?.minutesPerLesson ? <small>每课次 {stagePlan.minutesPerLesson} 分钟</small> : null}{stagePlan?.lessonCount ? origin("stagePlan") : null}</dd></div>
      </dl>
    </section>

    <div className={styles.columns}>
      <section className={styles.section} aria-label="学习目标">
        <div className={styles.sectionHeading}><h3>学习目标</h3>{plan.learningObjectives?.length ? origin("learningObjectives") : null}</div>
        {plan.learningObjectives?.length ? <ol className={styles.objectives}>{plan.learningObjectives.map((objective, index) => <li key={index}><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><p>{objective}</p></li>)}</ol> : <p className={styles.pending}>学习目标待明确。</p>}
      </section>
      <section className={styles.section} aria-label="学情与教学方式">
        <div className={styles.sectionHeading}><h3>学生基础与需要</h3>{plan.learnerContext && origin("learnerContext")}</div>
        <p className={styles.bodyText}>{plan.learnerContext || "学生基础与需要待明确。"}</p>
        <div className={`${styles.sectionHeading} ${styles.subheading}`}><h3>教学方式</h3>{plan.teachingApproach && origin("teachingApproach")}</div>
        <p className={styles.bodyText}>{plan.teachingApproach || "教学方式待明确。"}</p>
      </section>
    </div>

    <section className={styles.section} aria-label="教学阶段安排">
      <div className={styles.sectionHeading}><div><h3>教学阶段</h3><p className={styles.hint}>选择阶段，查看任务、成果和师生分工。</p></div>{stagePlan && origin("stagePlan")}</div>
      {(stagePlan?.drivingQuestion || stagePlan?.projectTask) && <div className={styles.projectContext}>
        {stagePlan.drivingQuestion && <Detail title="驱动问题">{stagePlan.drivingQuestion}</Detail>}
        {stagePlan.projectTask && <Detail title="项目任务">{stagePlan.projectTask}</Detail>}
      </div>}
      {activeStage ? <>
        <div className={styles.stageTabs} role="tablist" aria-label="教学阶段">
          {stages.map((stage, index) => <button type="button" key={stage.key} ref={(element) => { stageButtons.current[index] = element; }} role="tab" id={`${id}-tab-${stage.key}`} aria-controls={`${id}-stage-${stage.key}`} aria-selected={activeStage.key === stage.key} aria-label={stage.title} tabIndex={activeStage.key === stage.key ? 0 : -1} onClick={() => setSelectedStage(stage.key)} onKeyDown={(event) => moveStage(event, index)} className={styles.stageTab}>
            <span className={styles.stageIndex}>{String(index + 1).padStart(2, "0")}</span><strong>{stage.title}</strong><span className={styles.stageDuration}>{stage.durationMin == null ? "时长待明确" : `${stage.durationMin} 分钟`}</span><span className={styles.stagePreview}>{stage.requirements || "任务待明确"}</span>
          </button>)}
        </div>
        <div role="tabpanel" id={`${id}-stage-${activeStage.key}`} aria-labelledby={`${id}-tab-${activeStage.key}`} tabIndex={0} className={styles.stagePanel}>
          <div className={styles.stagePanelTitle}><h4>{activeStage.title}</h4><span>{activeStage.durationMin == null ? "时长待明确" : `${activeStage.durationMin} 分钟`}</span></div>
          <div className={styles.stageDetails}>
            <Detail title="学习任务">{activeStage.requirements}</Detail><Detail title="阶段成果">{activeStage.outputs}</Detail>
            <Detail title="教师职责">{activeStage.teacherActions}</Detail><Detail title="AI 支持">{activeStage.aiActions}</Detail>
            {activeStage.checkpoints?.length ? <Detail title="检查点"><TextList items={activeStage.checkpoints} /></Detail> : null}
            {activeStage.observationPoints?.length ? <Detail title="观察与介入"><TextList items={activeStage.observationPoints} /></Detail> : null}
          </div>
        </div>
      </> : <p className={styles.pending}>教学阶段尚待明确。</p>}
    </section>

    <section className={styles.section} aria-label="知识范围与深度">
      <div className={styles.sectionHeading}><h3>知识范围与深度</h3>{plan.knowledgePoints?.length ? origin("knowledgePoints") : null}</div>
      {plan.knowledgePoints?.length ? <div className={styles.knowledgeGrid}>{plan.knowledgePoints.map((point, index) => <article key={point.id} className={styles.knowledge}><h4><span>{String(index + 1).padStart(2, "0")}</span>{point.name}</h4><Detail title="讲到什么程度">{point.depth}</Detail>{point.teachingApproach && <Detail title="如何讲">{point.teachingApproach}</Detail>}</article>)}</div> : <p className={styles.pending}>知识范围与深度待明确。</p>}
    </section>

    {stagePlan && <section className={styles.section} aria-label="成果与评价">
      <div className={styles.sectionHeading}><h3>成果与评价</h3>{origin("stagePlan")}</div>
      <div className={styles.columns}>
        <div><h4 className={styles.columnTitle}>最终交付</h4>{stagePlan.finalDeliverables?.length ? <ul className={styles.deliverables}>{stagePlan.finalDeliverables.map((deliverable) => <li key={deliverable.id}><div><strong>{deliverable.name}</strong><span>{deliverable.required ? "必交" : "选交"}</span></div><p className={styles.hint}>成果形式：{deliverable.format}</p><p className={styles.bodyText}>{deliverable.requirements}</p></li>)}</ul> : <p className={styles.pending}>最终交付物待明确。</p>}</div>
        <div><h4 className={styles.columnTitle}>评价标准</h4><p className={styles.bodyText}>{stagePlan.evaluationCriteria || "评价标准待明确。"}</p>{rubric && <><p className={styles.evaluationMode}>{rubric.scoringMode === "teacher-final" ? "教师终审 · AI 提供评价建议" : `评价分工：教师 ${rubric.sourceWeights.teacher}% · AI ${rubric.sourceWeights.ai}%`}</p><ul className={styles.rubric}>{rubric.dimensions.map((dimension) => <li key={dimension.id}><div><strong>{dimension.name}</strong><span>{dimension.weight}%</span></div><p>{dimension.description}</p></li>)}</ul></>}</div>
      </div>
      {(reflectionQuestions.length > 0 || showcase) && <div className={`${styles.columns} ${styles.secondaryRow}`}>
        {reflectionQuestions.length > 0 && <Detail title="反思问题"><TextList items={reflectionQuestions} /></Detail>}
        {showcase && <Detail title="展示安排"><ul className={styles.list}>
          {showcase.presenterCount !== undefined && <li>选取 {showcase.presenterCount} 人汇报</li>}
          {showcase.presentationSec !== undefined && <li>每人汇报 {showcase.presentationSec} 秒</li>}
          {showcase.discussionSec !== undefined && <li>讨论 {showcase.discussionSec} 秒</li>}
          {showcase.transitionSec !== undefined && <li>衔接 {showcase.transitionSec} 秒</li>}
        </ul></Detail>}
      </div>}
    </section>}

    <div className={styles.columns}>
      <section className={styles.section} aria-label="教师特别要求"><div className={styles.sectionHeading}><h3>教师特别要求</h3>{plan.teacherRequirements?.length ? origin("teacherRequirements") : null}</div>{plan.teacherRequirements?.length ? <TextList items={plan.teacherRequirements} /> : <p className={styles.pending}>{Array.isArray(plan.teacherRequirements) ? "暂无特别要求。" : "教师特别要求待明确。"}</p>}</section>
      {stagePlan?.aiUsagePolicy && <section className={styles.section} aria-label="AI 使用边界"><div className={styles.sectionHeading}><h3>AI 使用边界</h3>{origin("stagePlan")}</div><p className={styles.bodyText}>{stagePlan.aiUsagePolicy}</p></section>}
    </div>
  </div>;
}
