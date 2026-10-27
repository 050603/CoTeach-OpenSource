import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { pblCommandSchema } from "@/lib/evaluation/pbl-policy";
import { getPblEvaluation, mutatePblEvaluation } from "@/lib/evaluation/pbl-service";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  try { return Response.json(await getPblEvaluation(auth.claims, (await context.params).instanceId), { headers }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); console.error("PBL evaluation read failed", error); return jsonError(request, "EVALUATION_UNAVAILABLE", "评价暂时无法读取，请重试", 503); }
}
export async function POST(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  const body = pblCommandSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(request, "INVALID_INPUT", "请检查评价内容、量规及请求版本", 400);
  try { return Response.json(await mutatePblEvaluation(auth.claims, (await context.params).instanceId, body.data), { headers }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); console.error("PBL evaluation write failed", error); return jsonError(request, "EVALUATION_SAVE_FAILED", "评价保存失败，请保留内容并重试", 503); }
}
