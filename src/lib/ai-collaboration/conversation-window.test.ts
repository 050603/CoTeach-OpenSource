import { describe, expect, it } from "vitest";
import type { CompanionMessage } from "@/lib/session/types";
import {
  LEGACY_CONVERSATION_ID,
  MODEL_HISTORY_MAX_CHARS,
  MODEL_HISTORY_MAX_MESSAGES,
  activeConversationId,
  modelConversationHistory,
  visibleConversationMessages,
} from "./conversation-window";

function message(input: Partial<CompanionMessage> & Pick<CompanionMessage, "id" | "role">): CompanionMessage {
  return {
    content: input.id,
    createdAt: "2026-08-25T00:00:00.000Z",
    visibility: "student-and-teacher",
    ...input,
  };
}

describe("AI collaboration conversation window", () => {
  it("keeps legacy messages current until a reset marker starts a new conversation", () => {
    const messages = [
      message({ id: "old", role: "student" }),
      message({
        id: "reset",
        role: "system-trigger",
        triggerKind: "conversation-reset",
        conversationId: "conversation-2",
        visibility: "teacher-only",
      }),
      message({ id: "new", role: "agent", conversationId: "conversation-2" }),
    ];
    expect(activeConversationId(messages)).toBe("conversation-2");
    expect(visibleConversationMessages(messages, "conversation-2").map((item) => item.id))
      .toEqual(["new"]);
    expect(visibleConversationMessages(messages, LEGACY_CONVERSATION_ID).map((item) => item.id))
      .toEqual(["old"]);
  });

  it("retains soft-deleted records but excludes them from UI and model context", () => {
    const messages = [
      message({ id: "visible", role: "student", conversationId: "current" }),
      message({
        id: "deleted",
        role: "agent",
        conversationId: "current",
        hiddenFromStudentAt: "2026-08-25T01:00:00.000Z",
        excludedFromAiAt: "2026-08-25T01:00:00.000Z",
      }),
    ];
    expect(visibleConversationMessages(messages, "current").map((item) => item.id))
      .toEqual(["visible"]);
    expect(modelConversationHistory(messages, "current").map((item) => item.content))
      .toEqual(["visible"]);
    expect(messages).toHaveLength(2);
  });

  it("uses only the newest bounded model context", () => {
    const messages = Array.from({ length: 12 }, (_, index) => message({
      id: `message-${index}`,
      role: index % 2 ? "agent" : "student",
      content: "字".repeat(700),
      conversationId: "current",
    }));
    const history = modelConversationHistory(messages, "current");
    expect(history.length).toBeLessThanOrEqual(MODEL_HISTORY_MAX_MESSAGES);
    expect(history.reduce((sum, item) => sum + item.content.length, 0))
      .toBeLessThanOrEqual(MODEL_HISTORY_MAX_CHARS);
    expect(history.at(-1)?.role).toBe("assistant");
  });
});
