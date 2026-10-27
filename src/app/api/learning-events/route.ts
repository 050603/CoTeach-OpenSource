import { withReadApiBoundary, readApiOptionsFor, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { ingestClassroomLearningEvents } from "@/lib/learning-analytics/ingest";
import { withHttpMetrics } from "@/lib/observability/http";
import { timeProgress } from "@/lib/observability/progress-request-timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function postLearningEvents(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await timeProgress("learning-auth", () => authenticateRequest(request, "student"));
  if ("response" in auth) return auth.response;
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "INVALID_JSON" }, { status: 400 }); }
  try { return Response.json(await timeProgress("learning-ingest", () => ingestClassroomLearningEvents(auth.claims, body,
    { replay: request.headers.get("X-OpenPBL-Learning-Replay") === "1" }))); }
  catch (error) { return legacyAiError(error); }
}
export const POST = withReadApiBoundary(withHttpMetrics("POST", "/api/learning-events", postLearningEvents));

export const OPTIONS = readApiOptionsFor(["POST"]);
export const GET = readApiMethodNotAllowed;
export const HEAD = readApiMethodNotAllowed;
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
export const DELETE = readApiMethodNotAllowed;
