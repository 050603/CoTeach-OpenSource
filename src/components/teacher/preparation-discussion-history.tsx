"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, History, MessageSquare, UserRound } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { PreparationSessionSnapshot } from "@/lib/collaborative-preparation/types";
import { preparationThemeClassName } from "./preparation-shell";
import styles from "./collaborative-preparation.module.css";

export function PreparationDiscussionHistory({ turns, open, onOpenChange }: {
  turns: PreparationSessionSnapshot["turns"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const lastTurnId = turns.at(-1)?.id;
  const [seenTurnId, setSeenTurnId] = useState(lastTurnId);

  function scrollToLatest() {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
    followLatest.current = true;
    setAwayFromLatest(false);
    setSeenTurnId(lastTurnId);
  }
  useEffect(() => {
    if (!open || !followLatest.current) return;
    // Limit scrolling to the record panel; never move the page behind the dialog.
    const frame = requestAnimationFrame(() => {
      if (list.current) list.current.scrollTop = list.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, lastTurnId]);

  const rounds = new Map<string, number>();
  let round = 0;
  for (const turn of turns) {
    if (turn.role === "user") round += 1;
    rounds.set(turn.id, Math.max(1, round));
  }
  return <Dialog open={open} onOpenChange={(next) => {
    if (next) { followLatest.current = true; setAwayFromLatest(false); setSeenTurnId(lastTurnId); }
    onOpenChange(next);
  }}>
    <DialogTrigger asChild><button type="button" className={styles.historyTrigger} disabled={!turns.length}><History size={16} />沟通记录<span>{turns.length}</span></button></DialogTrigger>
    <DialogContent className={`pbl-platform-theme ${preparationThemeClassName} ${styles.historyDialog}`} showCloseButton={false}>
      <div className={styles.historyHeader}><div><DialogTitle>沟通记录</DialogTitle><DialogDescription className="mt-2">按讨论顺序保存。可以回看 AI 的提问和你的回答。</DialogDescription></div><DialogClose asChild><button type="button" className={styles.historyReturn}>返回当前问题</button></DialogClose></div>
      <ol ref={list} className={styles.historyList} aria-label="备课讨论记录" tabIndex={0} onScroll={() => {
        const element = list.current;
        if (!element) return;
        const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        followLatest.current = nearEnd;
        setAwayFromLatest(!nearEnd);
        if (nearEnd) setSeenTurnId(lastTurnId);
      }}>
        {turns.map((turn) => {
          const date = new Date(turn.createdAt);
          const validDate = Number.isFinite(date.getTime());
          return <li key={turn.id} className={styles.historyTurn} data-role={turn.role}>
            <div className={styles.turnMeta}><span>{turn.role === "user" ? <UserRound size={15} /> : <MessageSquare size={15} />}{turn.role === "user" ? "教师 · 你" : "AI 备课伙伴"}</span><span>第 {rounds.get(turn.id)} 轮{validDate && <time dateTime={turn.createdAt} title={date.toLocaleString("zh-CN")}>{date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>}</span></div>
            <p className={styles.turnText}>{turn.content}</p>
            {turn.question && <div className={styles.recordQuestion}><strong>本轮提问</strong><p>{turn.question.prompt}</p>{turn.question.options.length > 0 && <details><summary>查看当时的选项</summary><ul>{turn.question.options.map((option) => <li key={option.id}><strong>{option.label}</strong><p>{option.description}</p></li>)}</ul></details>}</div>}
          </li>;
        })}
      </ol>
      <div className={styles.historyFooter}><span aria-live="polite">{awayFromLatest ? seenTurnId !== lastTurnId ? "有新回复，可回到最新记录查看" : "正在回看之前的讨论" : "已到最新记录"}</span><button type="button" className={styles.historyReturn} onClick={scrollToLatest}><ArrowDown size={16} />回到最新记录</button></div>
    </DialogContent>
  </Dialog>;
}
