import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { getStudentPostTestAssessment, savePostTestDraft, submitPostTestAssessment } from "@/lib/platform/posttest-service";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const answers = z.record(z.string(), z.union([z.string().max(10_000), z.array(z.string().max(300)).max(8)]));
const submissionSchema = z.object({ answers, questionVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const draftSchema = submissionSchema.extend({ currentPage: z.number().int().min(0).max(100), version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) });
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  try {
    return Response.json(await getStudentPostTestAssessment(auth.claims, (await context.params).activityId), { headers });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "POSTTEST_READ_FAILED", "无法读取后测", 503);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = draftSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查后测草稿内容", 400);
  try {
    return Response.json(await savePostTestDraft(auth.claims, (await context.params).activityId, parsed.data), { headers });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "POSTTEST_DRAFT_FAILED", "后测草稿保存失败，请重试", 503);
  }
}

export async function POST(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = submissionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查后测作答内容", 400);
  try {
    return Response.json({ submission: await submitPostTestAssessment(auth.claims, (await context.params).activityId, parsed.data) }, { headers });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "POSTTEST_SUBMISSION_FAILED", "后测提交失败，请稍后重试", 503);
  }
}
