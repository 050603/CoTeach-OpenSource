"use client";

import { Bot, MessageSquareText, UserRound } from "lucide-react";
import { AiMemberMarkdown } from "@/components/views/student/ai-member-markdown";
import type { ProjectPracticeTurn } from "@/lib/classroom/project-practice-analytics";
import { cn } from "@/lib/utils";

export function ProjectCollaborationTranscript({ turns }: { turns: ProjectPracticeTurn[] }) {
  const displayedTurns = [...turns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.sequence - left.sequence);
  return <div>
      {turns.length ? (
        <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3"><p className="flex items-center gap-2 text-sm font-bold text-stone-800"><MessageSquareText size={16} className="text-blue-600" />学生与 AI 协作对话</p><span className="text-[10px] text-stone-500">按上下文对话轮完整展示</span></div>
          <div className="mt-3 space-y-4 overflow-auto pr-1">
            {displayedTurns.map((turn) => (
              <section className="rounded-xl border border-stone-200 bg-stone-50/70 p-3" key={`${turn.conversationId}-${turn.sequence}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-stone-500">
                  <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-blue-100 px-2 py-0.5 font-semibold text-blue-800">{turn.locationLabel}</span><span>第 {turn.turn} 轮对话 · {turn.messages.length} 条消息</span></div>
                  <time>{new Date(turn.occurredAt).toLocaleString("zh-CN")}</time>
                </div>
                {turn.context?.targetText ? <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-stone-700"><span className="font-semibold text-amber-800">{turn.context.issueType ? `${turn.context.issueType} · ` : ""}批注对象：</span>{turn.context.targetText}</div> : null}
                <div className="mt-3 space-y-2">
                  {turn.messages.map((message) => (
                    <div key={message.id}>
                      <div className={cn(
                        "max-w-[88%] rounded-xl px-3 py-2.5 text-xs leading-5",
                        message.role === "student"
                          ? "ml-auto rounded-br-sm bg-stone-900 text-white"
                          : message.error
                            ? "rounded-bl-sm bg-rose-50 text-rose-700"
                            : "rounded-bl-sm border border-stone-200 bg-white text-stone-800",
                      )}>
                        <p className={cn("mb-1 flex items-center gap-1 text-[10px]", message.role === "student" ? "justify-end text-stone-300" : message.error ? "text-rose-600" : "font-semibold text-blue-700")}>
                          {message.role === "student" ? <><UserRound size={11} />学生</> : <><Bot size={11} />{message.error ? "系统" : "AI 组员"}</>}
                          <time className="ml-1 opacity-70">{new Date(message.occurredAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
                        </p>
                        <div className={cn(message.role === "student" && "[&_a]:text-sky-200 [&_blockquote]:text-stone-200 [&_code]:text-stone-100")}>
                          <AiMemberMarkdown content={message.content} />
                        </div>
                      </div>
                      {message.modification ? <div className="mt-2 rounded-lg border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/70 p-3 text-xs text-stone-900"><div className="flex flex-wrap items-center justify-between gap-2"><strong>AI 修改 · {message.modification.title ?? (message.modification.type === "work-delivery" ? "组员交付" : "局部建议")}</strong><span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold">{message.modification.undoneAt ? "已撤销" : message.modification.decision === "undone" ? "已撤销" : message.modification.decision === "modified" ? "修改后采纳" : message.modification.decision === "adopted" ? "学生已采用" : message.modification.decision === "revision" ? "已退回修改" : message.modification.decision === "rejected" ? "学生未采用" : "等待决定"}</span></div>{message.modification.targetText ? <div className="mt-2 rounded-md bg-rose-50 px-2.5 py-2"><span className="font-semibold text-rose-700">原内容：</span><span className="whitespace-pre-wrap text-stone-700">{message.modification.targetText}</span></div> : null}{message.modification.replacement ? <div className="mt-1.5 rounded-md bg-emerald-50 px-2.5 py-2"><span className="font-semibold text-emerald-700">AI 建议：</span><span className="whitespace-pre-wrap text-stone-700">{message.modification.replacement}</span></div> : null}<ProjectDocumentChanges actions={message.modification.documentActions} />{message.modification.decisionSummary ? <p className="mt-2 text-[11px] text-[var(--pbl-teacher)]">{message.modification.decisionSummary}</p> : null}</div> : null}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : <div className="mt-4 rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">尚无学生与 AI 的协作对话。</div>}
  </div>;
}

/** Read-only document changes, shared by conversations and decision details. */
export function ProjectDocumentChanges({ actions }: { actions?: unknown[] }) {
  const labels: Record<string, string> = { append: "追加内容", "insert-before": "在原文前插入", "insert-after": "在原文后插入", replace: "替换原文", delete: "删除原文", none: "无需写入文档" };
  const changes = (actions ?? []).flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.operation !== "string" || !labels[item.operation]) return [];
    return [{ label: labels[item.operation], target: typeof item.targetText === "string" ? item.targetText : "", content: typeof item.content === "string" ? item.content : "", description: typeof item.description === "string" ? item.description : "" }];
  });
  if (!changes.length) return null;
  return <div className="mt-3 space-y-3">{changes.map((change, index) => <section className="space-y-2 rounded-lg border border-stone-200 bg-white p-3" key={index}>
    <h4 className="font-semibold">{change.label}</h4>
    {change.description ? <AiMemberMarkdown content={change.description} /> : null}
    {change.target ? <div className="rounded-md bg-rose-50 p-2"><strong>原内容：</strong><AiMemberMarkdown content={change.target} /></div> : null}
    {change.content ? <div className="rounded-md bg-emerald-50 p-2"><strong>修改内容：</strong><AiMemberMarkdown content={change.content} /></div> : null}
  </section>)}</div>;
}
