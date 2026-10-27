import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AiInteractionEvent } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  loadAiEvents: vi.fn(),
}));
vi.mock("@/lib/ai-collaboration/audit-read", () => ({ loadCourseAiInteractionEvents: mocks.loadAiEvents }));
vi.mock("@/lib/companion/server-store", () => ({ loadCompanionState: vi.fn(async () => ({})) }));
vi.mock("@/lib/showcase/state", () => ({ loadShowcaseState: vi.fn(async () => ({})) }));
vi.mock("@/lib/project-practice/versions", () => ({ listProjectDocumentVersions: vi.fn(async () => []) }));

import { loadInstanceCourse } from "./v2-course-projection";
import { createPblTemplateCourse, encodePblTemplate } from "@/lib/platform/pbl-template";

describe("V2 classroom AI evidence readback", () => {
  it.each([undefined, false, true])("reads monitoring only from the run override %s", async (monitoring) => {
    const template = createPblTemplateCourse("template");
    template.pblConfig!.documentPasteMonitoringEnabled = true;
    const now = new Date("2026-09-01T01:00:00Z");
    const instance = {
      id: "instance", createdAt: now, updatedAt: now, status: "TEACHING",
      runtimeConfig: monitoring === undefined ? {} : { documentPasteMonitoringEnabled: monitoring },
      templateVersionId: "version", templateVersion: { templateId: "template", snapshot: encodePblTemplate(template) },
      activityId: "activity", activity: { title: "Project", config: {}, chapter: { offeringId: "offering", offering: { invitations: [] } } },
      participations: [],
    };
    mocks.loadAiEvents.mockResolvedValue([]);
    const empty = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const db = new Proxy({}, { get: (_, name) => typeof name === "symbol" || name === "then" ? undefined
      : name === "classroomInstance" ? { findUnique: vi.fn(async () => instance) } : empty }) as Prisma.TransactionClient;
    expect((await loadInstanceCourse("instance", db))?.pblConfig?.documentPasteMonitoringEnabled).toBe(monitoring === true);
  });
  it.each([undefined, 2].flatMap(contractVersion => [undefined, "student"].map(studentId => ({ contractVersion, studentId }))))("keeps the general projection scoped for $contractVersion / $studentId", async ({ contractVersion, studentId }) => {
    const event: AiInteractionEvent = {
      id: "event-1", courseId: "instance", studentId: "student", stageKey: "make",
      conversationId: "conversation", source: "sidebar", eventType: "request",
      actorRole: "student", content: "如何验证？", createdAt: "2026-09-01T01:00:00Z",
    };
    mocks.loadAiEvents.mockResolvedValue([event]);
    const now = new Date("2026-09-01T01:00:00Z");
    const instance = {
      id: "instance", createdAt: now, updatedAt: now, status: "TEACHING", runtimeConfig: contractVersion ? { evaluationContractVersion: contractVersion, posttestAccess: { status: "closed", version: 0 } } : {},
      templateVersionId: "version", templateVersion: { templateId: "template", snapshot: {} },
      activityId: "activity", activity: {
        title: "Project", config: {}, chapter: { offeringId: "offering", offering: { invitations: [] } },
      },
      participations: [],
    };
    const empty = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const reflectionView = { id: "new-reflection", courseId: "instance", studentId: "student", studentName: "学生",
      improvementPlan: "补充验证", createdAt: now.toISOString(), updatedAt: now.toISOString() };
    const oldReflection = { ...reflectionView, id: "old-reflection", content: "旧反思正文" };
    const newFeedback = { id: "new-feedback", content: "新格式教师反馈" };
    const oldFeedback = { id: "old-feedback", content: "旧格式教师反馈" };
    const outcomes = {
      reflection: { findMany: vi.fn(async () => [
        { id: reflectionView.id, participationId: "participation", content: "新反思正文", metadata: { collection: "reflections", view: reflectionView }, createdAt: now, updatedAt: now },
        { id: oldReflection.id, participationId: "participation", content: oldReflection.content, metadata: { collection: "reflections", view: oldReflection }, createdAt: now, updatedAt: now },
      ]) },
      evaluation: { findMany: vi.fn(async () => [
        { metadata: { schemaVersion: 2, collection: "feedback" }, result: newFeedback },
        { metadata: { collection: "feedback", view: oldFeedback }, result: null },
        { metadata: { contractVersion: 2 }, result: { id: "unpublished", source: "teacher", privateContent: "unpublished PBL grade" } },
      ]) },
    };
    const supports = { findMany: vi.fn(async () => [{ type: "PBL_PROCESS_REPORT", structuredPayload: { summary: "unpublished PBL report", evidence: [{ content: "private report evidence" }] } }]) };
    const db = new Proxy({}, {
      get: (_, name) => typeof name === "symbol" || name === "then"
        ? undefined
        : name === "classroomInstance" ? { findUnique: vi.fn(async () => instance) }
          : name === "aiSupportRecord" ? supports : name === "reflection" || name === "evaluation" ? outcomes[name] : empty,
    }) as Prisma.TransactionClient;

    const course = await loadInstanceCourse("instance", db, studentId ? { studentId } : undefined);

    expect(mocks.loadAiEvents).toHaveBeenCalledWith("instance", db, studentId);
    expect(course?.aiInteractionEvents).toEqual([event]);
    expect(course?.reflections).toEqual([{ ...reflectionView, content: "新反思正文" }, oldReflection]);
    expect(course?.feedback).toEqual([newFeedback, oldFeedback]);
    expect(JSON.stringify(course)).not.toContain("unpublished PBL");
    expect(JSON.stringify(course)).not.toContain("private report evidence");
    expect(course?.evaluationContractVersion).toBe(contractVersion);
    expect(course?.stages[4].view).toBe(contractVersion === 2 ? "pbl-evaluation" : "experiment-posttest");
  });
});
