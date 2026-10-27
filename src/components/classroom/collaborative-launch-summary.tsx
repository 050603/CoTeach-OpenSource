import type { Course } from "@/lib/session/types";

/** Only public, adopted classroom requirements belong here, never the preparation conversation. */
export function CollaborativeLaunchSummary({ course, compact = false, presentation = false }: {
  course: Course;
  compact?: boolean;
  presentation?: boolean;
}) {
  const plan = course.content?.stagePlan;
  if (plan?.source !== "collaborative-preparation") return null;
  const launch = plan.stages.find((stage) => stage.key === "launch");
  const deliverables = plan.finalDeliverables ?? [];
  const contents = <div className={presentation ? "space-y-6 text-[clamp(18px,2vw,28px)] leading-relaxed" : "space-y-5 text-sm leading-7"}>
    {plan.drivingQuestion ? <p className="font-semibold text-[var(--pbl-text-strong)]">{plan.drivingQuestion}</p> : null}
    {plan.projectTask ? <section><h3 className="font-semibold">项目任务</h3><p className="mt-1 whitespace-pre-wrap break-words">{plan.projectTask}</p></section> : null}
    {course.learningObjectives?.length ? <section><h3 className="font-semibold">学习目标</h3><ul className="mt-1 list-disc space-y-1 pl-5">{course.learningObjectives.map((goal, index) => <li className="break-words" key={index}>{goal}</li>)}</ul></section> : null}
    {launch?.requirements ? <section><h3 className="font-semibold">从这里开始</h3><p className="mt-1 whitespace-pre-wrap break-words">{launch.requirements}</p></section> : null}
    {deliverables.length ? <section><h3 className="font-semibold">需要完成的成果</h3><ul className="mt-1 space-y-2">{deliverables.map((item) => <li className="break-words" key={item.id}><strong>{item.name}</strong>{item.format ? `（${item.format}）` : ""}：{item.requirements}</li>)}</ul></section> : course.expectedOutcome ? <section><h3 className="font-semibold">需要完成的成果</h3><p className="mt-1 whitespace-pre-wrap break-words">{course.expectedOutcome}</p></section> : null}
    <section><h3 className="font-semibold">课堂安排 · 共 {plan.totalMinutes} 分钟</h3><ol className="mt-2 grid gap-2 sm:grid-cols-2">{plan.stages.map((stage, index) => <li className="rounded-lg border border-[var(--pbl-border)] px-3 py-2" key={stage.key}><span>{index + 1}. {stage.title}</span><span className="ml-3 whitespace-nowrap text-[var(--pbl-text-muted)]">{stage.durationMin} 分钟</span></li>)}</ol></section>
    {plan.evaluationCriteria ? <section><h3 className="font-semibold">成果评价</h3><p className="mt-1 whitespace-pre-wrap break-words">{plan.evaluationCriteria}</p></section> : null}
  </div>;
  const classes = "min-w-0 rounded-xl border border-[var(--pbl-border)] bg-white p-5 text-[var(--pbl-text)] sm:p-6";
  return compact ? <details className={classes}><summary className="min-h-11 cursor-pointer font-semibold">项目任务与学习目标</summary><div className="mt-4">{contents}</div></details>
    : <section aria-label="项目启动说明" className={`${classes}${presentation ? " min-h-0 flex-1 overflow-auto" : ""}`}><h2 className={presentation ? "mb-6 text-[clamp(24px,3vw,40px)] font-bold" : "mb-4 text-lg font-semibold"}>项目启动说明</h2>{contents}</section>;
}
