import { describe, expect, it } from "vitest";
import type { LearningEvent, LearningSignal } from "@/lib/session/types";
import {
  aggregateCommonIssues,
  analyzeStudentLearning,
  calculateToleratedDurationSec,
  dedupeLearningEvents,
  isLearningSignalRelevant,
} from "./analyzer";

const BASE_TIME = Date.parse("2026-07-11T10:00:00.000Z");

function event(
  id: string,
  type: LearningEvent["type"],
  offsetMs: number,
  patch: Partial<LearningEvent> = {},
): LearningEvent {
  return {
    id,
    idempotencyKey: patch.idempotencyKey ?? id,
    courseId: "course-1",
    studentId: patch.studentId ?? "student-1",
    stageKey: "ai-learning",
    sceneId: "scene-1",
    type,
    occurredAt: new Date(BASE_TIME + offsetMs).toISOString(),
    ...patch,
  };
}

describe("learning analytics", () => {
  it("deduplicates retried events by idempotency key", () => {
    const first = event("event-1", "heartbeat", 0, { idempotencyKey: "same", durationMs: 30_000, visible: true });
    const retry = event("event-2", "heartbeat", 1_000, { idempotencyKey: "same", durationMs: 30_000, visible: true });
    expect(dedupeLearningEvents([first, retry])).toEqual([first]);
  });

  it("counts only foreground heartbeat duration and warns only beyond the human-tolerant limit", () => {
    const result = analyzeStudentLearning({
      events: [
        event("enter", "scene-enter", 0),
        event("visible-1", "heartbeat", 30_000, { durationMs: 120_000, visible: true }),
        event("hidden", "heartbeat", 100_000, { durationMs: 500_000, visible: false }),
        event("visible-2", "heartbeat", 220_001, { durationMs: 100_001, visible: true }),
      ],
      expectedDurationSec: 120,
      now: BASE_TIME + 220_001,
    });

    expect(result.metrics.effectiveDurationMs).toBe(220_001);
    expect(result.metrics.toleratedDurationMs).toBe(210_000);
    expect(result.signals).toContainEqual(expect.objectContaining({ kind: "dwell-overrun" }));
  });

  it("does not keep dwell or idle warnings after the student completes or leaves a scene", () => {
    const result = analyzeStudentLearning({
      events: [
        event("enter", "scene-enter", 0),
        event("heartbeat", "heartbeat", 240_000, { durationMs: 240_000, visible: true }),
        event("complete", "scene-complete", 241_000, { progressMarker: "completed" }),
        event("leave", "scene-leave", 242_000),
      ],
      expectedDurationSec: 120,
      now: BASE_TIME + 900_000,
    });
    expect(result.signals).toEqual([]);
  });

  it("hides legacy temporal signals after completion even if they were persisted by an older version", () => {
    const signal: LearningSignal = {
      id: "old", courseId: "course-1", studentId: "student-1", stageKey: "ai-learning",
      sceneId: "scene-1", kind: "dwell-overrun", severity: "warning", status: "open",
      title: "旧告警", summary: "旧告警", normalizedIssueKey: "old", evidenceEventIds: [],
      aiInterventionAttempts: 0, firstDetectedAt: new Date(BASE_TIME).toISOString(), lastDetectedAt: new Date(BASE_TIME).toISOString(),
    };
    expect(isLearningSignalRelevant(signal, [event("leave", "scene-leave", 1_000)], true)).toBe(false);
  });

  it("uses actual TTS and planned student activity as the observable duration floor", () => {
    expect(calculateToleratedDurationSec({
      expectedDurationSec: 120,
      ttsDurationSec: 180,
      plannedStudentActivitySec: 90,
    })).toBe(405);
  });

  it("flags the third replay of an actively open scene", () => {
    const result = analyzeStudentLearning({
      events: [
        event("enter", "scene-enter", 0),
        event("replay-1", "scene-replay", 20_000),
        event("replay-2", "scene-replay", 40_000),
        event("replay-3", "scene-replay", 60_000),
      ],
      expectedDurationSec: 120,
      now: BASE_TIME + 60_000,
    });

    expect(result.metrics.replayCount).toBe(3);
    expect(result.signals).toContainEqual(expect.objectContaining({ kind: "repeated-playback" }));
  });

  it("flags five minutes of inactivity only while the scene remains open", () => {
    const result = analyzeStudentLearning({
      events: [event("enter", "scene-enter", 0)],
      expectedDurationSec: 120,
      now: BASE_TIME + 300_001,
    });
    expect(result.signals).toContainEqual(expect.objectContaining({ kind: "idle" }));
  });

  it("flags four consecutive conversation rounds without progress", () => {
    const result = analyzeStudentLearning({
      events: [event("enter", "stage-enter", 0)],
      expectedDurationSec: 120,
      now: BASE_TIME,
      conversationRounds: [
        { id: "round-1", progressed: false },
        { id: "round-2", progressed: false },
        { id: "round-3", progressed: false },
        { id: "round-4", progressed: false },
      ],
    });
    expect(result.signals).toContainEqual(expect.objectContaining({ kind: "conversation-no-progress" }));
  });

  it("escalates unresolved signals after two AI intervention attempts", () => {
    const result = analyzeStudentLearning({
      events: [event("enter", "scene-enter", 0)],
      expectedDurationSec: 120,
      now: BASE_TIME + 300_001,
      aiInterventionAttempts: 2,
    });
    expect(result.signals.find((signal) => signal.kind === "idle")).toMatchObject({
      severity: "high",
      aiInterventionAttempts: 2,
    });
  });

  it("aggregates only when the same content affects at least 30 percent and two students", () => {
    const makeSignal = (studentId: string, issue = "idle:ai-learning:scene-1"): LearningSignal => ({
      id: `signal-${studentId}`,
      courseId: "course-1",
      studentId,
      stageKey: "ai-learning",
      sceneId: "scene-1",
      kind: "idle",
      severity: "warning",
      status: "open",
      title: "学习停滞",
      summary: "超过三分钟无活动",
      normalizedIssueKey: issue,
      evidenceEventIds: [],
      aiInterventionAttempts: 0,
      firstDetectedAt: new Date(BASE_TIME).toISOString(),
      lastDetectedAt: new Date(BASE_TIME).toISOString(),
    });

    expect(aggregateCommonIssues([0, 1, 2].map((n) => makeSignal(`s-${n}`)), 10)).toHaveLength(1);
    expect(aggregateCommonIssues([0].map((n) => makeSignal(`s-${n}`)), 2)).toHaveLength(0);
    expect(aggregateCommonIssues([makeSignal("s-0")], 1)).toHaveLength(0);
    expect(aggregateCommonIssues([0, 1].map((n) => makeSignal(`s-${n}`)), 2)).toHaveLength(1);
    expect(aggregateCommonIssues(Array.from({ length: 29 }, (_, n) => makeSignal(`s-${n}`)), 100)).toHaveLength(0);
    expect(aggregateCommonIssues(Array.from({ length: 30 }, (_, n) => makeSignal(`s-${n}`)), 100)).toHaveLength(1);
  });

  it("merges comprehension friction by stable knowledge point and counts each student once", () => {
    const signal = (studentId: string, kind: "dwell-overrun" | "repeated-playback", sceneId: string): LearningSignal => ({
      id: `${studentId}-${kind}`,
      courseId: "course-1",
      studentId,
      stageKey: "ai-learning",
      sceneId,
      kind,
      severity: "warning",
      status: "open",
      title: "理解困难",
      summary: kind,
      content: { knowledgePointIds: ["kp-1"] },
      normalizedIssueKey: `${kind}:${sceneId}`,
      evidenceEventIds: [],
      aiInterventionAttempts: 0,
      firstDetectedAt: new Date(BASE_TIME).toISOString(),
      lastDetectedAt: new Date(BASE_TIME).toISOString(),
    });

    const issues = aggregateCommonIssues([
      signal("s-1", "dwell-overrun", "runtime-a"),
      signal("s-1", "repeated-playback", "runtime-b"),
      signal("s-2", "repeated-playback", "runtime-c"),
    ], 5);

    expect(issues).toHaveLength(1);
    expect(issues[0].studentIds).toHaveLength(2);
    expect(issues[0].signalIds).toHaveLength(3);
    expect(issues[0].normalizedIssueKey).toContain("comprehension-friction:ai-learning:kp:kp-1");
  });
});
