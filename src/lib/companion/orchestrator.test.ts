import { describe, expect, it } from "vitest";
import type { CompanionThread, TeacherAgentDirective } from "@/lib/session/types";
import { activeDirectivesForStudent, isSubstantiallyRepeatedResponse, maxSpeakersForTurn, recorderVisibility, shouldAllowProactiveIntervention, shouldProactivelyReviewArtifact, shouldSendStageOpening, shouldUseReviewer } from "./orchestrator";

const thread: CompanionThread = { id: "thread-1", courseId: "course-1", studentId: "student-1", stageKey: "proposal", messages: [], createdAt: "2026-07-11T10:00:00.000Z", updatedAt: "2026-07-11T10:00:00.000Z" };

describe("companion orchestrator policies", () => {
  it("sends only one opening per student and stage", () => {
    expect(shouldSendStageOpening(thread)).toBe(true);
    expect(shouldSendStageOpening({ ...thread, openingSentAt: "2026-07-11T10:01:00.000Z" })).toBe(false);
  });

  it("keeps automatic recorder summaries teacher-only to avoid duplicate student messages", () => {
    expect(recorderVisibility("idle")).toBe("teacher-only");
    expect(recorderVisibility("milestone")).toBe("teacher-only");
    expect(recorderVisibility("no-progress")).toBe("teacher-only");
  });

  it("activates reviewer for artifact changes and milestones", () => {
    expect(shouldUseReviewer("artifact-stalled")).toBe(true);
    expect(shouldUseReviewer("milestone")).toBe(true);
    expect(shouldUseReviewer("idle")).toBe(false);
  });

  it("applies active course and student directives until completed or revoked", () => {
    const base: TeacherAgentDirective = { id: "d1", courseId: "course-1", stageKey: "proposal", targetStudentIds: [], targetScope: "course", goal: "补充证据", instruction: "引导学生找到证据", successCriteria: ["产物包含证据"], status: "active", teacherName: "教师", createdAt: "2026-07-11T10:00:00.000Z", updatedAt: "2026-07-11T10:00:00.000Z" };
    expect(activeDirectivesForStudent([base, { ...base, id: "d2", targetScope: "student", targetStudentIds: ["student-2"] }], "student-1", "proposal").map((item) => item.id)).toEqual(["d1"]);
  });

  it("limits proactive turns to one speaker and only allows a second role when requested", () => {
    expect(maxSpeakersForTurn("stage-opening", "告诉我下一步")).toBe(1);
    expect(maxSpeakersForTurn(undefined, "帮我检查方案")).toBe(1);
    expect(maxSpeakersForTurn(undefined, "请从两个角度分别检查方案")).toBe(2);
  });

  it("throttles low-priority reminders without delaying milestones", () => {
    const now = Date.parse("2026-07-15T10:00:00.000Z");
    expect(shouldAllowProactiveIntervention({ kind: "document-saved", now, lastProactiveAt: now - 60_000 })).toBe(false);
    expect(shouldAllowProactiveIntervention({ kind: "document-saved", now, lastProactiveAt: now - 9 * 60_000 })).toBe(true);
    expect(shouldAllowProactiveIntervention({ kind: "milestone", now, lastProactiveAt: now - 1_000 })).toBe(true);
  });

  it("stays quiet for routine saves and reviews milestone submissions or uploads", () => {
    expect(shouldProactivelyReviewArtifact("document-saved", false)).toBe(false);
    expect(shouldProactivelyReviewArtifact("document-saved", true)).toBe(true);
    expect(shouldProactivelyReviewArtifact("file-uploaded", false)).toBe(true);
  });

  it("detects a later role that substantially repeats an earlier response", () => {
    expect(isSubstantiallyRepeatedResponse(
      "先补充三组测试数据，再记录测试结果，最后根据结果修改方案。",
      ["你现在先补充三组测试数据，记录测试结果，再依据结果修改方案。"],
    )).toBe(true);
    expect(isSubstantiallyRepeatedResponse(
      "先补充三组测试数据并记录结果。",
      ["需要先说明这个方案解决的是哪一个真实问题。"],
    )).toBe(false);
  });
});
