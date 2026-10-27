"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { PreparationPlan, PreparationSessionSnapshot } from "@/lib/collaborative-preparation/types";
import { preparationThemeClassName } from "./preparation-shell";
import styles from "./preparation-plan-summary.module.css";

const fieldLabels: Record<string, string> = { courseName: "课程主题", subject: "学科", grade: "教学对象", totalMinutes: "课程总时长", learnerContext: "学生基础与需要", learningObjectives: "学习目标", knowledgePoints: "知识范围与深度", teachingApproach: "教学方式", teacherRequirements: "教师特别要求", stagePlan: "五阶段安排" };

export function PreparationPlanSummary({ plan, fieldOrigins = {}, complete = false, confirmed = false, fields }: {
  plan: Partial<PreparationPlan>;
  fieldOrigins?: PreparationSessionSnapshot["fieldOrigins"];
  complete?: boolean;
  confirmed?: boolean;
  fields?: readonly (keyof PreparationPlan)[];
}) {
  function section(key: keyof PreparationPlan, children: ReactNode) {
    if (!children || (fields && !fields.includes(key))) return null;
    return <section key={key} className="border-b border-slate-100 py-4 last:border-0"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-900">{fieldLabels[key]}</h3><span className="text-xs text-slate-500">{confirmed ? "教师已确认" : fieldOrigins[key] === "teacher-stated" ? "教师已明确" : "AI 建议 · 待确认"}</span></div><div className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-700">{children}</div></section>;
  }
  const stagePlan = plan.stagePlan;
  return <div aria-label={complete ? "完整课程方案" : "当前课程方案"}>
    {section("courseName", plan.courseName)}
    {section("subject", plan.subject)}
    {section("grade", plan.grade)}
    {section("totalMinutes", plan.totalMinutes ? `${plan.totalMinutes} 分钟` : null)}
    {section("learnerContext", plan.learnerContext)}
    {section("learningObjectives", plan.learningObjectives?.length ? <ul className="list-disc space-y-1 pl-5">{plan.learningObjectives.map((item, index) => <li key={index}>{item}</li>)}</ul> : null)}
    {section("knowledgePoints", plan.knowledgePoints?.length ? <ul className="space-y-3">{plan.knowledgePoints.map((point) => <li key={point.id}><strong>{point.name}</strong><p>讲到什么程度：{point.depth}</p>{point.teachingApproach && <p>如何讲：{point.teachingApproach}</p>}</li>)}</ul> : null)}
    {section("teachingApproach", plan.teachingApproach)}
    {section("teacherRequirements", plan.teacherRequirements?.length ? <ul className="list-disc pl-5">{plan.teacherRequirements.map((item, index) => <li key={index}>{item}</li>)}</ul> : null)}
    {section("stagePlan", stagePlan ? <div className="space-y-4">
      {stagePlan.drivingQuestion && <p><strong>驱动问题：</strong>{stagePlan.drivingQuestion}</p>}
      {stagePlan.projectTask && <p><strong>项目任务：</strong>{stagePlan.projectTask}</p>}
      {stagePlan.stages?.map((stage) => <div key={stage.key} className="border-l-2 border-[var(--pbl-teacher-border)] pl-3"><h4 className="font-semibold">{stage.title} · {stage.durationMin} 分钟</h4><p>{stage.requirements}</p>{complete && <><p>成果：{stage.outputs}</p><p>教师行动：{stage.teacherActions}</p><p>AI 支持：{stage.aiActions}</p>{stage.checkpoints?.length ? <p>检查点：{stage.checkpoints.join("；")}</p> : null}{stage.observationPoints?.length ? <p>观察与介入：{stage.observationPoints.join("；")}</p> : null}</>}</div>)}
      {stagePlan.lessonCount && stagePlan.minutesPerLesson ? <p>共 {stagePlan.lessonCount} 课次，每课次 {stagePlan.minutesPerLesson} 分钟</p> : null}
      {complete && <>
        {stagePlan.finalDeliverables?.length ? <div><strong>最终交付</strong><ul className="list-disc pl-5">{stagePlan.finalDeliverables.map((item) => <li key={item.id}>{item.name}（{item.format}，{item.required ? "必交" : "选交"}）：{item.requirements}</li>)}</ul></div> : null}
        <p><strong>评价标准：</strong>{stagePlan.evaluationCriteria}</p>
        {stagePlan.evaluationRubric && <div><p>评价分工：教师 {stagePlan.evaluationRubric.sourceWeights.teacher}% · AI {stagePlan.evaluationRubric.sourceWeights.ai}%</p><ul className="list-disc pl-5">{stagePlan.evaluationRubric.dimensions.map((item) => <li key={item.id}>{item.name} {item.weight}%：{item.description}</li>)}</ul></div>}
        {stagePlan.reflectionQuestionSet?.questions.length ? <div><strong>反思问题</strong><ul className="list-disc pl-5">{stagePlan.reflectionQuestionSet.questions.map((item) => <li key={item.id}>{item.prompt}{item.required ? "（必答）" : ""}</li>)}</ul></div> : stagePlan.reflectionQuestions?.length ? <p><strong>反思问题：</strong>{stagePlan.reflectionQuestions.join("；")}</p> : null}
        {stagePlan.aiUsagePolicy && <p><strong>AI 使用边界：</strong>{stagePlan.aiUsagePolicy}</p>}
        {stagePlan.showcasePlan && <p><strong>展示安排：</strong>{[stagePlan.showcasePlan.presenterCount !== undefined ? `选取 ${stagePlan.showcasePlan.presenterCount} 人汇报` : "", stagePlan.showcasePlan.presentationSec !== undefined ? `每人 ${stagePlan.showcasePlan.presentationSec} 秒` : "", stagePlan.showcasePlan.discussionSec !== undefined ? `讨论 ${stagePlan.showcasePlan.discussionSec} 秒` : "", stagePlan.showcasePlan.transitionSec !== undefined ? `衔接 ${stagePlan.showcasePlan.transitionSec} 秒` : ""].filter(Boolean).join("；")}</p>}
      </>}
    </div> : null)}
    {!Object.keys(plan).length && <p className="py-4 text-sm leading-7 text-slate-500">你的想法会在讨论中逐步整理到这里。AI 提出的建议会单独标记，最后由你确认。</p>}
  </div>;
}

const planGroups: { id: string; title: string; fields: readonly (keyof PreparationPlan)[] }[] = [
  { id: "overview", title: "课程概况", fields: ["courseName", "subject", "grade", "totalMinutes", "learnerContext"] },
  { id: "teaching", title: "目标与教学", fields: ["learningObjectives", "knowledgePoints", "teachingApproach"] },
  { id: "stages", title: "阶段与成果", fields: ["stagePlan"] },
  { id: "requirements", title: "教师要求", fields: ["teacherRequirements"] },
];

function hasContent(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export function PreparationPlanSidebar({ plan, fieldOrigins, confirmed, missingFields, onDetailsOpenChange }: {
  plan: Partial<PreparationPlan>;
  fieldOrigins?: PreparationSessionSnapshot["fieldOrigins"];
  confirmed: boolean;
  missingFields: string[];
  onDetailsOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const headings = useRef<Record<string, HTMLElement | null>>({});
  const hasPlan = Object.values(plan).some(hasContent);
  const groupSummaries: Record<string, string> = {
    overview: plan.learnerContext ? "主题、对象与学情" : "主题、对象与课时",
    teaching: [plan.learningObjectives?.length ? `${plan.learningObjectives.length} 个目标` : "", plan.knowledgePoints?.length ? `${plan.knowledgePoints.length} 个知识点` : ""].filter(Boolean).join(" · "),
    stages: [plan.stagePlan?.stages?.length ? `${plan.stagePlan.stages.length} 个阶段` : "", plan.stagePlan?.finalDeliverables?.length ? `${plan.stagePlan.finalDeliverables.length} 项成果` : ""].filter(Boolean).join(" · "),
    requirements: plan.teacherRequirements?.length ? `${plan.teacherRequirements.length} 项特别要求` : Array.isArray(plan.teacherRequirements) ? "暂无特别要求" : "",
  };
  function changeOpen(next: boolean) {
    setOpen(next);
    onDetailsOpenChange(next);
  }
  useEffect(() => {
    if (!open || !expandedGroup) return;
    const frame = requestAnimationFrame(() => {
      const heading = headings.current[expandedGroup];
      const container = body.current;
      if (heading && container) container.scrollTop += heading.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, expandedGroup]);

  return <aside className={styles.sidebar} aria-label="课程方案摘要">
    <div className={styles.heading}><h2>课程方案</h2><span>{confirmed ? "已确认" : "逐步完善中"}</span></div>
    {hasPlan ? <>
      <h3 className={styles.courseName}>{plan.courseName || "课程主题待明确"}</h3>
      <p className={styles.facts}>{[plan.subject, plan.grade, plan.totalMinutes ? `${plan.totalMinutes} 分钟` : "时长待明确"].filter(Boolean).join(" · ")}</p>
      {plan.learningObjectives?.length ? <p className={styles.objective}><span>学习目标</span>{plan.learningObjectives[0]}</p> : <p className={styles.emptyGoal}>学习目标将在讨论中逐步明确。</p>}
      <Dialog open={open} onOpenChange={changeOpen}>
        <div className={styles.links}>
          {planGroups.map((group) => <button key={group.id} type="button" aria-label={`查看${group.title}`} aria-haspopup="dialog" onClick={(event) => {
            trigger.current = event.currentTarget;
            setExpandedGroup(group.id);
            changeOpen(true);
          }}><span>{group.title}<small>{group.fields.some((field) => hasContent(plan[field])) || (group.id === "requirements" && Array.isArray(plan.teacherRequirements)) ? groupSummaries[group.id] || "已整理" : "待讨论"}</small></span><ChevronRight size={16} aria-hidden="true" /></button>)}
        </div>
        <DialogContent className={`pbl-platform-theme ${preparationThemeClassName} ${styles.dialog}`} showCloseButton={false}
          onOpenAutoFocus={(event) => { event.preventDefault(); if (expandedGroup) headings.current[expandedGroup]?.focus({ preventScroll: true }); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
          <div className={styles.dialogHeader}><div><DialogTitle>课程方案详情</DialogTitle><DialogDescription className="mt-2">按需展开查看；需要调整时，返回讨论补充想法。</DialogDescription></div><DialogClose asChild><button type="button" className={styles.returnButton}>返回备课</button></DialogClose></div>
          <div ref={body} className={styles.dialogBody} aria-label="课程方案详细内容" role="region" tabIndex={0}>
            {planGroups.map((group) => <details key={group.id} open={expandedGroup === group.id} className={styles.group}>
              <summary ref={(element) => { headings.current[group.id] = element; }} onClick={(event) => { event.preventDefault(); setExpandedGroup((current) => current === group.id ? null : group.id); }}><span>{group.title}</span><ChevronDown size={18} aria-hidden="true" /></summary>
              <div className={styles.groupContent}>
                {group.fields.some((field) => hasContent(plan[field])) ? <PreparationPlanSummary plan={plan} fieldOrigins={fieldOrigins} confirmed={confirmed} complete fields={group.fields} /> : <p className={styles.emptyGroup}>{group.id === "requirements" && Array.isArray(plan.teacherRequirements) ? "尚未提出特别要求，可在讨论中随时补充。" : "这部分还在讨论中，明确后会显示在这里。"}</p>}
              </div>
            </details>)}
          </div>
        </DialogContent>
      </Dialog>
    </> : <p className={styles.emptyGroup}>你的想法会逐步整理成方案。先和 AI 讨论，明确后再查看各部分内容。</p>}
    {missingFields.length > 0 && <details className={styles.missing}><summary>还需明确 {missingFields.length} 项</summary><ul>{missingFields.map((key) => <li key={key}>{fieldLabels[key] ?? key}</li>)}</ul></details>}
    <p className={styles.note}>{confirmed ? "方案已确认，讨论记录已保存。" : "AI 建议待你确认，详情中标注来源。"}</p>
  </aside>;
}
