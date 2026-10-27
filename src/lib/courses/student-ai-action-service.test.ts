import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { ActionEnvelope } from "./contracts";

const mocks = vi.hoisted(() => {
  const records = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const scope = { participationId: "participation", offeringId: "offering", researchKey: "research",
    userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, enrollmentStatus: "ACTIVE",
    instanceStatus: "TEACHING", offeringStatus: "OPEN", archivedAt: null as Date | null, runtimeVersion: 4 };
  const tx = {
    $queryRaw: vi.fn(), $executeRaw: vi.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<number>>(async () => 1),
    aiSupportRecord: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), create: vi.fn() },
    classroomSubmission: { findMany: vi.fn(async () => []) },
    aiTask: { findFirst: vi.fn() },
    projectGroup: { findMany: vi.fn(async () => []) },
    domainEvent: { create: vi.fn(), upsert: vi.fn() },
  };
  return { records, receipts, scope, tx, transaction: vi.fn(), lock: vi.fn(), load: vi.fn(),
    mutate: vi.fn(), access: vi.fn(async () => true), publish: vi.fn() };
});
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: async (fn: (tx: typeof mocks.tx) => unknown, options: unknown) => {
  mocks.transaction(options); return fn(mocks.tx);
} }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock, loadCourse: mocks.load, mutateProjectedCourse: mocks.mutate }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
import { executeCourseAction } from "./action-service";

const claims: AuthClaims = { role: "student", sub: "student", studentName: "学生", sv: 1 };
const at = "2026-10-16T00:00:00.000Z";
type Kind = "UPSERT_AI_CONTRIBUTION" | "ADD_COMPANION_PROCESS_RECORD";
const kinds: Kind[] = ["UPSERT_AI_CONTRIBUTION", "ADD_COMPANION_PROCESS_RECORD"];
function envelope(kind: Kind, requestId = "request-1"): ActionEnvelope {
  return { requestId, action: kind === "UPSERT_AI_CONTRIBUTION" ? { type: kind, payload: { courseId: "course", contribution: {
    id: "record", courseId: "course", studentId: "student", stageKey: "make", companionId: "recorder", impact: "low",
    request: "原问题", suggestion: "原回答", sourceEvidenceIds: [], status: "decided", createdAt: at,
  } } } : { type: kind, payload: { courseId: "course", record: {
    id: "record", courseId: "course", studentId: "student", stageKey: "make", title: "AI 协作", summary: "原过程",
    source: "agent", createdAt: at,
  } } } };
}
function incoming(input: ActionEnvelope): Record<string, unknown> {
  const action = input.action;
  if (action.type === "UPSERT_AI_CONTRIBUTION") return action.payload.contribution as unknown as Record<string, unknown>;
  if (action.type === "ADD_COMPANION_PROCESS_RECORD") return action.payload.record as unknown as Record<string, unknown>;
  throw new Error("fixture");
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.records.clear(); mocks.receipts.clear();
  Object.assign(mocks.scope, { userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1,
    enrollmentStatus: "ACTIVE", instanceStatus: "TEACHING", offeringStatus: "OPEN", archivedAt: null, runtimeVersion: 4 });
  mocks.lock.mockResolvedValue(undefined);
  mocks.tx.$queryRaw.mockImplementation(async (_sql, key) => [{ ...mocks.scope, receipt: mocks.receipts.get(key)?.payload ?? null }]);
  mocks.tx.$executeRaw.mockResolvedValue(1);
  mocks.tx.aiSupportRecord.findUnique.mockImplementation(async ({ where }) => mocks.records.get(where.id) ?? null);
  mocks.tx.aiSupportRecord.findMany.mockImplementation(async () => [...mocks.records.values()]);
  mocks.tx.aiSupportRecord.create.mockImplementation(async ({ data }) => { mocks.records.set(data.id, data); return data; });
  mocks.tx.aiSupportRecord.upsert.mockImplementation(async ({ where, create, update }) => {
    const old = mocks.records.get(where.id);
    const value = old ? { ...old, ...Object.fromEntries(Object.entries(update).filter(([, item]) => item !== undefined)) } : create;
    mocks.records.set(where.id, value); return value;
  });
  mocks.tx.domainEvent.create.mockImplementation(async ({ data }) => { mocks.receipts.set(data.idempotencyKey, data); return data; });
  mocks.tx.domainEvent.upsert.mockImplementation(async ({ where, create }) => {
    const value = mocks.receipts.get(where.idempotencyKey) ?? create; mocks.receipts.set(where.idempotencyKey, value); return value;
  });
  mocks.tx.classroomSubmission.findMany.mockResolvedValue([]); mocks.tx.aiTask.findFirst.mockResolvedValue(null);
  mocks.tx.projectGroup.findMany.mockResolvedValue([]);
});

describe.each(kinds)("personal AI record action %s", kind => {
  it("commits the record and complete receipt without reading the aggregate classroom", async () => {
    const input = envelope(kind); const ack = await executeCourseAction("course", input, claims);
    expect(ack).toEqual({ requestId: input.requestId, courseVersion: 5, eventCursor: expect.stringMatching(/~.+/) });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.objectContaining({ lowPriorityCourseId: "course" }));
    expect(mocks.lock).toHaveBeenCalledOnce(); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.lock.mock.invocationCallOrder[0]);
    expect(mocks.receipts.get(`course-action:student:${input.requestId}`)).toMatchObject({ participationId: "participation",
      researchKey: "research", payload: { action: input.action, ack, scope: "student", studentId: "student" } });
    expect(mocks.publish).toHaveBeenCalledWith("course", expect.objectContaining({ type: "course-updated", payload: {
      actionType: kind, courseVersion: ack.courseVersion, eventCursor: ack.eventCursor, scope: "student", studentId: "student",
    } }));
    const update = mocks.tx.$executeRaw.mock.calls[0][0].join("");
    expect(update).toContain("jsonb_set("); expect(update).toContain("'{version}'");
    expect(update).not.toContain('"status"'); expect(update).not.toContain("currentStageIndex");
  });
  it("replays the complete acknowledgement after closure without touching records or the course", async () => {
    const input = envelope(kind); const ack = await executeCourseAction("course", input, claims);
    mocks.scope.instanceStatus = "FINISHED";
    mocks.tx.$executeRaw.mockClear(); mocks.tx.aiSupportRecord.findUnique.mockClear(); mocks.tx.domainEvent.create.mockClear();
    expect(await executeCourseAction("course", input, claims)).toEqual(ack);
    expect(mocks.tx.aiSupportRecord.findUnique).not.toHaveBeenCalled(); expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
    expect(mocks.tx.domainEvent.create).not.toHaveBeenCalled();
  });
  it("rejects a reused request ID with changed content", async () => {
    const input = envelope(kind); await executeCourseAction("course", input, claims);
    const changed = envelope(kind); incoming(changed).stageKey = "launch";
    await expect(executeCourseAction("course", changed, claims)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });
  it.each([
    { userStatus: "SUSPENDED" }, { userRole: "TEACHER" }, { sessionVersion: 2 }, { enrollmentStatus: "WITHDRAWN" },
  ])("rechecks revoked identity even for a known receipt: %j", async change => {
    const input = envelope(kind); await executeCourseAction("course", input, claims); Object.assign(mocks.scope, change);
    await expect(executeCourseAction("course", input, claims)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
  it.each([{ instanceStatus: "FINISHED" }, { enrollmentStatus: "COMPLETED" }, { offeringStatus: "CLOSED" }, { archivedAt: new Date(at) }])(
    "rejects newly queued writes after a fresh scope change: %j", async change => {
      mocks.lock.mockImplementation(async () => { Object.assign(mocks.scope, change); });
      await expect(executeCourseAction("course", envelope(kind), claims)).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY", status: 409 });
      expect(mocks.records.size).toBe(0); expect(mocks.tx.domainEvent.create).not.toHaveBeenCalled();
    });
  it.each([{ participationId: "other-participant" }, { offeringId: "other-offering" }, { createdById: "other-student" }, { type: "OTHER" }])(
    "rejects an existing foreign entity instead of overwriting it: %j", async change => {
      const input = envelope(kind); await executeCourseAction("course", input, claims);
      const old = [...mocks.records.values()][0]; Object.assign(old, change);
      await expect(executeCourseAction("course", envelope(kind, "different-request"), claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE", status: 403 });
    });
  it("rejects another student's source evidence and missing references", async () => {
    const input = envelope(kind); incoming(input)[kind === "UPSERT_AI_CONTRIBUTION" ? "sourceEvidenceIds" : "evidenceIds"] = ["evidence"];
    await expect(executeCourseAction("course", input, claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE" });
    mocks.tx.classroomSubmission.findMany.mockResolvedValue([{ payload: { view: { id: "evidence", studentId: "other", courseId: "course" } } }] as never);
    await expect(executeCourseAction("course", input, claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE" });
    expect(mocks.records.size).toBe(0);
  });
  it("accepts only referenced personal evidence, with its active group membership", async () => {
    const input = envelope(kind); incoming(input)[kind === "UPSERT_AI_CONTRIBUTION" ? "sourceEvidenceIds" : "evidenceIds"] = ["evidence"];
    mocks.tx.classroomSubmission.findMany.mockResolvedValue([{ payload: { view: { id: "evidence", studentId: "student", courseId: "course", groupId: "grp-self" } } }] as never);
    await expect(executeCourseAction("course", input, claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE" });
    mocks.tx.projectGroup.findMany.mockResolvedValue([{ id: "offering:grp-self", members: [{ userId: "student" }] }] as never);
    await expect(executeCourseAction("course", input, claims)).resolves.toMatchObject({ courseVersion: 5 });
    expect(mocks.tx.classroomSubmission.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({
      participation: { instanceId: "course" }, AND: expect.arrayContaining([{ OR: [{ payload: { path: ["view", "id"], equals: "evidence" } }] }]),
    }) }));
  });
  it("does not publish or acknowledge when the receipt write fails", async () => {
    mocks.tx.domainEvent.create.mockRejectedValueOnce(new Error("receipt unavailable"));
    await expect(executeCourseAction("course", envelope(kind), claims)).rejects.toThrow("receipt unavailable");
    expect(mocks.publish).not.toHaveBeenCalled();
    // Database rollback is separately exercised against a real transaction.
  });
});

it("updates contributions while retaining the stored creator and canonical envelope", async () => {
  await executeCourseAction("course", envelope("UPSERT_AI_CONTRIBUTION"), claims);
  const changed = envelope("UPSERT_AI_CONTRIBUTION", "request-2"); incoming(changed).suggestion = "更新后的辅助建议";
  await executeCourseAction("course", changed, claims);
  expect(mocks.records.get("course:aiContributions:record")).toMatchObject({ createdById: "student", type: "AICONTRIBUTIONS",
    structuredPayload: { instanceId: "course", collection: "aiContributions", provenance: { actorId: "student", actorRole: "student" },
      view: { suggestion: "更新后的辅助建议" } } });
});
it("rejects another owner's historical contribution sharing the requested logical ID", async () => {
  mocks.records.set("historical", { id: "historical", participationId: "other-participant", offeringId: "offering",
    createdById: "other", type: "AICONTRIBUTIONS", structuredPayload: { instanceId: "course", collection: "aiContributions",
      view: { id: "record", studentId: "other", courseId: "course" } } });
  await expect(executeCourseAction("course", envelope("UPSERT_AI_CONTRIBUTION"), claims))
    .rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE" });
  expect(mocks.tx.aiSupportRecord.upsert).not.toHaveBeenCalled();
});
it("updates an owned historical contribution in place instead of duplicating its logical ID", async () => {
  const input = envelope("UPSERT_AI_CONTRIBUTION");
  mocks.records.set("historical", { id: "historical", participationId: "participation", offeringId: "offering",
    createdById: "student", type: "AICONTRIBUTIONS", structuredPayload: { instanceId: "course", collection: "aiContributions",
      view: { ...incoming(input), suggestion: "旧建议" } } });
  await executeCourseAction("course", input, claims);
  expect(mocks.records.size).toBe(1); expect(mocks.records.has("course:aiContributions:record")).toBe(false);
  expect(mocks.records.get("historical")).toMatchObject({ structuredPayload: { view: { suggestion: "原回答" } } });
});
it("preserves original process text and deduplicates its established research fact", async () => {
  await executeCourseAction("course", envelope("ADD_COMPANION_PROCESS_RECORD"), claims);
  const changed = envelope("ADD_COMPANION_PROCESS_RECORD", "request-2"); incoming(changed).summary = "不能覆写原文";
  incoming(changed).createdAt = "2026-10-17T00:00:00.000Z"; incoming(changed).stageKey = "showcase";
  await executeCourseAction("course", changed, claims);
  expect(mocks.records.get("record")).toMatchObject({ summary: "原过程", createdAt: new Date(at) });
  const facts = [...mocks.receipts.values()].filter(row => row.eventType === "companion_process_recorded");
  expect(facts).toHaveLength(1); expect(facts[0]).toMatchObject({ participationId: "participation", researchKey: "research",
    payload: { entityId: "record", stageKey: "make", status: "RECORDED", source: "session_dispatch", schemaVersion: 1 } });
});
it("validates the persisted task owner before accepting a process record reference", async () => {
  const input = envelope("ADD_COMPANION_PROCESS_RECORD"); incoming(input).taskId = "task";
  mocks.tx.aiTask.findFirst.mockResolvedValue({ id: "task", createdById: "other", input: { legacy: { stageKey: "make" } } });
  await expect(executeCourseAction("course", input, claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE" });
  mocks.tx.aiTask.findFirst.mockResolvedValue({ id: "task", createdById: "student", input: { legacy: { stageKey: "make" } } });
  await expect(executeCourseAction("course", input, claims)).resolves.toMatchObject({ courseVersion: 5 });
});
