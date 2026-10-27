import { withReadApiBoundary, readApiOptionsFor, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";
import { GET as getDocument, POST as postDocument, DELETE as deleteDocument } from "@/lib/ai-collaboration/document-handlers";
import { withHttpMetrics } from "@/lib/observability/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 360;
export const GET = withReadApiBoundary(withHttpMetrics("GET", "/api/ai-collaboration/document", getDocument, {
  operation: request => new URL(request.url).searchParams.has("requestId") ? "ai-background" : "read",
}));
export const POST = withReadApiBoundary(withHttpMetrics("POST", "/api/ai-collaboration/document", postDocument));
export const DELETE = withReadApiBoundary(withHttpMetrics("DELETE", "/api/ai-collaboration/document", deleteDocument));

export const OPTIONS = readApiOptionsFor(["GET", "POST", "DELETE"]);
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
