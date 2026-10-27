"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { Course } from "@/lib/session/types";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import { deriveProjectPracticeRows, type PracticeDecisionRecord } from "@/lib/classroom/project-practice-analytics";
import { ProjectCollaborationTranscript, ProjectDocumentChanges } from "@/components/views/teacher/project-collaboration-transcript";
import { TeacherContentMonitorPanel, useTeacherContentMonitor } from "@/components/views/teacher/teacher-content-monitor";
import { AiMemberMarkdown } from "@/components/views/student/ai-member-markdown";
import { TeacherOperationDrawer } from "./teacher-operation-details";
import styles from "./teacher-project-analytics.module.css";

type ProjectTab = "overview" | "progress" | "collaboration";
type DetailTab = "conversation" | "suggestions" | "reminders";
type ProgressFilter = "all" | "unsubmitted" | "attention" | "not-started" | "in-progress" | "submitted";
type CollaborationFilter = "all" | "participating" | "adopted" | "rejected" | "boundary" | "external";
const TABS: Array<{ value: ProjectTab; label: string }> = [{ value: "overview", label: "概览" }, { value: "progress", label: "学生进度" }, { value: "collaboration", label: "AI 协作" }];
const DETAIL_TABS: Array<{ value: DetailTab; label: string }> = [{ value: "conversation", label: "协作对话" }, { value: "suggestions", label: "建议处理" }, { value: "reminders", label: "外部内容提醒" }];
const DECISION_LABELS: Record<PracticeDecisionRecord["decision"], string> = {
  adopted: "已采纳", modified: "修改后采纳", rejected: "未采纳", revision: "已退回修改", undone: "已撤销", pending: "待决定",
};
const adopted = (record: PracticeDecisionRecord) => record.decision === "adopted" || record.decision === "modified";
function time(value: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "暂无记录";
}
function TabBar<T extends string>({ id, label, tabs, value, onChange }: { id: string; label: string; tabs: Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const index = tabs.findIndex(tab => tab.value === value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    onChange(tabs[next].value);
    document.getElementById(`${id}-${tabs[next].value}`)?.focus();
  }
  return <div role="tablist" aria-label={label} className={styles.tabs} onKeyDown={onKeyDown}>{tabs.map(tab => <button key={tab.value} id={`${id}-${tab.value}`} type="button" role="tab" aria-selected={tab.value === value} aria-controls={`${id}-${tab.value}-panel`} tabIndex={tab.value === value ? 0 : -1} onClick={() => onChange(tab.value)}>{tab.label}</button>)}</div>;
}

export function TeacherProjectAnalytics({ course, active = true, degraded = false, onStudentWork }: { course: Course; active?: boolean; degraded?: boolean; onStudentWork: (studentId: string) => void }) {
  // A classroom/stage change resets local browsing; ordinary view switches keep it mounted.
  return <ProjectAnalytics key={`${course.id}:${course.currentStageIndex}`} course={course} active={active} degraded={degraded} onStudentWork={onStudentWork} />;
}
function ProjectAnalytics({ course, active, degraded, onStudentWork }: { course: Course; active: boolean; degraded: boolean; onStudentWork: (studentId: string) => void }) {
  const id = useId();
  const rows = useMemo(() => deriveProjectPracticeRows(course), [course]);
  const documentMode = normalizePblCourseConfig(course.pblConfig).makeArtifactMode === "document";
  const monitor = useTeacherContentMonitor(course, active && documentMode);
  const [tab, setTab] = useState<ProjectTab>("overview");
  const [query, setQuery] = useState("");
  const [collaborationQuery, setCollaborationQuery] = useState("");
  const [filter, setFilter] = useState<ProgressFilter>("all");
  const [collaborationFilter, setCollaborationFilter] = useState<CollaborationFilter>("all");
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [detail, setDetail] = useState<{ studentId: string; tab: DetailTab; open: boolean }>({ studentId: "", tab: "conversation", open: false });
  const panels = useRef<Partial<Record<ProjectTab, HTMLElement | null>>>({});
  const scroll = useRef<Record<ProjectTab, number>>({ overview: 0, progress: 0, collaboration: 0 });
  useLayoutEffect(() => {
    if (active && panels.current[tab]) panels.current[tab]!.scrollTop = scroll.current[tab];
  }, [active, tab]);
  const reminderCounts = useMemo(() => {
    if (!documentMode) return new Map<string, { pendingCount: number; reviewedCount: number; dismissedCount: number }>();
    if (monitor.studentCounts) return new Map(monitor.studentCounts.map(item => [item.studentId, item]));
    // Older servers have no aggregate: the loaded records are complete only at the final page.
    if (!monitor.events || monitor.nextCursor) return undefined;
    const result = new Map<string, { pendingCount: number; reviewedCount: number; dismissedCount: number }>();
    for (const event of monitor.events) {
      const counts = result.get(event.studentId) ?? { pendingCount: 0, reviewedCount: 0, dismissedCount: 0 };
      if (event.status === "pending") counts.pendingCount++;
      else if (event.status === "reviewed") counts.reviewedCount++;
      else if (event.status === "dismissed") counts.dismissedCount++;
      result.set(event.studentId, counts);
    }
    return result;
  }, [documentMode, monitor.studentCounts, monitor.events, monitor.nextCursor]);
  const pendingFor = (studentId: string) => reminderCounts ? reminderCounts.get(studentId)?.pendingCount ?? 0 : undefined;
  const needsAttention = (row: typeof rows[number]) => row.signals.length > 0 || row.boundaryTriggerCount > 0 || (pendingFor(row.student.id) ?? 0) > 0;
  const attentionRows = rows.filter(needsAttention);
  const decisions = rows.flatMap(row => row.decisions);
  const participating = rows.filter(row => row.participating);
  const totalInteractions = rows.reduce((total, row) => total + row.dialogueRounds, 0);
  const counts = {
    active: rows.filter(row => row.progressState === "in-progress").length,
    notStarted: rows.filter(row => row.progressState === "not-started").length,
    submitted: rows.filter(row => row.submitted).length,
    adopted: decisions.filter(adopted).length,
    rejected: decisions.filter(record => record.decision === "rejected").length,
  };
  const hasDecisions = decisions.some(record => record.decision !== "pending");
  const visibleRows = [...rows].filter(row => row.student.name.toLocaleLowerCase().includes((tab === "collaboration" ? collaborationQuery : query).trim().toLocaleLowerCase()))
    .filter(row => tab === "collaboration"
      ? collaborationFilter === "participating" ? row.participating : collaborationFilter === "adopted" ? row.decisions.some(adopted) : collaborationFilter === "rejected" ? row.decisions.some(record => record.decision === "rejected") : collaborationFilter === "boundary" ? row.boundaryTriggerCount > 0 : collaborationFilter === "external" ? !reminderCounts || (pendingFor(row.student.id) ?? 0) > 0 : true
      : filter === "unsubmitted" ? !row.submitted : filter === "attention" ? needsAttention(row) : filter === "all" ? true : row.progressState === filter)
    .sort((left, right) => sort === "name" ? left.student.name.localeCompare(right.student.name, "zh-CN") : right.updatedAt.localeCompare(left.updatedAt) || left.student.name.localeCompare(right.student.name, "zh-CN"));
  const incompleteAttention = tab === "progress" && filter === "attention" && !reminderCounts;
  const incompleteExternalFilter = tab === "collaboration" && collaborationFilter === "external" && !reminderCounts;
  const selected = rows.find(row => row.student.id === detail.studentId);
  function progress(next: ProgressFilter) { setQuery(""); setFilter(next); setTab("progress"); }
  function collaboration(next: CollaborationFilter) { setCollaborationQuery(""); setCollaborationFilter(next); setTab("collaboration"); }
  function openStudent(studentId: string, target: DetailTab = "conversation") { setDetail({ studentId, tab: target, open: true }); }
  function openReminders() { setDetail({ studentId: "", tab: "reminders", open: true }); }
  const panelProps = (value: ProjectTab) => ({ id: `${id}-${value}-panel`, role: "tabpanel" as const, "aria-labelledby": `${id}-${value}`, hidden: tab !== value, className: styles.panel });
  function rememberScroll(value: ProjectTab, event: UIEvent<HTMLElement>) {
    if (active && tab === value) scroll.current[value] = event.currentTarget.scrollTop;
  }
  const reminderLabel = `外部内容提醒${monitor.pendingCount ? `（${monitor.pendingCount} 待核实）` : ""}${monitor.error ? " · 同步失败" : ""}`;
  const progressSegments = [
    { label: "未开始", count: counts.notStarted, filter: "not-started" as const, tone: "idle" },
    { label: "任务进行中", count: counts.active, filter: "in-progress" as const, tone: "active" },
    { label: "提交过成果", count: counts.submitted, filter: "submitted" as const, tone: "submitted" },
  ];
  const headlineMetrics = [
    { label: "任务进行中", count: counts.active, helper: "已开始写作或上传，尚未提交", tone: "active", unit: "人", onClick: () => progress("in-progress") },
    { label: "提交过成果", count: counts.submitted, helper: "提交过一次即计入，可持续迭代", tone: "submitted", unit: "人", onClick: () => progress("submitted") },
    { label: "参与 AI 协作", count: participating.length, helper: "主动对话或作出建议处理决定", tone: "collaboration", unit: "人", onClick: () => collaboration("participating") },
    { label: "累计 AI 交互", count: totalInteractions, helper: "学生每发起一轮对话，累计 1 次", tone: "interactions", unit: "次", onClick: () => collaboration("participating") },
  ];

  return <section className={styles.root} aria-label="第三阶段班级学情" hidden={!active}>
    <header className={styles.header}><h2>班级学情</h2><p>项目实践 · 已进入本场 {rows.length} 人</p></header>
    {degraded ? <p role="status" className={styles.notice}>数据同步延迟，当前显示最近收到的课堂记录</p> : null}
    {documentMode && monitor.error ? <p role="status" className={styles.notice}>外部提醒同步失败，{reminderCounts ? "保留上次读取的统计。" : "待同步学生提醒数量。"}</p> : null}
    <TabBar id={id} label="项目实践班级学情内容" tabs={TABS} value={tab} onChange={setTab} />
    <section {...panelProps("overview")} ref={node => { panels.current.overview = node; }} onScroll={event => rememberScroll("overview", event)}>
      <div className={styles.metrics} role="group" aria-label="项目实践关键统计">
        {headlineMetrics.map(metric => <button key={metric.label} type="button" data-tone={metric.tone} onClick={metric.onClick}>
          <span>{metric.label}<ChevronRight size={16} /></span><strong>{metric.tone === "interactions" ? <><span className={styles.counterDigits}>{new Intl.NumberFormat("zh-CN").format(metric.count).split("").map((digit, index) => <span key={index} className={/\d/.test(digit) ? styles.counterDigit : styles.counterSeparator}>{digit}</span>)}</span><small>{metric.unit}</small></> : rows.length ? <>{metric.count}<small>{metric.unit}</small></> : "—"}</strong>
          <small>{metric.helper}</small>
        </button>)}
      </div>
      {!rows.length ? <p className={styles.empty}>暂无学生进入本场课堂。</p> : <div className={styles.overviewGrid}>
        <section className={styles.chart} aria-label="项目推进分布">
          <header><h3>项目推进分布</h3><span>{rows.length} 人</span></header>
          <div className={styles.stacked} role="img" aria-label={progressSegments.map(item => `${item.label} ${item.count} 人`).join("，")}>
            {progressSegments.filter(item => item.count > 0).map(item => <span key={item.tone} data-tone={item.tone} style={{ width: `${item.count / rows.length * 100}%` }}>{item.count}</span>)}
          </div>
          <div className={styles.chartLegend}>{progressSegments.map(item => <button key={item.tone} type="button" data-tone={item.tone} onClick={() => progress(item.filter)}><i aria-hidden="true" /><span>{item.label}</span><strong>{item.count}<small>人</small></strong></button>)}</div>
          <p className={styles.caption}>每位学生只计入一种状态；提交后继续修改，仍计入“提交过成果”。</p>
          <div className={styles.decisionSummary}><button type="button" onClick={() => collaboration("adopted")}>采纳或修改建议 <strong>{hasDecisions ? `${counts.adopted} 次` : "暂无记录"}</strong></button><button type="button" onClick={() => collaboration("rejected")}>未采纳建议 <strong>{hasDecisions ? `${counts.rejected} 次` : "暂无记录"}</strong></button></div>
        </section>
        <section className={styles.attention} aria-label="需关注学生概览">
          <header><h3>需关注的学生</h3><button type="button" onClick={() => progress("attention")}>查看全部<ChevronRight size={16} /></button></header>
          {attentionRows.length ? <div className={styles.attentionStudents}>{attentionRows.slice(0, 12).map(row => <button key={row.student.id} type="button" onClick={() => openStudent(row.student.id)}><strong>{row.student.name}</strong><span>{[row.signals.length ? `学习提醒 ${row.signals.length}` : "", row.boundaryTriggerCount ? `AI 边界 ${row.boundaryTriggerCount}` : "", pendingFor(row.student.id) ? `外部待核实 ${pendingFor(row.student.id)}` : ""].filter(Boolean).join(" · ")}</span></button>)}</div> : <p className={styles.empty}>{!reminderCounts ? "正在同步外部提醒…" : "暂未发现需关注的学生。"}</p>}
          <p className={styles.caption}>外部内容提醒需结合学生说明核实。</p>
        </section>
      </div>}
    </section>
    {(["progress", "collaboration"] as const).map(value => <section {...panelProps(value)} key={value} ref={node => { panels.current[value] = node; }} onScroll={event => rememberScroll(value, event)}>
      {value === "collaboration" ? <div className={styles.collaborationHeader} role="group" aria-label="AI 协作汇总">
        <div className={styles.collaborationSummary}><span>参与 <strong>{participating.length}</strong> 人</span><span>采纳或修改 <strong>{counts.adopted}</strong> 次</span><span>未采纳 <strong>{counts.rejected}</strong> 次</span></div>
        {documentMode ? <button type="button" className={styles.reminders} onClick={openReminders}>{reminderLabel}<ChevronRight size={16} /></button> : null}
      </div> : null}
      <div className={styles.toolbar}>
        <label className={styles.search}><Search size={16} aria-hidden="true" /><input aria-label={value === "progress" ? "搜索进度学生" : "搜索协作学生"} placeholder="搜索学生姓名" value={value === "progress" ? query : collaborationQuery} onChange={event => value === "progress" ? setQuery(event.target.value) : setCollaborationQuery(event.target.value)} /></label>
        {value === "progress" ? <label className={styles.selectLabel}><span className="sr-only">进度筛选</span><select value={filter} onChange={event => setFilter(event.target.value as ProgressFilter)}><option value="all">全部学生</option><option value="not-started">未开始</option><option value="in-progress">任务进行中</option><option value="submitted">提交过成果</option><option value="unsubmitted">尚未提交</option><option value="attention">需关注</option></select></label>
          : <label className={styles.selectLabel}><span className="sr-only">协作筛选</span><select value={collaborationFilter} onChange={event => setCollaborationFilter(event.target.value as CollaborationFilter)}><option value="all">全部学生</option><option value="participating">参与 AI 协作</option><option value="adopted">采纳或修改建议</option><option value="rejected">未采纳建议</option><option value="boundary">AI 边界触发</option>{documentMode ? <option value="external" disabled={!reminderCounts}>外部待核实{!reminderCounts ? "（待同步）" : ""}</option> : null}</select></label>}
        <label className={styles.selectLabel}><span className="sr-only">排序</span><select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="updated">最近更新</option><option value="name">学生姓名</option></select></label><span className={styles.listCount}>{incompleteAttention ? visibleRows.length ? `已知 ${visibleRows.length} 人` : "待同步" : `${visibleRows.length} 人`}</span>
      </div>
      {value === "progress" && incompleteAttention ? <p role="status" className={styles.caption}>外部提醒尚未同步，当前仅显示已知的学习提醒与 AI 边界。</p> : null}
      {value === "collaboration" && incompleteExternalFilter ? <p role="status" className={styles.caption}>完整外部提醒统计待同步，暂时显示全部学生。</p> : null}
      <ul className={styles.students} aria-label={value === "progress" ? "学生进度列表" : "学生协作列表"}>
        {visibleRows.map(row => <li key={row.student.id} data-student-id={row.student.id} data-progress={row.progressState} data-attention={needsAttention(row)}>
          <div className={styles.studentHeading}><button type="button" onClick={() => openStudent(row.student.id)} aria-label={`查看${row.student.name}的 AI 协作`}>{row.student.name}<ChevronRight size={14} /></button><span className={styles.status} data-submitted={row.submitted}>{row.progressState === "submitted" ? "提交过" : row.progressState === "in-progress" ? "进行中" : "未开始"}</span></div>
          <div className={styles.tags} aria-label={`${row.student.name}的${value === "progress" ? "进度" : "协作"}标签`}>
            {value === "progress" ? <><span className={styles.tag}>{row.contentCharactersKnown ? `已写 ${row.contentCharacters} 字` : row.externalVersions.some(version => version.status === "submitted") ? "文件成果" : "正文待读取"}</span><button className={styles.tag} type="button" onClick={() => onStudentWork(row.student.id)}>提交 {row.submissionCount} 次</button></> : null}
            <button className={styles.tag} type="button" onClick={() => openStudent(row.student.id)}>对话 {row.dialogueRounds} 轮</button>
            {value === "collaboration" ? <><button className={styles.tag} type="button" onClick={() => openStudent(row.student.id, "suggestions")}>采纳 {row.decisions.filter(adopted).length} 次</button><button className={styles.tag} type="button" onClick={() => openStudent(row.student.id, "suggestions")}>未采纳 {row.decisions.filter(record => record.decision === "rejected").length} 次</button></> : null}
            {value === "collaboration" || row.boundaryTriggerCount > 0 ? <button className={styles.tag} data-tone={row.boundaryTriggerCount ? "boundary" : undefined} type="button" onClick={() => openStudent(row.student.id)}>AI 边界 {row.boundaryTriggerCount} 次</button> : null}
            {documentMode && (value === "collaboration" || (pendingFor(row.student.id) ?? 0) > 0) ? <button className={styles.tag} data-tone={pendingFor(row.student.id) ? "external" : undefined} type="button" onClick={() => openStudent(row.student.id, "reminders")}>外部待核实 {pendingFor(row.student.id) ?? "—"}</button> : null}
            {row.signals.length ? <button className={styles.tag} data-tone="attention" type="button" title={row.signals.map(signal => signal.title).join("；")} onClick={() => openStudent(row.student.id)}>学习提醒 {row.signals.length}</button> : null}
          </div>
          <footer className={styles.cardFooter}><span title={`最近更新：${time(row.updatedAt)}`}>{time(row.updatedAt)}</span><button type="button" onClick={() => onStudentWork(row.student.id)}>查看成果</button></footer>
        </li>)}
      </ul>
      {!visibleRows.length ? <p className={styles.empty}>{rows.length ? incompleteAttention ? "正在同步完整关注名单…" : "没有匹配的学生，可调整搜索或筛选条件。" : "暂无学生进入本场课堂。"}</p> : null}
    </section>)}
    <TeacherOperationDrawer wide open={active && detail.open} onOpenChange={open => setDetail(previous => ({ ...previous, open }))} title={selected ? `${selected.student.name} · AI 协作` : "AI 协作详情"} description="查看协作过程与建议处理；外部内容提醒需要结合学生说明核实。">
      <div className={styles.detail}>
        <TabBar id={`${id}-detail`} label="学生协作详情内容" tabs={documentMode ? DETAIL_TABS : DETAIL_TABS.filter(item => item.value !== "reminders")} value={detail.tab} onChange={next => setDetail(previous => ({ ...previous, tab: next }))} />
        {detail.tab !== "reminders" ? <label className={styles.studentSelect}>学生<select value={selected?.student.id ?? ""} onChange={event => setDetail(previous => ({ ...previous, studentId: event.target.value }))}><option value="">选择学生</option>{rows.map(row => <option key={row.student.id} value={row.student.id}>{row.student.name}</option>)}</select></label> : null}
        <section role="tabpanel" id={`${id}-detail-${detail.tab}-panel`} aria-labelledby={`${id}-detail-${detail.tab}`}>
          {selected && detail.tab !== "reminders" && needsAttention(selected) ? <details className={styles.attentionEvidence}><summary>需关注依据{selected.boundaryTriggerCount ? ` · AI 边界 ${selected.boundaryTriggerCount} 次` : ""}{pendingFor(selected.student.id) ? ` · 外部待核实 ${pendingFor(selected.student.id)}` : ""}</summary>{selected.signals.map(signal => <p key={signal.id}><strong>{signal.title}</strong>{signal.summary ? `：${signal.summary}` : ""}</p>)}{selected.boundaryTriggerCount ? <p>已记录 AI 协作边界触发，可结合下方对话查看具体上下文。</p> : null}{pendingFor(selected.student.id) ? <button type="button" onClick={() => openStudent(selected.student.id, "reminders")}>查看外部内容核实记录</button> : null}</details> : null}
          {detail.tab === "reminders" && documentMode ? <TeacherContentMonitorPanel course={course} state={monitor} studentId={detail.studentId} onStudentChange={studentId => setDetail(previous => ({ ...previous, studentId }))} />
            : !selected ? <p className={styles.empty}>选择学生查看协作记录。</p>
              : detail.tab === "conversation" ? <ProjectCollaborationTranscript turns={selected.turns} />
                : <div className={styles.suggestions}>{selected.decisions.length ? selected.decisions.map(record => <article key={record.key}>
                  <header><h3>{record.title || "AI 建议"}</h3><span className={styles.status}>{DECISION_LABELS[record.decision]}</span></header>
                  <p className={styles.metadata}>{time(record.updatedAt)}</p>
                  {record.targetText ? <div className={styles.original}><strong>原内容</strong><AiMemberMarkdown content={record.targetText} /></div> : null}
                  {record.replacement ? <div className={styles.replacement}><strong>AI 建议</strong><AiMemberMarkdown content={record.replacement} /></div> : null}
                  <ProjectDocumentChanges actions={record.documentActions} />
                  {record.summary ? <AiMemberMarkdown content={record.summary} /> : null}
                </article>) : <p className={styles.empty}>暂无建议处理记录。</p>}</div>}
        </section>
      </div>
    </TeacherOperationDrawer>
  </section>;
}
