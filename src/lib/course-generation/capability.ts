export function isBackgroundCourseGenerationEnabled(): boolean {
  const configured = process.env.COURSE_GENERATION_BACKGROUND_ENABLED;
  if (configured === "true") return true;
  if (configured === "false") return false;

  // Workstations stay request-bound by default. Production servers backed by
  // PostgreSQL enable durable generation without exposing technical details.
  return process.env.NODE_ENV === "production" && Boolean(process.env.DATABASE_URL);
}
