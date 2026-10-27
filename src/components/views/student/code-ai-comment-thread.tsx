"use client";

import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  LoaderCircle,
  MessageSquareText,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type { CodeAiCommentThread } from "@/lib/ai-collaboration/code-comment-types";
import type { CodeAiChangeSet } from "@/lib/ai-collaboration/code-policy";
import { cn } from "@/lib/utils";

type Props = {
  busy: boolean;
  changeSet: CodeAiChangeSet | null;
  draft: string;
  error: string | null;
  positionTop: number;
  previewChangeIndex: number;
  siblingCount: number;
  siblingIndex: number;
  thread: CodeAiCommentThread;
  onAcceptChangeSet: () => void;
  onChangeDraft: (value: string) => void;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  onPreviewChange: (index: number) => void;
  onRejectChangeSet: () => void;
  onRequestEdit: () => void;
  onSubmit: () => void;
};

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function CodeAiCommentThreadPanel({
  busy,
  changeSet,
  draft,
  error,
  positionTop,
  previewChangeIndex,
  siblingCount,
  siblingIndex,
  thread,
  onAcceptChangeSet,
  onChangeDraft,
  onClose,
  onNavigate,
  onPreviewChange,
  onRejectChangeSet,
  onRequestEdit,
  onSubmit,
}: Props) {
  return (
    <section
      aria-label={`AI 代码批注：${thread.title}`}
      className="absolute right-3 z-40 flex max-h-[min(34rem,calc(100%-1.5rem))] w-[min(390px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_18px_60px_-20px_rgba(28,25,23,0.48)]"
      style={{ top: positionTop }}
    >
      <header className="shrink-0 border-b border-stone-200 bg-white px-3.5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className={cn(
              "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg",
              thread.severity === "error"
                ? "bg-rose-50 text-rose-700"
                : thread.severity === "warning"
                  ? "bg-amber-50 text-amber-700"
                  : "bg-sky-50 text-sky-700",
            )}>
              <MessageSquareText size={16} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[10px] font-medium text-stone-500">
                {thread.filePath} · 第 {thread.startLine}{thread.endLine === thread.startLine ? "" : `-${thread.endLine}`} 行
              </p>
              <h3 className="mt-0.5 text-sm font-semibold leading-5 text-stone-950">{thread.title}</h3>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {siblingCount > 1 ? (
              <>
                <button aria-label="上一条批注" className="grid size-7 place-items-center rounded-md text-stone-500 hover:bg-stone-100" onClick={() => onNavigate(-1)} type="button"><ChevronLeft size={14} /></button>
                <span className="min-w-9 text-center text-[10px] text-stone-500">{siblingIndex + 1}/{siblingCount}</span>
                <button aria-label="下一条批注" className="grid size-7 place-items-center rounded-md text-stone-500 hover:bg-stone-100" onClick={() => onNavigate(1)} type="button"><ChevronRight size={14} /></button>
              </>
            ) : null}
            <button aria-label={changeSet ? "收起修改说明，仍可从顶部决定是否采用" : "关闭代码批注"} className="grid size-7 place-items-center rounded-md text-stone-500 hover:bg-stone-100" onClick={onClose} title={changeSet ? "收起后可在差异视图顶部重新打开" : "关闭批注"} type="button"><X size={15} /></button>
          </div>
        </div>
        {thread.quotedCode ? (
          <pre className="mt-2.5 max-h-24 overflow-auto rounded-lg bg-stone-950 px-3 py-2 font-mono text-[10px] leading-4 text-stone-200">{thread.quotedCode}</pre>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-stone-50/70 p-3.5" aria-live="polite">
        {thread.comments.map((comment) => (
          <article
            className={cn(
              "max-w-[94%] rounded-xl border px-3 py-2.5 text-xs leading-5 shadow-sm",
              comment.role === "student"
                ? "ml-auto rounded-br-sm border-stone-800 bg-stone-900 text-white"
                : "rounded-bl-sm border-stone-200 bg-white text-stone-700",
            )}
            key={comment.id}
          >
            <div className={cn("mb-1 flex items-center justify-between gap-3 text-[9px]", comment.role === "student" ? "text-stone-300" : "text-stone-500")}>
              <span className="inline-flex items-center gap-1">{comment.role === "student" ? "我" : <><Bot size={10} />AI 组员</>}</span>
              <time>{timeLabel(comment.createdAt)}</time>
            </div>
            <p className="whitespace-pre-wrap">{comment.content}</p>
          </article>
        ))}

        {busy ? (
          <div className="inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-xs text-stone-500 shadow-sm"><LoaderCircle className="animate-spin" size={13} />正在结合这处代码和运行结果思考…</div>
        ) : null}

        {changeSet ? (
          <section className="overflow-hidden rounded-xl border border-sky-200 bg-white shadow-sm">
            <div className="border-b border-sky-100 bg-sky-50 px-3 py-2.5">
              <p className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-sky-800"><FileDiff size={13} />局部修改建议 · 等待确认</p>
              <h4 className="mt-1 text-xs font-semibold text-stone-950">{changeSet.title}</h4>
              <p className="mt-1 text-[10px] leading-4 text-stone-600">{changeSet.summary}</p>
            </div>
            <div className="p-3">
              <div className="space-y-1.5">
                {changeSet.changes.map((change, index) => (
                  <button className={cn("flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left", previewChangeIndex === index ? "border-sky-300 bg-sky-50" : "border-stone-200 hover:bg-stone-50")} key={change.filePath} onClick={() => onPreviewChange(index)} type="button">
                    <span className="truncate font-mono text-[10px] text-stone-800">{change.filePath}</span>
                    <span className="ml-2 shrink-0 text-[9px] font-medium text-stone-500">{change.operation === "create" ? "新增" : change.operation === "delete" ? "删除" : "修改"}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-4 text-stone-500">主编辑区已显示红绿差异，确认前不会写入代码。</p>
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <button className="rounded-lg border border-stone-300 px-2.5 py-2 text-[10px] font-semibold text-stone-700 hover:bg-stone-50" onClick={onRejectChangeSet} type="button">保留原代码</button>
                <button className="inline-flex items-center justify-center gap-1 rounded-lg bg-stone-950 px-2.5 py-2 text-[10px] font-semibold text-white hover:bg-stone-800" onClick={onAcceptChangeSet} type="button"><CheckCircle2 size={12} />接受修改</button>
              </div>
            </div>
          </section>
        ) : null}
      </div>

      <form className="shrink-0 border-t border-stone-200 bg-white p-3" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        {error ? <p className="mb-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">{error}</p> : null}
        {!changeSet && !draft ? (
          <button className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-2.5 py-1.5 text-[10px] font-medium text-stone-600 hover:bg-stone-50" disabled={busy} onClick={onRequestEdit} type="button"><Sparkles size={11} />请提出局部修改</button>
        ) : null}
        <div className="flex items-end gap-2 rounded-xl border border-stone-300 bg-white p-2 focus-within:border-stone-500 focus-within:ring-2 focus-within:ring-stone-100">
          <textarea
            className="max-h-28 min-h-12 flex-1 resize-none bg-transparent px-1 text-xs leading-5 text-stone-900 outline-none placeholder:text-stone-400"
            disabled={busy || Boolean(changeSet)}
            maxLength={1600}
            onChange={(event) => onChangeDraft(event.target.value)}
            placeholder="回复 AI 组员，或让它针对这处代码提出修改…"
            value={draft}
          />
          <button aria-label="发送批注回复" className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-950 text-white disabled:opacity-35" disabled={busy || Boolean(changeSet) || !draft.trim()} type="submit"><Send size={13} /></button>
        </div>
      </form>
    </section>
  );
}
