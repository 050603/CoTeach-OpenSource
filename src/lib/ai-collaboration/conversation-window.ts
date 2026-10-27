import type { CompanionMessage } from "@/lib/session/types";

export const LEGACY_CONVERSATION_ID = "legacy";
export const MODEL_HISTORY_MAX_MESSAGES = 6;
export const MODEL_HISTORY_MAX_CHARS = 2_400;
const MODEL_HISTORY_MAX_MESSAGE_CHARS = 600;

function belongsToConversation(message: CompanionMessage, conversationId: string): boolean {
  if (conversationId === LEGACY_CONVERSATION_ID) {
    return !message.conversationId || message.conversationId === LEGACY_CONVERSATION_ID;
  }
  return message.conversationId === conversationId;
}

export function activeConversationId(messages: CompanionMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.triggerKind === "conversation-reset" && message.conversationId) {
      return message.conversationId;
    }
  }
  return LEGACY_CONVERSATION_ID;
}

export function visibleConversationMessages(
  messages: CompanionMessage[],
  conversationId: string,
): CompanionMessage[] {
  return messages.filter((message) =>
    belongsToConversation(message, conversationId)
    && !message.hiddenFromStudentAt
    && message.visibility === "student-and-teacher"
    && (message.role === "student" || message.role === "agent"));
}

export function modelConversationHistory(
  messages: CompanionMessage[],
  conversationId: string,
): Array<{ role: "user" | "assistant"; content: string }> {
  const candidates = messages.filter((message) =>
    belongsToConversation(message, conversationId)
    && !message.excludedFromAiAt
    && (message.role === "student" || message.role === "agent"));
  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  let remainingChars = MODEL_HISTORY_MAX_CHARS;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MODEL_HISTORY_MAX_MESSAGES || remainingChars <= 0) break;
    const message = candidates[index];
    const content = message.content.trim().slice(0, Math.min(
      MODEL_HISTORY_MAX_MESSAGE_CHARS,
      remainingChars,
    ));
    if (!content) continue;
    selected.push({
      role: message.role === "student" ? "user" : "assistant",
      content,
    });
    remainingChars -= content.length;
  }

  return selected.reverse();
}
