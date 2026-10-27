"use client";

import { useCallback, useState } from "react";
import { TeacherOperationDrawer } from "@/components/classroom/teacher-operation-details";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import type { Course } from "@/lib/session/types";
import type { PblEvaluationConfig, PblEvaluationRecord, PblEvaluationSnapshot } from "@/lib/evaluation/pbl-contract";
import { EvaluationForm } from "./evaluation-form";
import { EvaluationArtifact, EvaluationRecord, ProcessReport } from "./evaluation-record";
import { EvaluationExport } from "./evaluation-export";
import { ProcessEvaluationEntry } from "./process-evaluation-panel";
import { useEvaluation, type EvaluationInput } from "./use-evaluation";
import styles from "./evaluation.module.css";

function ReturnEvaluation({ record, command }: { record: PblEvaluationRecord | null; command: (input: EvaluationInput) => Promise<PblEvaluationSnapshot> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!record || record.status !== "submitted") return null;
  const submit = async () => {
    setBusy(true); setError("");
    try { await command({ action: "return", evaluationId: record.id, version: record.version, reason }); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "退回失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <div className="my-3">{open ? <><label className={styles.field}><span>修订要求</span><textarea value={reason} onChange={event => setReason(event.target.value)} /></label>{error ? <p className={styles.error} role="alert">{error}</p> : null}<div className={styles.actions}><button className={styles.button} disabled={busy || !reason.trim()} type="button" onClick={() => void submit()}>确认退回修订</button><button className={styles.button} type="button" onClick={() => setOpen(false)}>取消</button></div></> : <button className={styles.button} type="button" onClick={() => setOpen(true)}>{record.source === "teacher" ? "重新修订教师评价" : "退回修订"}</button>}</div>;
}

function EvaluationSettings({ snapshot, command }: { snapshot: PblEvaluationSnapshot; command: (input: EvaluationInput) => Promise<PblEvaluationSnapshot> }) {
  const [config, setConfig] = useState<PblEvaluationConfig>(() => structuredClone(snapshot.config));
  const [pairs, setPairs] = useState<Array<{ reviewerParticipationId: string; targetParticipationId: string }>>([]);
  const [reviewer, setReviewer] = useState(snapshot.participants[0]?.participationId ?? "");
  const [target, setTarget] = useState(snapshot.participants.find((item, index) => index > 0 && item.artifacts.length)?.participationId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const run = async (assign: boolean) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const updated = await command({ action: "config", version: config.version, config: { rubric: config.rubric, peerMode: config.peerMode, reviewsPerStudent: config.reviewsPerStudent, anonymous: config.anonymous } });
      setConfig(updated.config);
      if (assign) await command({ action: "assign", ...(config.peerMode === "manual" ? { pairs } : {}) });
      setMessage(assign ? "互评任务已分配，已提交的评价继续保留。" : "评价设置已保存。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "设置保存失败，请刷新后重试。"); }
    finally { setBusy(false); }
  };
  const canConfigure = snapshot.canWrite || snapshot.canConfigureRubric;
  return <div className={styles.root}>
    <section className={styles.section}><h3>评价量规</h3><p className={styles.muted}>{snapshot.canConfigureRubric ? "开课前可调整本场量规，权重合计需为 100%。" : "本场已经开课，评价量规已固定。"}</p>
      {config.rubric.map((dimension, index) => <div className={`${styles.grid} my-4`} key={dimension.id}>
        <label className={styles.field}><span>维度 {index + 1}</span><input disabled={!snapshot.canConfigureRubric} value={dimension.name} onChange={event => setConfig(old => ({ ...old, rubric: old.rubric.map((item, position) => position === index ? { ...item, name: event.target.value } : item) }))} /></label>
        <label className={styles.field}><span>评价说明</span><textarea disabled={!snapshot.canConfigureRubric} value={dimension.description} onChange={event => setConfig(old => ({ ...old, rubric: old.rubric.map((item, position) => position === index ? { ...item, description: event.target.value } : item) }))} /></label>
        <label className={styles.field}><span>权重（%）</span><input type="number" min={1} max={100} disabled={!snapshot.canConfigureRubric} value={dimension.weight} onChange={event => setConfig(old => ({ ...old, rubric: old.rubric.map((item, position) => position === index ? { ...item, weight: Number(event.target.value) } : item) }))} /></label>
      </div>)}
    </section>
    <section className={styles.section}><h3>同伴互评安排</h3><div className={styles.grid}>
      <label className={styles.field}><span>分配方式</span><select disabled={!canConfigure} value={config.peerMode} onChange={event => setConfig(old => ({ ...old, peerMode: event.target.value as PblEvaluationConfig["peerMode"] }))}><option value="off">关闭互评</option><option value="balanced">均衡分配已提交作品</option><option value="presenters-only">仅评价已汇报学生</option><option value="manual">教师手动分配</option></select></label>
      <label className={styles.field}><span>每人评价作品数</span><input disabled={!canConfigure || config.peerMode === "off" || config.peerMode === "manual"} type="number" min={1} max={10} value={config.reviewsPerStudent} onChange={event => setConfig(old => ({ ...old, reviewsPerStudent: Number(event.target.value) }))} /></label>
    </div><label className={styles.check}><input type="checkbox" disabled={!canConfigure} checked={config.anonymous} onChange={event => setConfig(old => ({ ...old, anonymous: event.target.checked }))} />向被评价学生隐藏互评人姓名</label>
    {config.peerMode === "manual" ? <><div className={styles.grid}><label className={styles.field}><span>评价人</span><select value={reviewer} onChange={event => setReviewer(event.target.value)}>{snapshot.participants.map(item => <option key={item.participationId} value={item.participationId}>{item.name}</option>)}</select></label><label className={styles.field}><span>作品作者</span><select value={target} onChange={event => setTarget(event.target.value)}><option value="">选择已有作品的学生</option>{snapshot.participants.filter(item => item.participationId !== reviewer && item.artifacts.length).map(item => <option key={item.participationId} value={item.participationId}>{item.name}</option>)}</select></label></div>
      <button className={`${styles.button} mt-3`} type="button" disabled={!canConfigure || !reviewer || !target || reviewer === target} onClick={() => setPairs(old => old.some(item => item.reviewerParticipationId === reviewer && item.targetParticipationId === target) ? old : [...old, { reviewerParticipationId: reviewer, targetParticipationId: target }])}>加入分配名单</button>
      <ul className={styles.list}>{pairs.map((pair, index) => <li className={styles.listItem} key={`${pair.reviewerParticipationId}:${pair.targetParticipationId}`}>{snapshot.participants.find(item => item.participationId === pair.reviewerParticipationId)?.name} → {snapshot.participants.find(item => item.participationId === pair.targetParticipationId)?.name}<button className={`${styles.button} ml-3`} type="button" onClick={() => setPairs(old => old.filter((_, position) => position !== index))}>移除</button></li>)}</ul>
    </> : null}
    <p className={styles.muted}>互评任务绑定具体作品版本，学生仅能查看分配给自己的作品。已提交任务不会被重新分配覆盖。</p></section>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}{message ? <p className={styles.notice} role="status">{message}</p> : null}
    <div className={styles.actions}><button className={styles.button} type="button" disabled={busy || !canConfigure} onClick={() => void run(false)}>保存设置</button><button className={styles.primary} type="button" disabled={busy || !snapshot.canWrite || config.peerMode === "off" || config.peerMode === "manual" && !pairs.length} onClick={() => void run(true)}>保存并分配互评</button></div>
  </div>;
}

export function TeacherPblEvaluation({ course, presentation = "workspace" }: { course: Course; presentation?: TeacherPresentationMode }) {
  if (presentation !== "workspace") return <div className={styles.root}><header className={styles.header}><div><h2>项目评价</h2><p>请完成个人自评与分配的同伴互评。评价需要引用作品和学习过程中的具体依据。</p></div></header><p className={styles.notice}>教师将结合自评、同伴反馈与 AI 过程报告给出综合评价。</p></div>;
  return <TeacherEvaluationWorkspace course={course} />;
}

type TeacherEvaluationWorkspaceProps = { course: Course; participationId?: string; onEvaluationChange?: (snapshot: PblEvaluationSnapshot) => void };

export function TeacherEvaluationWorkspace(props: TeacherEvaluationWorkspaceProps) {
  return <TeacherEvaluationWorkspaceContent {...props} key={`${props.course.id}:${props.participationId ?? "class"}`} />;
}

function TeacherEvaluationWorkspaceContent({ course, participationId, onEvaluationChange }: TeacherEvaluationWorkspaceProps) {
  const { snapshot, error, refresh, command: runCommand } = useEvaluation(course.id);
  const command = useCallback(async (input: EvaluationInput) => {
    const result = await runCommand(input);
    onEvaluationChange?.(result);
    return result;
  }, [runCommand, onEvaluationChange]);
  const [selectedId, setSelectedId] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedPublish, setSelectedPublish] = useState<string[]>([]);
  const [includeTeacher, setIncludeTeacher] = useState(true);
  const [includeProcess, setIncludeProcess] = useState(true);
  const [publishError, setPublishError] = useState("");
  const [publishStatus, setPublishStatus] = useState("");
  const [publishing, setPublishing] = useState(false);
  const selected = participationId ? snapshot?.participants.find(item => item.participationId === participationId)
    : snapshot?.participants.find(item => item.participationId === selectedId) ?? snapshot?.participants[0];
  const publishIds = participationId ? selected ? [selected.participationId] : [] : selectedPublish;
  const publish = async () => {
    setPublishing(true); setPublishError(""); setPublishStatus("");
    try {
      const result = await command({ action: "publish", participationIds: publishIds, includeTeacher, includeProcess });
      const published = result.participants.filter(item => publishIds.includes(item.participationId) && item.published && item.published.at !== snapshot?.participants.find(previous => previous.participationId === item.participationId)?.published?.at).length;
      setPublishStatus(`已向 ${published} 位学生发布评价结果。${published < publishIds.length ? "其余学生尚无可发布的新结果，请先核对教师定评与过程报告。" : ""}`);
    }
    catch (cause) { setPublishError(cause instanceof Error ? cause.message : "发布失败，请重试。"); }
    finally { setPublishing(false); }
  };
  return <div className={`${styles.root} classroom-stage`}>
    <header className={styles.header}><div><h2>项目评价</h2><p className={styles.muted}>自评、互评、教师评价与 AI 过程报告分别呈现，最终由教师综合定评。</p></div><div className={styles.toolbar}>{!participationId && snapshot ? <EvaluationExport snapshot={snapshot} /> : null}{!participationId ? <button className={styles.button} type="button" disabled={!snapshot} onClick={() => setSettingsOpen(true)}>评价设置与互评分配</button> : null}<button className={styles.button} type="button" onClick={() => void refresh()}>刷新评价</button></div></header>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!snapshot ? !error ? <p className={styles.empty} role="status">正在加载评价记录…</p> : null : <>
      {!participationId ? <div className={styles.metrics}>{[["自评提交", `${snapshot.completion.selfSubmitted}/${snapshot.completion.total}`], ["互评提交", `${snapshot.completion.peerSubmitted}/${snapshot.completion.peerAssigned}`], ["教师定评", `${snapshot.completion.teacherSubmitted}/${snapshot.completion.total}`], ["结果发布", `${snapshot.completion.published}/${snapshot.completion.total}`]].map(([label, value]) => <div className={styles.metric} key={label}><strong>{value}</strong><span>{label}</span></div>)}</div> : null}
      <section className={styles.section}><h3>个人评价档案</h3><div className={styles.toolbar}>{participationId ? <p className="font-semibold">{selected?.name ?? "未找到该学生的评价档案"}</p> : <label className={`${styles.field} min-w-48 flex-1`}><span>选择学生</span><select value={selected?.participationId ?? ""} onChange={event => setSelectedId(event.target.value)}>{snapshot.participants.map(item => <option value={item.participationId} key={item.participationId}>{item.name} · {item.teacherEvaluation?.status === "submitted" ? "已定评" : "待定评"}{item.published ? " · 已发布" : ""}</option>)}</select></label>}{selected ? <ProcessEvaluationEntry course={course} studentId={selected.studentId} /> : null}</div>
      {selected ? <>
        <div className={styles.list}>{selected.artifacts.length ? selected.artifacts.map(artifact => <EvaluationArtifact artifact={artifact} key={artifact.versionId} />) : <p className={styles.empty}>该学生尚未提交作品，可以结合现场表现与真实过程记录评价。</p>}</div>
        <details className={styles.listItem}><summary className="min-h-11 cursor-pointer font-semibold">自评与同伴反馈</summary><EvaluationRecord record={selected.selfEvaluation} title="学生自评" />{snapshot.canWrite ? <ReturnEvaluation record={selected.selfEvaluation} command={command} /> : null}{selected.peerEvaluations.length ? selected.peerEvaluations.map((record, index) => <div key={record.id}><EvaluationRecord record={record} title={`同伴反馈 ${index + 1}`} />{snapshot.canWrite ? <ReturnEvaluation record={record} command={command} /> : null}</div>) : <p className={styles.empty}>尚无同伴反馈。</p>}</details>
        <details className={`${styles.listItem} mt-3`}><summary className="min-h-11 cursor-pointer font-semibold">AI 过程报告{selected.processReport ? " · 已生成" : " · 尚未生成"}</summary><ProcessReport report={selected.processReport} /></details>
        <section className={styles.section}><EvaluationForm key={`teacher:${selected.participationId}`} instanceId={course.id} participationId={selected.participationId} source="teacher" record={selected.teacherEvaluation} rubric={snapshot.config.rubric} canWrite={snapshot.canWrite && (["showcase", "reflection"].includes(snapshot.stage) || course.status === "finished")} canSubmit={snapshot.stage === "reflection" || course.status === "finished"} command={command} refresh={refresh} />{snapshot.canWrite ? <ReturnEvaluation record={selected.teacherEvaluation} command={command} /> : null}</section>
        {selected.published ? <p className={styles.notice}>该学生已收到 {new Date(selected.published.at).toLocaleString("zh-CN")} 发布的结果。后续修订需要再次发布才对学生生效。</p> : null}
      </> : <p className={styles.empty}>{participationId ? "该学生的评价档案暂不可用，请刷新或返回学生名单核对。" : "本场暂无学生。"}</p>}</section>
      <details className={styles.section}><summary className="min-h-11 cursor-pointer text-lg font-semibold">发布评价结果</summary><p className={styles.muted}>{participationId ? "选择需要发布给当前学生的内容。" : "选择学生与需要发布的内容。"}发布后学生可以查看本次结果；后续生成或修订不会自动覆盖已发布内容。</p>
        <div className={styles.toolbar}><label className={styles.check}><input type="checkbox" checked={includeTeacher} onChange={event => setIncludeTeacher(event.target.checked)} />教师定评</label><label className={styles.check}><input type="checkbox" checked={includeProcess} onChange={event => setIncludeProcess(event.target.checked)} />AI 过程报告</label>{!participationId ? <><button className={styles.button} type="button" onClick={() => setSelectedPublish(snapshot.participants.filter(item => (!includeTeacher || item.teacherEvaluation?.status === "submitted") && (!includeProcess || item.processReport)).map(item => item.participationId))}>选择已准备好结果的学生</button><button className={styles.button} type="button" onClick={() => setSelectedPublish([])}>清空选择</button></> : null}</div>
        {!participationId ? <div className={styles.grid}>{snapshot.participants.map(item => <label className={styles.check} key={item.participationId}><input type="checkbox" checked={selectedPublish.includes(item.participationId)} onChange={event => setSelectedPublish(old => event.target.checked ? [...old, item.participationId] : old.filter(id => id !== item.participationId))} />{item.name}{item.published ? " · 已发布" : ""}</label>)}</div> : <p className={styles.muted}>仅向当前学生发布所选内容。</p>}
        {publishError ? <p className={styles.error} role="alert">{publishError}</p> : null}{publishStatus ? <p className={styles.notice} role="status">{publishStatus}</p> : null}
        <button className={`${styles.primary} mt-4`} type="button" disabled={!snapshot.canPublish || publishing || !publishIds.length || !includeTeacher && !includeProcess} onClick={() => void publish()}>{participationId ? "发布给当前学生" : `发布给已选 ${publishIds.length} 人`}</button>
      </details>
      {!participationId && course.platformContext ? <a className={styles.button} href={`/teacher/classes/${encodeURIComponent(course.platformContext.offeringId)}/activities/${encodeURIComponent(course.platformContext.activityId)}/experiment`}>实验拓展 · 前后测配置与结果</a> : null}
      {!participationId ? <TeacherOperationDrawer open={settingsOpen} onOpenChange={setSettingsOpen} title="评价设置与互评分配" description="评价量规在开课前确认；互评可以按本场实际情况安排。">{settingsOpen ? <EvaluationSettings key={course.id} snapshot={snapshot} command={command} /> : null}</TeacherOperationDrawer> : null}
    </>}
  </div>;
}

export function EvaluationWorkspaceEntry({ course }: { course: Course }) {
  const [open, setOpen] = useState(false);
  if (course.evaluationContractVersion !== 2) return null;
  return <><button className={styles.button} type="button" onClick={() => setOpen(true)}>打开项目评价</button><TeacherOperationDrawer open={open} onOpenChange={setOpen} title="项目评价" description="查看个人作品、自评、同伴反馈和过程报告，完成教师定评。">{open ? <TeacherEvaluationWorkspace course={course} /> : null}</TeacherOperationDrawer></>;
}

export function EvaluationSetupEntry({ course }: { course: Course }) {
  const [open, setOpen] = useState(false);
  const { snapshot, error, refresh, command } = useEvaluation(course.id, open);
  if (course.evaluationContractVersion !== 2) return null;
  return <><button className={styles.button} type="button" onClick={() => setOpen(true)}>项目评价设置</button><TeacherOperationDrawer open={open} onOpenChange={setOpen} title="项目评价设置" description="开课前确认本场评价量规。互评任务可在成果汇报后分配。">{error ? <p className={styles.error} role="alert">{error}<button className={styles.button} type="button" onClick={() => void refresh()}>重试</button></p> : null}{open && snapshot ? <EvaluationSettings snapshot={snapshot} command={command} /> : <p className={styles.empty}>正在读取评价设置…</p>}</TeacherOperationDrawer></>;
}
