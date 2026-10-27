import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { withReadApiBoundary, readApiMethodNotAllowed, readApiOptionsFor } from "@/lib/auth/read-api-boundary";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { isDatabaseConfigured } from "@/lib/db/client";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { ShowcasePresentationError } from "@/lib/showcase/presentation-service";
import { getShowcaseRecommendations } from "@/lib/showcase/recommendation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ courseId: string }> };

async function handle(request: Request, context: Context, enqueue: boolean) {
  if (enqueue) { const csrf = requireSameOrigin(request); if (csrf) return csrf; }
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) return Response.json({ code: "DATABASE_REQUIRED", message: "汇报推荐需要连接数据库。" }, { status: 503 });
  const { courseId } = await context.params;
  if (enqueue) {
    if (!(await canAccessLegacyCourse(auth.claims, courseId, "write"))) return Response.json({ code: "FORBIDDEN", message: "当前课堂不能启动推荐分析。" }, { status: 403 });
    const rate = await checkDistributedRateLimit({ namespace: "showcase-recommendations", key: `${auth.claims.sub}:${courseId}`, limit: 20, windowSeconds: 60 });
    if (!rate.allowed) return rateLimitedResponse(rate.retryAfterMs);
  }
  try {
    return Response.json(await getShowcaseRecommendations(courseId, auth.claims, enqueue), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ShowcasePresentationError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
    console.error("[showcase/recommendations] request failed", error);
    return Response.json({ code: "RECOMMENDATION_UNAVAILABLE", message: "推荐暂不可用，仍可浏览作品并自行选择学生。" }, { status: 503 });
  }
}

export const GET = withReadApiBoundary((request: Request, context: Context) => handle(request, context, false));
export const POST = withReadApiBoundary((request: Request, context: Context) => handle(request, context, true));
export const OPTIONS = readApiOptionsFor(["GET", "POST"]);
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
export const DELETE = readApiMethodNotAllowed;
