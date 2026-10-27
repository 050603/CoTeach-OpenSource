import { beforeEach, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { ActionEnvelope } from "./contracts";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";

const mocks = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), mutate: vi.fn(), publish: vi.fn(), access: vi.fn(async () => true),
  tx: { domainEvent: { findUnique: vi.fn(), create: vi.fn() }, classroomInstance: { findUnique: vi.fn() } } }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (tx: typeof mocks.tx) => unknown) => operation(mocks.tx) }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock, loadCourse: mocks.load, mutateProjectedCourse: mocks.mutate }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
import { executeCourseAction } from "./action-service";

const claims: AuthClaims = { sub: "teacher", role: "teacher", username: "teacher", displayName: "教师", sv: 1 };
const now = "2026-10-16T00:00:00.000Z";
function fixture() {
  const before = createPblTemplateCourse("course"); before.status = "teaching"; before.currentStageIndex = 1; before.version = 800; before.stageVersion = 4;
  before.stageTransitions = [];
  const envelope: ActionEnvelope = { requestId: "request", expectedVersion: 3, action: { type: "UPDATE_COURSE", payload: { id: before.id,
    patch: { currentStageIndex: 2, stageTransitions: [{ id: "transition", baseStageVersion: before.stageVersion, fromStageKey: before.stages[1]!.key,
      toStageKey: before.stages[2]!.key, gateStatus: "passed", blockers: [], warnings: [], actor: "教师", createdAt: now }],
    uiState: { resourceProjection: null, teacherResourceProjection: null } } } } };
  return { before, envelope };
}
beforeEach(() => { vi.resetAllMocks(); mocks.tx.classroomInstance.findUnique.mockResolvedValue(null); });

it("accepts the confirmed stage command despite newer student versions and replays its exact receipt", async () => {
  const { before, envelope } = fixture(); mocks.load.mockResolvedValue(before); mocks.mutate.mockResolvedValue({ ...before, version: 801 });
  const input = structuredClone(envelope); const ack = await executeCourseAction("course", envelope, claims);
  expect(ack.courseVersion).toBe(801);
  expect(mocks.load.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.lock.mock.invocationCallOrder[0]);
  expect(mocks.mutate).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ type: "UPDATE_COURSE" }), "teacher", { id: "teacher", role: "teacher" }, before, { skipStageReadback: true });
  expect(envelope).toEqual(input);
  mocks.tx.domainEvent.findUnique.mockResolvedValue(mocks.tx.domainEvent.create.mock.calls[0]![0].data);
  before.status = "finished";
  expect(await executeCourseAction("course", envelope, claims)).toEqual(ack);
  expect(mocks.mutate).toHaveBeenCalledOnce();
});

it("rejects another teacher's intervening stage transition without writing a second record", async () => {
  const { before, envelope } = fixture(); before.currentStageIndex = 2; mocks.load.mockResolvedValue(before);
  await expect(executeCourseAction("course", envelope, claims)).rejects.toMatchObject({ code: "CLASSROOM_STAGE_CONFLICT", status: 409 });
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.tx.domainEvent.create).not.toHaveBeenCalled();
});

it("retains the aggregate version guard for ordinary teacher edits", async () => {
  const { before } = fixture(); mocks.load.mockResolvedValue(before);
  await expect(executeCourseAction("course", { requestId: "edit", expectedVersion: 3,
    action: { type: "UPDATE_COURSE", payload: { id: before.id, patch: { name: "编辑课程" } } } }, claims))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409, details: { currentVersion: 800 } });
  expect(mocks.mutate).not.toHaveBeenCalled();
});

function activityEnvelope(): ActionEnvelope {
  return { requestId: "activity-request", expectedVersion: 800, action: { type: "ADD_ACTIVITY", payload: {
    courseId: "course", activity: { id: "activity", actor: "教师", action: "投屏知识讲授历史页面", detail: "能量守恒", createdAt: now },
  } } };
}

it("accepts a teacher projection activity and replays the receipt without a second write", async () => {
  const { before } = fixture();
  const envelope = activityEnvelope();
  mocks.load.mockResolvedValue(before);
  mocks.mutate.mockResolvedValue({ ...before, version: 801 });
  const ack = await executeCourseAction("course", envelope, claims);
  expect(ack).toMatchObject({ requestId: envelope.requestId, courseVersion: 801, eventCursor: expect.any(String) });
  expect(mocks.mutate).toHaveBeenCalledWith(mocks.tx, envelope.action, claims.sub, { id: claims.sub, role: "teacher" }, before, { skipStageReadback: false });
  mocks.tx.domainEvent.findUnique.mockResolvedValue(mocks.tx.domainEvent.create.mock.calls[0]![0].data);
  expect(await executeCourseAction("course", envelope, claims)).toEqual(ack);
  expect(mocks.mutate).toHaveBeenCalledOnce();
  expect(mocks.tx.domainEvent.create).toHaveBeenCalledOnce();
});

it("rejects a student-authored activity before any write", async () => {
  await expect(executeCourseAction("course", activityEnvelope(), { ...claims, role: "student", studentName: "学生" }))
    .rejects.toMatchObject({ code: "FORBIDDEN_ACTION", status: 403 });
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(mocks.tx.domainEvent.create).not.toHaveBeenCalled();
});

it("rejects a teacher without classroom access even when replaying an activity request", async () => {
  mocks.access.mockResolvedValue(false);
  await expect(executeCourseAction("course", activityEnvelope(), claims)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(mocks.tx.domainEvent.findUnique).not.toHaveBeenCalled();
});
