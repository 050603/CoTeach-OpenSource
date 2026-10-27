import type { Prisma } from "@prisma/client";
import { PlatformError } from "@/lib/platform/platform-error";

type ContentReference = { path: string; messageId: string };
type MessageEntry = { path: string; value: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clone = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/** Only message arrays in the public document protocol are compacted. Model
 * evidence, prepared checkpoints and the structured result stay untouched. */
function messageEntries(response: Record<string, unknown>): MessageEntry[] {
  const groups = [{ path: "messages", messages: response.messages },
    { path: "commentThread.comments", messages: object(response.commentThread).comments },
    ...(Array.isArray(response.commentThreads) ? response.commentThreads.map((thread, index) => ({
      path: `commentThreads.${index}.comments`, messages: object(thread).comments,
    })) : [])];
  return groups.flatMap(group => Array.isArray(group.messages) ? group.messages.flatMap((value, index) => {
    const message = object(value);
    return typeof message.id === "string" ? [{ path: `${group.path}.${index}`, value: message }] : [];
  }) : []);
}

export async function compressDocumentResponse(db: Prisma.TransactionClient, conversationId: string, response: Record<string, unknown>) {
  const saved = clone(response);
  const entries = messageEntries(saved).filter(entry => typeof entry.value.content === "string");
  if (!entries.length) return { schemaVersion: 1, response: saved };
  const messages = await db.aiMessage.findMany({ where: { conversationId,
    id: { in: [...new Set(entries.map(entry => String(entry.value.id)))] } }, select: { id: true, content: true } });
  const byId = new Map(messages.map(message => [message.id, message]));
  const responseContentRefs: ContentReference[] = [];
  for (const entry of entries) {
    const messageId = String(entry.value.id);
    const canonical = byId.get(messageId);
    // Older receipts can include messages whose original row is unavailable.
    // Preserve their inline evidence; never infer an ID from text or timestamps.
    if (!canonical || canonical.content !== entry.value.content) continue;
    delete entry.value.content;
    responseContentRefs.push({ path: entry.path, messageId });
  }
  return responseContentRefs.length ? { schemaVersion: 2, response: saved, responseContentRefs }
    : { schemaVersion: 1, response: saved };
}

export async function hydrateDocumentResponse(db: Prisma.TransactionClient, conversationId: string | null | undefined,
  identity: { courseId: string; studentId: string; participationId: string }, output: unknown) {
  const saved = object(output);
  if (!saved.response || typeof saved.response !== "object" || Array.isArray(saved.response)) return undefined;
  const response = saved.response as Record<string, unknown>;
  if (saved.schemaVersion !== 2 || !Array.isArray(saved.responseContentRefs) || !saved.responseContentRefs.length) return response;
  const missing = () => new PlatformError("REQUEST_RECEIPT_MISSING", "已保存的回答暂时无法读取，请稍后查询或重试。", 503);
  if (!conversationId) throw missing();
  const restored = clone(response);
  const entries = new Map(messageEntries(restored).map(entry => [entry.path, entry.value]));
  const refs = saved.responseContentRefs as ContentReference[];
  if (refs.some(ref => typeof ref.path !== "string" || typeof ref.messageId !== "string"
    || entries.get(ref.path)?.id !== ref.messageId)) throw missing();
  const messages = await db.aiMessage.findMany({ where: { conversationId,
    id: { in: [...new Set(refs.map(ref => ref.messageId))] },
    OR: [{ userId: null }, { userId: identity.studentId }],
    conversation: { userId: identity.studentId, participationId: identity.participationId,
      participation: { instanceId: identity.courseId, enrollment: { userId: identity.studentId } } },
  }, select: { id: true, content: true } });
  const byId = new Map(messages.map(message => [message.id, message]));
  for (const ref of refs) {
    const canonical = byId.get(ref.messageId);
    if (!canonical) throw missing();
    entries.get(ref.path)!.content = canonical.content;
  }
  return restored;
}
