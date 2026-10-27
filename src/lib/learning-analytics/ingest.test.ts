import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { LearningEvent, LearningSignal } from "@/lib/session/types";
const mocks = vi.hoisted(() => ({ admission: vi.fn(), options: vi.fn(), user: vi.fn(), instance: vi.fn(), participation: vi.fn(), events: vi.fn(), insert: vi.fn(), signals: vi.fn(), remove: vi.fn(), upsert: vi.fn(), version: vi.fn(), notification: vi.fn(), count: vi.fn(), query: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: mocks.query, classroomParticipation: { count: mocks.count } } }));
vi.mock("@/lib/db/transaction-retry", () => ({ tryPersonalCourseRowMutationAdmission: mocks.admission, runMutationTransaction: (operation: (tx: unknown) => unknown, options: unknown) => { mocks.options(options); return operation({
  classroomInstance: { findUnique: mocks.instance, update: mocks.version }, classroomParticipation: { findFirst: mocks.participation, count: mocks.count },
  learningEvent: { findMany: mocks.events, createMany: mocks.insert }, learningSignal: { findMany: mocks.signals, deleteMany: mocks.remove, upsert: mocks.upsert },
  domainEvent: { create: mocks.notification }, $queryRaw: mocks.query,
}); } }));
import { ingestClassroomLearningEvents } from "./ingest";
import { learningEventBatchSize } from "@/lib/observability/learning-event-batches";
const claims = { role: "student", sub: "student", sv: 1 } as AuthClaims;
const event: LearningEvent = { id: "event", idempotencyKey: "key", studentId: "student", courseId: "course", stageKey: "learn", sceneId: "scene", type: "heartbeat", durationMs: 10000, occurredAt: new Date().toISOString(), metadata: { a: 1, b: "two" } };
const input = (events = [event]) => ({ courseId: "course", studentId: "student", events });
const instance = { id: "course", status: "TEACHING", runtimeConfig: { version: 8, uiState: { keep: true } }, templateVersionId: "template", activityId: "activity", activity: { archivedAt: null, chapterId: "chapter", chapter: { offeringId: "offering", offering: { status: "OPEN" } } } };
beforeEach(() => {
  vi.resetAllMocks();
  learningEventBatchSize.reset();
  mocks.user.mockResolvedValue({ id: "student" }); mocks.instance.mockResolvedValue(instance);
  mocks.participation.mockResolvedValue({ id: "participation", enrollmentId: "enrollment", enrollment: { status: "ACTIVE", researchKey: "research" } });
  mocks.events.mockImplementation(({ where }) => Promise.resolve(where.idempotencyKey ? [] : []));
  mocks.signals.mockResolvedValue([]); mocks.count.mockResolvedValue(40); mocks.query.mockImplementation(async (query, ...values) => {
    if (query.join("").includes('WITH facts AS')) {
      await mocks.insert({ data: JSON.parse(values[8]).map((row: object) => ({ ...row, userId: values[0], researchKey: values[1], offeringId: values[2], enrollmentId: values[3], chapterId: values[4], activityId: values[5], classroomInstanceId: values[6], participationId: values[7] })) });
      if (values[10].length) await mocks.remove({ where: { participationId: values[9], id: { in: values[10] } } });
      for (const row of JSON.parse(values[16])) await mocks.upsert(row);
      await mocks.version({ where: { id: values[19] }, data: { runtimeConfig: { ...(await mocks.instance()).runtimeConfig, version: JSON.parse(values[17]) } } });
      return [await mocks.notification()];
    }
    if (query.join("").includes('FROM "LearningSignal" s')) return [];
    if (query.join("").includes('FROM "User"')) {
      const current = await mocks.instance(); const participant = await mocks.participation();
      const existing = await mocks.events({ where: { idempotencyKey: true } });
      const allHistory = await mocks.events({ where: { classroomInstanceId: "course", userId: "student", participationId: "participation" } });
      const selection = JSON.parse(values[1]);
      const history = allHistory.filter((row: { metadata: { legacy: LearningEvent } }) => selection.some((item: { stageKey: string; sceneId: string; wholeStage: boolean }) => {
        const previous = row.metadata.legacy;
        return previous.stageKey === item.stageKey && (item.wholeStage || (previous.sceneId ?? "") === item.sceneId || previous.type === "stage-goal-complete");
      }));
      return [{ ...current, runtimeVersion: current.runtimeConfig?.version, actorStatus: "ACTIVE", actorRole: "student", actorSessionVersion: 1, chapterId: current.activity.chapterId, offeringId: current.activity.chapter.offeringId, offeringStatus: current.activity.chapter.offering.status, archivedAt: current.activity.archivedAt, participationId: participant?.id, enrollmentId: participant?.enrollmentId, enrollmentStatus: participant?.enrollment.status, researchKey: participant?.enrollment.researchKey, existing, history, ownSignalRows: await mocks.signals(), content: {} }];
    }
    return [{ content: {} }];
  });
  mocks.notification.mockResolvedValue({ id: "notice", createdAt: new Date("2026-09-26T00:00:00Z") });
});
describe("narrow classroom telemetry transaction", () => {
  it("counts batch size once per validated ingestion attempt, including replay but excluding invalid scope", async () => {
    await expect(ingestClassroomLearningEvents(claims, {})).rejects.toMatchObject({ code: "INVALID_EVENTS" });
    await expect(ingestClassroomLearningEvents({ ...claims, sub: "other" }, input())).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
    await ingestClassroomLearningEvents(claims, input());
    mocks.events.mockResolvedValue([mocks.insert.mock.calls[0][0].data[0]]);
    await ingestClassroomLearningEvents(claims, input());
    const metric = await learningEventBatchSize.get();
    expect(metric.values).toContainEqual(expect.objectContaining({ metricName: "openpbl_learning_event_batch_size_count", value: 2 }));
    expect(metric.values).toContainEqual(expect.objectContaining({ metricName: "openpbl_learning_event_batch_size_sum", value: 2 }));
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
  it("keeps combined personal→course→row admission before fresh scope reads and writes", async () => {
    await ingestClassroomLearningEvents(claims, input());
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ lowPriorityCourseId: "course", deferCourseAdmission: true }));
    expect(mocks.admission).toHaveBeenCalledWith(expect.anything(), "learning-events:course:student", "course");
    expect(mocks.admission.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.calls[0][0].join("")).toContain('le."userId" = u.id AND le."classroomInstanceId" = ci.id AND le."participationId" = p.id');
    expect(mocks.admission.mock.invocationCallOrder[0]).toBeLessThan(mocks.insert.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.calls[0][0].join("")).toContain("jsonb_build_object('legacy', (le.metadata -> 'legacy') - 'metadata')");
  });
  it("persists owned evidence, version and durable notification and reads only personal history", async () => {
    expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ acceptedIds: ["event"], duplicateCount: 0, signals: [], commonIssues: [] });
    expect(mocks.insert.mock.calls[0][0].data[0]).toMatchObject({ userId: "student", participationId: "participation", researchKey: "research", classroomInstanceId: "course", metadata: { legacy: event, requestFingerprint: expect.any(String) } });
    expect(mocks.version).toHaveBeenCalledWith({ where: { id: "course" }, data: { runtimeConfig: { version: 9, uiState: { keep: true } } } });
    expect(mocks.publish).toHaveBeenCalledWith("course", expect.objectContaining({ payload: expect.objectContaining({ courseVersion: 9, scope: "student", studentId: "student", eventCursor: expect.any(String) }) }));
  });
  it("acknowledges committed replay despite reordered JSON without writing or incrementing version", async () => {
    await ingestClassroomLearningEvents(claims, input());
    const row = mocks.insert.mock.calls[0][0].data[0];
    mocks.events.mockResolvedValue([row]); mocks.insert.mockClear(); mocks.version.mockClear(); mocks.notification.mockClear(); mocks.publish.mockClear();
    const replay = await ingestClassroomLearningEvents(claims, input([{ ...event, metadata: { b: "two", a: 1 } }]));
    expect(replay).toMatchObject({ acceptedIds: ["event"], duplicateCount: 1 });
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.version).not.toHaveBeenCalled(); expect(mocks.notification).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rejects reused key with altered content or event ID, including within one batch", async () => {
    for (const changed of [{ ...event, durationMs: 42 }, { ...event, id: "other-event" }]) {
      await expect(ingestClassroomLearningEvents(claims, input([event, changed]))).rejects.toMatchObject({ code: "LEARNING_EVENT_CONFLICT", status: 409 });
    }
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("supports legacy rows without fingerprints only when their full enriched event matches", async () => {
    await ingestClassroomLearningEvents(claims, input());
    const row = mocks.insert.mock.calls[0][0].data[0]; delete row.metadata.requestFingerprint;
    mocks.events.mockResolvedValue([row]);
    expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ acceptedIds: ["event"], duplicateCount: 1 });
    await expect(ingestClassroomLearningEvents(claims, input([{ ...event, durationMs: 42 }]))).rejects.toMatchObject({ code: "LEARNING_EVENT_CONFLICT" });
  });
  it("deduplicates identical items inside a batch while acknowledging its ID", async () => {
    expect(await ingestClassroomLearningEvents(claims, input([event, event]))).toMatchObject({ acceptedIds: ["event"], duplicateCount: 1 });
    expect(mocks.insert.mock.calls[0][0].data).toHaveLength(1);
  });
  it("rejects new evidence after closure but acknowledges a committed replay", async () => {
    await ingestClassroomLearningEvents(claims, input()); const row = mocks.insert.mock.calls[0][0].data[0];
    mocks.instance.mockResolvedValue({ ...instance, status: "FINISHED" });
    await expect(ingestClassroomLearningEvents(claims, input())).rejects.toMatchObject({ code: "COURSE_LOCKED", status: 409 });
    mocks.events.mockResolvedValue([row]); expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ duplicateCount: 1 });
  });
  it("removes stale scene warnings after whole-stage completion and preserves unrelated signals", async () => {
    const finish: LearningEvent = { ...event, id: "finish", idempotencyKey: "finish", sceneId: undefined, type: "stage-goal-complete" };
    const stale = { id: "stale", studentId: "student", stageKey: "learn", sceneId: "scene", kind: "dwell-overrun", aiInterventionAttempts: 0 };
    const unrelated = { ...stale, id: "keep", stageKey: "make" };
    mocks.signals.mockResolvedValue([{ id: "db-stale", payload: { view: stale } }, { id: "db-keep", payload: { view: unrelated } }]);
    mocks.events.mockImplementation(({ where }) => Promise.resolve(where.idempotencyKey ? [] : [{ metadata: { legacy: { ...event, type: "scene-enter", occurredAt: new Date(Date.now() - 300000).toISOString() } } }, { metadata: { legacy: finish } }]));
    const result = await ingestClassroomLearningEvents(claims, input([finish]));
    expect(mocks.remove).toHaveBeenCalledWith({ where: { participationId: "participation", id: { in: ["db-stale"] } } });
    expect(result.signals).toEqual([unrelated]);
  });
  it("keeps stage completion evidence when a later heartbeat revisits just one scene", async () => {
    const finish = { ...event, id: "done", idempotencyKey: "done", sceneId: undefined, type: "stage-goal-complete" };
    mocks.events.mockImplementation(({ where }) => Promise.resolve(where.idempotencyKey ? [] : [
      { metadata: { legacy: { ...event, type: "scene-enter", occurredAt: new Date(Date.now() - 600000).toISOString() } } },
      { metadata: { legacy: finish } },
      { metadata: { legacy: { ...event, stageKey: "unrelated", type: "scene-enter" } } },
    ]));
    const result = await ingestClassroomLearningEvents(claims, input([{ ...event, expectedDurationSec: 1 }]));
    expect(result.signals).toEqual([]);
    expect(JSON.parse(mocks.query.mock.calls[0][2])).toEqual([{ stageKey: "learn", sceneId: "scene", wholeStage: false }]);
  });
  it("includes every affected scene in mixed batches and all scenes only for completed stages", async () => {
    await ingestClassroomLearningEvents(claims, input([
      event, { ...event, id: "next", idempotencyKey: "next", sceneId: "second" },
      { ...event, id: "done", idempotencyKey: "done", stageKey: "make", type: "stage-goal-complete", sceneId: undefined },
    ]));
    expect(JSON.parse(mocks.query.mock.calls[0][2])).toEqual([
      { stageKey: "learn", sceneId: "scene", wholeStage: false },
      { stageKey: "learn", sceneId: "second", wholeStage: false },
      { stageKey: "make", sceneId: "", wholeStage: true },
    ]);
  });
  it("does not publish or return success when the transaction fails", async () => {
    mocks.notification.mockRejectedValue(new Error("DB write failure"));
    await expect(ingestClassroomLearningEvents(claims, input())).rejects.toThrow("DB write failure");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("keeps committed acknowledgement when realtime transport fails", async () => {
    mocks.publish.mockRejectedValue(new Error("Redis offline")); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ acceptedIds: ["event"] }); log.mockRestore();
  });
  it("rejects foreign ownership, invalid duration and future timestamps before writing", async () => {
    await expect(ingestClassroomLearningEvents({ ...claims, sub: "other" }, input())).rejects.toMatchObject({ status: 403 });
    for (const bad of [{ ...event, durationMs: -1 }, { ...event, occurredAt: new Date(Date.now() + 600000).toISOString() }, { ...event, courseId: "foreign" }]) {
      await expect(ingestClassroomLearningEvents(claims, input([bad]))).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("stable learning issue derivations", () => {
  let facts: Array<{ idempotencyKey: string; metadata: { legacy: LearningEvent } }>;
  let signalRows: Map<string, { id: string; payload: { view: LearningSignal; components?: LearningSignal[] } }>;

  function frictionEvents(sceneId: string, dwell: boolean, knowledgePointId?: string): LearningEvent[] {
    const now = Date.now();
    const make = (suffix: string, type: LearningEvent["type"], ageMs: number, patch: Partial<LearningEvent> = {}): LearningEvent => ({
      ...event, id: `${sceneId}-${suffix}`, idempotencyKey: `${sceneId}-${suffix}`, sceneId, type,
      occurredAt: new Date(now - ageMs).toISOString(),
      content: { sceneTitle: sceneId, ...(knowledgePointId ? { knowledgePointIds: [knowledgePointId] } : {}) },
      ...patch,
    });
    return [
      make("enter", "scene-enter", 100_000),
      make("replay-1", "scene-replay", 80_000),
      make("replay-2", "scene-replay", 60_000),
      make("replay-3", "scene-replay", 40_000),
      make("heartbeat", "heartbeat", 1_000, { durationMs: dwell ? 100_000 : 1_000, visible: true, expectedDurationSec: 1 }),
    ];
  }

  beforeEach(() => {
    facts = [];
    signalRows = new Map();
    mocks.events.mockImplementation(() => Promise.resolve(facts));
    mocks.signals.mockImplementation(() => Promise.resolve([...signalRows.values()]));
    mocks.insert.mockImplementation(({ data }) => { facts.push(...data); });
    mocks.upsert.mockImplementation((row) => { signalRows.set(row.id, row); });
    mocks.remove.mockImplementation(({ where }) => { where.id.in.forEach((id: string) => signalRows.delete(id)); });
  });

  it("writes one stable issue for simultaneous dwell and replay, preserving every fact and both reasons", async () => {
    const events = frictionEvents("scene", true);
    const result = await ingestClassroomLearningEvents(claims, input(events));
    expect(result.acceptedIds).toEqual(events.map(item => item.id));
    expect(facts.map(row => row.metadata.legacy)).toEqual(events);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      id: "learning-signal-student-comprehension-friction-learn-scene-scene",
      kind: "dwell-overrun", severity: "warning", normalizedIssueKey: "comprehension-friction:learn:scene:scene",
    });
    expect(new Set(result.signals[0].evidenceEventIds)).toEqual(new Set(["scene-heartbeat", "scene-replay-1", "scene-replay-2", "scene-replay-3"]));
    expect(result.signals[0].summary).toContain("本次进入后前台有效学习");
    expect(result.signals[0].summary).toContain("该内容已重复播放 3 次");
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(result.signals[0]).not.toHaveProperty("components");
    expect([...signalRows.values()][0].payload.components).toHaveLength(2);

    const replay = await ingestClassroomLearningEvents(claims, input(events));
    expect(replay).toMatchObject({ acceptedIds: events.map(item => item.id), duplicateCount: events.length, signals: result.signals });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(["same batch", "later batch"])("merges the same knowledge point across scenes in %s and removes only expired components", async (batch) => {
    const first = frictionEvents("first", true, "kp-shared");
    const second = frictionEvents("second", false, "kp-shared");
    if (batch === "later batch") await ingestClassroomLearningEvents(claims, input(first));
    const initial = await ingestClassroomLearningEvents(claims, input(batch === "same batch" ? [...first, ...second] : second));
    expect(initial.signals).toHaveLength(1);
    const signalId = "learning-signal-student-comprehension-friction-learn-kp-kp-shared";
    expect(initial.signals[0]).toMatchObject({ id: signalId, severity: "warning", kind: "dwell-overrun" });
    expect(new Set(initial.signals[0].evidenceEventIds)).toEqual(new Set([
      "first-heartbeat", "first-replay-1", "first-replay-2", "first-replay-3",
      "second-replay-1", "second-replay-2", "second-replay-3",
    ]));
    expect(signalRows.size).toBe(1);

    const close = (sceneId: string, type: "scene-complete" | "scene-leave"): LearningEvent => ({
      ...event, id: `${sceneId}-${type}`, idempotencyKey: `${sceneId}-${type}`, sceneId, type,
      occurredAt: new Date().toISOString(), progressMarker: "completed",
    });
    const afterFirst = await ingestClassroomLearningEvents(claims, input([close("first", "scene-complete")]));
    expect(afterFirst.signals).toHaveLength(1);
    expect(afterFirst.signals[0]).toMatchObject({ id: signalId, sceneId: "second", severity: "notice", kind: "repeated-playback" });
    expect(new Set(afterFirst.signals[0].evidenceEventIds)).toEqual(new Set(["second-replay-1", "second-replay-2", "second-replay-3"]));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(signalRows.size).toBe(1);

    const afterSecond = await ingestClassroomLearningEvents(claims, input([close("second", "scene-leave")]));
    expect(afterSecond.signals).toEqual([]);
    expect(signalRows.size).toBe(0);
    expect(mocks.remove).toHaveBeenCalledWith({ where: { participationId: "participation", id: { in: [`participation:${signalId}`] } } });
    expect(facts.map(row => row.metadata.legacy).slice(0, 10)).toEqual([...first, ...second]);
  });

  it("retains legacy evidence, the highest severity and issue detection times when another scene contributes", async () => {
    const first = frictionEvents("first", true, "kp-shared");
    await ingestClassroomLearningEvents(claims, input(first));
    const stored = [...signalRows.values()][0];
    const oldDetection = "2026-07-11T10:00:00.000Z";
    stored.payload.view = { ...stored.payload.view, severity: "high", aiInterventionAttempts: 2, firstDetectedAt: oldDetection };
    delete stored.payload.components;
    const before = structuredClone(stored.payload.view);

    const result = await ingestClassroomLearningEvents(claims, input(frictionEvents("second", false, "kp-shared")));
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ id: before.id, severity: "high", aiInterventionAttempts: 2, firstDetectedAt: oldDetection });
    expect(new Set(result.signals[0].evidenceEventIds)).toEqual(new Set([...before.evidenceEventIds, "second-replay-1", "second-replay-2", "second-replay-3"]));
    expect(result.signals[0].summary).toContain(before.summary);
    expect(Date.parse(result.signals[0].lastDetectedAt)).toBeGreaterThanOrEqual(Date.parse(before.lastDetectedAt));
  });

  it("does not rewrite an unrelated handled issue or its private evidence", async () => {
    await ingestClassroomLearningEvents(claims, input(frictionEvents("scene", true)));
    const unrelated: LearningSignal = {
      ...[...signalRows.values()][0].payload.view,
      id: "unrelated", stageKey: "make", sceneId: "different-scene", status: "handled",
      handledAt: "2026-07-11T10:00:00.000Z", evidenceEventIds: ["unrelated-evidence"],
    };
    const untouched = { id: "participation:unrelated", payload: { view: unrelated } };
    signalRows.set(untouched.id, untouched);
    mocks.upsert.mockClear();
    const next: LearningEvent = { ...event, id: "next-heartbeat", idempotencyKey: "next-heartbeat", occurredAt: new Date().toISOString() };
    const result = await ingestClassroomLearningEvents(claims, input([next]));
    expect(result.signals.find(signal => signal.id === unrelated.id)).toEqual(unrelated);
    expect(signalRows.get(untouched.id)).toBe(untouched);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0][0].id).not.toBe(untouched.id);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

it("reads runtime after combined admission so a preceding teacher projection is retained", async () => {
  mocks.admission.mockImplementation(async () => { mocks.instance.mockResolvedValue({ ...instance, runtimeConfig: { version: 41, uiState: { projectionController: { teacherId: 'teacher', clientId: 'tab' }, currentSlide: 3 } } }); });
  await ingestClassroomLearningEvents(claims, input());
  expect(mocks.version).toHaveBeenCalledWith({ where: { id: "course" }, data: { runtimeConfig: { version: 42, uiState: { projectionController: { teacherId: 'teacher', clientId: 'tab' }, currentSlide: 3 } } } });
});

it("rejects an already committed event when the session version has been revoked", async () => {
  await ingestClassroomLearningEvents(claims, input());
  mocks.events.mockResolvedValue([mocks.insert.mock.calls[0][0].data[0]]);
  await expect(ingestClassroomLearningEvents({ ...claims, sv: 2 }, input())).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
});

describe("committed immutable retry before admission", () => {
  async function prepare(events = [event]) {
    await ingestClassroomLearningEvents(claims, input(events));
    const rows = mocks.insert.mock.calls[0][0].data;
    mocks.events.mockImplementation(({ where }) => Promise.resolve(where.idempotencyKey ? rows : []));
    mocks.admission.mockClear(); mocks.insert.mockClear(); mocks.version.mockClear(); mocks.notification.mockClear(); mocks.publish.mockClear();
    return {
      id: "course", actorStatus: "ACTIVE", actorRole: "student", actorSessionVersion: 1,
      participationId: "participation", enrollmentId: "enrollment", enrollmentStatus: "ACTIVE", matchesOffering: true,
      existing: rows.map((row: { idempotencyKey: string; metadata: unknown }) => ({ ...row, matchesScope: true })),
      ownSignalRows: [],
    };
  }

  it("acknowledges every original event without waiting for an unrelated course write", async () => {
    const context = await prepare();
    mocks.query.mockResolvedValueOnce([context]);
    mocks.admission.mockRejectedValue(new Error("must not wait on course admission"));
    const result = await ingestClassroomLearningEvents(claims, input(), { replay: true });
    expect(result).toEqual({ acceptedIds: ["event"], duplicateCount: 1, signals: [], commonIssues: [] });
    expect(mocks.admission).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.version).not.toHaveBeenCalled();
    expect(mocks.notification).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("checks each original occurrence, including duplicate keys and reordered JSON", async () => {
    const context = await prepare();
    mocks.query.mockResolvedValueOnce([context]);
    expect(await ingestClassroomLearningEvents(claims, input([event, { ...event, metadata: { b: "two", a: 1 } }]), { replay: true }))
      .toMatchObject({ acceptedIds: ["event"], duplicateCount: 2 });
    for (const changed of [{ ...event, id: "changed-id" }, { ...event, durationMs: 42 }]) {
      mocks.query.mockResolvedValueOnce([context]);
      await expect(ingestClassroomLearningEvents(claims, input([event, changed]), { replay: true }))
        .rejects.toMatchObject({ code: "LEARNING_EVENT_CONFLICT", status: 409 });
    }
    expect(mocks.admission).not.toHaveBeenCalled();
  });

  it("uses fresh private signals and keeps committed receipts readable after closure", async () => {
    const context = await prepare();
    const signal = { id: "current-signal", studentId: "student", kind: "dwell-overrun", evidenceEventIds: ["event"] };
    mocks.instance.mockResolvedValue({ ...instance, status: "FINISHED" });
    mocks.query.mockResolvedValueOnce([{ ...context, enrollmentStatus: "COMPLETED", ownSignalRows: [{ payload: { view: signal } }] }]);
    expect(await ingestClassroomLearningEvents(claims, input(), { replay: true })).toMatchObject({ duplicateCount: 1, signals: [signal] });
    expect(mocks.admission).not.toHaveBeenCalled();
  });

  it.each([
    [{ actorStatus: "DISABLED" }, "UNAUTHENTICATED", 401],
    [{ actorRole: "teacher" }, "UNAUTHENTICATED", 401],
    [{ actorSessionVersion: 2 }, "UNAUTHENTICATED", 401],
    [{ enrollmentStatus: "WITHDRAWN" }, "STUDENT_SCOPE_MISMATCH", 403],
    [{ participationId: null }, "STUDENT_SCOPE_MISMATCH", 403],
    [{ matchesOffering: false }, "STUDENT_SCOPE_MISMATCH", 403],
  ])("revalidates live actor and ownership before accepting a retry: %j", async (patch, code, status) => {
    const context = await prepare(); mocks.query.mockResolvedValueOnce([{ ...context, ...patch }]);
    await expect(ingestClassroomLearningEvents(claims, input(), { replay: true })).rejects.toMatchObject({ code, status });
    expect(mocks.admission).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("falls back to the existing locked path when any fact is missing or uses a legacy fingerprint", async () => {
    const context = await prepare();
    mocks.query.mockResolvedValueOnce([{ ...context, existing: [] }]);
    expect(await ingestClassroomLearningEvents(claims, input(), { replay: true })).toMatchObject({ duplicateCount: 1 });
    expect(mocks.admission).toHaveBeenCalledOnce();
    const historical = structuredClone(context); delete historical.existing[0].metadata.requestFingerprint;
    mocks.query.mockResolvedValueOnce([historical]);
    expect(await ingestClassroomLearningEvents(claims, input(), { replay: true })).toMatchObject({ duplicateCount: 1 });
    expect(mocks.admission).toHaveBeenCalledTimes(2);
    mocks.query.mockResolvedValueOnce([context]);
    mocks.instance.mockResolvedValue({ ...instance, status: "FINISHED" });
    await expect(ingestClassroomLearningEvents(claims, input([event, { ...event, id: "new", idempotencyKey: "new" }]), { replay: true }))
      .rejects.toMatchObject({ code: "COURSE_LOCKED", status: 409 });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("does not trust a matching fingerprint on a fact owned by a different classroom participant", async () => {
    const context = await prepare(); context.existing[0].matchesScope = false;
    mocks.query.mockResolvedValueOnce([context]);
    await expect(ingestClassroomLearningEvents(claims, input(), { replay: true })).rejects.toMatchObject({ code: "LEARNING_EVENT_CONFLICT", status: 409 });
    expect(mocks.admission).not.toHaveBeenCalled();
  });
});
