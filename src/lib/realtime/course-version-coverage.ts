export type CourseVersionRange = [number, number];
export const PRIVATE_VERSION_COVERAGE_PROTOCOL = "student-private-versions-v1";
const MAX_COVERED_VERSIONS = 500; // Maximum raw events in one authenticated page.
const validVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Compress exact evidence only. A gap must never be filled with min/max. */
export function courseVersionRanges(versions: number[]): CourseVersionRange[] {
  if (versions.length > MAX_COVERED_VERSIONS) return [];
  const sorted = [...new Set(versions.filter(validVersion))].sort((a, b) => a - b);
  const ranges: CourseVersionRange[] = [];
  for (const version of sorted) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === version) last[1] = version;
    else ranges.push([version, version]);
  }
  return ranges;
}

/** Consume only a contiguous prefix beyond a confirmed snapshot/watermark.
 * Malformed or oversized evidence is unknown and cannot advance anything. */
export function advanceCourseVersionCoverage(confirmed: number, value: unknown): number {
  if (!Number.isSafeInteger(confirmed) || confirmed < 0 || !Array.isArray(value)
    || value.length > MAX_COVERED_VERSIONS) return confirmed;
  let count = 0; let previousEnd = 0;
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2 || !validVersion(range[0]) || !validVersion(range[1])
      || range[1] < range[0] || range[0] <= previousEnd) return confirmed;
    count += range[1] - range[0] + 1;
    if (count > MAX_COVERED_VERSIONS) return confirmed;
    previousEnd = range[1];
  }
  let version = confirmed;
  for (const [start, end] of value as CourseVersionRange[]) {
    if (start > version + 1) break;
    if (end > version) version = end;
  }
  return version;
}

/** These producers update only the author's progress, trajectory/signals,
 * answers or personal tutor state. Generic actions can affect a group even
 * when their notification is student-scoped, so must remain unexplained.
 */
export function isPersonalVersionEvent(eventType: string, source: unknown): boolean {
  return eventType === "UPDATE_STUDENT_PROGRESS"
    || eventType === "KNOWLEDGE_QUIZ_SUBMITTED"
    || eventType === "KNOWLEDGE_QUIZ_GRADED"
    || eventType === "KNOWLEDGE_TUTOR_COMPLETED"
    || (eventType === "UPDATE_COURSE" && source === "learning-events");
}
