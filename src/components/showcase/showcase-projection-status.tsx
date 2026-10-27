"use client";

import { useCoursePresence } from "@/hooks/use-course-presence";
import { SHOWCASE_RECEIPT_TTL_MS } from "@/lib/showcase/projection-receipt-types";
import type { ShowcasePresentationSnapshot } from "@/lib/session/types";
import { useEffect, useState } from "react";

export function ShowcaseProjectionStatus({ courseId, presentation }: { courseId: string; presentation: ShowcasePresentationSnapshot }) {
  const presence = useCoursePresence({ courseId, role: "teacher" });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 5_000); return () => window.clearInterval(timer); }, []);
  const reports = new Map((presence.showcaseReceipts ?? []).filter(report => report.presentationId === presentation.id
    && report.artifactVersionId === presentation.artifactVersionId && now - report.receivedAt < SHOWCASE_RECEIPT_TTL_MS).map(report => [report.studentId, report]));
  const students = presence.members.filter(member => member.role === "student");
  const ready = students.filter(student => reports.get(student.id)?.status === "ready").length;
  const failed = students.filter(student => reports.get(student.id)?.status === "error");
  const loading = students.filter(student => reports.get(student.id)?.status !== "ready" && reports.get(student.id)?.status !== "error");
  return <details className="relative text-xs" aria-label="学生投屏接收状态">
    <summary className="min-h-11 cursor-pointer content-center whitespace-nowrap" aria-live="polite">投屏已启动 · 作品已打开 {ready}/{students.length}{presence.degraded ? " · 在线状态延迟" : ""}</summary>
    <div className="absolute right-0 top-full z-20 w-72 max-w-[90vw] rounded-lg border border-stone-200 bg-white p-3 text-stone-700 shadow-xl">
      <p>按当前在线学生统计，回执在 45 秒后过期。</p>
      <p className="mt-2">{loading.length} 人加载中／待接收 · {failed.length} 人加载失败</p>
      {loading.length ? <p className="mt-2 break-words">待接收：{loading.map(student => student.name).join("、")}</p> : null}
      {failed.length ? <p className="mt-2 break-words text-rose-700">加载失败：{failed.map(student => student.name).join("、")}</p> : null}
      <button className="mt-2 min-h-11 font-semibold underline" onClick={() => void presence.refresh()} type="button">重新检查接收状态</button>
    </div>
  </details>;
}
