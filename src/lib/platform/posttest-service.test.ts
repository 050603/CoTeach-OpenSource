import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => {
  const db = {
    $queryRaw: vi.fn(),
    activity: { findUnique: vi.fn() },
    enrollment: { findUnique: vi.fn() },
    activityProgress: { findUnique: vi.fn(), upsert: vi.fn() },
    activitySubmission: { findFirst: vi.fn(), create: vi.fn() },
  };
  return { db, transaction: vi.fn(), student: vi.fn(), auth: vi.fn(), csrf: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("./access", () => ({ requireStudentUser: mocks.student, requireTeacherUser: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));

import { getStudentPostTestAssessment, savePostTestDraft, submitPostTestAssessment } from "./posttest-service";
import { PostTestConfigSchema, createCoTeachPostTestTemplate } from "./posttest";
import { publicExperimentQuestions } from "./experiment";
import { GET, POST, PUT } from "@/app/api/platform/activities/[activityId]/posttest/route";

const claims = { role: "student", sub: "student" } as AuthClaims;
const config = PostTestConfigSchema.parse({
  schemaVersion: 1,
  content: "请独立作答并按真实体验选择分值。",
  minutes: 15,
  questions: [
    { id: "choice", type: "single-choice", prompt: "哪个选项正确？", options: ["甲", "乙"], correctAnswer: "乙" },
    { id: "multiple", type: "multiple-choice", prompt: "选择两项", options: ["甲", "乙", "丙"], correctAnswer: ["甲", "丙"] },
    { id: "judgment", type: "true-false", prompt: "判断正误", correctAnswer: "true" },
    { id: "explain", type: "short-answer", prompt: "解释方法", correctAnswer: "参考解释" },
    { id: "rating", type: "scale", prompt: "本次学习有帮助", scale: { min: 1, max: 5 }, group: { id: "experience", title: "体验", referenceNote: "教师包括真人教师和 AI。" } },
    { id: "feedback", type: "short-answer", prompt: "意见建议", optional: true },
  ],
});
const version = (value = config) => createHash("sha256").update(JSON.stringify(publicExperimentQuestions(value.questions))).digest("hex");
const answers = { choice: "乙", multiple: ["甲", "丙"], judgment: "true", explain: "解释方法", rating: "4" };
const activity = {
  id: "posttest", type: "POSTTEST", title: "课后测验", version: 3,
  archivedAt: null, isOpen: true, opensAt: null, config,
  chapter: { id: "chapter", offeringId: "offering", archivedAt: null, isOpen: true, opensAt: null, offering: { id: "offering", status: "OPEN" } },
};
const enrollment = { id: "enrollment", offeringId: "offering", status: "ACTIVE", researchKey: "research" };
const submittedAt = new Date("2026-10-19T02:00:00.000Z");
const storedSubmission = {
  id: "submission", enrollmentId: enrollment.id, activityId: activity.id, researchKey: enrollment.researchKey,
  activityVersion: activity.version,
  activitySnapshot: { type: activity.type, title: activity.title, config, version: activity.version },
  payload: { answers, objectiveScore: 3, objectiveTotal: 3, submittedAt: submittedAt.toISOString(), questionVersion: version() },
  submittedAt,
};
const draft = { answers: { choice: "乙" }, currentPage: 1, version: 2, updatedAt: submittedAt.toISOString(), questionVersion: version() };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.student.mockResolvedValue({ id: "student" });
  mocks.transaction.mockImplementation((operation) => operation(mocks.db));
  mocks.db.activity.findUnique.mockResolvedValue(activity);
  mocks.db.enrollment.findUnique.mockResolvedValue(enrollment);
  mocks.db.activityProgress.findUnique.mockResolvedValue(null);
  mocks.db.activitySubmission.findFirst.mockResolvedValue(null);
  mocks.db.activitySubmission.create.mockImplementation(({ data }) => data);
  mocks.db.activityProgress.upsert.mockImplementation(({ create }) => create);
  mocks.auth.mockResolvedValue({ claims });
  mocks.csrf.mockReturnValue(null);
});

describe("independent posttest access and snapshots", () => {
  it("keeps answer keys out of the public question fingerprint and preserves drafts when only grading keys change", async () => {
    const original = await getStudentPostTestAssessment(claims, "posttest");
    const rekeyed = structuredClone(config);
    rekeyed.questions[0].correctAnswer = "甲";
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, config: rekeyed });
    mocks.db.activityProgress.findUnique.mockResolvedValue({ progressData: { posttestDraft: draft } });
    const updated = await getStudentPostTestAssessment(claims, "posttest");
    expect(updated.questionVersion).toBe(original.questionVersion);
    expect(updated.draft).toEqual(draft);
    expect(updated.questionVersion).not.toBe(createHash("sha256").update(JSON.stringify(config.questions)).digest("hex"));
    expect(updated.questionVersion).not.toBe(createHash("sha256").update(JSON.stringify(rekeyed.questions)).digest("hex"));
  });

  it("opens directly as a learning activity and removes every answer key", async () => {
    const result = await getStudentPostTestAssessment(claims, "posttest");
    expect(result).toMatchObject({ enabled: true, available: true, introduction: config.content, minutes: 15, studentKey: "enrollment", questionVersion: version(), draft: null, submission: null });
    expect(result.questions).toHaveLength(config.questions.length);
    expect(result.questions.every((question) => !Object.hasOwn(question, "correctAnswer"))).toBe(true);
    expect(result.questions[4].group?.referenceNote).toBe("教师包括真人教师和 AI。");
    expect(mocks.db.enrollment.findUnique).toHaveBeenCalledWith({ where: { userId_offeringId: { userId: "student", offeringId: "offering" } } });
  });

  it("records the complete CoTeach template without classroom or pretest records", async () => {
    const template = createCoTeachPostTestTemplate();
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, config: template });
    const response = await getStudentPostTestAssessment(claims, "posttest");
    expect(response.questions).toHaveLength(54);
    const complete = Object.fromEntries(template.questions.filter((question) => !question.optional).map((question) => [question.id, question.type === "scale" ? "4" : "不知道"]));
    await submitPostTestAssessment(claims, "posttest", { answers: complete, questionVersion: version(template) });
    expect(mocks.db.activitySubmission.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: expect.objectContaining({ answers: complete, objectiveScore: 0, objectiveTotal: 0 }) }) }));
  });

  it.each([
    { activity: { ...activity, isOpen: false } },
    { activity: { ...activity, opensAt: new Date("2099-01-01") } },
    { activity: { ...activity, chapter: { ...activity.chapter, isOpen: false } } },
    { activity: { ...activity, chapter: { ...activity.chapter, opensAt: new Date("2099-01-01") } } },
  ])("hides questions and saved records while the directory item is locked", async ({ activity: locked }) => {
    mocks.db.activity.findUnique.mockResolvedValue(locked);
    mocks.db.activitySubmission.findFirst.mockResolvedValue(storedSubmission);
    mocks.db.activityProgress.findUnique.mockResolvedValue({ progressData: { posttestDraft: draft } });
    expect(await getStudentPostTestAssessment(claims, "posttest")).toMatchObject({ available: false, questions: [], draft: null, submission: null });
    await expect(savePostTestDraft(claims, "posttest", { answers: {}, currentPage: 0, version: 0, questionVersion: version() })).rejects.toMatchObject({ code: "ASSESSMENT_UNAVAILABLE", status: 403 });
    await expect(submitPostTestAssessment(claims, "posttest", { answers, questionVersion: version() })).rejects.toMatchObject({ code: "ASSESSMENT_UNAVAILABLE", status: 403 });
    expect(mocks.db.activitySubmission.create).not.toHaveBeenCalled();
    expect(mocks.db.activityProgress.upsert).not.toHaveBeenCalled();
  });

  it.each([null, { ...enrollment, status: "WITHDRAWN" }])("requires an active or completed enrollment", async (membership) => {
    mocks.db.enrollment.findUnique.mockResolvedValue(membership);
    await expect(getStudentPostTestAssessment(claims, "posttest")).rejects.toMatchObject({ code: "ENROLLMENT_REQUIRED", status: 403 });
    await expect(submitPostTestAssessment(claims, "posttest", { answers, questionVersion: version() })).rejects.toMatchObject({ code: "ENROLLMENT_REQUIRED", status: 403 });
    expect(mocks.db.activitySubmission.findFirst).not.toHaveBeenCalled();
  });

  it("rejects teachers, draft courses, archived directory items and other activity types", async () => {
    await expect(getStudentPostTestAssessment({ sub: "teacher", role: "teacher", username: "teacher", displayName: "教师", sv: 1 }, "posttest")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.student).not.toHaveBeenCalled();
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, chapter: { ...activity.chapter, offering: { id: "offering", status: "DRAFT" } } });
    await expect(getStudentPostTestAssessment(claims, "posttest")).rejects.toMatchObject({ code: "COURSE_NOT_OPEN" });
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, archivedAt: submittedAt });
    await expect(getStudentPostTestAssessment(claims, "posttest")).rejects.toMatchObject({ code: "NOT_FOUND" });
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, chapter: { ...activity.chapter, archivedAt: submittedAt } });
    await expect(getStudentPostTestAssessment(claims, "posttest")).rejects.toMatchObject({ code: "NOT_FOUND" });
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, type: "FORM" });
    await expect(getStudentPostTestAssessment(claims, "posttest")).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
  });

  it.each(["FINISHED", "ARCHIVED"])("allows immutable review after the course becomes %s and prevents writes", async (status) => {
    const changed = { ...config, content: "后续说明", questions: [{ id: "new", type: "short-answer", prompt: "新题目" }] };
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, config: changed, chapter: { ...activity.chapter, offering: { id: "offering", status } } });
    mocks.db.enrollment.findUnique.mockResolvedValue({ ...enrollment, status: "COMPLETED" });
    mocks.db.activitySubmission.findFirst.mockResolvedValue(storedSubmission);
    const result = await getStudentPostTestAssessment(claims, "posttest");
    expect(result).toMatchObject({ available: false, questionVersion: version(), introduction: config.content, draft: null, submission: { id: "submission", answers, submittedAt } });
    expect(result.questions.map((question) => question.id)).toEqual(config.questions.map((question) => question.id));
    expect(result.questions.some((question) => Object.hasOwn(question, "correctAnswer"))).toBe(false);
    await expect(submitPostTestAssessment(claims, "posttest", { answers, questionVersion: version() })).rejects.toMatchObject({ code: "ASSESSMENT_UNAVAILABLE" });
    await expect(savePostTestDraft(claims, "posttest", { answers: {}, currentPage: 0, version: 0, questionVersion: version() })).rejects.toMatchObject({ code: "ASSESSMENT_UNAVAILABLE" });
    expect(mocks.db.activitySubmission.create).not.toHaveBeenCalled();
  });
});

describe("independent posttest drafts", () => {
  it("restores partial answers and uses optimistic versions under the activity row lock", async () => {
    mocks.db.activityProgress.findUnique.mockResolvedValue({ progressData: { learningContext: "keep", posttestDraft: draft } });
    expect((await getStudentPostTestAssessment(claims, "posttest")).draft).toEqual(draft);
    const input = { answers: { ...draft.answers, rating: "4" }, currentPage: 2, version: 2, questionVersion: version() };
    const saved = await savePostTestDraft(claims, "posttest", input);
    expect(saved.draft).toMatchObject({ answers: input.answers, currentPage: 2, version: 3, questionVersion: version() });
    expect(mocks.db.$queryRaw.mock.calls[0][0].join("")).toContain('FROM "Activity" WHERE "id" =  FOR UPDATE');
    expect(mocks.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.activityProgress.upsert.mock.invocationCallOrder[0]);
    expect(mocks.db.activityProgress.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ status: "IN_PROGRESS", progressData: expect.objectContaining({ learningContext: "keep", posttestDraft: expect.objectContaining({ version: 3 }) }) }) }));
    await expect(savePostTestDraft(claims, "posttest", { ...input, version: 1 })).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT", status: 409 });
    expect(mocks.db.activityProgress.upsert).toHaveBeenCalledTimes(1);
  });

  it("drops a draft for old questions and rejects stale clients before writing", async () => {
    const oldVersion = "0".repeat(64);
    mocks.db.activityProgress.findUnique.mockResolvedValue({ progressData: { posttestDraft: { ...draft, questionVersion: oldVersion } } });
    expect((await getStudentPostTestAssessment(claims, "posttest")).draft).toBeNull();
    await expect(savePostTestDraft(claims, "posttest", { answers: draft.answers, currentPage: 0, version: 2, questionVersion: oldVersion })).rejects.toMatchObject({ code: "QUESTION_VERSION_CONFLICT", status: 409 });
    await expect(submitPostTestAssessment(claims, "posttest", { answers, questionVersion: oldVersion })).rejects.toMatchObject({ code: "QUESTION_VERSION_CONFLICT", status: 409 });
    expect(mocks.db.activityProgress.upsert).not.toHaveBeenCalled();
    expect(mocks.db.activitySubmission.create).not.toHaveBeenCalled();
    expect((await savePostTestDraft(claims, "posttest", { answers: {}, currentPage: 0, version: 0, questionVersion: version() })).draft.version).toBe(1);
  });

  it("keeps the current draft when only the activity title or introduction changes", async () => {
    mocks.db.activity.findUnique.mockResolvedValue({ ...activity, title: "更新后标题", version: 4, config: { ...config, content: "更新后说明" } });
    mocks.db.activityProgress.findUnique.mockResolvedValue({ progressData: { posttestDraft: draft } });
    expect(await getStudentPostTestAssessment(claims, "posttest")).toMatchObject({ introduction: "更新后说明", questionVersion: version(), draft });
    expect((await savePostTestDraft(claims, "posttest", { answers: draft.answers, currentPage: 1, version: 2, questionVersion: version() })).draft.version).toBe(3);
  });

  it.each([
    { answers: { unknown: "value" }, currentPage: 0, version: 0, code: "INVALID_ANSWERS" },
    { answers: { choice: "unknown" }, currentPage: 0, version: 0, code: "INVALID_ANSWERS" },
    { answers: { rating: "6" }, currentPage: 0, version: 0, code: "INVALID_ANSWERS" },
    { answers: { multiple: ["甲", "甲"] }, currentPage: 0, version: 0, code: "INVALID_ANSWERS" },
    { answers: {}, currentPage: -1, version: 0, code: "INVALID_INPUT" },
    { answers: {}, currentPage: 0, version: 1.5, code: "INVALID_INPUT" },
    { answers: {}, currentPage: 0, version: Number.MAX_SAFE_INTEGER, code: "INVALID_INPUT" },
  ])("rejects malformed draft values without changing progress", async ({ code, ...input }) => {
    await expect(savePostTestDraft(claims, "posttest", { ...input, questionVersion: version() })).rejects.toMatchObject({ code });
    expect(mocks.db.activityProgress.upsert).not.toHaveBeenCalled();
  });

  it("does not overwrite a completed assessment with a delayed autosave", async () => {
    mocks.db.activitySubmission.findFirst.mockResolvedValue(storedSubmission);
    await expect(savePostTestDraft(claims, "posttest", { answers: draft.answers, currentPage: 0, version: 2, questionVersion: version() })).rejects.toMatchObject({ code: "ASSESSMENT_SUBMITTED", status: 409 });
    expect(mocks.db.activityProgress.upsert).not.toHaveBeenCalled();
    expect((await getStudentPostTestAssessment(claims, "posttest")).draft).toBeNull();
  });
});

describe("independent posttest submission", () => {
  it("stores an immutable question snapshot, scores objective questions and completes the student record", async () => {
    mocks.db.activityProgress.findUnique.mockResolvedValue({ progressData: { learningContext: "keep", posttestDraft: draft } });
    const result = await submitPostTestAssessment(claims, "posttest", { answers: { ...answers, explain: "  解释方法  ", feedback: "" }, questionVersion: version() });
    expect(result).toMatchObject({ id: expect.any(String), answers, submittedAt: expect.any(Date) });
    const created = mocks.db.activitySubmission.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ enrollmentId: "enrollment", activityId: "posttest", researchKey: "research", activityVersion: 3, activitySnapshot: { type: "POSTTEST", title: "课后测验", config, version: 3 }, payload: { answers, objectiveScore: 3, objectiveTotal: 3, questionVersion: version() } });
    const progress = mocks.db.activityProgress.upsert.mock.calls[0][0];
    expect(progress.update).toMatchObject({ status: "COMPLETED", completedAt: created.submittedAt, progressData: { learningContext: "keep", answers, submissionId: created.id, submittedAt: created.submittedAt.toISOString(), objectiveScore: 3, objectiveTotal: 3 } });
    expect(progress.update.progressData).not.toHaveProperty("posttestDraft");
    expect(mocks.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.activitySubmission.create.mock.invocationCallOrder[0]);
  });

  it.each([
    { ...answers, choice: undefined },
    { ...answers, choice: "不存在" },
    { ...answers, multiple: ["甲", "甲"] },
    { ...answers, judgment: "yes" },
    { ...answers, rating: "0" },
    { ...answers, injected: "答案" },
  ])("rejects incomplete or invalid submissions and preserves the draft", async (invalid) => {
    await expect(submitPostTestAssessment(claims, "posttest", { answers: invalid, questionVersion: version() })).rejects.toMatchObject({ code: "INVALID_ANSWERS", status: 400 });
    expect(mocks.db.activitySubmission.create).not.toHaveBeenCalled();
    expect(mocks.db.activityProgress.upsert).not.toHaveBeenCalled();
  });

  it("returns the original submission when a successful response was lost and refuses changed answers", async () => {
    mocks.db.activitySubmission.findFirst.mockResolvedValue(storedSubmission);
    const repeated = { rating: "4", explain: "  解释方法  ", judgment: "true", multiple: ["丙", "甲"], choice: "乙" };
    expect(await submitPostTestAssessment(claims, "posttest", { answers: repeated, questionVersion: version() })).toEqual({ id: "submission", answers, submittedAt });
    await expect(submitPostTestAssessment(claims, "posttest", { answers: { ...answers, choice: "甲" }, questionVersion: version() })).rejects.toMatchObject({ code: "ASSESSMENT_SUBMITTED", status: 409 });
    expect(mocks.db.activitySubmission.create).not.toHaveBeenCalled();
    expect(mocks.db.activityProgress.upsert).not.toHaveBeenCalled();
  });
});

describe("independent posttest route guards", () => {
  const context = { params: Promise.resolve({ activityId: "posttest" }) };
  const request = (method: string, body?: unknown) => new Request("http://localhost/api/platform/activities/posttest/posttest", { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });

  it("requires student authentication and same-origin mutations", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await GET(request("GET"), context)).status).toBe(401);
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "student");
    expect(mocks.db.activity.findUnique).not.toHaveBeenCalled();
    mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
    expect((await PUT(request("PUT", {}), context)).status).toBe(403);
    expect((await POST(request("POST", {}), context)).status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("validates the question fingerprint and preserves domain conflict responses", async () => {
    expect((await POST(request("POST", { answers, questionVersion: "invalid" }), context)).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    const conflict = await PUT(request("PUT", { answers: {}, currentPage: 0, version: 0, questionVersion: "0".repeat(64) }), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "QUESTION_VERSION_CONFLICT" });
  });

  it("uses the existing assessment response protocol and disables HTTP caching", async () => {
    const loaded = await GET(request("GET"), context);
    expect(loaded.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await loaded.json()).toMatchObject({ available: true, questionVersion: version(), studentKey: "enrollment" });
    const saved = await PUT(request("PUT", { answers: {}, currentPage: 0, version: 0, questionVersion: version() }), context);
    expect(saved.headers.get("Cache-Control")).toContain("no-store");
    expect(await saved.json()).toMatchObject({ draft: { version: 1, answers: {}, questionVersion: version() } });
    const submitted = await POST(request("POST", { answers, questionVersion: version() }), context);
    expect(submitted.headers.get("Cache-Control")).toContain("no-store");
    expect(await submitted.json()).toMatchObject({ submission: { id: expect.any(String), answers, submittedAt: expect.any(String) } });
  });
});
