import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { StudentClaims, TeacherClaims } from "@/lib/auth/session";
import type { Course, KnowledgeLectureAttempt, StudentAiProgress } from "@/lib/session/types";
import {
  canApplyDiscussionAsyncResult,
  canStartDiscussionRecording,
  discussionStatusAfterPlayback,
  getPublicDiscussionSnapshot,
  parseAssistantDecision,
  rankDiscussionCandidates,
} from "./service";

type DiscussionRow = Prisma.PublicDiscussionSessionGetPayload<{
  include: {
    currentStudent: { select: { id: true; displayName: true } };
    turns: { include: { student: { select: { displayName: true } } } };
  };
}>;

const database = vi.hoisted(() => ({
  publicDiscussionSession: { findFirst: vi.fn<() => Promise<DiscussionRow | null>>() },
}));
vi.mock("@/lib/db/client", () => ({ prisma: database }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function studentClaims(sub: string): StudentClaims {
  return { sub, role: "student", studentName: sub, sv: 1 };
}

function discussionRow(courseId: string, version = 1): DiscussionRow {
  const createdAt = new Date("2026-10-17T00:00:00.000Z");
  return {
    id: `discussion-${courseId}`,
    classroomInstanceId: courseId,
    createdById: "teacher",
    currentStudentId: "student-7",
    currentStudent: { id: "student-7", displayName: "发言同学" },
    knowledgePointId: "kp-1",
    topic: "课堂讨论",
    mode: "INQUIRY",
    openingPrompt: "请说明依据。",
    status: "AWAITING_STUDENT",
    resumeStatus: null,
    version,
    roundCount: 1,
    candidateEvidence: [{
      studentId: "student-7", studentName: "发言同学", online: true,
      reason: "教师推荐", evidence: "待澄清的回答", participationCount: 0,
    }],
    soundOwnerId: "teacher",
    soundClientId: "sound-client-a",
    soundLeaseUntil: new Date(createdAt.getTime() + 30_000),
    keyConclusion: null,
    misconceptionRepair: null,
    transferQuestion: null,
    createdAt,
    updatedAt: createdAt,
    endedAt: null,
    turns: [1, 2, 3].map((sequence) => ({
      id: `turn-${sequence}`, sessionId: `discussion-${courseId}`,
      studentId: "student-7", student: { displayName: "发言同学" },
      clientRequestId: `answer-${courseId}-${sequence}`, sequence,
      role: "STUDENT", content: `回答 ${sequence}`, source: "TEXT", createdAt,
    })),
  };
}

describe("public discussion snapshot reads", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_PUBLIC_DISCUSSION", "true");
    database.publicDiscussionSession.findFirst.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("shares a running row read across students, projects each identity and reloads after settlement", async () => {
    const gate = deferred<DiscussionRow>();
    const row = discussionRow("shared");
    database.publicDiscussionSession.findFirst.mockReturnValueOnce(gate.promise);
    const reads = Array.from({ length: 30 }, (_, i) => getPublicDiscussionSnapshot("shared", studentClaims(`student-${i}`)));
    await Promise.resolve();
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledOnce();
    gate.resolve(row);
    const snapshots = await Promise.all(reads);
    expect(snapshots.map((snapshot) => snapshot.session?.isCurrentStudent)).toEqual(
      Array.from({ length: 30 }, (_, i) => i === 7),
    );
    for (const snapshot of snapshots) {
      expect(snapshot.teacher).toBeUndefined();
      expect(snapshot.session?.turns.map((turn) => turn.sequence)).toEqual([1, 2, 3]);
      expect(snapshot.session?.createdAt).toBe(row.createdAt.toISOString());
    }
    snapshots[0].session!.turns[0].content = "local edit";
    expect(snapshots[1].session!.turns[0].content).toBe("回答 1");
    expect(row.turns[0].content).toBe("回答 1");
    database.publicDiscussionSession.findFirst.mockResolvedValueOnce(discussionRow("shared", 2));
    expect((await getPublicDiscussionSnapshot("shared", studentClaims("student-7"))).session?.version).toBe(2);
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(2);
  });

  it("keeps different courses separate and shares the complete ended-session fallback", async () => {
    const first = deferred<DiscussionRow | null>();
    const second = deferred<DiscussionRow | null>();
    database.publicDiscussionSession.findFirst.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = getPublicDiscussionSnapshot("course-a", studentClaims("student-1"));
    const b = getPublicDiscussionSnapshot("course-b", studentClaims("student-2"));
    await Promise.resolve();
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(2);
    first.resolve(discussionRow("course-a"));
    second.resolve(discussionRow("course-b"));
    expect((await a).session?.courseId).toBe("course-a");
    expect((await b).session?.courseId).toBe("course-b");

    const ended = { ...discussionRow("ended"), status: "ENDED", endedAt: new Date("2026-10-17T00:01:00.000Z") };
    database.publicDiscussionSession.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(ended);
    const snapshots = await Promise.all([
      getPublicDiscussionSnapshot("ended", studentClaims("student-1")),
      getPublicDiscussionSnapshot("ended", studentClaims("student-7")),
    ]);
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(4);
    expect(snapshots.map((snapshot) => snapshot.session?.status)).toEqual(["ended", "ended"]);
    expect(snapshots[1].session?.turns).toHaveLength(3);
    expect(snapshots[1].session?.endedAt).toBe(ended.endedAt.toISOString());
  });

  it("shares a current failure without preventing a later successful read", async () => {
    const gate = deferred<DiscussionRow>();
    database.publicDiscussionSession.findFirst.mockReturnValueOnce(gate.promise);
    const settled = Promise.allSettled([
      getPublicDiscussionSnapshot("failed", studentClaims("student-1")),
      getPublicDiscussionSnapshot("failed", studentClaims("student-2")),
    ]);
    gate.reject(new Error("database unavailable"));
    const results = await settled;
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "database unavailable" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "database unavailable" }) },
    ]);
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledOnce();
    database.publicDiscussionSession.findFirst.mockResolvedValueOnce(discussionRow("failed", 2));
    expect((await getPublicDiscussionSnapshot("failed", studentClaims("student-1"))).session?.version).toBe(2);
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(2);
  });

  it("expires a hung join and keeps the replacement in flight when the old read settles", async () => {
    vi.useFakeTimers();
    const old = deferred<DiscussionRow>(), fresh = deferred<DiscussionRow>();
    database.publicDiscussionSession.findFirst.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = getPublicDiscussionSnapshot("expired", studentClaims("student-1"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_001);
    const second = getPublicDiscussionSnapshot("expired", studentClaims("student-2"));
    await Promise.resolve();
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(2);
    old.resolve(discussionRow("expired", 1));
    expect((await first).session?.version).toBe(1);
    const third = getPublicDiscussionSnapshot("expired", studentClaims("student-7"));
    await Promise.resolve();
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(2);
    fresh.resolve(discussionRow("expired", 2));
    expect((await Promise.all([second, third])).map((snapshot) => snapshot.session?.version)).toEqual([2, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads each teacher request independently and evaluates sound ownership and expiry per caller", async () => {
    vi.useFakeTimers();
    const row = discussionRow("teacher");
    vi.setSystemTime(row.createdAt);
    database.publicDiscussionSession.findFirst.mockResolvedValue(row);
    const claims: TeacherClaims = { sub: "teacher", role: "teacher", username: "teacher", displayName: "教师", sv: 1 };
    const [owner, other] = await Promise.all([
      getPublicDiscussionSnapshot("teacher", claims, "sound-client-a"),
      getPublicDiscussionSnapshot("teacher", claims, "sound-client-b"),
    ]);
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(2);
    expect(owner.teacher?.soundOwner).toBe(true);
    expect(other.teacher?.soundOwner).toBe(false);
    expect(owner.teacher?.candidates).toHaveLength(1);
    vi.setSystemTime(row.soundLeaseUntil!.getTime() + 1);
    expect((await getPublicDiscussionSnapshot("teacher", claims, "sound-client-a")).teacher?.soundOwner).toBe(false);
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledTimes(3);
  });

  it("does not read or retain a disabled feature response", async () => {
    vi.stubEnv("ENABLE_PUBLIC_DISCUSSION", "false");
    expect(await getPublicDiscussionSnapshot("disabled", studentClaims("student-1"))).toEqual({ enabled: false });
    expect(database.publicDiscussionSession.findFirst).not.toHaveBeenCalled();
    vi.stubEnv("ENABLE_PUBLIC_DISCUSSION", "true");
    database.publicDiscussionSession.findFirst.mockResolvedValueOnce(discussionRow("disabled"));
    expect((await getPublicDiscussionSnapshot("disabled", studentClaims("student-1"))).session).toBeDefined();
    expect(database.publicDiscussionSession.findFirst).toHaveBeenCalledOnce();
  });
});

function attempt(studentId: string, earned: number, answer: string): StudentAiProgress {
  const quiz: KnowledgeLectureAttempt = {
    id: `attempt-${studentId}`,
    sectionId: "section-1",
    quizOutlineId: "quiz-1",
    runtimeSceneId: "scene-1",
    submittedAt: "2026-09-16T00:00:00.000Z",
    score: earned,
    maxScore: 10,
    knowledgePointIds: ["kp-1"],
    questions: [{
      questionId: `question-${studentId}`,
      prompt: "请说明判断依据",
      answer,
      points: 10,
      earned,
      correct: earned >= 8,
      feedback: "请核对概念与证据。",
      knowledgePointIds: ["kp-1"],
    }],
  };
  return {
    classroomId: "course-1",
    studentId,
    currentSceneIndex: 1,
    totalScenes: 2,
    completedScenes: [],
    lastActiveAt: "2026-09-16T00:00:00.000Z",
    masteryLevel: "in-progress",
    knowledgeLectureAttempts: [quiz],
  };
}

function course(): Course {
  return {
    id: "course-1",
    name: "公开讨论模拟课堂",
    subject: "科学",
    grade: "八年级",
    hours: 1,
    summary: "",
    drivingQuestion: "证据怎样支持结论？",
    status: "teaching",
    stages: [],
    currentStageIndex: 0,
    content: { knowledgePoints: [{ id: "kp-1", name: "证据链", description: "" }] },
    students: [
      { id: "student-a", name: "安同学", joinedAt: "2026-09-16T00:00:00.000Z", stageProgress: {} },
      { id: "student-b", name: "白同学", joinedAt: "2026-09-16T00:00:00.000Z", stageProgress: {} },
      { id: "student-c", name: "陈同学", joinedAt: "2026-09-16T00:00:00.000Z", stageProgress: {} },
    ],
    aiLearningProgress: {
      "student-a": attempt("student-a", 2, "只要结论正确就算有证据"),
      "student-b": attempt("student-b", 7, "实验记录可以支持结论"),
      "student-c": attempt("student-c", 2, "只要结论正确就算有证据"),
    },
  } as unknown as Course;
}

describe("public discussion candidate selection", () => {
  it("only recommends online students and prioritizes representative misunderstanding for inquiry", () => {
    const ranked = rankDiscussionCandidates(
      course(),
      "kp-1",
      "inquiry",
      new Set(["student-a", "student-b"]),
    );

    expect(ranked.map((candidate) => candidate.studentId)).toEqual(["student-a", "student-b"]);
    expect(ranked[0]).toMatchObject({ online: true, evidence: expect.stringContaining("结论正确") });
  });

  it("uses lower prior participation as the tie breaker for comparable evidence", () => {
    const ranked = rankDiscussionCandidates(
      course(),
      "kp-1",
      "inquiry",
      new Set(["student-a", "student-c"]),
      new Map([["student-a", 2], ["student-c", 0]]),
    );

    expect(ranked.map((candidate) => candidate.studentId)).toEqual(["student-c", "student-a"]);
    expect(rankDiscussionCandidates(course(), "kp-1", "debate", new Set())).toEqual([]);
  });
});

describe("public discussion stale async result guard", () => {
  const current = { version: 7, status: "AI_GENERATING", currentStudentId: "student-a" };

  it("accepts only the generation that still owns the same state and student", () => {
    expect(canApplyDiscussionAsyncResult(current, {
      version: 7,
      status: "AI_GENERATING",
      studentId: "student-a",
    })).toBe(true);
    expect(canApplyDiscussionAsyncResult(current, {
      version: 6,
      status: "AI_GENERATING",
      studentId: "student-a",
    })).toBe(false);
    expect(canApplyDiscussionAsyncResult(current, {
      version: 7,
      status: "PAUSED",
      studentId: "student-a",
    })).toBe(false);
    expect(canApplyDiscussionAsyncResult(current, {
      version: 7,
      status: "AI_GENERATING",
      studentId: "student-b",
    })).toBe(false);
  });
});

describe("public discussion voice-loop state helpers", () => {
  it("allows a second recording after ASR failure and for legacy confirmation sessions", () => {
    expect(canStartDiscussionRecording("AWAITING_STUDENT")).toBe(true);
    expect(canStartDiscussionRecording("AWAITING_RETRY")).toBe(true);
    expect(canStartDiscussionRecording("AWAITING_CONFIRMATION")).toBe(true);
    expect(canStartDiscussionRecording("AI_GENERATING")).toBe(false);
  });

  it("waits for the student after a follow-up and for the teacher after a completion recommendation", () => {
    expect(discussionStatusAfterPlayback("AI_READY")).toBe("AWAITING_STUDENT");
    expect(discussionStatusAfterPlayback("AI_COMPLETION_READY")).toBe("AWAITING_TEACHER_CONFIRMATION");
    expect(discussionStatusAfterPlayback("AI_FAILED")).toBeUndefined();
  });

  it("parses the model decision and enforces the third-round limit", () => {
    expect(parseAssistantDecision('{"reply":"再举一个例子。","decision":"continue"}', 1)).toEqual({
      reply: "再举一个例子。",
      decision: "continue",
    });
    expect(parseAssistantDecision('{"reply":"你的解释已经完整。","decision":"recommend_end"}', 2)).toEqual({
      reply: "你的解释已经完整。",
      decision: "recommend_end",
    });
    expect(parseAssistantDecision('{"reply":"还可以继续。","decision":"continue"}', 3)).toEqual({
      reply: "还可以继续。",
      decision: "recommend_end",
    });
    expect(parseAssistantDecision('{"reply":"继续做迁移说明。","decision":"recommend_end"}', 2, true)).toEqual({
      reply: "继续做迁移说明。",
      decision: "continue",
    });
  });
});
