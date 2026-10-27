import { withReadApiBoundary, readApiOptions, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";
import { getCourses } from "@/lib/courses/http-read-handlers";
import { dispatchCourseRead } from "@/lib/courses/course-read-worker-pool";
import { withHttpMetrics } from "@/lib/observability/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withReadApiBoundary(withHttpMetrics("GET", "/api/courses", async request =>
  await dispatchCourseRead("courses", request) ?? getCourses(request)));
export const OPTIONS = readApiOptions;
export const POST = readApiMethodNotAllowed;
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
export const DELETE = readApiMethodNotAllowed;
