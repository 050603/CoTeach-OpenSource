import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { getClassroomPosttestAccess, setClassroomPosttestAccess } from "@/lib/platform/experiment-access-service";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const inputSchema = z.object({ status: z.enum(["open", "closed"]), version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) }).strict();
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ instanceId: string }> };

export async function GET(request: Request, context: Context) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try { return Response.json(await getClassroomPosttestAccess(auth.claims, (await context.params).instanceId), { headers }); }
  catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "EXPERIMENT_ACCESS_FAILED", "无法读取后测开放状态", 503);
  }
}

export async function POST(request: Request, context: Context) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查后测开放状态和版本", 400);
  try { return Response.json(await setClassroomPosttestAccess(auth.claims, (await context.params).instanceId, parsed.data), { headers }); }
  catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "EXPERIMENT_ACCESS_FAILED", "无法更新后测开放状态", 503);
  }
}
