import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => {
  const db = { $queryRaw: vi.fn(), classroomInstance: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() }, courseTeacher: { findFirst: vi.fn() }, experimentAssessmentAssignment: { count: vi.fn() }, domainEvent: { create: vi.fn() }, activity: { findUnique: vi.fn() } };
  return { db, teacher: vi.fn(), transaction: vi.fn(), publish: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("@/lib/platform/access", () => ({ requireTeacherUser: mocks.teacher }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
import { getActivityExperimentRuns, getClassroomPosttestAccess, setClassroomPosttestAccess } from "./experiment-access-service";

const claims = { sub: "teacher", role: "teacher" } as AuthClaims;
const instance = { id: "run", status: "FINISHED", runtimeConfig: { evaluationContractVersion: 2, posttestAccess: { status: "closed", version: 0 }, version: 7, currentStageIndex: 4 },
  activity: { isOpen: true, archivedAt: null, chapter: { offeringId: "offering", isOpen: true, archivedAt: null, offering: { status: "OPEN" } } } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
  mocks.transaction.mockImplementation((operation) => operation(mocks.db));
  mocks.db.classroomInstance.findUnique.mockResolvedValue(instance);
  mocks.db.courseTeacher.findFirst.mockResolvedValue({ id: "teacher-link" });
  mocks.db.experimentAssessmentAssignment.count.mockResolvedValue(2);
});

describe("independent classroom posttest access", () => {
  it("opens a finished V2 classroom without changing its lifecycle or frozen questionnaires", async () => {
    expect(await getClassroomPosttestAccess(claims, "run")).toEqual({ contractVersion: 2, access: { status: "closed", version: 0 } });
    const result = await setClassroomPosttestAccess(claims, "run", { status: "open", version: 0 });
    expect(result.access).toMatchObject({ status: "open", version: 1, openedAt: expect.any(String) });
    expect(mocks.db.classroomInstance.update).toHaveBeenCalledWith({ where: { id: "run" }, data: { runtimeConfig: expect.objectContaining({ evaluationContractVersion: 2, posttestAccess: result.access, version: 8, currentStageIndex: 4 }) } });
    expect(mocks.db.$queryRaw.mock.calls[0][0].join("")).toContain('"ClassroomInstance" WHERE "id" =  FOR UPDATE');
    expect(mocks.db.domainEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: "experiment-posttest-access-changed", actorId: "teacher", classroomInstanceId: "run" }) });
  });
  it("rejects stale teacher controls and never changes a legacy classroom", async () => {
    await expect(setClassroomPosttestAccess(claims, "run", { status: "open", version: 2 })).rejects.toMatchObject({ code: "ASSESSMENT_ACCESS_VERSION_CONFLICT" });
    mocks.db.classroomInstance.findUnique.mockResolvedValue({ ...instance, runtimeConfig: { posttestOpenedAt: "2026-10-01T00:00:00Z" } });
    await expect(setClassroomPosttestAccess(claims, "run", { status: "open", version: 0 })).rejects.toMatchObject({ code: "LEGACY_EXPERIMENT_ACCESS" });
    expect(mocks.db.classroomInstance.update).not.toHaveBeenCalled();
  });
  it("increments the guard on close and reopen while retaining unrelated runtime fields", async () => {
    mocks.db.classroomInstance.findUnique.mockResolvedValue({ ...instance, runtimeConfig: { ...instance.runtimeConfig, posttestAccess: { status: "open", version: 1 } } });
    const closed = await setClassroomPosttestAccess(claims, "run", { status: "closed", version: 1 });
    mocks.db.classroomInstance.findUnique.mockResolvedValue({ ...instance, runtimeConfig: { ...instance.runtimeConfig, posttestAccess: closed.access } });
    const reopened = await setClassroomPosttestAccess(claims, "run", { status: "open", version: 2 });
    expect(reopened.access).toMatchObject({ status: "open", version: 3, closedAt: closed.access.closedAt });
  });
  it("checks teacher ownership before returning access or allowing changes", async () => {
    mocks.db.courseTeacher.findFirst.mockResolvedValue(null);
    await expect(getClassroomPosttestAccess(claims, "run")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setClassroomPosttestAccess(claims, "run", { status: "open", version: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.db.classroomInstance.update).not.toHaveBeenCalled();
  });
  it.each(["offering", "activity", "scheduled", "teaching", "assignment"])("does not bypass the %s opening prerequisite", async (guard) => {
    const changed = structuredClone(instance);
    if (guard === "offering") changed.activity.chapter.offering.status = "FINISHED";
    if (guard === "activity") changed.activity.isOpen = false;
    if (guard === "scheduled") changed.status = "SCHEDULED";
    if (guard === "teaching") changed.status = "TEACHING";
    if (guard === "assignment") mocks.db.experimentAssessmentAssignment.count.mockResolvedValue(0);
    mocks.db.classroomInstance.findUnique.mockResolvedValue(changed);
    await expect(setClassroomPosttestAccess(claims, "run", { status: "open", version: 0 })).rejects.toMatchObject({ code: guard === "assignment" ? "ASSESSMENT_ASSIGNMENT_REQUIRED" : "ASSESSMENT_UNAVAILABLE" });
    expect(mocks.db.classroomInstance.update).not.toHaveBeenCalled();
  });
  it("lists old and new runs without loading any questionnaire snapshots", async () => {
    mocks.db.activity.findUnique.mockResolvedValue({ type: "CLASSROOM", chapter: { offeringId: "offering" } });
    mocks.db.classroomInstance.findMany.mockResolvedValue([{ id: "old", runNo: 1, status: "FINISHED" }]);
    expect(await getActivityExperimentRuns(claims, "activity")).toEqual([{ id: "old", runNo: 1, status: "FINISHED" }]);
    expect(mocks.db.classroomInstance.findMany).toHaveBeenCalledWith({ where: { activityId: "activity" }, orderBy: { runNo: "desc" }, select: { id: true, runNo: true, status: true } });
  });
});
