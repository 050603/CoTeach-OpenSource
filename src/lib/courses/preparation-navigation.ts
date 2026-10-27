export function courseDetailedEditHref(courseId: string): string {
  return `/teacher/prepare/${encodeURIComponent(courseId)}/verify/edit`;
}

export type CourseDetailLocation = {
  view?: string;
  stage?: string;
  section?: string;
  sceneId?: string;
  classroomId?: string;
};

export function courseDetailHref(courseId: string, location: CourseDetailLocation = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(location)) if (value) query.set(key, value);
  return `/teacher/prepare/${encodeURIComponent(courseId)}/preview${query.size ? `?${query}` : ""}`;
}

/** Return links stay within this course's preparation workspace. */
export function resolvePreparationReturnHref(
  value: string | null | undefined,
  courseId: string,
  fallback = courseDetailHref(courseId),
): string {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\\\u0000-\u001f]/.test(value)) return fallback;
  try {
    const url = new URL(value, "https://coteach.local");
    const prefix = `/teacher/prepare/${encodeURIComponent(courseId)}/`;
    const allowed = ["preview", "verify", "verify/edit", "classroom-editor", "resources", "versions"];
    if (url.origin !== "https://coteach.local" || !allowed.some((path) => url.pathname === `${prefix}${path}`)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function courseEditorHref(
  courseId: string,
  kind: "design" | "classroom" | "versions",
  location: { section?: string; sceneId?: string; returnTo?: string } = {},
): string {
  const path = kind === "design" ? "verify/edit" : kind === "classroom" ? "classroom-editor" : "versions";
  const query = new URLSearchParams();
  if (location.section) query.set("section", location.section);
  if (location.sceneId) query.set("sceneId", location.sceneId);
  if (location.returnTo) query.set("returnTo", resolvePreparationReturnHref(location.returnTo, courseId));
  return `/teacher/prepare/${encodeURIComponent(courseId)}/${path}${query.size ? `?${query}` : ""}`;
}

const ACTIVE_GENERATION_STATUSES = new Set([
  "queued",
  "running",
  "review_available",
  "paused",
  "cancelling",
]);

export type CourseLibraryStatus =
  | "published"
  | "completed-unpublished"
  | "incomplete"
  | "generating"
  | "archived";

type CourseLibraryStateInput = {
  archived?: boolean;
  generationStatus?: string | null;
  latestVersionStatus?: string | null;
  generationRun?: {
    scope?: string | null;
    status?: string | null;
  } | null;
};

export function isCourseGenerationActive(status?: string | null): boolean {
  return Boolean(status && ACTIVE_GENERATION_STATUSES.has(status.toLowerCase()));
}

export function courseLibraryStatus(input: CourseLibraryStateInput): CourseLibraryStatus {
  if (input.archived) return "archived";
  if (isCourseGenerationActive(input.generationStatus)) return "generating";
  if (input.latestVersionStatus?.toLowerCase() === "published") return "published";
  if (input.generationRun?.scope === "full-course" && input.generationRun.status === "completed") {
    return "completed-unpublished";
  }
  return "incomplete";
}

export function coursePreparationHref(courseId: string, status: CourseLibraryStatus): string {
  const encodedId = encodeURIComponent(courseId);
  return status === "generating" || status === "incomplete"
    ? `/teacher/prepare/${encodedId}/verify`
    : `/teacher/prepare/${encodedId}/preview`;
}
