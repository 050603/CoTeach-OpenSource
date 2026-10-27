import { after } from "next/server";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { preparationMutationSchema } from "@/lib/collaborative-preparation/schema";
import { loadPreparationSession, PreparationError, runPreparationTurn, submitPreparationMutation } from "@/lib/collaborative-preparation/server";
import { GenerationReferenceError } from "@/lib/course-design/generation-references";
import { CourseEvidenceError } from "@/lib/textbook/course-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ courseId: string }> };
const headers = { "Cache-Control": "private, no-store" };

async function guarded(request: Request, context: Context, mutate: boolean): Promise<Response> {
  const { courseId } = await context.params;
  const ownerId = await authorizeTemplateRequest(request, courseId);
  if (ownerId instanceof Response) return ownerId;
  try {
    if (!mutate) return Response.json({ session: await loadPreparationSession(courseId, ownerId) }, { headers });
    const parsed = preparationMutationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "PREPARATION_INVALID", detail: parsed.error.issues[0]?.message ?? "备课输入格式不正确。" }, { status: 400, headers });
    if ((request.method === "POST" && parsed.data.action) || (request.method === "PATCH" && !parsed.data.action)) return Response.json({ error: "PREPARATION_INVALID", detail: "备课操作与请求方式不一致。" }, { status: 400, headers });
    const limit = await checkDistributedRateLimit({ namespace: "collaborative-preparation", key: ownerId, limit: 20, windowSeconds: 60 });
    if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
    const result = await submitPreparationMutation(courseId, ownerId, parsed.data);
    if (result.turnId) after(() => runPreparationTurn(result.turnId!));
    return Response.json({ session: result.session }, { status: result.session.status === "processing" ? 202 : 200, headers });
  } catch (error) {
    if (error instanceof PreparationError || error instanceof GenerationReferenceError || error instanceof CourseEvidenceError) return Response.json({ error: error.code, detail: error.message }, { status: error.status, headers });
    console.error("[collaborative-preparation] Request failed", { operation: request.method, error: error instanceof Error ? error.name : "unknown" });
    return Response.json({ error: "PREPARATION_UNAVAILABLE", detail: "备课服务暂时不可用，请稍后重试，已保存内容不会丢失。" }, { status: 503, headers });
  }
}
export async function GET(request: Request, context: Context) { return guarded(request, context, false); }
export async function POST(request: Request, context: Context) { return guarded(request, context, true); }
export async function PATCH(request: Request, context: Context) { return guarded(request, context, true); }
