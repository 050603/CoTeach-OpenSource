import { withReadApiBoundary, readApiOptions, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";
import { getCourseState } from "@/lib/courses/http-read-handlers";
import { dispatchCourseRead } from "@/lib/courses/course-read-worker-pool";
import { withHttpMetrics } from "@/lib/observability/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withReadApiBoundary(withHttpMetrics(
  "GET", "/api/courses/:courseId/state",
  async (request: Request, context: { params: Promise<{ courseId: string }> }) => {
    const { courseId } = await context.params;
    return await dispatchCourseRead("state", request, courseId) ?? getCourseState(request, context);
  },
));
export const OPTIONS = readApiOptions;
export const POST = readApiMethodNotAllowed;
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
export const DELETE = readApiMethodNotAllowed;
