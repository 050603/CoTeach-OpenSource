import { collectProgressTimings, type ProgressTimingSpan } from "@/lib/observability/progress-request-timing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentAiProgress } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  readReceipt: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
  publish: vi.fn(),
  tx: {
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: mocks.readReceipt } }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));

import { persistStudentAiProgress } from "./ai-progress-service";

function progress(overrides: Partial<StudentAiProgress> = {}): StudentAiProgress {
  return {
    classroomId: "classroom-1", studentId: "student-1", currentSceneIndex: 2,
    totalScenes: 3, completedScenes: ["scene-1"], masteryLevel: "in-progress",
    lastActiveAt: "2026-09-26T00:00:00.000Z", completionModelVersion: 2,
    ...overrides,
  };
}

function setParticipation(row: { id: string; enrollment?: { offeringId?: string; researchKey?: string }; workspace?: { projectState: unknown }; stageProgress?: unknown }) {
  mocks.tx.$queryRaw.mockResolvedValueOnce([{ ...row, offeringId: row.enrollment?.offeringId, researchKey: row.enrollment?.researchKey,
    projectState: row.workspace?.projectState, runtimeVersion: 2, userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, enrollmentStatus: "ACTIVE", classroomStatus: "TEACHING", offeringStatus: "OPEN", archivedAt: null }]);
}

function committedJson() {
  return mocks.tx.$queryRaw.mock.calls[1].slice(1).flatMap(value => {
    if (typeof value !== "string" || !value.startsWith("{")) return [];
    return [JSON.parse(value)];
  });
}

describe("persistStudentAiProgress", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readReceipt.mockResolvedValue([]);
    mocks.transaction.mockImplementation((callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx));
    mocks.tx.$queryRaw.mockResolvedValue([{ id: "event-1", createdAt: new Date("2026-09-26T00:00:01.000Z") }]);
  });

  function committedReceipt(overrides: Record<string, unknown> = {}) {
    return { participationId: "participation-1", userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1,
      enrollmentStatus: "COMPLETED", classroomId: "classroom-1", matchesScope: true,
      receipt: { fingerprint: "hash", requestId: "request", studentId: "student-1", stageKey: "ai-learning", scope: "student",
        response: progress({ currentSceneIndex: 0, completedScenes: [] }) }, ...overrides };
  }
  const replayRequest = { requestId: "request", fingerprint: "hash", sessionVersion: 1 };

  it("replays only a live-authorized committed receipt without entering the course write queue", async () => {
    const row = committedReceipt();
    mocks.readReceipt.mockResolvedValue([row]);
    // A successful replay must finish even if every write is waiting for closure.
    mocks.transaction.mockImplementation(() => { throw new Error("write queue must not be entered"); });
    expect(await persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).toBe(row.receipt.response);
    expect(mocks.readReceipt).toHaveBeenCalledOnce();
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.tx.$queryRaw).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each([{ userStatus: "DISABLED" }, { userRole: "TEACHER" }, { sessionVersion: 2 }, { enrollmentStatus: "WITHDRAWN" }])("rechecks current identity before fast receipt replay: %s", async revoked => {
    mocks.readReceipt.mockResolvedValue([committedReceipt(revoked)]);
    await expect(persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects an old receipt after its live participation/offering ownership is lost", async () => {
    mocks.readReceipt.mockResolvedValue([committedReceipt({ participationId: null })]);
    await expect(persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).rejects.toMatchObject({ code: "STUDENT_NOT_FOUND", status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("never acknowledges a conflicting key, foreign event, or changed classroom as a replay", async () => {
    for (const override of [{ matchesScope: false }, { classroomId: "new-classroom" },
      { receipt: { ...committedReceipt().receipt, fingerprint: "other-content" } },
      { receipt: { ...committedReceipt().receipt, requestId: "other-request" } },
      { receipt: { ...committedReceipt().receipt, stageKey: "make" } },
      { receipt: { ...committedReceipt().receipt, response: progress({ studentId: "other-student" }) } },
      { receipt: { ...committedReceipt().receipt, response: progress({ classroomId: "other-classroom" }) } },
      { receipt: null }]) {
      mocks.readReceipt.mockResolvedValueOnce([committedReceipt(override)]);
      await expect(persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    }
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rechecks a preflight miss under the original course lock when another request committed meanwhile", async () => {
    const row = committedReceipt();
    mocks.tx.$queryRaw.mockResolvedValue([{ userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1,
      enrollmentStatus: "COMPLETED", classroomStatus: "FINISHED", receipt: row.receipt,
      hasReceipt: true, matchesScope: true, classroomId: "classroom-1" }]);
    expect(await persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).toBe(row.receipt.response);
    expect(mocks.readReceipt).toHaveBeenCalledOnce(); expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.lock).toHaveBeenCalledOnce(); expect(mocks.tx.$queryRaw).toHaveBeenCalledOnce(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects a foreign receipt that appeared only after the unlocked read missed", async () => {
    const row = committedReceipt({ matchesScope: false });
    mocks.tx.$queryRaw.mockResolvedValue([{ ...row, hasReceipt: true }]);
    await expect(persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(mocks.transaction).toHaveBeenCalledOnce(); expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.tx.$queryRaw).toHaveBeenCalledOnce(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("propagates a failed receipt read without inventing a successful acknowledgement", async () => {
    const failure = new Error("receipt read unavailable"); mocks.readReceipt.mockRejectedValue(failure);
    await expect(persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).rejects.toBe(failure);
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("reports receipt-read time without claiming a write transaction, merge or publish ran", async () => {
    mocks.readReceipt.mockResolvedValue([committedReceipt()]);
    const spans: ProgressTimingSpan[] = [];
    await collectProgressTimings(performance.now(), spans, () => persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest));
    expect(spans.map(span => span.phase)).toEqual(["progress-receipt-read"]);
    expect(spans[0].outcome).toBe("ok"); expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("merges a stale playback report without losing concurrent quiz and tutor records", async () => {
    const attempts = Array.from({ length: 45 }, (_, index) => ({ id: `quiz-${index}` }));
    setParticipation({
      id: "participation-1",
      enrollment: { offeringId: "offering-1", researchKey: "research-1" },
      workspace: { projectState: { aiLearningProgress: progress({
        completedScenes: ["scene-1", "scene-2"], masteryLevel: "mastered", quizScore: 100,
        knowledgeLectureAttempts: attempts,
        knowledgeLectureTutorThreads: [{ id: "thread-1" }],
        adaptiveLearning: { enabled: true },
      } as unknown as Partial<StudentAiProgress>) } },
      stageProgress: { progress: { launch: 40, "ai-learning": 20 } },
    });

    const saved = await persistStudentAiProgress("classroom-1", "student-1", progress({
      completedScenes: ["scene-1", "scene-3"], masteryLevel: "in-progress",
    }));

    expect(saved.completedScenes).toEqual(["scene-1", "scene-2", "scene-3"]);
    expect(saved.masteryLevel).toBe("completed");
    expect(saved.quizScore).toBeUndefined();
    expect(saved.knowledgeLectureAttempts).toBeUndefined();
    expect(saved.knowledgeLectureTutorThreads).toBeUndefined();
    expect(saved.adaptiveLearning).toBeUndefined();
    expect(mocks.lock).toHaveBeenCalledWith(mocks.tx, "classroom-1");
    const writes = committedJson();
    expect(writes).toContainEqual(expect.objectContaining({ progress: 100, scope: "student", courseVersion: 3 }));
    expect(writes).toContainEqual(expect.objectContaining({ aiLearningProgress: expect.objectContaining({ knowledgeLectureAttempts: attempts }) }));
    expect(writes).toContainEqual({ progress: { launch: 40, "ai-learning": 100 } });
    expect(mocks.publish).toHaveBeenCalledWith("classroom-1", expect.objectContaining({ payload: expect.objectContaining({ courseVersion: 3, eventCursor: "2026-09-26T00:00:01.000Z~event-1" }) }));
  });

  it("removes invalid prior completions and derives percentage from legal merged scenes", async () => {
    setParticipation({
      id: "participation-1", enrollment: { offeringId: "offering-1" },
      workspace: { projectState: { aiLearningProgress: progress({ completedScenes: ["teacher", "scene-1"], completedOutlineIds: ["teacher", "scene-1"] }) } },
      stageProgress: { progress: { "ai-learning": 100 } },
    });
    const saved = await persistStudentAiProgress("classroom-1", "student-1", progress({ totalScenes: 2 }), [{ id: "scene-1" }, { id: "scene-2" }]);
    expect(saved.completedScenes).toEqual(["scene-1"]);
    expect(saved.completedOutlineIds).toEqual(["scene-1"]);
    expect(saved.masteryLevel).toBe("in-progress");
    expect(committedJson()).toContainEqual({ progress: { "ai-learning": 50 } });
  });

  it("rejects a playback report queued behind classroom closure", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{ id: "participation-1", userStatus: "ACTIVE", userRole: "STUDENT", enrollmentStatus: "ACTIVE", classroomStatus: "FINISHED", offeringStatus: "OPEN" }]);
    await expect(persistStudentAiProgress("classroom-1", "student-1", progress())).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY", status: 409 });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("returns the original compact receipt after newer progress or closure without touching versions/events", async () => {
    const response = progress();
    const row = committedReceipt({ receipt: { ...committedReceipt().receipt, response } });
    mocks.tx.$queryRaw.mockResolvedValue([{ ...row, hasReceipt: true, classroomStatus: "FINISHED" }]);
    expect(await persistStudentAiProgress("course", "student-1", progress({ currentSceneIndex: 0 }), undefined, replayRequest)).toEqual(response);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    await expect(persistStudentAiProgress("course", "student-1", progress(), undefined, { ...replayRequest, fingerprint: "changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });
  it.each([{ userStatus: "DISABLED" }, { userRole: "TEACHER" }, { sessionVersion: 2 }, { enrollmentStatus: "WITHDRAWN" }])("authorizes before replaying receipts: %s", async revoked => {
    mocks.tx.$queryRaw.mockResolvedValue([{ ...committedReceipt(), hasReceipt: true, ...revoked }]);
    await expect(persistStudentAiProgress("course", "student-1", progress(), undefined, replayRequest)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each([[], new Error("receipt insert failed")])("never acknowledges or publishes an incomplete commit: %s", async result => {
    setParticipation({ id: "participation-1", enrollment: { offeringId: "offering-1" } });
    if (result instanceof Error) mocks.tx.$queryRaw.mockRejectedValueOnce(result);
    else mocks.tx.$queryRaw.mockResolvedValueOnce(result);
    await expect(persistStudentAiProgress("classroom-1", "student-1", progress())).rejects.toThrow();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("retains the real commit and replay branches while timing their own work", async () => {
    setParticipation({ id: "participation-1", enrollment: { offeringId: "offering-1" } });
    const spans: ProgressTimingSpan[] = [];
    const result = await collectProgressTimings(performance.now(), spans, () =>
      persistStudentAiProgress("course", "student-1", progress()));
    expect(result.completedScenes).toEqual(["scene-1"]);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledOnce();
    const transaction = spans.find(span => span.phase === "progress-transaction")!;
    const callback = spans.find(span => span.phase === "progress-callback")!;
    const publish = spans.find(span => span.phase === "progress-publish")!;
    expect(transaction.startMs).toBeLessThanOrEqual(callback.startMs);
    expect(transaction.endMs).toBeGreaterThanOrEqual(callback.endMs);
    expect(publish.startMs).toBeGreaterThanOrEqual(transaction.endMs);
    expect(spans.filter(span => span.phase === "progress-write")).toHaveLength(1);
    mocks.publish.mockClear(); mocks.tx.$queryRaw.mockClear();
    mocks.tx.$queryRaw.mockResolvedValue([{ ...committedReceipt(), hasReceipt: true, classroomStatus: "FINISHED",
      receipt: { ...committedReceipt().receipt, requestId: "replay", response: result } }]);
    const replaySpans: ProgressTimingSpan[] = [];
    expect(await collectProgressTimings(performance.now(), replaySpans, () =>
      persistStudentAiProgress("course", "student-1", progress(), undefined, { requestId: "replay", fingerprint: "hash", sessionVersion: 1 }))).toBe(result);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    expect(replaySpans.some(span => span.phase === "progress-write" || span.phase === "progress-publish")).toBe(false);
  });

});
