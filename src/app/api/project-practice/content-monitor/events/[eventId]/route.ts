import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { updateContentMonitorEvent } from "@/lib/project-practice/content-monitor-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const courseId = z.string().min(1).max(128);
const schema = z.discriminatedUnion("action", [
  z.object({ courseId, action: z.literal("acknowledge") }).strict(),
  z.object({ courseId, action: z.literal("explain"), source: z.enum(["own-draft", "template", "quotation", "ai-assisted", "other"]), explanation: z.string().trim().max(2000) }).strict(),
  z.object({ courseId, action: z.literal("review"), status: z.enum(["reviewed", "dismissed"]), note: z.string().trim().max(2000).optional() }).strict(),
]);
export async function PATCH(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  const { eventId } = await context.params;
  if (!parsed.success || eventId.length > 200) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  try { return Response.json({ event: await updateContentMonitorEvent(auth.claims, eventId, parsed.data) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return legacyAiError(error); }
}
