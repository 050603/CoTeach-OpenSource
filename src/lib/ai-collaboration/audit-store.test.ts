import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  db: { $queryRaw: vi.fn(), classroomParticipation: { findFirst: vi.fn() }, aiConversation: { findFirst: vi.fn(), upsert: vi.fn() }, aiMessage: { findMany: vi.fn() }, aiInteractionEvent: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (db: unknown) => unknown) => operation(mocks.db) }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn() }));
import { appendAiInteractionEvents, listAiInteractionEvents, loadCourseAiInteractionEvents } from "./audit-store";
const event = { courseId: "instance", studentId: "student", stageKey: "make", conversationId: "editor-logical", source: "sidebar" as const, eventType: "response" as const, actorRole: "ai" as const, content: "建议", requestId: "request" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.classroomParticipation.findFirst.mockResolvedValue({ id: "participation", enrollment: { offeringId: "offering", researchKey: "research" }, instance: { activity: { chapter: { offeringId: "offering" } } } });
  mocks.db.aiConversation.upsert.mockImplementation(({ create }) => Promise.resolve(create));
  mocks.db.aiInteractionEvent.create.mockImplementation(({ data }) => Promise.resolve({ id: "event", createdAt: new Date(), ...data }));
  mocks.db.aiInteractionEvent.findMany.mockResolvedValue([]);
  mocks.db.aiMessage.findMany.mockResolvedValue([]);
});
describe("legacy AI research fact bridge", () => {
  it("resolves logical editor conversation IDs and preserves the legacy response contract", async () => {
    const [result] = await appendAiInteractionEvents([event]);
    expect(result).toMatchObject({ courseId: "instance", studentId: "student", stageKey: "make", conversationId: "editor-logical", actorRole: "ai", content: "建议" });
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ researchKey: "research", offeringId: "offering", participationId: "participation", actor: "assistant", conversationId: expect.stringMatching(/^legacy-ai-conversation:/) }) });
  });
  it("keeps the original occurrence time of a replayed browser event", async () => {
    const [result] = await appendAiInteractionEvents([{ ...event, createdAt: "2026-09-01T01:00:00.000Z" }]);
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ payload: expect.objectContaining({ legacy: expect.objectContaining({ occurredAt: "2026-09-01T01:00:00.000Z" }) }) }) });
    expect(result.payload?.occurredAt).toBe("2026-09-01T01:00:00.000Z");
  });
  it("deduplicates retried request events before any foreign-key writes", async () => {
    await appendAiInteractionEvents([event]);
    const saved = mocks.db.aiInteractionEvent.create.mock.calls[0][0].data;
    mocks.db.aiInteractionEvent.findUnique.mockResolvedValue({ ...saved, id: "event", createdAt: new Date() });
    mocks.db.aiInteractionEvent.create.mockClear(); mocks.db.aiConversation.upsert.mockClear();
    await appendAiInteractionEvents([event]);
    expect(mocks.db.aiInteractionEvent.create).not.toHaveBeenCalled(); expect(mocks.db.aiConversation.upsert).not.toHaveBeenCalled();
  });
  it("rejects AI events without an actual student participation", async () => {
    mocks.db.classroomParticipation.findFirst.mockResolvedValue(null);
    await expect(appendAiInteractionEvents([event])).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
    expect(mocks.db.aiInteractionEvent.create).not.toHaveBeenCalled();
  });
  it("scopes history by participation instance and rejects malformed cursors", async () => {
    await listAiInteractionEvents({ courseId: "instance", studentId: "student", stageKey: "make" });
    expect(mocks.db.aiInteractionEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { participation: { instanceId: "instance" }, userId: "student", payload: { path: ["legacy", "stageKey"], equals: "make" } } }));
    await expect(listAiInteractionEvents({ courseId: "instance", cursor: "invalid" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it("loads all project-practice audit facts into a classroom snapshot in message order", async () => {
    mocks.db.aiInteractionEvent.findMany.mockResolvedValue([
      { id: "student-message", userId: "student", conversationId: "stored-conversation", eventType: "request", actor: "student", content: "如何验证假设？", requestId: "turn-1", payload: { legacy: { stageKey: "make", source: "sidebar", conversationId: "logical-conversation" }, detail: { intent: "discuss" } }, createdAt: new Date("2026-09-01T01:00:00Z") },
      { id: "ai-message", userId: "student", conversationId: "stored-conversation", eventType: "response", actor: "assistant", content: "先列出可测量的指标。", requestId: "turn-1", payload: { legacy: { stageKey: "make", source: "sidebar", conversationId: "logical-conversation" }, detail: { kind: "guidance" } }, createdAt: new Date("2026-09-01T01:00:01Z") },
    ]);

    const events = await loadCourseAiInteractionEvents("instance", mocks.db as never, "student");

    expect(mocks.db.aiInteractionEvent.findMany).toHaveBeenCalledWith({
      where: { participation: { instanceId: "instance" }, userId: "student", payload: { path: ["legacy", "stageKey"], equals: "make" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(events.map(item => [item.conversationId, item.actorRole, item.content])).toEqual([
      ["logical-conversation", "student", "如何验证假设？"],
      ["logical-conversation", "ai", "先列出可测量的指标。"],
    ]);
  });
  it("resolves canonical message text for paged and classroom readers while retaining old inline evidence", async () => {
    const rows = [
      { id: "new", userId: "student", conversationId: "owned", offeringId: "offering", participationId: "participation", eventType: "response", actor: "assistant", content: null, requestId: "request",
        payload: { schemaVersion: 2, legacy: { stageKey: "make" }, detail: { contentRef: "AiMessage", messageId: "message" } }, createdAt: new Date("2026-10-20T00:00:01Z") },
      { id: "old", userId: "student", conversationId: "owned", eventType: "response", actor: "assistant", content: "旧记录正文", payload: {}, createdAt: new Date("2026-10-20T00:00:00Z") },
    ];
    mocks.db.aiInteractionEvent.findMany.mockResolvedValue(rows);
    mocks.db.aiMessage.findMany.mockResolvedValue([{ id: "message", conversationId: "owned", userId: null, content: "完整 canonical 正文",
      conversation: { userId: "student", participationId: "participation", offeringId: "offering" } }]);
    const page = await listAiInteractionEvents({ courseId: "instance", limit: 1 });
    expect(page.events[0].content).toBe("完整 canonical 正文");
    expect(page.nextCursor).toBeDefined();
    expect(mocks.db.aiMessage.findMany).toHaveBeenCalledWith({ where: { OR: [expect.objectContaining({ id: { in: ["message"] }, conversationId: "owned",
      conversation: { userId: "student", participationId: "participation", offeringId: "offering", participation: { instanceId: "instance" } } })] },
    select: { id: true, conversationId: true, userId: true, content: true,
      conversation: { select: { userId: true, participationId: true, offeringId: true } } } });
    expect((await loadCourseAiInteractionEvents("instance", mocks.db as never)).map(event => event.content))
      .toEqual(["完整 canonical 正文", "旧记录正文"]);
  });
  it("marks missing or foreign canonical content without exposing unrelated messages", async () => {
    mocks.db.aiInteractionEvent.findMany.mockResolvedValue([{ id: "new", userId: "student", conversationId: "owned", eventType: "response", actor: "assistant", content: null,
      payload: { schemaVersion: 2, detail: { contentRef: "AiMessage", messageId: "foreign" } }, createdAt: new Date() }]);
    mocks.db.aiMessage.findMany.mockResolvedValue([{ id: "foreign", conversationId: "other-conversation", userId: null, content: "他人的正文" }]);
    const { events } = await listAiInteractionEvents({ courseId: "instance" });
    expect(events[0].content).toBeUndefined();
    expect(events[0].payload).toMatchObject({ messageId: "foreign", contentReferenceMissing: true });
  });
  it("batches canonical message IDs by complete ownership while retaining duplicate audit events and order", async () => {
    const row = (id: string, messageId: string, conversationId = "owned", userId = "student", participationId = "participation", offeringId = "offering") => ({
      id, userId, conversationId, participationId, offeringId, eventType: "response", actor: "assistant", content: null,
      payload: { schemaVersion: 2, legacy: { stageKey: "make" }, detail: { contentRef: "AiMessage", messageId } }, createdAt: new Date("2026-10-20T00:00:00Z"),
    });
    mocks.db.aiInteractionEvent.findMany.mockResolvedValue([
      row("event-1", "message-1"), row("event-2", "message-2"), row("event-3", "message-1"),
      row("event-4", "message-3", "second"),
      row("event-5", "message-4", "owned", "other-student"),
      row("event-6", "message-5", "owned", "student", "other-participation"),
      row("event-7", "message-6", "owned", "student", "participation", "other-offering"),
    ]);
    const message = (id: string, conversationId = "owned", userId = "student", participationId = "participation", offeringId = "offering") => ({
      id, conversationId, userId: null, content: `完整正文 ${id}`, conversation: { userId, participationId, offeringId },
    });
    mocks.db.aiMessage.findMany.mockResolvedValue([
      message("message-1"), message("message-2"), message("message-3", "second"),
      message("message-4", "owned", "other-student"), message("message-5", "owned", "student", "other-participation"),
      message("message-6", "owned", "student", "participation", "other-offering"),
    ]);

    const events = await loadCourseAiInteractionEvents("instance", mocks.db as never);

    const branches = mocks.db.aiMessage.findMany.mock.calls[0][0].where.OR;
    expect(branches).toHaveLength(5);
    expect(branches[0]).toEqual({ id: { in: ["message-1", "message-2"] }, conversationId: "owned",
      conversation: { userId: "student", participationId: "participation", offeringId: "offering", participation: { instanceId: "instance" } } });
    expect(branches.slice(1).map((branch: { id: { in: string[] } }) => branch.id.in)).toEqual([["message-3"], ["message-4"], ["message-5"], ["message-6"]]);
    expect(branches.every((branch: { conversation: { participation: { instanceId: string } } }) => branch.conversation.participation.instanceId === "instance")).toBe(true);
    expect(events.map(item => [item.id, item.content])).toEqual([
      ["event-1", "完整正文 message-1"], ["event-2", "完整正文 message-2"], ["event-3", "完整正文 message-1"],
      ["event-4", "完整正文 message-3"], ["event-5", "完整正文 message-4"], ["event-6", "完整正文 message-5"], ["event-7", "完整正文 message-6"],
    ]);
  });
  it.each([
    ["conversation", { conversationId: "foreign-course-conversation" }],
    ["message author", { userId: "other-student" }],
    ["conversation owner", { conversation: { userId: "other-student", participationId: "participation", offeringId: "offering" } }],
    ["classroom participation", { conversation: { userId: "student", participationId: "foreign-course-participation", offeringId: "offering" } }],
    ["offering", { conversation: { userId: "student", participationId: "participation", offeringId: "other-offering" } }],
  ])("still rejects a canonical reference with a mismatching %s after batching", async (_label, mismatch) => {
    mocks.db.aiInteractionEvent.findMany.mockResolvedValue([{ id: "event", userId: "student", conversationId: "owned", participationId: "participation", offeringId: "offering", eventType: "response", actor: "assistant", content: null,
      payload: { schemaVersion: 2, detail: { contentRef: "AiMessage", messageId: "foreign" } }, createdAt: new Date("2026-10-20T00:00:00Z") }]);
    mocks.db.aiMessage.findMany.mockResolvedValue([{ id: "foreign", conversationId: "owned", userId: null, content: "不得暴露的正文",
      conversation: { userId: "student", participationId: "participation", offeringId: "offering" }, ...mismatch }]);

    const events = await loadCourseAiInteractionEvents("instance", mocks.db as never);

    expect(events[0].content).toBeUndefined();
    expect(events[0].payload?.contentReferenceMissing).toBe(true);
    expect(mocks.db.aiMessage.findMany.mock.calls[0][0].where.OR[0].conversation.participation).toEqual({ instanceId: "instance" });
  });
});
