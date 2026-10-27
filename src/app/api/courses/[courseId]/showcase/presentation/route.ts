import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { isDatabaseConfigured } from "@/lib/db/client";
import {
  executeShowcaseAction,
  getShowcaseData,
  ShowcasePresentationError,
  updateShowcaseViewport,
} from "@/lib/showcase/presentation-service";
import type { ShowcaseAction } from "@/lib/showcase/types";
import { withHttpMetrics } from "@/lib/observability/http";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { withReadApiBoundary, readApiOptionsFor, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign"),
    groupId: z.string().min(1).max(128).nullable(),
    studentId: z.string().min(1).max(128).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal("save-queue"),
    orderedStudentIds: z.array(z.string().min(1).max(128)).max(500),
    minutesPerStudent: z.number().finite().int().min(1).max(60),
    selectionMode: z.literal("teacher-selected").optional(),
    selectedStudentIds: z.array(z.string().min(1).max(128)).max(500).optional(),
    presentationSec: z.number().int().min(15).max(3600).optional(),
    discussionSec: z.number().int().min(0).max(1800).optional(),
    transitionSec: z.number().int().min(0).max(600).optional(),
    presenterCount: z.number().int().min(1).max(500).optional(),
  }).strict(),
  z.object({
    action: z.literal("start"),
    studentId: z.string().min(1).max(128),
    artifactKind: z.enum(["document", "pdf"]),
    artifactVersionId: z.string().min(1).max(128),
    displayMode: z.preprocess(
      (value) => value === "document" ? "continuous" : value,
      z.enum(["continuous", "slides"]),
    ).default("continuous"),
    clientId: z.string().min(1).max(128).optional(),
    takeover: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal("take-control"), presentationId: z.string().min(1).max(128), clientId: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal("end"), presentationId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("finish-evaluation"),
    presentationId: z.string().uuid(),
    note: z.string().trim().max(2_000).nullable().optional(),
  }).strict(),
]);

async function getMeasured(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) return Response.json({ code: "DATABASE_REQUIRED", message: "成果汇报需要连接数据库。" }, { status: 503 });
  const { courseId } = await context.params;
  // getShowcaseData performs the live read-access check for every caller.
  try {
    return Response.json(await getShowcaseData(courseId, auth.claims), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return showcaseError(error);
  }
}
export const GET = withReadApiBoundary(withHttpMetrics("GET", "/api/courses/:courseId/showcase/presentation", getMeasured, { operation: "read" }));

async function postMeasured(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) return Response.json({ code: "DATABASE_REQUIRED", message: "成果汇报需要连接数据库。" }, { status: 503 });
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "write"))) return Response.json({ code: "COURSE_LOCKED", message: "课程当前不允许进行汇报操作。" }, { status: 403 });
  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({
      code: "INVALID_ACTION",
      message: "汇报操作参数无效。",
      details: parsed.error.flatten(),
    }, { status: 400 });
  }
  const action = parsed.data as ShowcaseAction;
  const rate = await checkDistributedRateLimit({
    namespace: "showcase-presentation",
    key: `${auth.claims.sub}:${courseId}`,
    limit: 30,
    windowSeconds: 60,
  });
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfterMs);
  try {
    return Response.json(await executeShowcaseAction(courseId, action, auth.claims), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return showcaseError(error);
  }
}
export const POST = withReadApiBoundary(postMeasured);
const ViewportSchema = z.object({
  presentationId: z.string().min(1).max(128),
  clientId: z.string().min(1).max(128),
  controlEpoch: z.number().int().min(1),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  displayMode: z.enum(["continuous", "slides"]).optional(),
  viewState: z.object({
    page: z.number().int().min(1).max(100_000).optional(),
    scrollRatio: z.number().finite().min(0).max(1).optional(),
    blockId: z.string().min(1).max(128).optional(),
    blockOffset: z.number().finite().min(0).max(1).optional(),
    pageOffset: z.number().finite().min(0).max(1).optional(),
  }).strict(),
}).strict();

async function patchViewport(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher") return Response.json({ code: "FORBIDDEN", message: "只有教师可以控制汇报。" }, { status: 403 });
  if (!isDatabaseConfigured()) return Response.json({ code: "DATABASE_REQUIRED", message: "成果汇报需要连接数据库。" }, { status: 503 });
  const { courseId } = await context.params;
  const parsed = ViewportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "INVALID_VIEWPORT", message: "汇报阅读位置无效。" }, { status: 400 });
  const rate = await checkDistributedRateLimit({ namespace: "showcase-viewport", key: `${auth.claims.sub}:${courseId}`, limit: 300, windowSeconds: 60 });
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfterMs);
  try {
    return Response.json(await updateShowcaseViewport(courseId, parsed.data, auth.claims), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return showcaseError(error); }
}
export const PATCH = withReadApiBoundary(patchViewport);
export const OPTIONS = readApiOptionsFor(["GET", "POST", "PATCH"]);
export const PUT = readApiMethodNotAllowed;
export const DELETE = readApiMethodNotAllowed;

function showcaseError(error: unknown): Response {
  if (error instanceof ShowcasePresentationError) {
    return Response.json({ code: error.code, message: error.message }, { status: error.status });
  }
  console.error("[showcase/presentation] request failed", error);
  return Response.json({ code: "SHOWCASE_FAILED", message: "汇报操作未完成，请稍后重试。" }, { status: 500 });
}
