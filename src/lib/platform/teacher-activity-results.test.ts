import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  teacher: vi.fn(), auth: vi.fn(), activity: vi.fn(), teacherLink: vi.fn(), enrollments: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  activity: { findUnique: mocks.activity },
  courseTeacher: { findFirst: mocks.teacherLink },
  enrollment: { findMany: mocks.enrollments },
} }));
vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));

import { getTeacherActivityResults } from "./teacher-activity-results";
import { createCoTeachPostTestTemplate } from "./posttest";
import { GET } from "@/app/api/platform/activities/[activityId]/results/route";

const claims = { sub: "teacher", role: "teacher" } as AuthClaims;
const at = new Date("2026-10-20T03:00:00.000Z");
const quizConfig = { schemaVersion: 1, content: "说明", questions: [{ id: "q1", title: "说明你的理解", required: true }] };
const activity = {
  id: "activity", type: "QUIZ", title: "本节测验", description: "按实际理解回答", version: 4,
  config: quizConfig, isOpen: true, opensAt: null, archivedAt: null,
  chapter: { id: "chapter", title: "第一章", offeringId: "offering", isOpen: true, opensAt: null, archivedAt: null, offering: { id: "offering", name: "教学设计", status: "OPEN" } },
};
const quizSubmission = {
  id: "latest", activityVersion: 2,
  activitySnapshot: { type: "QUIZ", title: "原测验", config: quizConfig, version: 2 },
  payload: { answers: { q1: "原始理解" }, submittedAt: at.toISOString() },
  submittedAt: at,
};

function progress(overrides: Record<string, unknown> = {}) {
  return { status: "IN_PROGRESS", startedAt: at, completedAt: null, lastAccessedAt: at, progressData: null, ...overrides };
}
function member(id: string, submissions: unknown[] = [], activityProgress: unknown[] = []) {
  return { id, user: { id: `user-${id}`, displayName: `学生${id}`, username: `student-${id}` }, submissions, activityProgress };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
  mocks.activity.mockResolvedValue(activity);
  mocks.teacherLink.mockResolvedValue({ id: "teacher-link" });
  mocks.enrollments.mockResolvedValue([]);
  mocks.auth.mockResolvedValue({ claims });
});

describe("teacher activity results authorization and roster", () => {
  it("checks teaching membership before reading any student answers", async () => {
    mocks.teacherLink.mockResolvedValue(null);
    await expect(getTeacherActivityResults(claims, "activity")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.teacher).toHaveBeenCalledWith(claims, expect.anything());
    expect(mocks.teacherLink).toHaveBeenCalledWith({ where: { offeringId: "offering", userId: "teacher" } });
    expect(mocks.enrollments).not.toHaveBeenCalled();
  });

  it("returns a complete empty result and only supports quizzes and independent posttests", async () => {
    expect(await getTeacherActivityResults(claims, "activity")).toEqual({
      activity: { id: "activity", title: "本节测验", type: "Quiz", description: "按实际理解回答", isOpen: true, questionCount: 1, chapter: { id: "chapter", title: "第一章" }, offering: { id: "offering", name: "教学设计" } },
      summary: { totalStudents: 0, notStartedCount: 0, inProgressCount: 0, submittedCount: 0 }, students: [],
    });
    mocks.activity.mockResolvedValue({ ...activity, type: "FORM" });
    mocks.enrollments.mockClear();
    await expect(getTeacherActivityResults(claims, "activity")).rejects.toMatchObject({ code: "INVALID_ACTIVITY", status: 400 });
    expect(mocks.enrollments).not.toHaveBeenCalled();
  });

  it("uses one eligible roster for the denominator, student names and each student's latest formal answer", async () => {
    const roster = [
      { ...member("a", [quizSubmission]), offeringId: "offering", status: "ACTIVE" },
      { ...member("b"), offeringId: "offering", status: "completed" },
      { ...member("withdrawn", [quizSubmission]), offeringId: "offering", status: "WITHDRAWN" },
      { ...member("other", [quizSubmission]), offeringId: "other-course", status: "ACTIVE" },
    ];
    mocks.enrollments.mockImplementation(({ where }) => roster.filter((entry) => entry.offeringId === where.offeringId && where.status.in.includes(entry.status)));
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.summary).toEqual({ totalStudents: 2, notStartedCount: 1, inProgressCount: 0, submittedCount: 1 });
    expect(result.students.map((entry) => entry.student.id)).toEqual(["user-a", "user-b"]);
    expect(mocks.enrollments).toHaveBeenCalledWith(expect.objectContaining({
      where: { offeringId: "offering", status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } },
      select: expect.objectContaining({
        user: { select: { id: true, displayName: true, username: true } },
        submissions: expect.objectContaining({ where: { activityId: "activity" }, take: 1, orderBy: [{ submittedAt: "desc" }, { id: "desc" }] }),
        activityProgress: expect.objectContaining({ where: { activityId: "activity" }, take: 1 }),
      }),
    }));
    expect(result.students[0].submission?.id).toBe("latest");
  });

  it("distinguishes untouched progress, current drafts and formal submissions", async () => {
    mocks.enrollments.mockResolvedValue([
      member("untouched", [], [progress({ status: "NOT_STARTED", startedAt: null, lastAccessedAt: null })]),
      member("draft", [], [progress({ progressData: { posttestDraft: { answers: { q1: "草稿" } } } })]),
      member("submitted", [quizSubmission], [progress()]),
    ]);
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.summary).toEqual({ totalStudents: 3, notStartedCount: 1, inProgressCount: 1, submittedCount: 1 });
    expect(result.students.map((entry) => entry.status)).toEqual(["not-started", "in-progress", "submitted"]);
    expect(result.students[1].submission).toBeNull();
  });

  it.each([
    { ...activity, isOpen: false },
    { ...activity, chapter: { ...activity.chapter, isOpen: false } },
    { ...activity, opensAt: new Date("2099-01-01") },
    { ...activity, chapter: { ...activity.chapter, offering: { ...activity.chapter.offering, status: "FINISHED" } } },
  ])("reports collection as closed when the activity cannot accept answers", async (closed) => {
    mocks.activity.mockResolvedValue(closed);
    mocks.enrollments.mockResolvedValue([member("student", [quizSubmission])]);
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.activity.isOpen).toBe(false);
    expect(result.summary.submittedCount).toBe(1);
  });
});

describe("teacher formal answer snapshots", () => {
  it("shows each quiz's original long question text even after the teacher edits the same question id", async () => {
    const longPrompt = "请依据案例解释教学关系。".repeat(100);
    const old = { ...quizSubmission, activitySnapshot: { ...quizSubmission.activitySnapshot, config: { questions: [{ id: "q1", title: longPrompt, correctAnswer: "原参考答案" }] } } };
    mocks.activity.mockResolvedValue({ ...activity, config: { questions: [{ id: "q1", title: "修改后的新问题" }, { id: "q2", title: "新增题" }] } });
    mocks.enrollments.mockResolvedValue([member("student", [old])]);
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.activity.questionCount).toBe(2);
    expect(result.students[0].submission).toMatchObject({ activityVersion: 2, snapshotSource: "submission", questions: [{ id: "q1", prompt: longPrompt, type: "short-answer", correctAnswer: "原参考答案" }], answers: { q1: "原始理解" }, objectiveScore: null, objectiveTotal: null });
  });

  it("preserves the full 54-question posttest, authored groups, reference answers and saved objective scores", async () => {
    const config = createCoTeachPostTestTemplate();
    config.questions[0].correctAnswer = config.questions[0].options![0];
    const answers = Object.fromEntries(config.questions.filter((question) => !question.optional).map((question, index) => [question.id, question.type === "scale" ? "4" : index === 0 ? question.correctAnswer : "不知道"]));
    const row = { ...quizSubmission, activitySnapshot: { type: "POSTTEST", title: "后测", version: 2, config }, payload: { answers, objectiveScore: 1, objectiveTotal: 1 } };
    mocks.activity.mockResolvedValue({ ...activity, type: "POSTTEST", config });
    mocks.enrollments.mockResolvedValue([member("student", [row])]);
    const result = await getTeacherActivityResults(claims, "activity");
    const saved = result.students[0].submission!;
    expect(result.activity).toMatchObject({ type: "PostTest", questionCount: 54 });
    expect(result.summary).toMatchObject({ submittedCount: 1, inProgressCount: 0 });
    expect(saved).toMatchObject({ snapshotSource: "submission", objectiveScore: 1, objectiveTotal: 1, answers });
    expect(saved.questions).toHaveLength(54);
    expect(saved.questions.map((question) => question.group)).toEqual(config.questions.map((question) => question.group));
    expect(saved.questions[0].correctAnswer).toBe(config.questions[0].correctAnswer);
    expect(saved.questions.at(-1)).toMatchObject({ id: "F01", optional: true });
  });

  it("keeps a free-text quiz answer without inventing a question or score", async () => {
    const row = { ...quizSubmission, activitySnapshot: { ...quizSubmission.activitySnapshot, config: null }, payload: { answer: "对本课的完整回答", answers: {} } };
    mocks.activity.mockResolvedValue({ ...activity, config: null });
    mocks.enrollments.mockResolvedValue([member("student", [row])]);
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.activity.questionCount).toBe(0);
    expect(result.students[0].submission).toMatchObject({ questions: [], answer: "对本课的完整回答", answers: {}, objectiveScore: null, objectiveTotal: null });
  });

  it("retains all five posttest question types and genuine multiple-choice answer arrays", async () => {
    const config = { schemaVersion: 1, content: "", questions: [
      { id: "single", type: "single-choice", prompt: "单选", options: ["甲", "乙"], correctAnswer: "甲" },
      { id: "multiple", type: "multiple-choice", prompt: "多选", options: ["甲", "乙", "丙"], correctAnswer: ["甲", "丙"] },
      { id: "judgment", type: "true-false", prompt: "判断", correctAnswer: "true" },
      { id: "explain", type: "short-answer", prompt: "解释", correctAnswer: "参考解释" },
      { id: "rating", type: "scale", prompt: "体验", scale: { min: 0, max: 10 } },
    ] };
    const answers = { single: "甲", multiple: ["甲", "丙"], judgment: "true", explain: "实际解释", rating: "10" };
    mocks.activity.mockResolvedValue({ ...activity, type: "POSTTEST", config });
    mocks.enrollments.mockResolvedValue([member("student", [{ ...quizSubmission, activitySnapshot: { type: "POSTTEST", config, version: 2 }, payload: { answers, objectiveScore: 3, objectiveTotal: 3 } }])]);
    const saved = (await getTeacherActivityResults(claims, "activity")).students[0].submission!;
    expect(saved.questions.map((question) => question.type)).toEqual(["single-choice", "multiple-choice", "true-false", "short-answer", "scale"]);
    expect(saved.questions[1]).toMatchObject({ options: ["甲", "乙", "丙"], correctAnswer: ["甲", "丙"] });
    expect(saved).toMatchObject({ answers, objectiveScore: 3, objectiveTotal: 3 });
  });

  it.each([
    { ...quizSubmission, activitySnapshot: null },
    { ...quizSubmission, activitySnapshot: { ...quizSubmission.activitySnapshot, version: 99 } },
    { ...quizSubmission, activitySnapshot: { ...quizSubmission.activitySnapshot, config: { questions: [{ id: "q1" }] } } },
    { ...quizSubmission, payload: { answers: { q1: { selected: "伪装对象" } } } },
    { ...quizSubmission, payload: { answers: { q1: ["真实文字", 7] } } },
    { ...quizSubmission, payload: { answers: { q1: true } } },
    { ...quizSubmission, payload: {} },
  ])("keeps a diagnostic for invalid persisted records instead of falling back to current questions", async (row) => {
    mocks.enrollments.mockResolvedValue([member("student", [row], [progress({ status: "COMPLETED", completedAt: at, progressData: { answers: { q1: "旧投影" } } })])]);
    await expect(getTeacherActivityResults(claims, "activity")).rejects.toMatchObject({ code: "INVALID_ACTIVITY_SUBMISSION", status: 409, details: { submissionId: "latest", reason: expect.any(String) } });
  });

  it("does not turn missing or malformed posttest scores into zero scores", async () => {
    const config = { schemaVersion: 1, content: "", questions: [{ id: "q1", type: "short-answer", prompt: "解释方法" }] };
    mocks.activity.mockResolvedValue({ ...activity, type: "POSTTEST", config });
    const row = { ...quizSubmission, activitySnapshot: { type: "POSTTEST", config, version: 2 }, payload: { answers: { q1: "方法" } } };
    mocks.enrollments.mockResolvedValue([member("student", [row])]);
    await expect(getTeacherActivityResults(claims, "activity")).rejects.toMatchObject({ code: "INVALID_ACTIVITY_SUBMISSION", details: { submissionId: "latest", reason: "后测客观评分记录无效" } });
  });
});

describe("legacy quiz completion evidence", () => {
  it("recovers only completed quiz answers and clearly labels the absence of a historical snapshot", async () => {
    mocks.enrollments.mockResolvedValue([member("student", [], [progress({ status: "COMPLETED", completedAt: at, progressData: { answers: { q1: "旧版真实回答" } } })])]);
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.summary).toMatchObject({ submittedCount: 1, inProgressCount: 0 });
    expect(result.students[0].submission).toMatchObject({ id: "legacy:student:activity", submittedAt: at.toISOString(), activityVersion: 4, snapshotSource: "legacy", answers: { q1: "旧版真实回答" }, questions: [{ id: "q1", prompt: "说明你的理解", type: "short-answer" }] });
  });

  it.each([
    progress({ status: "IN_PROGRESS", completedAt: at, progressData: { answers: { q1: "草稿" } } }),
    progress({ status: "COMPLETED", completedAt: null, progressData: { answers: { q1: "草稿" } } }),
    progress({ status: "COMPLETED", completedAt: at, progressData: { posttestDraft: { answers: { q1: "草稿" } } } }),
    progress({ status: "COMPLETED", completedAt: at, progressData: { answer: "", answers: { q1: [], q2: " " } } }),
  ])("does not count incomplete, draft-only or empty progress as a formal quiz answer", async (entry) => {
    mocks.enrollments.mockResolvedValue([member("student", [], [entry])]);
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.summary).toMatchObject({ submittedCount: 0, inProgressCount: 1 });
    expect(result.students[0].submission).toBeNull();
  });

  it("never treats posttest progress as a legacy submission even when it claims to be completed", async () => {
    mocks.activity.mockResolvedValue({ ...activity, type: "POSTTEST", config: createCoTeachPostTestTemplate() });
    mocks.enrollments.mockResolvedValue([member("student", [], [progress({ status: "COMPLETED", completedAt: at, progressData: { answers: { q1: "旧投影" }, answer: "答案" } })])]);
    const result = await getTeacherActivityResults(claims, "activity");
    expect(result.summary).toMatchObject({ submittedCount: 0, inProgressCount: 1 });
    expect(result.students[0].submission).toBeNull();
  });

  it("preserves a real top-level free-text legacy answer", async () => {
    mocks.activity.mockResolvedValue({ ...activity, config: null });
    mocks.enrollments.mockResolvedValue([member("student", [], [progress({ status: "COMPLETED", completedAt: at, progressData: { answer: "旧版整篇回答" } })])]);
    const saved = (await getTeacherActivityResults(claims, "activity")).students[0].submission;
    expect(saved).toMatchObject({ questions: [], answer: "旧版整篇回答", answers: {}, snapshotSource: "legacy", submittedAt: at.toISOString() });
  });

  it("uses the latest formal submission in preference to a newer progress projection", async () => {
    mocks.enrollments.mockResolvedValue([member("student", [quizSubmission], [progress({ status: "COMPLETED", completedAt: new Date("2026-10-21"), progressData: { answers: { q1: "后续投影" } } })])]);
    expect((await getTeacherActivityResults(claims, "activity")).students[0].submission).toMatchObject({ id: "latest", answers: { q1: "原始理解" }, snapshotSource: "submission" });
  });
});

describe("teacher activity result route", () => {
  const context = { params: Promise.resolve({ activityId: "activity" }) };
  const request = () => new Request("http://localhost/api/platform/activities/activity/results");

  it("requires teacher authentication before accessing results", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "teacher");
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(mocks.enrollments).not.toHaveBeenCalled();
  });

  it("returns private uncached data and preserves authorization and record diagnostics", async () => {
    const response = await GET(request(), context);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ activity: { type: "Quiz" }, summary: { totalStudents: 0 } });
    mocks.teacherLink.mockResolvedValue(null);
    const denied = await GET(request(), context);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "FORBIDDEN" });
    mocks.teacherLink.mockResolvedValue({ id: "link" });
    mocks.enrollments.mockResolvedValue([member("student", [{ ...quizSubmission, payload: { answers: { q1: 4 } } }])]);
    const invalid = await GET(request(), context);
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_ACTIVITY_SUBMISSION", details: { submissionId: "latest", reason: expect.any(String) } });
  });

  it("returns an infrastructure error without inventing an empty result", async () => {
    mocks.enrollments.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ACTIVITY_RESULTS_UNAVAILABLE" });
  });
});
