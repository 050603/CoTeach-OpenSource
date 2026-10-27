// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ update: vi.fn(), query: vi.fn(), unique: vi.fn(), course: vi.fn(), prepare: vi.fn(), first: vi.fn(), many: vi.fn(), write: vi.fn(), latest: vi.fn(), instances: vi.fn(), participations: vi.fn(), input: { requests: [] as Array<{ at: string }> } }));
vi.mock("server-only", () => ({}));
const db = { aiTask: { updateMany: mocks.update, findUnique: mocks.unique, findFirst: mocks.first, findMany: mocks.many, update: mocks.write }, artifactVersion: { findFirst: mocks.latest }, $executeRaw: vi.fn() };
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: () => false, prisma: { classroomParticipation: { findMany: mocks.participations }, classroomInstance: { findMany: mocks.instances }, get aiTask() { return db.aiTask; }, $queryRaw: mocks.query, $transaction: (run: (arg: typeof db) => unknown) => run(db) } }));
vi.mock("@/lib/llm/classroom-capacity", () => ({ isBackgroundAiCapacityError: (error: { code?: string }) => error?.code === "CLASSROOM_BACKGROUND_CAPACITY" }));
vi.mock("./persistence", () => ({ showcaseStore: { loadCourse: mocks.course }, createShowcaseStore: () => ({ loadCourse: mocks.course }) }));
vi.mock("./recommendation-facts", () => ({ refreshShowcaseFacts: vi.fn() }));
vi.mock("./recommendation-service", () => ({ SHOWCASE_RECOMMENDATION_QUEUE: "analysis", SHOWCASE_PREPARATION_QUEUE: "prepare", SHOWCASE_RECOMMENDATION_MAX_ATTEMPTS: 2,
  enqueueShowcaseRecommendationForStudent: vi.fn(), prepareShowcaseRecommendation: mocks.prepare, showcaseJson: (x: unknown) => x, showcasePreparationId: () => "state", showcaseAnalysisContext: () => ({ contextFingerprint: "digest" }) }));
vi.mock("./recommendation-analysis", () => ({ executeShowcaseRecommendationAnalysis: vi.fn(), ShowcaseUnreadableArtifact: class extends Error {}, ShowcaseRecommendationScopeChanged: class extends Error {} }));
import { claimShowcaseRecommendation, runShowcaseRecommendationJob, reserveShowcaseModelRequest, reconcileShowcaseRecommendations } from "./recommendation-worker";
import { enqueueShowcaseRecommendationForStudent } from "./recommendation-service";
import { ShowcaseRecommendationScopeChanged } from "./recommendation-analysis";
import { LlmJsonModeUnsupportedError } from "@/lib/llm/errors";
const task = { schemaVersion: 2 as const, analysisVersion: 2, courseId: "course", studentId: "s", artifactVersionId: "v", artifactKind: "document" as const, contextFingerprint: "digest", requirements: "req", dimensions: [], snapshot: { blocks: [], text: "abc", fingerprint: "fp", structure: "s" } };
const job = () => ({ id: "job", attemptCount: 0, startedAt: new Date(), input: task, queueKey: "analysis" });
beforeEach(() => {
  vi.clearAllMocks(); mocks.update.mockResolvedValue({ count: 1 }); mocks.query.mockResolvedValue([]);
  mocks.course.mockResolvedValue({ status: "teaching", content: {}, stages: [{ key: "make" }], currentStageIndex: 0 });
  mocks.first.mockResolvedValue({ id: "job", input: { ...task, requests: [] }, attemptCount: 0 });
  mocks.unique.mockImplementation(async ({ where }) => where.id === "state" ? { status: "READY", output: { artifactVersionId: "v", taskId: "job" } } : { attemptCount: 1, input: task });
  mocks.latest.mockResolvedValue({ id: "v" }); mocks.many.mockResolvedValue([]);
});
it("claims atomically without spending provider attempts and retires exhausted leases", async () => {
  await expect(claimShowcaseRecommendation()).resolves.toBeNull();
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ attemptCount: { gte: 2 } }) }));
  const sql = mocks.query.mock.calls[0][0].join("?"); expect(sql).toContain("FOR UPDATE SKIP LOCKED"); expect(sql).not.toContain('"attemptCount" + 1');
});
it("runs local preparation independently of model work", async () => {
  const current = { ...job(), queueKey: "prepare" };
  await runShowcaseRecommendationJob(current, new AbortController().signal);
  expect(mocks.prepare).toHaveBeenCalledWith(current); expect(mocks.course).not.toHaveBeenCalled();
});
it("caches an already-started result under its lease without mutating the current target", async () => {
  const output = { qualityScore: 86, dimensionScores: { work: 86 }, reasons: [] }, current = job();
  await runShowcaseRecommendationJob(current, new AbortController().signal, vi.fn(async () => output));
  expect(mocks.update).toHaveBeenCalledWith({ where: { id: current.id, status: "RUNNING", startedAt: current.startedAt }, data: expect.objectContaining({ status: "COMPLETED", output }) });
});
it("reserves one real request and rejects superseded targets and exhausted budgets", async () => {
  await reserveShowcaseModelRequest(job());
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attemptCount: { increment: 1 }, input: expect.objectContaining({ requests: [expect.objectContaining({ at: expect.any(String) })] }) }) }));
  mocks.unique.mockResolvedValueOnce({ status: "READY", output: { artifactVersionId: "v", taskId: "new-job" } });
  await expect(reserveShowcaseModelRequest(job())).rejects.toThrow("QUALITY_SUPERSEDED");
  mocks.first.mockResolvedValueOnce({ attemptCount: 2 }); await expect(reserveShowcaseModelRequest(job())).rejects.toThrow("QUALITY_REQUEST_BUDGET_EXHAUSTED");
});
it("enforces cooldown across different content jobs and defers while preparation is pending", async () => {
  mocks.many.mockResolvedValueOnce([{ input: { requests: [{ at: new Date().toISOString() }] } }]);
  await expect(reserveShowcaseModelRequest(job())).rejects.toThrow("QUALITY_COOLDOWN"); expect(mocks.update).not.toHaveBeenCalled();
  mocks.unique.mockResolvedValueOnce({ status: "PENDING" }); await expect(reserveShowcaseModelRequest(job())).rejects.toThrow("QUALITY_COOLDOWN");
});
it("persists format fallback for the next bounded attempt, and never retries indefinitely", async () => {
  await runShowcaseRecommendationJob(job(), new AbortController().signal, vi.fn(async () => { throw new LlmJsonModeUnsupportedError("unsupported"); }));
  expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({ status: "PENDING", input: { jsonMode: false } });
  mocks.unique.mockResolvedValueOnce({ attemptCount: 2, input: task });
  await runShowcaseRecommendationJob(job(), new AbortController().signal, vi.fn(async () => { throw new Error("failed"); }));
  expect(mocks.update.mock.calls.at(-1)?.[0].data.status).toBe("FAILED");
  await runShowcaseRecommendationJob(job(), new AbortController().signal, vi.fn(async () => { throw new ShowcaseRecommendationScopeChanged("QUALITY_CONTEXT_CHANGED"); }));
  expect(mocks.update.mock.calls.at(-1)?.[0].data.status).toBe("CANCELLED");
});
it("defers capacity without spending a request and resumes after restart", async () => {
  await runShowcaseRecommendationJob(job(), new AbortController().signal, vi.fn(async () => { throw { code: "CLASSROOM_BACKGROUND_CAPACITY", retryAfterMs: 5_000 }; }));
  expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({ status: "PENDING", error: "QUALITY_CAPACITY_BUSY" });
  const stopped = new AbortController(); stopped.abort(); await runShowcaseRecommendationJob(job(), stopped.signal);
  expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({ status: "PENDING", error: "QUALITY_WORKER_STOPPED" });
});

it("limits deployment repair to recently active teaching sessions instead of abandoned historical classes", async () => {
  mocks.instances.mockResolvedValueOnce([]);
  await reconcileShowcaseRecommendations();
  expect(mocks.instances).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "TEACHING", OR: expect.arrayContaining([
    expect.objectContaining({ updatedAt: { gte: expect.any(Date) } }),
    expect.objectContaining({ participations: expect.any(Object) }),
  ]) }) }));
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("recovers a missing submission notification and leaves matching prepared versions alone", async () => {
  mocks.instances.mockResolvedValue([{ id: "course" }]);
  mocks.participations.mockResolvedValue([{ enrollment: { userId: "s" }, artifacts: [{ versions: [{ id: "v", submittedAt: new Date(), createdAt: new Date() }] }] }]);
  mocks.unique.mockResolvedValueOnce(null);
  await reconcileShowcaseRecommendations();
  expect(enqueueShowcaseRecommendationForStudent).toHaveBeenCalledExactlyOnceWith("course", "s");
  mocks.unique.mockResolvedValueOnce({ status: "READY", output: { artifactVersionId: "v", contextFingerprint: "digest" } });
  await reconcileShowcaseRecommendations();
  expect(enqueueShowcaseRecommendationForStudent).toHaveBeenCalledOnce();
});
