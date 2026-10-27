// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), settings: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: () => null }));
vi.mock("@/lib/knowledge-lecture-settings", () => ({
  getKnowledgeLectureTutorSettings: mocks.settings, saveKnowledgeLectureTutorSettings: vi.fn(),
}));
vi.mock("@/lib/courses/knowledge-tutor-tts-config", () => ({ resolveExplanationTtsConfig: mocks.resolve }));
import { GET } from "./route";

const request = (audio = true) => new Request(`http://localhost/api/knowledge-lecture/settings${audio ? "?purpose=audio" : ""}`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ claims: { role: "student", sub: "student-1" } });
  mocks.settings.mockResolvedValue({ ttsSpeed: 1 });
  mocks.resolve.mockResolvedValue({ providerId: "qwen-tts", modelId: "configured-model", voice: "configured-voice", speed: 1,
    apiKey: "private-key", baseUrl: "https://private-provider.example.test" });
});

describe("knowledge tutor audio settings", () => {
  it("returns the effective prepared-explanation selection without credentials when no feature override is saved", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: {
      ttsProviderId: "qwen-tts", ttsModelId: "configured-model", ttsVoice: "configured-voice", ttsSpeed: 1,
    } });
    expect(mocks.resolve).toHaveBeenCalledWith({ ttsSpeed: 1 });
  });

  it("preserves the raw teacher settings contract without resolving audio", async () => {
    mocks.settings.mockResolvedValue({ modelString: "model", ttsSpeed: 1 });
    expect(await (await GET(request(false))).json()).toEqual({ settings: { modelString: "model", ttsSpeed: 1 } });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("uses browser speech only for an explicit saved selection", async () => {
    mocks.settings.mockResolvedValue({ ttsProviderId: "browser-native-tts", ttsVoice: "selected-voice", ttsSpeed: 1.2 });
    mocks.resolve.mockResolvedValue(null);
    expect(await (await GET(request())).json()).toEqual({ settings: {
      ttsProviderId: "browser-native-tts", ttsVoice: "selected-voice", ttsSpeed: 1.2,
    } });
  });

  it.each(["missing", "disabled"])("reports %s configuration without substituting browser speech or exposing secrets", async (failure) => {
    if (failure === "missing") mocks.resolve.mockResolvedValue(null);
    else mocks.resolve.mockRejectedValue(new Error("private-key https://private-provider.example.test"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).not.toHaveProperty("settings");
    expect(JSON.stringify(payload)).not.toContain("private");
  });

  it("authenticates before looking up configuration", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await GET(request())).status).toBe(401);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
