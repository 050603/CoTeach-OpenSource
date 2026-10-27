import { authenticateRequest } from "@/lib/auth/request-guards";
import { getActivityExperimentRuns } from "@/lib/platform/experiment-access-service";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try { return Response.json({ instances: await getActivityExperimentRuns(auth.claims, (await context.params).activityId) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "EXPERIMENT_RUNS_FAILED", "无法读取课堂场次", 503);
  }
}
