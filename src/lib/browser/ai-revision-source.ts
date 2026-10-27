import type { AiRevisionSource } from "@/lib/session/types";

/** Capture only the exact editor operation. Unsupported browser crypto leaves attribution unknown. */
export async function createAiRevisionSource(before: string, after: string, source: Pick<AiRevisionSource, "requestId" | "contributionId" | "eventId" | "decisionEventId" | "action">): Promise<AiRevisionSource | undefined> {
  if (before === after || !(source.requestId || source.contributionId || source.eventId)) return undefined;
  try {
    const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const [beforeContentHash, afterContentHash] = await Promise.all([digest(before), digest(after)]);
    return { action: source.action, ...(source.requestId ? { requestId: source.requestId } : {}), ...(source.contributionId ? { contributionId: source.contributionId } : {}), ...(source.eventId ? { eventId: source.eventId } : {}), ...(source.decisionEventId ? { decisionEventId: source.decisionEventId } : {}), beforeContentHash, afterContentHash };
  } catch { return undefined; }
}
