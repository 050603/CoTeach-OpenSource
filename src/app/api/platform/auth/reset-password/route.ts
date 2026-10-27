import { z } from "zod";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";
import { readPasswordResetCookie } from "@/lib/auth/password-reset-cookie";
import { completeStudentPasswordReset } from "@/lib/platform/student-password-recovery";
import { PlatformError } from "@/lib/platform/platform-error";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH) }).strict();

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const ipLimit = await checkDistributedRateLimit({ namespace: "student-reset-ip", key: getClientIp(request), limit: 120, windowSeconds: 600 });
  if (!ipLimit.allowed) return rateLimitedResponse(ipLimit.retryAfterMs);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", `请重新申请密码重置；${PASSWORD_LENGTH_HINT}`, 400);
  const token = readPasswordResetCookie(request);
  if (!token) return jsonError(request, "RESET_REQUEST_INVALID", "请在提交申请的浏览器中完成重置", 400);
  const limit = await checkDistributedRateLimit({ namespace: "student-reset-browser", key: token, limit: 5, windowSeconds: 600 });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
  try {
    return Response.json(await completeStudentPasswordReset(token, parsed.data.password), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "RESET_FAILED", "暂时无法重置密码，请稍后重试", 503);
  }
}
