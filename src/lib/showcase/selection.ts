import type { ShowcaseData } from "./types";

/** An unsaved legacy queue lists available students; it is not a selected roster. */
export function showcaseSelectedStudentIds(data: Pick<ShowcaseData, "queue" | "queueConfig" | "activePresentation"> | undefined): string[] {
  if (!data) return [];
  const configured = data.queueConfig?.schemaVersion === 2 ? data.queueConfig.selectedStudentIds ?? []
    : data.queueConfig ? data.queue.map((item) => item.studentId)
    : data.queue.filter((item) => ["completed", "evaluating", "presenting", "called", "pending-approval"].includes(item.status)).map((item) => item.studentId);
  const started = data.queue.filter((item) => ["presenting", "completed", "evaluating"].includes(item.status)).map((item) => item.studentId);
  return [...new Set([...configured, ...started, ...(data.activePresentation ? [data.activePresentation.studentId] : [])])];
}
