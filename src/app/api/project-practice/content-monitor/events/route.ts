import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { listContentMonitorEvents } from "@/lib/project-practice/content-monitor-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ courseId: z.string().min(1).max(128), studentId: z.string().min(1).max(128).optional(), cursor: z.string().max(200).optional() }).strict();
export async function GET(request: Request) {
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  try { return Response.json(await listContentMonitorEvents(auth.claims, parsed.data), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return legacyAiError(error); }
}
