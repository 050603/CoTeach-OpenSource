import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { finalizeCodeArtifact } from "@/lib/project-practice/code-finalize";
import { legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { notifyProcessEvaluation } from "@/lib/evaluation/process-notifications";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BodySchema = z.object({ courseId: z.string().min(1).max(128), submissionId: z.string().min(1).max(128), studentId: z.string().min(1).max(128).optional(), stageKey: z.literal("make"), expectedVersion: z.number().int().positive(), requestId: z.string().min(1).max(160), revisionNote: z.string().trim().max(2000).optional() }).strict();
export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: "INVALID_REQUEST", message: "提交参数无效。" }, { status: 400 });
  try {
    const receipt = await runMutationTransaction(tx => finalizeCodeArtifact(tx, auth.claims, body.data), { lowPriorityCourseId: body.data.courseId });
    notifyProcessEvaluation(body.data.courseId, auth.claims.sub, true);
    try { await publishCourseEvent(body.data.courseId, { type: "course-updated", courseId: body.data.courseId, at: new Date().toISOString(), payload: { source: "code-finalized", scope: "student", studentId: auth.claims.sub } }); }
    catch (error) { console.error("[code-finalize] realtime notification failed", error); }
    return Response.json({ ok: true, versionId: receipt.versionId, sequence: receipt.sequence, submittedAt: receipt.submittedAt, submissionVersion: receipt.submissionVersion });
  } catch (error) { return legacyAiError(error); }
}
