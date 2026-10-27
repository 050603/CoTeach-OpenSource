"use client";

import { useState } from "react";
import type { ShowcaseAction, ShowcaseData } from "@/lib/showcase/types";
import { PrimaryButton } from "@/components/ui";
import { showcaseSelectedStudentIds } from "@/lib/showcase/selection";

/** Timing settings are separate from the always-visible presenter selection workspace. */
export function ShowcaseSelectionPanel({ data, busy, save }: {
  data: ShowcaseData; busy: boolean; save: (action: ShowcaseAction) => Promise<void>;
}) {
  const config = data.queueConfig;
  const [presentationSec, setPresentationSec] = useState(config?.presentationSec ?? 180);
  const [transitionSec, setTransitionSec] = useState(config?.transitionSec ?? 20);
  const [presenterCount, setPresenterCount] = useState(config?.presenterCount ?? 3);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const selected = showcaseSelectedStudentIds(data);
  async function submit() {
    setMessage(""); setFailed(false);
    try {
      await save({ action: "save-queue", selectionMode: "teacher-selected", selectedStudentIds: selected,
        orderedStudentIds: [...data.queue.map((item) => item.studentId).filter((id) => selected.includes(id)), ...selected.filter((id) => !data.queue.some((item) => item.studentId === id))],
        presentationSec, discussionSec: config?.discussionSec ?? 60, transitionSec, presenterCount,
        minutesPerStudent: Math.min(60, Math.max(1, Math.ceil((presentationSec + transitionSec) / 60))),
      });
      setMessage("人数与时间已保存");
    } catch (caught) { setFailed(true); setMessage(caught instanceof Error ? caught.message : "保存失败，请重试"); }
  }
  return <section aria-label="汇报人数与时间" className="space-y-4">
    <p className="text-sm leading-6 text-stone-600">已选 {selected.length} 人 · 每人汇报与衔接 {presentationSec + transitionSec} 秒 · 完整安排 {selected.length * (presentationSec + transitionSec)} 秒</p>
    {data.budget ? <p className="text-sm text-stone-600">本阶段剩余 {Math.floor(data.budget.stageRemainingSec)} 秒{data.budget.overrunSec ? `，当前安排预计超出 ${data.budget.overrunSec} 秒，可继续安排或调整时长。` : "。"}</p> : null}
    {([ ["目标汇报人数", presenterCount, setPresenterCount, 1, Math.max(100, data.students.length)], ["汇报秒数", presentationSec, setPresentationSec, 15, 3600], ["衔接秒数", transitionSec, setTransitionSec, 0, 600] ] as const).map(([label, value, setter, min, max]) => <label className="block text-sm" key={label}>{label}<input aria-label={label} className="mt-1 min-h-11 w-full rounded-md border border-stone-300 bg-white px-3" type="number" min={min} max={max} value={value} disabled={busy} onChange={(event) => setter(Math.max(min, Math.min(max, Math.round(Number(event.target.value) || min))))} /></label>)}
    <PrimaryButton disabled={busy} onClick={() => void submit()} tone="blue">{busy ? "正在保存…" : "保存人数与时间"}</PrimaryButton>
    {message ? <p className={failed ? "text-sm text-rose-700" : "text-sm text-emerald-700"} role={failed ? "alert" : "status"}>{message}</p> : null}
  </section>;
}
