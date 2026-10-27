"use client";

import { useEffect, useState } from "react";

import styles from "./ai-member-processing-bubble.module.css";

export function AiMemberProcessingBubble({ recovering = false, phase }: {
  recovering?: boolean;
  phase?: "sending" | "queued" | "running";
}) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => setPageHidden(document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return <div aria-label="AI 组员正在处理" aria-live="polite" aria-atomic="true" className="max-w-[94%] rounded-xl rounded-bl-sm border border-stone-200 bg-white px-3 py-2.5 text-xs text-stone-600" role="status">
    <span className="block text-[10px] font-semibold text-[var(--pbl-ai)]">AI 组员</span>
    <span className="mt-1 inline-flex items-center gap-1">
      <span>{recovering ? "正在查询已保存的回答" : phase === "queued" ? "请求已排队" : phase === "sending" ? "正在发送请求并等待回答" : phase === "running" ? "正在思考并准备回答" : "正在等待 AI 回答"}</span>
      {!reducedMotion ? <span aria-hidden="true" className={styles.dots} data-paused={pageHidden}>
        {[0, 1, 2].map((dot) => <i className={styles.dot} key={dot} />)}
      </span> : <span aria-hidden="true">…</span>}
    </span>
  </div>;
}
