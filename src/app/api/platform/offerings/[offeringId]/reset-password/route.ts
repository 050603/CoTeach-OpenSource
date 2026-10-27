import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { getTeacherStudentPasswordResetRequest, updateTeacherStudentPasswordResetRequest } from "@/lib/platform/student-password-recovery";
import { PlatformError } from "@/lib/platform/platform-error";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ enrollmentId: z.string().trim().min(1), requestId: z.string().trim().min(1), action: z.enum(["approve", "cancel"]) }).strict();
type Context = { params: Promise<{ offeringId: string }> };

export async function GET(request: Request, context: Context) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const enrollmentId = new URL(request.url).searchParams.get("enrollmentId");
  if (!enrollmentId) return jsonError(request, "INVALID_INPUT", "请先选择学生", 400);
  try {
    return Response.json({ request: await getTeacherStudentPasswordResetRequest(auth.claims, (await context.params).offeringId, enrollmentId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "RESET_REQUEST_FAILED", "暂时无法查看重置申请", 503);
  }
}

export async function POST(request: Request, context: Context) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请选择当前学生的重置申请", 400);
  try {
    const { enrollmentId, requestId, action } = parsed.data;
    const result = await updateTeacherStudentPasswordResetRequest(auth.claims, (await context.params).offeringId, enrollmentId, requestId, action);
    return Response.json({ request: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "RESET_REQUEST_FAILED", "暂时无法处理重置申请", 503);
  }
}
