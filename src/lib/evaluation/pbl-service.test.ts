import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import { DEFAULT_PBL_RUBRIC, emptyPblAnswers, type PblEvaluationRecord } from "./pbl-contract";
const mocks = vi.hoisted(() => ({ user: vi.fn(), instance: vi.fn(), teacher: vi.fn(), rows: vi.fn(), find: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), assignments: vi.fn(), assignment: vi.fn(), assign: vi.fn(), cancel: vi.fn(), versions: vi.fn(), reports: vi.fn(), report: vi.fn(), receipt: vi.fn(), event: vi.fn(), instanceUpdate: vi.fn(), participantUpdate: vi.fn(), presenters: vi.fn() }));
const db = vi.hoisted(() => ({ $executeRaw: vi.fn(), classroomInstance: { findUnique: mocks.instance, update: mocks.instanceUpdate }, courseTeacher: { findFirst: mocks.teacher },
  evaluation: { findMany: mocks.rows, findUnique: mocks.find, findFirst: mocks.find, create: mocks.create, update: mocks.update, upsert: mocks.upsert },
  peerReviewAssignment: { findMany: mocks.assignments, findFirst: mocks.assignment, upsert: mocks.assign, updateMany: mocks.cancel },
  artifactVersion: { findMany: mocks.versions }, aiSupportRecord: { findMany: mocks.reports, findFirst: mocks.report },
  domainEvent: { findUnique: mocks.receipt, create: mocks.event }, classroomParticipation: { update: mocks.participantUpdate }, showcasePresentation: { findMany: mocks.presenters } }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (fn: (db: unknown) => unknown) => fn(db) }));
vi.mock("@/lib/platform/access", () => ({ getPlatformUser: mocks.user }));
import { getPblEvaluation, mutatePblEvaluation } from "./pbl-service";
const student = { sub: "s1", role: "student" } as AuthClaims;
const teacher = { sub: "t", role: "teacher" } as AuthClaims;
const key = "1b283575-dc73-4f24-98d5-be25ee4bcf3f";
const participants = ["1", "2", "3"].map(n => ({ id: `p${n}`, enrollmentId: `e${n}`, completedAt: null, stageProgress: {}, enrollment: { offeringId: "o", userId: `s${n}`, status: "ACTIVE", user: { id: `s${n}`, displayName: `Student ${n}` } } }));
const instance = () => ({ id: "i", status: "TEACHING", startedAt: new Date(), activityId: "a", runtimeConfig: { evaluationContractVersion: 2, currentStageIndex: 4 }, templateVersion: { snapshot: null }, activity: { isOpen: true, opensAt: null, archivedAt: null, chapter: { isOpen: true, opensAt: null, archivedAt: null, offeringId: "o", offering: { status: "OPEN" } } }, participations: participants });
const answers = { ...emptyPblAnswers(DEFAULT_PBL_RUBRIC), evidence: "作品事实", learning: "收获", plan: "改进计划", strengths: "优点", improvements: "建议", comment: "教师评语" };
function evaluation(source: "self" | "peer" | "teacher", extra: Partial<PblEvaluationRecord> = {}): PblEvaluationRecord { return { id: "ev", participationId: "p1", source, assignmentId: null, version: 1, status: "submitted", rubric: DEFAULT_PBL_RUBRIC, answers, suggestedScore: null, score: null, submittedAt: "now", returnedReason: null, updatedAt: "now", history: [], ...extra }; }
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockImplementation((claims: AuthClaims) => ({ id: claims.sub, role: claims.role, displayName: "Name" }));
  mocks.instance.mockImplementation(() => instance()); mocks.teacher.mockResolvedValue({ id: "t" });
  for (const fn of [mocks.rows, mocks.assignments, mocks.versions, mocks.reports, mocks.presenters]) fn.mockResolvedValue([]);
  mocks.assign.mockImplementation(({ create }) => ({ ...create, id: `${create.reviewerParticipationId}:${create.targetParticipationId}` }));
});
describe("PBL authorization, persistence and publication", () => {
  it("blocks students forging teacher scores, other self evaluations and unassigned peer reviews", async () => {
    for (const command of [{ source: "teacher", participationId: "p1" }, { source: "self", participationId: "p2" }, { source: "peer", participationId: "p2", assignmentId: "unknown" }] as const) {
      await expect(mutatePblEvaluation(student, "i", { action: "submit", ...command, version: 0, answers, idempotencyKey: key })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("saves draft with version and preserves null scores; rejects stale edits and submitted revisions", async () => {
    await mutatePblEvaluation(student, "i", { action: "save", source: "self", participationId: "p1", version: 0, answers, idempotencyKey: key });
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "PBL_SELF", score: null, result: expect.objectContaining({ version: 1, status: "draft" }) }) });
    mocks.find.mockResolvedValue({ id: "ev", result: evaluation("self") });
    await expect(mutatePblEvaluation(student, "i", { action: "save", source: "self", participationId: "p1", version: 0, answers, idempotencyKey: key })).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });
    await expect(mutatePblEvaluation(student, "i", { action: "save", source: "self", participationId: "p1", version: 1, answers, idempotencyKey: key })).rejects.toMatchObject({ code: "EVALUATION_LOCKED" });
  });
  it("returns locked submissions without discarding the previous submitted answers", async () => {
    mocks.find.mockResolvedValue({ id: "ev", result: evaluation("self") });
    await mutatePblEvaluation(teacher, "i", { action: "return", evaluationId: "ev", version: 1, reason: "请补充", idempotencyKey: key });
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "ev" }, data: { result: expect.objectContaining({ status: "returned", version: 2, history: [expect.objectContaining({ version: 1, status: "submitted", answers })] }) } });
  });
  it("replays the same request without duplicate writes and rejects changed bodies", async () => {
    const command = { action: "save", source: "self", participationId: "p1", version: 0, answers, idempotencyKey: key } as const;
    await mutatePblEvaluation(student, "i", command);
    mocks.receipt.mockResolvedValue({ payload: mocks.event.mock.calls[0][0].data.payload });
    await mutatePblEvaluation(student, "i", command); expect(mocks.create).toHaveBeenCalledTimes(1);
    await expect(mutatePblEvaluation(student, "i", { ...command, answers: { ...answers, comment: "different" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("hides unpublished reports/teacher drafts and never queries private AI records for students", async () => {
    mocks.rows.mockResolvedValue([{ type: "PBL_TEACHER", participationId: "p1", result: evaluation("teacher", { status: "draft" }) }]);
    const result = await getPblEvaluation(student, "i");
    expect(result.participants).toHaveLength(1); expect(result.participants[0].teacherEvaluation).toBeNull(); expect(result.participants[0].processReport).toBeNull(); expect(mocks.reports).not.toHaveBeenCalled();
  });
  it("publishes immutable teacher/report snapshots and hides reviewer identity and history", async () => {
    const frozen = evaluation("teacher", { score: 80, returnedReason: "private return note", history: [{ version: 1, status: "submitted", answers: { ...answers, comment: "unpublished old teacher notes", finalScore: 20 }, at: "before" }] });
    mocks.rows.mockResolvedValue([{ type: "PBL_TEACHER", participationId: "p1", result: evaluation("teacher", { score: 20 }) }, { type: "PBL_PUBLICATION", participationId: "p1", result: { at: "publish", teacherEvaluation: frozen, peerEvaluations: [evaluation("peer", { evaluatorName: "Secret name", assignmentId: "assignment-with-identity", history: [{ version: 1, status: "submitted", answers, at: "now" }] })], processReport: { id: "r", dimensions: [], summary: "published", generatedAt: "now" } } }, { type: "PBL_PEER", participationId: "p1", result: evaluation("peer", { evaluatorName: "Secret name", history: [{ version: 1, status: "submitted", answers, at: "now" }] }) }]);
    const result = await getPblEvaluation(student, "i");
    expect(result.participants[0].teacherEvaluation?.score).toBe(80); expect(JSON.stringify(result)).not.toContain("unpublished old teacher notes"); expect(JSON.stringify(result)).not.toContain("private return note"); expect(result.participants[0].processReport?.summary).toBe("published");
    expect(JSON.stringify(result)).not.toContain("Secret name"); expect(result.participants[0].peerEvaluations[0].history).toEqual([]); expect(result.participants[0].peerEvaluations[0].assignmentId).toBeNull();
  });
  it("locks rubric after start and disallows publication during learning", async () => {
    const config = { rubric: [{ id: "new", name: "new", description: "", weight: 100 }], peerMode: "off", reviewsPerStudent: 2, anonymous: true } as const;
    await expect(mutatePblEvaluation(teacher, "i", { action: "config", config: { ...config, rubric: [...config.rubric] }, version: 0, idempotencyKey: key })).rejects.toMatchObject({ code: "RUBRIC_FROZEN" });
    mocks.instance.mockImplementation(() => ({ ...instance(), runtimeConfig: { evaluationContractVersion: 2, currentStageIndex: 1 } }));
    await expect(mutatePblEvaluation(teacher, "i", { action: "publish", participationIds: ["p1"], includeTeacher: true, includeProcess: true, idempotencyKey: key })).rejects.toMatchObject({ code: "EVALUATION_LOCKED" });
  });
  it("pins formal versions and retains submitted assignments during redistribution", async () => {
    mocks.instance.mockImplementation(() => ({ ...instance(), runtimeConfig: { ...instance().runtimeConfig, pblEvaluationConfig: { version: 1, rubric: DEFAULT_PBL_RUBRIC, peerMode: "balanced", reviewsPerStudent: 2, anonymous: true } } }));
    mocks.versions.mockResolvedValue(participants.map(p => ({ id: `v-${p.id}`, artifact: { participationId: p.id }, sequence: 1, submittedAt: new Date() })));
    mocks.rows.mockResolvedValue([{ result: evaluation("peer", { assignmentId: "prior", history: [], status: "submitted" }) }]);
    await mutatePblEvaluation(teacher, "i", { action: "assign", idempotencyKey: key });
    expect(mocks.assign).toHaveBeenCalledTimes(6);
    expect(mocks.assign.mock.calls.every(([arg]) => !arg.update.artifactVersionId)).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledWith({ where: { instanceId: "i", id: { notIn: expect.arrayContaining(["prior"]) } }, data: { status: "CANCELLED" } });
  });
  it("includes ended presenters and pins only their submitted work", async () => {
    mocks.instance.mockImplementation(() => ({ ...instance(), runtimeConfig: { ...instance().runtimeConfig, pblEvaluationConfig: { version: 1, rubric: DEFAULT_PBL_RUBRIC, peerMode: "presenters-only", reviewsPerStudent: 2, anonymous: true } } }));
    mocks.versions.mockResolvedValue(participants.map(p => ({ id: `v-${p.id}`, artifact: { participationId: p.id }, sequence: 1, submittedAt: new Date() })));
    mocks.presenters.mockResolvedValue([{ participationId: "p2" }]);
    await mutatePblEvaluation(teacher, "i", { action: "assign", idempotencyKey: key });
    expect(mocks.presenters).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: expect.arrayContaining(["ENDED"]) } }) }));
    expect(mocks.assign).toHaveBeenCalledTimes(2);
    expect(mocks.assign.mock.calls.every(([arg]) => arg.create.targetParticipationId === "p2")).toBe(true);
  });
  it("validates manual targets and excludes self assignments", async () => {
    mocks.instance.mockImplementation(() => ({ ...instance(), runtimeConfig: { ...instance().runtimeConfig, pblEvaluationConfig: { version: 1, rubric: DEFAULT_PBL_RUBRIC, peerMode: "manual", reviewsPerStudent: 2, anonymous: true } } }));
    mocks.versions.mockResolvedValue([{ id: "v", artifact: { participationId: "p2" }, sequence: 1, submittedAt: new Date() }]);
    await mutatePblEvaluation(teacher, "i", { action: "assign", pairs: [{ reviewerParticipationId: "p1", targetParticipationId: "p2" }], idempotencyKey: key });
    expect(mocks.assign).toHaveBeenCalledTimes(1);
    await expect(mutatePblEvaluation(teacher, "i", { action: "assign", pairs: [{ reviewerParticipationId: "p1", targetParticipationId: "p1" }], idempotencyKey: key })).rejects.toMatchObject({ code: "INVALID_ASSIGNMENT" });
    await expect(mutatePblEvaluation(teacher, "i", { action: "assign", pairs: [{ reviewerParticipationId: "p1", targetParticipationId: "p3" }], idempotencyKey: key })).rejects.toMatchObject({ code: "INVALID_ARTIFACT_VERSION" });
  });
  it("rejects stale sessions and closes student writes when the activity is withdrawn", async () => {
    mocks.user.mockResolvedValueOnce({ id: "s1", role: "student", sessionVersion: 2 });
    await expect(getPblEvaluation({ ...student, sv: 1 }, "i")).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.instance.mockImplementation(() => ({ ...instance(), activity: { ...instance().activity, isOpen: false } }));
    await expect(mutatePblEvaluation(student, "i", { action: "save", source: "self", participationId: "p1", version: 0, answers, idempotencyKey: key })).rejects.toMatchObject({ code: "EVALUATION_LOCKED" });
  });
  it("stops writes for old contracts, finished classrooms and withdrawn enrollments", async () => {
    mocks.instance.mockResolvedValue({ ...instance(), runtimeConfig: {} });
    await expect(getPblEvaluation(student, "i")).rejects.toMatchObject({ code: "LEGACY_EVALUATION" });
    mocks.instance.mockResolvedValue({ ...instance(), status: "FINISHED" });
    await expect(mutatePblEvaluation(student, "i", { action: "save", source: "self", participationId: "p1", version: 0, answers, idempotencyKey: key })).rejects.toMatchObject({ code: "EVALUATION_LOCKED" });
    mocks.instance.mockResolvedValue({ ...instance(), participations: [] });
    await expect(getPblEvaluation(student, "i")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
