"use client";

import { useState } from "react";
import { teacherPlatformFetch } from "@/lib/platform/client";
import type { PosttestAccess } from "@/lib/platform/experiment";

export function TeacherPosttestAccessControl({ instanceId, access, onChanged }: { instanceId: string; access: PosttestAccess; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await teacherPlatformFetch(`/api/platform/classroom-instances/${encodeURIComponent(instanceId)}/experiment/access`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: access.status === "open" ? "closed" : "open", version: access.version }),
      });
      const data = await response.json();
      if (!response.ok) { await onChanged(); throw new Error(data.message ?? "无法调整后测开放状态"); }
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法调整后测开放状态"); }
    finally { setBusy(false); }
  }
  return <section className="my-4 rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4" aria-label="实验拓展后测开放管理">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="font-semibold">实验拓展 · 后测{access.status === "open" ? "已开放" : "已关闭"}</p><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">课堂结束后可开放后测，仅完成本场课堂学习的学生可作答。关闭后保留已保存草稿和正式答案，重新开放时学生需重新加载测验。</p></div><button className="min-h-11 rounded-lg border border-[var(--pbl-teacher)] px-4 text-sm font-semibold text-[var(--pbl-teacher)] disabled:opacity-50" disabled={busy} onClick={() => void update()} type="button">{busy ? "正在更新…" : access.status === "open" ? "关闭后测" : "开放后测"}</button></div>
    {error ? <p className="mt-3 text-sm text-[var(--pbl-danger)]" role="alert">{error}</p> : null}
  </section>;
}
