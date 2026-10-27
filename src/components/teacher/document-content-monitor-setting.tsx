"use client";

import { useState } from "react";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import type { Course } from "@/lib/session/types";
import { useSession } from "@/lib/session/store";

export function DocumentContentMonitorSetting({ course, scope }: { course: Course; scope: "course-default" | "classroom" }) {
  const { updateCourse, flushSaves, retrySave, saveState } = useSession();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const enabled = normalizePblCourseConfig(course.pblConfig).documentPasteMonitoringEnabled;
  const readOnly = course.status === "finished" || (scope === "course-default" && Boolean(course.platformContext));

  async function apply(next: boolean) {
    if (saving || readOnly) return;
    setSaving(true); setMessage(""); setFailed(false);
    try {
      if (saveState === "error") await retrySave();
      updateCourse(course.id, { pblConfig: normalizePblCourseConfig({ ...course.pblConfig, documentPasteMonitoringEnabled: next }) });
      if (!await flushSaves()) throw new Error("设置尚未保存，请重试。");
      setMessage(scope === "course-default" ? "默认值已保存；发布后用于选用该版本的新课堂。" : "本场课堂设置已保存。");
    } catch (error) {
      setFailed(true); setMessage(error instanceof Error ? error.message : "设置保存失败，请重试。");
    } finally { setSaving(false); }
  }

  return <div className="space-y-2 text-sm">
    <label className="flex min-h-11 cursor-pointer items-center gap-3 font-semibold text-[var(--pbl-text)]">
      <input type="checkbox" role="switch" className="size-5 accent-[var(--pbl-teacher)]" checked={enabled}
        disabled={saving || readOnly} onChange={event => void apply(event.target.checked)} />
      <span>{scope === "course-default" ? "外部核心内容使用提醒默认开启" : "本场课堂开启外部核心内容使用提醒"}</span>
    </label>
    <p className="text-xs leading-5 text-[var(--pbl-text-muted)]">仅对疑似直接粘贴核心答案的行为提醒并保留核实记录，不自动判定 AI 来源或扣分。经核验的系统 AI 内容、空白模板等不产生提醒记录。</p>
    <p className="text-xs leading-5 text-[var(--pbl-text-muted)]">{scope === "course-default"
      ? "默认关闭。此设置随课程版本发布，新课堂继承后可独立调整，已有课堂不变。"
      : "只影响本场课堂；关闭后停止新增监测，已有提醒记录仍可查看。"}</p>
    {saving ? <p role="status" className="text-xs">正在保存设置…</p> : message ? <p role={failed ? "alert" : "status"} className={`text-xs ${failed ? "text-red-700" : "text-[var(--pbl-text-muted)]"}`}>{message}</p> : null}
    {failed ? <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" onClick={() => void apply(enabled)}>重试保存设置</button> : null}
  </div>;
}
