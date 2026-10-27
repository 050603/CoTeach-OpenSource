"use client";

import { useState } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { isValidInviteCode, normalizeInviteCode } from "@/lib/session/invite-code";
import { PrimaryButton } from "@/components/ui";

export function JoinClassForm({
  onSubmit,
  busy,
  errorMessage,
  variant = "card",
}: {
  onSubmit: (code: string, name: string) => void;
  busy?: boolean;
  errorMessage?: string;
  variant?: "card" | "bare";
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [localError, setLocalError] = useState<string | undefined>();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = normalizeInviteCode(code);
    if (!isValidInviteCode(normalized)) {
      setLocalError("请输入 6 位有效的邀请码（字母 + 数字）");
      return;
    }
    if (!name.trim()) {
      setLocalError("请输入你的姓名");
      return;
    }
    setLocalError(undefined);
    onSubmit(normalized, name.trim());
  }

  const error = localError ?? errorMessage;

  const formClassName =
    variant === "bare"
      ? "mx-auto flex w-full flex-col gap-5"
      : "mx-auto flex w-full max-w-md flex-col gap-5 rounded-[var(--radius-md)] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-8 shadow-[var(--shadow-raised)]";

  return (
    <form
      className={formClassName}
      onSubmit={submit}
    >
      <div className="text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[var(--pbl-student-soft)] text-[var(--pbl-student)]">
          <KeyRound size={26} />
        </div>
        <h2 className="mt-4 text-[26px] font-bold text-[var(--pbl-text-strong)]">加入课堂</h2>
        <p className="mt-1 text-sm text-[var(--pbl-text-muted)]">
          输入教师提供的邀请码与你的姓名，即可进入课堂
        </p>
      </div>

      <label className="block">
        <span className="mb-2 block text-sm font-semibold text-[var(--pbl-text)]">邀请码</span>
        <input
          className="h-12 w-full rounded-[var(--radius-xs)] border border-[var(--pbl-border-strong)] px-4 text-center text-xl font-bold tracking-[0.4em] text-[var(--pbl-text-strong)] outline-none transition focus:border-[var(--pbl-student)] focus:ring-2 focus:ring-[var(--pbl-student-soft)]"
          maxLength={32}
          onChange={(e) => setCode(
            normalizeInviteCode(e.target.value).replace(/[^A-Z0-9]/g, "").slice(0, 6),
          )}
          placeholder="A2K9QP"
          value={code}
          aria-label="邀请码"
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-semibold text-[var(--pbl-text)]">姓名</span>
        <input
          className="h-12 w-full rounded-[var(--radius-xs)] border border-[var(--pbl-border-strong)] px-4 text-center text-base outline-none transition focus:border-[var(--pbl-student)] focus:ring-2 focus:ring-[var(--pbl-student-soft)]"
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：张同学"
          value={name}
          aria-label="姓名"
        />
      </label>

      {error ? (
        <div className="rounded-[var(--radius-xs)] border border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--pbl-danger)]">
          {error}
        </div>
      ) : null}

      <PrimaryButton className="h-12 w-full justify-center text-base" tone="teal" disabled={busy} type="submit">
        <LogIn size={18} /> {busy ? "加入中..." : "进入课堂"}
      </PrimaryButton>
    </form>
  );
}
