"use client";

import { Check, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/browser/copy-text";
import { normalizeInviteCode } from "@/lib/session/invite-code";

export function InviteCodeCard({
  code,
  onRefresh,
  label = "邀请码",
  hint,
  size = "lg",
}: {
  code: string;
  onRefresh?: () => void;
  label?: string;
  hint?: string;
  size?: "lg" | "md";
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await copyTextToClipboard(normalizeInviteCode(code));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <div
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-6 text-center",
      )}
    >
      <div className="text-sm font-semibold text-[var(--pbl-teacher)]">{label}</div>
      <div
        className={cn(
          "mt-3 font-bold tracking-[0.4em] text-[var(--pbl-teacher)]",
          size === "lg" ? "text-[64px] leading-[64px]" : "text-[44px] leading-[44px]",
        )}
      >
        {code.slice(0, 3)} {code.slice(3, 6)}
      </div>
      {hint ? <p className="mt-3 text-sm text-stone-500">{hint}</p> : null}
      <div className="mt-5 flex items-center justify-center gap-3">
        <button
          className="inline-flex min-h-11 items-center gap-2 rounded-[6px] bg-[var(--pbl-student)] px-4 text-sm font-semibold text-white hover:bg-[var(--pbl-student-hover)]"
          onClick={copy}
          type="button"
        >
          {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制邀请码"}
        </button>
        {onRefresh ? (
          <button
            className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-stone-200 bg-white px-4 text-sm font-semibold text-stone-600 hover:bg-stone-50"
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw size={15} /> 重新生成
          </button>
        ) : null}
      </div>
    </div>
  );
}
