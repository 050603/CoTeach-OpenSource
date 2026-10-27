"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { emptyPblAnswers, pblWeightedScore, type PblEvaluationAnswers, type PblEvaluationRecord, type PblEvaluationSnapshot, type PblEvaluationSource, type PblRubricDimension } from "@/lib/evaluation/pbl-contract";
import { EvaluationRequestError, type EvaluationInput } from "./use-evaluation";
import { EvaluationRecord } from "./evaluation-record";
import styles from "./evaluation.module.css";

type Props = {
  instanceId: string; participationId: string; assignmentId?: string; source: PblEvaluationSource;
  record: PblEvaluationRecord | null; rubric: PblRubricDimension[]; canWrite: boolean; canSubmit?: boolean;
  command: (input: EvaluationInput) => Promise<PblEvaluationSnapshot>;
  refresh: () => Promise<PblEvaluationSnapshot | undefined>;
};
const sourceLabel = { self: "自评", peer: "同伴互评", teacher: "教师评价" };
function findRecord(snapshot: PblEvaluationSnapshot, props: Pick<Props, "source" | "participationId" | "assignmentId">) {
  if (props.source === "peer") return snapshot.assignments.find(item => item.id === props.assignmentId)?.evaluation ?? null;
  const participant = snapshot.participants.find(item => item.participationId === props.participationId);
  return (props.source === "self" ? participant?.selfEvaluation : participant?.teacherEvaluation) ?? null;
}
function restoredDraft(key: string, record: PblEvaluationRecord | null, rubric: PblRubricDimension[]) {
  const fallback = { answers: record?.answers ?? emptyPblAnswers(rubric), version: record?.version ?? 0 };
  if (record?.status === "submitted" || typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (saved && typeof saved.version === "number" && saved.answers?.dimensionScores && typeof saved.answers.comment === "string") return { answers: { ...emptyPblAnswers(rubric), ...saved.answers } as PblEvaluationAnswers, version: saved.version as number };
  } catch { /* Server autosave remains available when local storage is unavailable. */ }
  return fallback;
}

export function EvaluationForm(props: Props) {
  const { record, source, command, refresh, canWrite } = props;
  const rubric = record?.rubric ?? props.rubric;
  const storageKey = `pbl-evaluation:${props.instanceId}:${props.participationId}:${source}:${props.assignmentId ?? "self"}`;
  const [initial] = useState(() => restoredDraft(storageKey, record, rubric));
  const [answers, setAnswers] = useState(initial.answers);
  const [status, setStatus] = useState<"saved" | "dirty" | "saving" | "error">(JSON.stringify(initial.answers) === JSON.stringify(record?.answers ?? emptyPblAnswers(rubric)) ? "saved" : "dirty");
  const [error, setError] = useState("");
  const [hasSaved, setHasSaved] = useState(Boolean(record));
  const [conflict, setConflict] = useState(initial.version !== (record?.version ?? 0));
  const version = useRef(initial.version);
  const latest = useRef(answers);
  const saved = useRef(JSON.stringify(record?.answers ?? emptyPblAnswers(rubric)));
  const inFlight = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const locator = useRef({ source, participationId: props.participationId, assignmentId: props.assignmentId });
  const locked = !canWrite || record?.status === "submitted";
  const persist = useCallback(async (action: "save" | "submit") => {
    if (inFlight.current) {
      const completed = await inFlight.current;
      if (!completed) return false;
    }
    const content = latest.current;
    if (action === "save" && JSON.stringify(content) === saved.current) return true;
    const run = async () => {
      if (mounted.current) { setStatus("saving"); setError(""); }
      try {
        const snapshot = await command({ action, ...locator.current, version: version.current, answers: content });
        const result = findRecord(snapshot, locator.current);
        if (!result) throw new Error("服务器未返回已保存的评价，请刷新核对。");
        version.current = result.version;
        saved.current = JSON.stringify(content);
        const changed = JSON.stringify(latest.current) !== saved.current;
        try {
          if (changed) sessionStorage.setItem(storageKey, JSON.stringify({ answers: latest.current, version: result.version }));
          else sessionStorage.removeItem(storageKey);
        } catch { /* Acknowledged server writes are authoritative. */ }
        if (mounted.current) { setStatus(changed ? "dirty" : "saved"); setConflict(false); setHasSaved(true); }
        return true;
      } catch (reason) {
        if (mounted.current) {
          setStatus("error");
          setConflict(reason instanceof EvaluationRequestError && reason.status === 409);
          setError(reason instanceof Error ? reason.message : "保存失败，输入仍保留在此页面。");
        }
        return false;
      }
    };
    const promise = run();
    inFlight.current = promise;
    const result = await promise;
    if (inFlight.current === promise) inFlight.current = null;
    return result;
  }, [command, storageKey]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!record || record.version <= version.current || inFlight.current) return;
    if (JSON.stringify(latest.current) !== saved.current) { setConflict(true); return; }
    version.current = record.version;
    latest.current = record.answers;
    saved.current = JSON.stringify(record.answers);
    setAnswers(record.answers);
    setStatus("saved");
  }, [record]);
  useEffect(() => {
    if (locked || conflict || status !== "dirty") return;
    const timer = window.setTimeout(() => void persist("save"), 900);
    return () => window.clearTimeout(timer);
  }, [answers, conflict, locked, persist, status]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(latest.current) === saved.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);

  const change = (patch: Partial<PblEvaluationAnswers>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setAnswers(next);
    setStatus("dirty");
    try { sessionStorage.setItem(storageKey, JSON.stringify({ answers: next, version: version.current })); } catch { /* The pending server save still runs. */ }
  };
  const reload = async () => {
    const snapshot = await refresh();
    if (!snapshot) return;
    const current = findRecord(snapshot, locator.current);
    const next = current?.answers ?? emptyPblAnswers(snapshot.config.rubric);
    version.current = current?.version ?? 0;
    latest.current = next; saved.current = JSON.stringify(next);
    setAnswers(next); setConflict(false); setError(""); setStatus("saved"); setHasSaved(Boolean(current));
    try { sessionStorage.removeItem(storageKey); } catch { /* Nothing to clear. */ }
  };
  if (record?.status === "submitted") return <><p className={styles.notice}>已提交{sourceLabel[source]}，内容已锁定。需要修改时请教师退回修订。</p><EvaluationRecord record={record} title={sourceLabel[source]} /></>;
  const weighted = pblWeightedScore(rubric, answers.dimensionScores);
  const textField = (key: "evidence" | "strengths" | "improvements" | "learning" | "plan" | "comment" | "overrideReason", label: string) => <label className={styles.field} key={key}><span>{label}</span><textarea disabled={locked} required={source === "self" && ["evidence", "learning", "plan"].includes(key) || source === "peer" && ["strengths", "improvements"].includes(key) || source === "teacher" && key === "comment"} value={answers[key]} onChange={event => change({ [key]: event.target.value })} /></label>;
  return <form onSubmit={event => { event.preventDefault(); if (!locked && !conflict && props.canSubmit !== false) void persist("submit"); }}>
    <h3 className="text-lg font-semibold">{sourceLabel[source]}</h3>
    <p className={styles.muted}>根据实际作品和表现评价。缺少依据的维度选“无法判断”，不按 0 分处理。</p>
    {record?.returnedReason ? <p className={styles.notice}>教师修订要求：{record.returnedReason}</p> : null}
    {!canWrite ? <p className={styles.notice}>当前评价暂不可编辑。</p> : null}
    {canWrite && props.canSubmit === false ? <p className={styles.notice}>现在可以保存评价草稿，进入第五阶段后提交教师定评。</p> : null}
    {rubric.map(dimension => <div className={styles.dimension} key={dimension.id}>
      <div><strong>{dimension.name}</strong><span className={styles.muted}> · 权重 {dimension.weight}%</span><p className={styles.muted}>{dimension.description}</p></div>
      <label className={styles.field}><span className="sr-only">{dimension.name}评分</span><input aria-label={`${dimension.name}评分`} type="number" min={0} max={100} step={1} placeholder="无法判断" disabled={locked} value={answers.dimensionScores[dimension.id] ?? ""} onChange={event => change({ dimensionScores: { ...latest.current.dimensionScores, [dimension.id]: event.target.value === "" ? null : Number(event.target.value) } })} /><span className={styles.muted}>0–100 分；留空表示无法判断</span></label>
    </div>)}
    <p className="my-4 font-semibold">量规参考分：{weighted == null ? "有维度无法判断，暂不计算" : `${weighted} 分`}</p>
    <div className={styles.grid}>
      {source === "self" ? <>{textField("evidence", "我的作品与过程证据")}{textField("learning", "我学会了什么")}{textField("plan", "下次准备如何改进")}</> : null}
      {source === "peer" ? <>{textField("strengths", "有依据的优点")}{textField("improvements", "具体改进建议")}</> : null}
      {textField("comment", source === "teacher" ? "教师综合评语" : "补充说明")}
      {source === "teacher" ? <><label className={styles.field}><span>教师定评分数（可留空采用量规分）</span><input type="number" min={0} max={100} step={0.01} disabled={locked} value={answers.finalScore ?? ""} onChange={event => change({ finalScore: event.target.value === "" ? null : Number(event.target.value) })} /></label>{textField("overrideReason", "调整分数的依据")}</> : null}
    </div>
    {conflict ? <div className={styles.error} role="alert"><p>评价已在其他窗口更新。本页输入已保留，请核对后重新载入服务器版本。</p><details><summary>查看本页尚未保存的内容</summary><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(answers, null, 2)}</pre></details><button className={styles.button} type="button" onClick={() => void reload()}>放弃本页改动并载入最新版本</button></div> : error ? <p className={styles.error} role="alert">{error}</p> : null}
    <div className={styles.actions}>
      <span className={styles.muted} role="status">{status === "saving" ? "正在保存…" : status === "dirty" ? "有未保存修改" : status === "error" ? "尚未保存" : hasSaved ? "草稿已保存" : "尚未填写"}</span>
      <button className={styles.button} type="button" disabled={locked || conflict || status === "saving"} onClick={() => void persist("save")}>保存草稿</button>
      <button className={styles.primary} type="submit" disabled={locked || conflict || status === "saving" || props.canSubmit === false}>提交{sourceLabel[source]}</button>
    </div>
  </form>;
}
