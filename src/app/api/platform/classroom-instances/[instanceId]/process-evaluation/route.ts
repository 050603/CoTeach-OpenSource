import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
import { enqueueProcessEvaluation, getProcessEvaluation, requireProcessTeacher } from "@/lib/evaluation/process-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ instanceId: string }> };
const schema = z.object({ participationId: z.string().min(1).max(200).optional() }).strict();
export async function GET(request: Request, context: Context) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try {
    const result = await getProcessEvaluation(auth.claims, (await context.params).instanceId, new URL(request.url).searchParams.get("participationId") ?? undefined);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "PROCESS_READ_FAILED", "过程报告暂时无法读取", 503);
  }
}
export async function POST(request: Request, context: Context) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return jsonError(request, "INVALID_INPUT", "请选择本场学生", 400);
  try {
    const { instanceId } = await context.params;
    await requireProcessTeacher(auth.claims, instanceId);
    const queued = await enqueueProcessEvaluation(instanceId, { ...input.data, immediate: true, retryFailed: true });
    return Response.json({ queued }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "PROCESS_QUEUE_FAILED", "暂时无法准备过程报告，请稍后重试", 503);
  }
}
