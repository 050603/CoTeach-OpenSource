import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--pbl-bg)] text-[var(--pbl-text)]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-[var(--pbl-ai-soft)] blur-3xl opacity-60" />
      </div>

      <main className="relative mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-16 text-center">
        <span className="grid h-16 w-16 place-items-center rounded-full border-2 border-[var(--pbl-ai-border)] bg-[var(--pbl-surface)] shadow-[var(--shadow-soft)]">
          <Loader2 className="animate-spin text-[var(--pbl-ai)]" size={28} strokeWidth={1.8} />
        </span>
        <p className="font-editorial mt-6 text-lg font-semibold">正在准备课堂内容</p>
        <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">
          AI 伴学小组正在调取学习路径与场景数据
        </p>
      </main>
    </div>
  );
}
