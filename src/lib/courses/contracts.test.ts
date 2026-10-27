import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema } from "./contracts";

const requestId = "018f47a2-89d4-7c12-a4f4-18f244f6ec0b";

describe("ActionEnvelopeSchema", () => {
  it("accepts a bounded, valid progress update", () => {
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPDATE_STUDENT_PROGRESS",
        payload: {
          courseId: "course-1",
          studentId: "student-1",
          stageKey: "research",
          value: 75,
        },
      },
    }).success).toBe(true);
  });

  it("accepts a student code artifact submission", () => {
    const now = new Date().toISOString();
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPSERT_SUBMISSION",
        payload: {
          courseId: "course-1",
          submission: {
            id: "submission-1",
            courseId: "course-1",
            studentId: "student-1",
            studentName: "学生",
            stageKey: "make",
            type: "code",
            title: "Python 项目代码",
            content: JSON.stringify({ version: 1, language: "python", activeFileId: "main", files: [] }),
            status: "draft",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    }).success).toBe(true);
  });

  it("accepts only untrusted AI source hints and rejects forged verified provenance", () => {
    const now = new Date().toISOString();
    const payload = { courseId: "course-1", submission: { id: "draft", courseId: "course-1", studentId: "student", stageKey: "make", type: "code", title: "code", content: "code", status: "draft", createdAt: now, updatedAt: now }, aiRevisionSource: { requestId: "r", action: "adopted", beforeContentHash: "a".repeat(64), afterContentHash: "b".repeat(64) } };
    expect(ActionEnvelopeSchema.safeParse({ requestId, action: { type: "UPSERT_SUBMISSION", payload } }).success).toBe(true);
    expect(ActionEnvelopeSchema.safeParse({ requestId, action: { type: "UPSERT_SUBMISSION", payload: { ...payload, verifiedAiRevision: { status: "verified", eventId: "forged" } } } }).success).toBe(false);
    expect(ActionEnvelopeSchema.safeParse({ requestId, action: { type: "UPSERT_SUBMISSION", payload: { ...payload, aiRevisionSource: { ...payload.aiRevisionSource, before: "unbounded" } } } }).success).toBe(false);
  });

  it("accepts the structured five-stage reflection response", () => {
    const now = new Date().toISOString();
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPSERT_REFLECTION",
        payload: {
          courseId: "course-1",
          reflection: {
            id: "reflection-1",
            courseId: "course-1",
            studentId: "student-1",
            studentName: "学生",
            content: "【课程收获】\n完成了一次迭代",
            survey: {
              schemaVersion: 1,
              learningReflection: "完成了一次迭代",
              systemReflection: "AI 提问有帮助",
              aiHelpfulness: 4,
              systemUsability: 5,
              reuseIntention: 4,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    }).success).toBe(true);
  });

  it("rejects invalid progress, unknown actions, and non-UUID request IDs", () => {
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPDATE_STUDENT_PROGRESS",
        payload: {
          courseId: "course-1",
          studentId: "student-1",
          stageKey: "research",
          value: 101,
        },
      },
    }).success).toBe(false);
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: { type: "UNSAFE_ACTION", payload: {} },
    }).success).toBe(false);
    expect(ActionEnvelopeSchema.safeParse({
      requestId: "not-a-uuid",
      action: { type: "SET_UI_STATE", payload: {} },
    }).success).toBe(false);
  });

  it("validates the bounded projection control payload", () => {
    const valid = ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "SET_UI_STATE",
        payload: {
          courseId: "course-1",
          projectionControl: { clientId: "tab", baseStageVersion: 2, stageKey: "launch" },
          patch: { resourceProjection: null },
        },
      },
    });
    const invalid = ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "SET_UI_STATE",
        payload: {
          courseId: "course-1",
          patch: {
            resourceProjection: {
              resourceId: "resource-1",
              stageKey: "launch",
              title: "视频",
              startedAt: "not-a-date",
            },
          },
        },
      },
    });
    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it.each([
    undefined,
    { clientId: "old-tab" },
    { clientId: "tab", baseStageVersion: 0, stageKey: "launch" },
    { clientId: "tab", baseStageVersion: 1, stageKey: "" },
  ])("rejects projection commands without a valid classroom stage token (%#)", projectionControl => {
    expect(ActionEnvelopeSchema.safeParse({ requestId, action: { type: "SET_UI_STATE", payload: {
      courseId: "course-1", projectionControl, patch: { resourceProjection: null },
    } } }).success).toBe(false);
  });

  it("rejects incomplete survey scores or answers", () => {
    const now = new Date().toISOString();
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPSERT_REFLECTION",
        payload: {
          courseId: "course-1",
          reflection: {
            id: "reflection-1",
            courseId: "course-1",
            studentId: "student-1",
            studentName: "学生",
            content: "内容",
            survey: {
              schemaVersion: 1,
              learningReflection: "",
              systemReflection: "体验",
              aiHelpfulness: 4,
              systemUsability: 5,
              reuseIntention: 4,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    }).success).toBe(false);
  });
});

describe("conditional classroom timer initialization", () => {
  const payload = { courseId: "course-1", patch: {},
    intent: { type: "initialize-classroom-timing", baseStageVersion: 4, stageKey: "launch" } };
  const parse = (value: unknown) => ActionEnvelopeSchema.safeParse({ requestId, expectedVersion: 1,
    action: { type: "SET_UI_STATE", payload: value } });
  it("accepts the explicit empty-patch intent and keeps ordinary old-client UI edits valid", () => {
    expect(parse(payload).success).toBe(true);
    expect(parse({ courseId: "course-1", patch: { classroomTiming: { schemaVersion: 1, status: "paused", stages: [] } } }).success).toBe(true);
  });
  it.each([
    { ...payload, patch: { resourceProjection: null } },
    { ...payload, patch: { classroomTiming: { schemaVersion: 1 } } },
    { ...payload, projectionControl: { clientId: "browser" } },
    { ...payload, intent: { ...payload.intent, baseStageVersion: 0 } },
    { ...payload, intent: { ...payload.intent, baseStageVersion: Number.MAX_SAFE_INTEGER + 1 } },
    { ...payload, intent: { ...payload.intent, stageKey: "" } },
    { ...payload, intent: { ...payload.intent, type: "replace-classroom-timing" } },
    { ...payload, intent: { ...payload.intent, classroomTiming: {} } },
  ])("rejects mixed patches, invalid stage tokens and unknown intent fields (%#)", value => {
    expect(parse(value).success).toBe(false);
  });
});
