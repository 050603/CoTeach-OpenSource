import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { CONTENT_MONITOR_MAX_TEXT } from "@/lib/project-practice/content-monitor-contract";
import { ContentMonitorScopeClosed, readContentMonitorCheck, submitContentMonitorCheck } from "@/lib/project-practice/content-monitor-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const identity = { courseId: z.string().min(1).max(128), requestId: z.string().min(1).max(160) };
const inputSchema = z.object({ ...identity,
  fragments: z.array(z.object({ text: z.string().min(1).max(CONTENT_MONITOR_MAX_TEXT), beforeText: z.string().max(CONTENT_MONITOR_MAX_TEXT), blockId: z.string().max(160).optional() }).strict()).min(1).max(64),
  documentText: z.string().max(CONTENT_MONITOR_MAX_TEXT),
}).strict().refine(value => value.fragments.reduce((sum, fragment) => sum + fragment.text.length, 0) <= CONTENT_MONITOR_MAX_TEXT);
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "检测内容超出范围或参数无效。文档可继续编辑保存。" }, { status: 400, headers });
  try { return Response.json(await submitContentMonitorCheck(auth.claims, parsed.data), { headers }); }
  catch (error) {
    if (error instanceof ContentMonitorScopeClosed) return Response.json({ requestId: parsed.data.requestId, status: "cancelled" }, { headers });
    return legacyAiError(error);
  }
}

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = z.object(identity).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  try { return Response.json(await readContentMonitorCheck(auth.claims, parsed.data.courseId, parsed.data.requestId), { headers }); }
  catch (error) { return legacyAiError(error); }
}
