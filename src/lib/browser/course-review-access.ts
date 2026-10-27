/** UI preference only: this never grants access or changes learning progress. */
export function courseReviewKey(courseId: string | undefined, studentId: string | undefined, classroomId: string): string | null {
  return courseId && studentId ? `openpbl:course-review:${JSON.stringify([courseId, studentId, classroomId])}` : null;
}

export function courseReviewPages(scenes: ReadonlyArray<{ id: string }>): string {
  return JSON.stringify([...new Set(scenes.map((scene) => scene.id))].sort());
}

export function hasCourseReview(key: string | null, pages: string): boolean {
  try {
    return key !== null && localStorage.getItem(key) === pages;
  } catch {
    return false;
  }
}

export function rememberCourseReview(key: string | null, pages: string): void {
  try {
    if (key !== null) localStorage.setItem(key, pages);
  } catch {
    // Storage may be blocked or full. The mounted player still allows review.
  }
}
