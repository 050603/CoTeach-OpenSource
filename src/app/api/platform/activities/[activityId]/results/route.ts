import { authenticateRequest } from "@/lib/auth/request-guards";
import { getTeacherActivityResults } from "@/lib/platform/teacher-activity-results";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try {
    return Response.json(await getTeacherActivityResults(auth.claims, (await context.params).activityId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status, error.details);
    return jsonError(request, "ACTIVITY_RESULTS_UNAVAILABLE", "暂时无法读取测评结果", 503);
  }
}
