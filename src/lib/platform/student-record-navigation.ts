import type { OfferingStudentSummary, StudentAttentionReason } from "./student-records";

export type DetailTab = "progress" | "submissions" | "classrooms" | "account";
export type StudentRecordNavigation = {
  query: string;
  activityId: string;
  status: "all" | "not_started" | "in_progress" | "completed";
  attention: "all" | "participated" | StudentAttentionReason;
  sort: "recent" | "name" | "completion";
  page: number;
  student: string | null;
  tab: DetailTab;
  view: "list" | "detail";
};
export const STUDENT_PAGE_SIZE = 20;
export const defaultStudentNavigation: StudentRecordNavigation = {
  query: "", activityId: "all", status: "all", attention: "all", sort: "recent", page: 1,
  student: null, tab: "progress", view: "list",
};
function choice<T extends string>(value: string | null, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? value as T : fallback;
}
export function readStudentNavigation(params: Pick<URLSearchParams, "get">): StudentRecordNavigation {
  const page = Number(params.get("page") ?? 1);
  const student = params.get("student") || null;
  return {
    query: params.get("q") ?? "", activityId: params.get("activity") || "all",
    status: choice(params.get("status"), ["all", "not_started", "in_progress", "completed"], "all"),
    attention: choice(params.get("attention"), ["all", "participated", "not_participated", "incomplete_open_activity", "pending_teacher_evaluation"], "all"),
    sort: choice(params.get("sort"), ["recent", "name", "completion"], "recent"),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    student, tab: choice(params.get("tab"), ["progress", "submissions", "classrooms", "account"], "progress"),
    view: student && params.get("view") !== "list" ? "detail" : "list",
  };
}
export function studentNavigationQuery(state: StudentRecordNavigation): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.activityId !== "all") params.set("activity", state.activityId);
  if (state.status !== "all") params.set("status", state.status);
  if (state.attention !== "all") params.set("attention", state.attention);
  if (state.sort !== "recent") params.set("sort", state.sort);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.student) params.set("student", state.student);
  if (state.tab !== "progress") params.set("tab", state.tab);
  if (state.student && state.view === "list") params.set("view", "list");
  return params.toString();
}
export function filterStudentRecords(students: OfferingStudentSummary[], state: StudentRecordNavigation) {
  const query = state.query.trim().toLocaleLowerCase("zh-CN");
  return students.filter(student => {
    if (query && !`${student.displayName} ${student.username}`.toLocaleLowerCase("zh-CN").includes(query)) return false;
    if (state.attention === "participated" && !student.participated) return false;
    if (state.attention !== "all" && state.attention !== "participated" && !student.attentionReasons.includes(state.attention)) return false;
    const status = state.activityId === "all"
      ? !student.participated ? "not_started" : student.openActivityCount > 0 && student.completedOpenActivities === student.openActivityCount ? "completed" : "in_progress"
      : student.activityStatuses[state.activityId] ?? "not_started";
    return state.status === "all" || status === state.status;
  }).sort((a, b) => {
    const byName = () => a.displayName.localeCompare(b.displayName, "zh-CN") || a.enrollmentId.localeCompare(b.enrollmentId);
    if (state.sort === "name") return byName();
    if (state.sort === "completion") return (b.openActivityCount ? b.completedOpenActivities / b.openActivityCount : -1)
      - (a.openActivityCount ? a.completedOpenActivities / a.openActivityCount : -1) || byName();
    return (Date.parse(b.lastLearningAt ?? "") || 0) - (Date.parse(a.lastLearningAt ?? "") || 0) || byName();
  });
}
/** A deep-linked student owns its page; page buttons explicitly choose the next page's first student. */
export function resolveStudentSelection(students: OfferingStudentSummary[], state: StudentRecordNavigation) {
  const pageCount = Math.max(1, Math.ceil(students.length / STUDENT_PAGE_SIZE));
  const selectedIndex = students.findIndex(student => student.enrollmentId === state.student);
  const page = selectedIndex >= 0 ? Math.floor(selectedIndex / STUDENT_PAGE_SIZE) + 1 : Math.min(state.page, pageCount);
  const visible = students.slice((page - 1) * STUDENT_PAGE_SIZE, page * STUDENT_PAGE_SIZE);
  const selected = selectedIndex >= 0 ? students[selectedIndex] : visible[0] ?? null;
  return { page, pageCount, visible, selected, index: selected ? students.indexOf(selected) : -1 };
}
