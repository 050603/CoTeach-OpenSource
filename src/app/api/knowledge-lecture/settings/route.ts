import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { resolveExplanationTtsConfig } from "@/lib/courses/knowledge-tutor-tts-config";
import {
  getKnowledgeLectureTutorSettings,
  saveKnowledgeLectureTutorSettings,
} from "@/lib/knowledge-lecture-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const settings = await getKnowledgeLectureTutorSettings();
  if (new URL(request.url).searchParams.get("purpose") === "audio") {
    // Use the same effective provider/model/voice as prepared explanations.
    // Credentials and provider endpoints stay on the server.
    try {
      const config = await resolveExplanationTtsConfig(settings);
      if (config) return Response.json({ settings: {
        ttsProviderId: config.providerId, ttsModelId: config.modelId,
        ttsVoice: config.voice, ttsSpeed: config.speed,
      } });
      if (settings.ttsProviderId === "browser-native-tts") return Response.json({ settings });
      return Response.json({ error: "尚未配置助教语音服务，请联系教师检查语音设置" }, { status: 503 });
    } catch {
      return Response.json({ error: "助教语音配置不可用，请联系教师检查语音设置" }, { status: 503 });
    }
  }
  return Response.json({ settings });
}

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "INVALID_SETTINGS" }, { status: 400 });
  }
  return Response.json({ settings: await saveKnowledgeLectureTutorSettings(body) });
}
