/** Source-use reminders are observations for review, never authorship or grade evidence. */
export const CONTENT_MONITOR_EVENT_TYPE = "document_content_reminder";
export const CONTENT_MONITOR_QUEUE = "document-content-monitor-v1";
export const CONTENT_MONITOR_POLICY_VERSION = "conservative-core-paste-v1";
export const CONTENT_MONITOR_SINGLE_MIN = 300;
export const CONTENT_MONITOR_WINDOW_MIN = 600;
export const CONTENT_MONITOR_WINDOW_MS = 30_000;
export const CONTENT_MONITOR_MAX_TEXT = 30_000;

export type ContentMonitorSource = "own-draft" | "template" | "quotation" | "ai-assisted" | "other";
export type ContentMonitorEvent = {
  id: string;
  studentId: string;
  studentName: string;
  createdAt: string;
  pastedCharacters: number;
  excerpt: string;
  requirementQuote: string;
  reason: string;
  status: "pending" | "reviewed" | "dismissed";
  studentSource?: ContentMonitorSource;
  studentExplanation?: string;
  acknowledgedAt?: string;
  contentState: "unchanged" | "modified" | "removed" | "unknown";
  history: Array<{ at: string; actor: "student" | "teacher" | "system"; action: string; note?: string }>;
};
export type ContentMonitorFragment = { text: string; beforeText: string; blockId?: string };
export type ContentMonitorCheckInput = {
  courseId: string;
  requestId: string;
  fragments: ContentMonitorFragment[];
  documentText: string;
};
export type ContentMonitorReceipt = {
  requestId: string;
  status: "pending" | "clear" | "flagged" | "incomplete" | "cancelled";
  event?: ContentMonitorEvent;
};
export type ContentMonitorEventAction =
  | { courseId: string; action: "acknowledge" }
  | { courseId: string; action: "explain"; source: ContentMonitorSource; explanation: string }
  | { courseId: string; action: "review"; status: "reviewed" | "dismissed"; note?: string };

export function nonWhitespaceLength(value: string): number {
  return Array.from(value.replace(/\s/gu, "")).length;
}
