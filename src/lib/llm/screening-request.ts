import { getCompatThinkingBodyParams, PROVIDERS, type ProviderId } from "@openmaic/lib/ai/providers";

/** Use the existing transport adapters; deployment date suffixes share the catalog model's capability. */
export function screeningThinkingBody(model: string, endpoint: string): Record<string, unknown> {
  const candidates = [model, model.replace(/-\d{4,8}$/, "")];
  for (const candidate of candidates) {
    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      if (!provider.models.some(entry => entry.id === candidate)) continue;
      const body = getCompatThinkingBodyParams(providerId as ProviderId, candidate, { mode: "disabled", effort: "none" }, endpoint);
      if (body) return body;
    }
  }
  return {};
}
