"use client";

import { useCallback, useEffect, useState } from "react";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { TeacherExperimentResults } from "./teacher-experiment-results";

type Run = { id: string; runNo: number; status: string };
export function TeacherExperimentExtension({ activityId, offeringId }: { activityId: string; offeringId: string }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await teacherPlatformFetch(`/api/platform/activities/${encodeURIComponent(activityId)}/experiment`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.instances)) throw new Error(data.message ?? "无法读取课堂场次");
      setRuns(data.instances);
      setSelected((current) => data.instances.some((run: Run) => run.id === current) ? current : data.instances[0]?.id ?? "");
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取课堂场次"); }
  }, [activityId]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);
  return <section className="space-y-4 rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 md:p-6" aria-label="实验拓展管理">
    <div><h2 className="text-lg font-semibold">实验拓展管理</h2><p className="mt-2 text-sm text-[var(--pbl-text-muted)]">前测在课前完成，后测在主课堂之外独立开放。题目配置用于后续场次，已有场次继续使用各学生已分配的题目。</p></div>
    {error ? <p role="alert" className="text-sm text-[var(--pbl-danger)]">{error}<button type="button" className="ml-3 min-h-11 underline" onClick={() => void load()}>重试</button></p> : null}
    {runs.length ? <label className="flex flex-wrap items-center gap-3 text-sm">课堂场次<select aria-label="实验拓展课堂场次" className="min-h-11 rounded-lg border border-[var(--pbl-border)] px-3" value={selected} onChange={(event) => setSelected(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>第 {run.runNo} 次 · {run.status.toLowerCase() === "finished" ? "已结束" : run.status.toLowerCase() === "teaching" ? "授课中" : "待开课"}</option>)}</select></label> : !error ? <p className="text-sm text-[var(--pbl-text-muted)]">安排课堂场次后，可在这里开放后测并查看作答。</p> : null}
    {selected ? <TeacherExperimentResults key={selected} instanceId={selected} offeringId={offeringId} /> : null}
  </section>;
}
