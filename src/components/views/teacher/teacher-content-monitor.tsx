"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { teacherOperationStyles } from "@/components/classroom/teacher-operation-details";
import { DocumentContentMonitorSetting } from "@/components/teacher/document-content-monitor-setting";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import type { ContentMonitorEvent, ContentMonitorSource } from "@/lib/project-practice/content-monitor-contract";
import type { ContentMonitorStudentCount } from "@/lib/project-practice/content-monitor-service";
import type { Course } from "@/lib/session/types";

const SOURCE_LABEL: Record<ContentMonitorSource, string> = {
  "own-draft": "自己的已有草稿", template: "模板结构", quotation: "资料引用", "ai-assisted": "AI 辅助", other: "其他来源",
};
const STATUS_LABEL: Record<ContentMonitorEvent["status"], string> = { pending: "待核实", reviewed: "已核实", dismissed: "已排除" };
const CONTENT_LABEL: Record<ContentMonitorEvent["contentState"], string> = { unknown: "尚未核对保存稿", unchanged: "内容仍保留", modified: "之后已修改", removed: "之后已移除" };

type ContentMonitorSnapshot = {
  courseId: string;
  events?: ContentMonitorEvent[];
  pendingCount?: number;
  studentCounts?: ContentMonitorStudentCount[];
  nextCursor?: string;
  error: string;
  loading: boolean;
};

export type TeacherContentMonitorState = Omit<ContentMonitorSnapshot, "courseId"> & {
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
};

/** Shares reminder data between the class summary and its embedded review panel. */
export function useTeacherContentMonitor(course: Course, active = true): TeacherContentMonitorState {
  const [snapshot, setSnapshot] = useState<ContentMonitorSnapshot>();
  const request = useRef<{ courseId: string; enabled: boolean; controller?: AbortController; revision: number }>({
    courseId: course.id, enabled: active, revision: 0,
  });
  const pages = useRef(1);
  const lastVersion = useRef({ courseId: course.id, version: course.version });
  const refresh = useCallback(async () => {
    const state = request.current;
    if (!course.id || state.courseId !== course.id || !state.enabled || document.hidden) return;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const revision = ++state.revision;
    setSnapshot(previous => ({
      ...(previous?.courseId === course.id ? previous : { courseId: course.id, error: "" }), loading: true,
    }));
    try {
      const loaded: ContentMonitorEvent[] = [];
      let nextCursor: string | undefined;
      let pendingCount = 0;
      let studentCounts: ContentMonitorStudentCount[] | undefined;
      for (let page = 0; page < pages.current; page++) {
        const query = new URLSearchParams({ courseId: course.id, ...(nextCursor ? { cursor: nextCursor } : {}) });
        const response = await boundedFetch(`/api/project-practice/content-monitor/events?${query}`, {
          cache: "no-store", signal: controller.signal, headers: { "X-OpenPBL-Role": "teacher" },
        });
        const body = await response.json();
        if (revision !== state.revision || controller.signal.aborted || state.courseId !== course.id) return;
        if (!response.ok) throw new Error(body?.message ?? body?.error?.message ?? "提醒记录读取失败，请重试。");
        if (!Array.isArray(body.events)) throw new Error("提醒记录响应不完整，请重试。");
        loaded.push(...body.events);
        if (page === 0) {
          pendingCount = typeof body.pendingCount === "number" ? body.pendingCount : body.events.filter((event: ContentMonitorEvent) => event.status === "pending").length;
          if (body.studentCounts !== undefined) {
            if (!Array.isArray(body.studentCounts) || !body.studentCounts.every((entry: unknown) => {
              if (!entry || typeof entry !== "object") return false;
              const count = entry as ContentMonitorStudentCount;
              return typeof count.studentId === "string" && !!count.studentId
                && [count.pendingCount, count.reviewedCount, count.dismissedCount].every(value => Number.isSafeInteger(value) && value >= 0);
            }) || new Set(body.studentCounts.map((entry: ContentMonitorStudentCount) => entry.studentId)).size !== body.studentCounts.length) {
              throw new Error("学生提醒汇总响应不完整，请重试。");
            }
            studentCounts = body.studentCounts;
          }
        }
        nextCursor = typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : undefined;
        if (!nextCursor) break;
      }
      if (revision !== state.revision || controller.signal.aborted || state.courseId !== course.id) return;
      setSnapshot({ courseId: course.id, events: Array.from(new Map(loaded.map(event => [event.id, event])).values()), pendingCount, studentCounts, nextCursor, error: "", loading: false });
    } catch (reason) {
      if (revision === state.revision && !controller.signal.aborted && state.courseId === course.id) {
        setSnapshot(previous => ({
          ...(previous?.courseId === course.id ? previous : { courseId: course.id }),
          error: reason instanceof Error ? reason.message : "提醒记录读取失败，请重试。", loading: false,
        }));
      }
    } finally {
      if (revision === state.revision) state.controller = undefined;
    }
  }, [course.id]);

  const loadMore = useCallback(async () => {
    const state = request.current;
    if (state.courseId !== course.id || !state.enabled || state.controller || document.hidden) return;
    pages.current++;
    await refresh();
  }, [course.id, refresh]);

  useEffect(() => {
    const state = request.current;
    if (state.courseId !== course.id) pages.current = 1;
    state.courseId = course.id;
    state.enabled = active;
    const pause = () => { state.controller?.abort(); state.controller = undefined; state.revision++; };
    const onVisible = () => {
      if (!state.enabled) return;
      if (document.hidden) pause();
      else void refresh();
    };
    const first = active ? window.setTimeout(onVisible, 0) : undefined;
    const timer = active ? window.setInterval(() => { if (!document.hidden && !state.controller) void refresh(); }, 8_000) : undefined;
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      state.enabled = false;
      pause();
      window.clearTimeout(first); window.clearInterval(timer);
      window.removeEventListener("focus", onVisible); document.removeEventListener("visibilitychange", onVisible);
    };
  }, [course.id, active, refresh]);

  // A committed classroom event refreshes Course; polling also recovers missed notifications.
  useEffect(() => {
    const previous = lastVersion.current;
    lastVersion.current = { courseId: course.id, version: course.version };
    if (previous.courseId !== course.id || previous.version === course.version || !active) return;
    const timer = window.setTimeout(() => void refresh(), 500);
    return () => window.clearTimeout(timer);
  }, [course.id, course.version, active, refresh]);

  const current = snapshot?.courseId === course.id ? snapshot : undefined;
  return {
    events: current?.events, pendingCount: current?.pendingCount, studentCounts: current?.studentCounts, nextCursor: current?.nextCursor,
    error: current?.error ?? "", loading: active && (current?.loading ?? false), refresh, loadMore,
  };
}

export function TeacherContentMonitorPanel({ course, state, studentId, onStudentChange }: {
  course: Course;
  state: TeacherContentMonitorState;
  studentId?: string;
  onStudentChange?: (id: string) => void;
}) {
  const [selection, setSelection] = useState({ courseId: course.id, studentId: "" });
  const [status, setStatus] = useState<{ courseId: string; value: "all" | ContentMonitorEvent["status"] }>({ courseId: course.id, value: "pending" });
  const studentFilter = studentId ?? (selection.courseId === course.id ? selection.studentId : "");
  const statusFilter = status.courseId === course.id ? status.value : "pending";
  const { events, error, loading, refresh, loadMore, nextCursor } = state;
  const visible = events?.filter(event => (!studentFilter || event.studentId === studentFilter)
    && (statusFilter === "all" || event.status === statusFilter));
  const students = new Map(course.students.map(student => [student.id, student.name]));
  for (const event of events ?? []) if (!students.has(event.studentId)) students.set(event.studentId, event.studentName);
  return <div className="space-y-5">
    <DocumentContentMonitorSetting key={course.id} course={course} scope="classroom" />
    <p className="text-sm text-stone-600">记录供教师结合学生说明核实，不能据此认定 AI 来源，不自动扣分。</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-36 flex-1 text-xs font-semibold">学生
        <select className="mt-1 min-h-11 w-full rounded-lg border bg-white px-3 text-sm" value={studentFilter} onChange={event => {
          setSelection({ courseId: course.id, studentId: event.target.value }); onStudentChange?.(event.target.value);
        }}>
          <option value="">全部学生</option>{Array.from(students, ([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="min-w-32 flex-1 text-xs font-semibold">核实状态
        <select className="mt-1 min-h-11 w-full rounded-lg border bg-white px-3 text-sm" value={statusFilter} onChange={event => setStatus({ courseId: course.id, value: event.target.value as typeof statusFilter })}>
          <option value="pending">待核实</option><option value="all">全部记录</option><option value="reviewed">已核实</option><option value="dismissed">已排除</option>
        </select>
      </label>
      <button className={`${teacherOperationStyles.button} min-h-11`} type="button" onClick={() => void refresh()}><RefreshCw size={16} />刷新记录</button>
    </div>
    {error ? <p role="alert" className="text-sm text-red-700">{error}{events ? " 已保留上次读取的记录。" : ""}</p> : null}
    {!events && !error ? <p role="status" className="text-sm text-stone-500">正在读取提醒记录…</p> : null}
    {visible?.length === 0 ? <p className="text-sm text-stone-500">当前筛选下暂无提醒记录。</p> : null}
    {visible?.map(event => <ContentMonitorRecord key={`${course.id}:${event.id}`} event={event} courseId={course.id} refresh={refresh} />)}
    {nextCursor ? <button className={`${teacherOperationStyles.button} min-h-11`} type="button" disabled={loading}
      onClick={() => void loadMore()}>{loading ? "正在读取…" : "加载更多记录"}</button> : null}
  </div>;
}

function ContentMonitorRecord({ event, courseId, refresh }: { event: ContentMonitorEvent; courseId: string; refresh: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current?.abort(); };
  }, []);
  async function review(status: "reviewed" | "dismissed") {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () => alive.current && !controller.signal.aborted && request.current === controller;
    setSaving(true); setError("");
    try {
      const response = await boundedFetch(`/api/project-practice/content-monitor/events/${encodeURIComponent(event.id)}`, {
        method: "PATCH", signal: controller.signal, headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "teacher" },
        body: JSON.stringify({ courseId, action: "review", status, note: note.trim() || undefined }),
      });
      const body = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(body?.message ?? body?.error?.message ?? "核实结果保存失败，请重试。");
      if (body?.event?.id !== event.id || body.event.status !== status) throw new Error("核实结果回执不完整，请刷新记录后重试。");
      await refresh();
      if (isCurrent()) setNote("");
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "核实结果保存失败，请重试。");
    } finally {
      if (isCurrent()) { request.current = undefined; setSaving(false); }
    }
  }
  const history = event.history.filter(item => item.actor === "teacher" && item.note);
  return <article className="space-y-3 border-t border-stone-200 pt-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-bold">{event.studentName} · {STATUS_LABEL[event.status]}</h3>
      <time className="text-xs text-stone-500" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("zh-CN")}</time>
    </div>
    <p className="text-stone-600">疑似核心内容直接粘贴，来源待核实</p>
    <p className="text-xs text-stone-500">粘贴 {event.pastedCharacters} 字符 · {CONTENT_LABEL[event.contentState]} · {event.acknowledgedAt ? "学生已阅读提醒" : "学生尚未确认阅读"}</p>
    <details>
      <summary className="min-h-11 cursor-pointer py-3 font-semibold">查看核实片段与提醒依据</summary>
      <div className="space-y-3 pb-2">
        <blockquote className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-l-2 border-stone-300 pl-3">{event.excerpt}</blockquote>
        {event.requirementQuote ? <p><strong>对应任务要求：</strong>{event.requirementQuote}</p> : null}
        <p><strong>提醒依据：</strong>{event.reason}</p>
      </div>
    </details>
    <p><strong>学生说明：</strong>{event.studentSource ? `${SOURCE_LABEL[event.studentSource]}；${event.studentExplanation || "尚未补充说明"}` : "尚未提供"}</p>
    {history.map((item, index) => <p key={`${item.at}:${index}`} className="text-stone-600"><strong>教师核实备注：</strong>{item.note}</p>)}
    <label className="block text-xs font-semibold">核实备注（可选）
      <textarea className="mt-1 min-h-20 w-full rounded-lg border border-stone-300 p-3 text-sm font-normal" maxLength={1000} value={note} onChange={change => setNote(change.target.value)} placeholder="结合原文、学生解释与现场交流记录判断" />
    </label>
    <div className="flex flex-wrap gap-2">
      <button className={`${teacherOperationStyles.button} min-h-11`} type="button" disabled={saving} onClick={() => void review("reviewed")}>标记已核实</button>
      <button className={`${teacherOperationStyles.button} min-h-11`} type="button" disabled={saving} onClick={() => void review("dismissed")}>排除这条提醒</button>
    </div>
    {saving ? <p role="status">正在保存核实结果…</p> : null}{error ? <p role="alert" className="text-red-700">{error}</p> : null}
  </article>;
}
