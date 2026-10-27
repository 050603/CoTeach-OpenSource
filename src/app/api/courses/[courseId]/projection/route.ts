import { withReadApiBoundary, readApiOptions, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";
import { getProjectionState } from "@/lib/courses/http-realtime-read-handlers";
import { dispatchCourseRead } from "@/lib/courses/course-read-worker-pool";
import { withHttpMetrics } from "@/lib/observability/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withReadApiBoundary(withHttpMetrics(
  "GET", "/api/courses/:courseId/projection",
  async (request: Request, context: { params: Promise<{ courseId: string }> }) => {
    const { courseId } = await context.params;
    return await dispatchCourseRead("projection", request, courseId) ?? getProjectionState(request, context);
  },
));
export const OPTIONS = readApiOptions;
export const POST = readApiMethodNotAllowed;
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
export const DELETE = readApiMethodNotAllowed;
