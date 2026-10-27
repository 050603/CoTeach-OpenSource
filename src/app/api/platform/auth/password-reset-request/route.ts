import { z } from "zod";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";
import { passwordResetCookie, readPasswordResetCookie } from "@/lib/auth/password-reset-cookie";
import { createStudentPasswordResetRequest, getStudentPasswordResetRequest, RESET_BROWSER_SECONDS } from "@/lib/platform/student-password-recovery";
import { normalizeUsername } from "@/lib/platform/access";
import { PlatformError } from "@/lib/platform/platform-error";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ username: z.string().trim().min(1).max(64), displayName: z.string().trim().min(1).max(64) }).strict();

export async function GET(request: Request) {
  try {
    return Response.json({ request: await getStudentPasswordResetRequest(readPasswordResetCookie(request)) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError(request, "RESET_UNAVAILABLE", "暂时无法查看重置申请，请稍后重试", 503);
  }
}

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const ipLimit = await checkDistributedRateLimit({ namespace: "student-reset-request-ip", key: getClientIp(request), limit: 120, windowSeconds: 600 });
  if (!ipLimit.allowed) return rateLimitedResponse(ipLimit.retryAfterMs);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请输入学号和姓名", 400);
  const limit = await checkDistributedRateLimit({ namespace: "student-reset-request-account", key: normalizeUsername(parsed.data.username), limit: 5, windowSeconds: 600 });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
  try {
    const result = await createStudentPasswordResetRequest(parsed.data.username, parsed.data.displayName, readPasswordResetCookie(request));
    return Response.json({ request: result.request }, { status: 201, headers: { "Cache-Control": "no-store", "Set-Cookie": passwordResetCookie(result.browserToken, RESET_BROWSER_SECONDS) } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "RESET_REQUEST_FAILED", "暂时无法提交申请，请稍后重试", 503);
  }
}
