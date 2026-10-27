import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentMonitorEvent } from "@/lib/project-practice/content-monitor-contract";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), scope: vi.fn(), reminders: vi.fn(), participations: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ authorizeLegacyAiScope: mocks.scope, legacyAiError: () => Response.json({}, { status: 403 }) }));
vi.mock("@/lib/db/client", () => ({ prisma: { classroomParticipation: { findMany: mocks.participations } } }));
vi.mock("@/lib/ai-collaboration/audit-store", () => ({ listAiInteractionEvents: vi.fn(async () => ({ events: [] })) }));
vi.mock("@/lib/project-practice/versions", () => ({ listProjectDocumentVersions: vi.fn(async () => []) }));
vi.mock("@/lib/companion/server-store", () => ({ loadCompanionState: vi.fn(async () => ({ companionThreads: [] })) }));
vi.mock("@/lib/project-practice/content-monitor-service", async original => ({
  ...await original<typeof import("@/lib/project-practice/content-monitor-service")>(), listContentMonitorEvents: mocks.reminders,
}));
import { GET } from "./route";

const reminder: ContentMonitorEvent = {
  id: "reminder-1", studentId: "student-1", studentName: "学生", createdAt: "2026-10-25T00:00:00.000Z", pastedCharacters: 350,
  excerpt: "需要保护的粘贴片段", requirementQuote: "任务要求原文", reason: "片段已经完成方案比较", status: "dismissed", contentState: "modified",
  studentSource: "own-draft", studentExplanation: "需要保护的学生说明", history: [{ at: "2026-10-25T00:00:01.000Z", actor: "teacher", action: "dismissed", note: "需要保护的教师备注" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ claims: { role: "teacher", sub: "teacher-1" } });
  mocks.scope.mockResolvedValue({ instance: { activity: { title: "项目课堂" } } });
  mocks.participations.mockResolvedValue([{ enrollment: { user: { id: "student-1", displayName: "学生" }, researchKey: "research-1" } }]);
  mocks.reminders.mockResolvedValue({ events: [reminder], pendingCount: 0 });
});

describe("project practice export separates content reminders", () => {
  it.each(["", "&includeContent=false"])("omits reminder prose by default and explicit false (%s), without inflating AI statistics", async query => {
    const response = await GET(new Request(`http://localhost/api/project-practice/export?courseId=course-1&studentId=student-1${query}`));
    expect(response.status).toBe(200);
    const archive = await response.json();
    expect(archive.contentMonitorEvents).toEqual([expect.objectContaining({ id: reminder.id, studentSource: "own-draft", status: "dismissed" })]);
    const text = JSON.stringify(archive);
    for (const hidden of [reminder.excerpt, reminder.requirementQuote, reminder.reason, reminder.studentExplanation!, reminder.history[0].note!]) expect(text).not.toContain(hidden);
    expect(archive.summary).toMatchObject({ conversationCount: 0, interactionTurnCount: 0, interactionMessageCount: 0, auditEventCount: 0, aiModificationCount: 0 });
    expect(archive.auditEvents).toEqual([]);
    expect(archive.interactions).toEqual([]);
  });

  it("includes reminder evidence only with the explicit content switch", async () => {
    const response = await GET(new Request("http://localhost/api/project-practice/export?courseId=course-1&studentId=student-1&includeContent=true"));
    expect((await response.json()).contentMonitorEvents).toEqual([reminder]);
  });

  it("rejects student export before reading any reminders", async () => {
    mocks.auth.mockResolvedValue({ claims: { role: "student", sub: "student-1" } });
    const response = await GET(new Request("http://localhost/api/project-practice/export?courseId=course-1&studentId=student-1"));
    expect(response.status).toBe(403);
    expect(mocks.reminders).not.toHaveBeenCalled();
  });
});
