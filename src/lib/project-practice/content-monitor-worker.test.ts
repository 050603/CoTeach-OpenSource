import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  db: { $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(), aiTask: { updateMany: vi.fn() }, domainEvent: { upsert: vi.fn() } },
  assertScope: vi.fn(), evidence: vi.fn(), classify: vi.fn(), notify: vi.fn(), capacity: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db, isDatabaseConfigured: () => false }));
vi.mock("./content-monitor-policy", () => ({ classifyDocumentPaste: mocks.classify }));
vi.mock("./content-monitor-service", () => ({
  assertContentMonitorScope: mocks.assertScope, readContentMonitorEvidence: mocks.evidence, notifyContentMonitorChange: mocks.notify,
  clearedMonitorInput: (input: { requestId: string; fingerprint: string }) => ({ requestId: input.requestId, fingerprint: input.fingerprint }),
  monitorJson: (input: unknown) => input, ContentMonitorScopeClosed: class extends Error {},
}));
vi.mock("@/lib/ai-collaboration/proactive-review-capacity", () => ({
  withProactiveReviewCapacity: mocks.capacity, isProactiveReviewCapacityError: (error: unknown) => (error as { code?: string })?.code === "PROACTIVE_REVIEW_CAPACITY",
  proactiveReviewCapacitySnapshot: () => ({ active: 0, limit: 8 }), resolveProactiveReviewConcurrency: () => 8,
}));
vi.mock("@/lib/llm/classroom-capacity", () => ({ isBackgroundAiCapacityError: () => false, classroomAiCapacitySnapshot: () => ({ active: 0, pending: 0, limit: 40 }) }));
import { ContentMonitorScopeClosed } from "./content-monitor-service";
import { claimContentMonitorJob, retireContentMonitorJobs, runContentMonitorJob, type ContentMonitorJob } from "./content-monitor-worker";

const job: ContentMonitorJob = { id: "task", startedAt: new Date("2026-10-25T08:00:00.000Z"), attemptCount: 1,
  input: { requestId: "request", fingerprint: "hash", courseId: "course", studentId: "student", participationId: "participation", offeringId: "offering",
    researchKey: "research", sessionVersion: 3, stageVersion: 4, templateVersionId: "v1", studentName: "同学", submittedAt: "2026-10-25T08:00:00.000Z",
    fragments: [{ text: "核心答案正文".repeat(80) }], documentText: "周围文稿" } };
const evidence = { pastedText: job.input.fragments[0].text, taskRequirements: "独立分析校园问题并提出可核验的方案", nearbyText: "文稿", knownSources: [] };
const flagged = { outcome: "flagged" as const, reason: "已给出完整的具体方案", pasteExcerpt: "核心答案正文".repeat(5), taskRequirement: evidence.taskRequirements };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.$transaction.mockImplementation(callback => callback(mocks.db));
  mocks.db.aiTask.updateMany.mockResolvedValue({ count: 1 });
  mocks.evidence.mockResolvedValue(evidence);
  mocks.classify.mockResolvedValue(flagged);
  mocks.capacity.mockImplementation(callback => callback());
});

describe("content monitor durable worker", () => {
  it("commits an independent reminder together with the receipt, clearing all input text", async () => {
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.assertScope).toHaveBeenCalledWith(mocks.db, job.input);
    const update = mocks.db.aiTask.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: "task", status: "RUNNING", startedAt: job.startedAt });
    expect(update.data).toMatchObject({ status: "COMPLETED", output: { status: "flagged", eventId: "reminder:task" }, input: { requestId: "request", fingerprint: "hash" } });
    expect(update.data.input).not.toHaveProperty("fragments");
    const stored = mocks.db.domainEvent.upsert.mock.calls[0][0].create;
    expect(stored).toMatchObject({ eventType: "document_content_reminder", actorId: "student", classroomInstanceId: "course", participationId: "participation" });
    expect(stored.payload.event).toMatchObject({ status: "pending", excerpt: flagged.pasteExcerpt, contentState: "unknown" });
    expect(mocks.notify).toHaveBeenCalledWith("course", "student");
  });
  it.each(["clear", "exempt"])("does not retain text or create a behavior record for %s", async outcome => {
    mocks.classify.mockResolvedValue({ outcome });
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.db.domainEvent.upsert).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data).toMatchObject({ status: "COMPLETED", output: { status: "clear" }, input: { requestId: "request", fingerprint: "hash" } });
  });
  it("records unverifiable model output as incomplete without publishing an allegation", async () => {
    mocks.classify.mockResolvedValue({ outcome: "incomplete" });
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data.status).toBe("FAILED");
    expect(mocks.db.domainEvent.upsert).not.toHaveBeenCalled();
  });
  it("does not classify when the bounded server-source lookup could omit an older AI reply", async () => {
    mocks.evidence.mockResolvedValue({ ...evidence, sourceCoverageComplete: false });
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.db.domainEvent.upsert).not.toHaveBeenCalled();
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data.status).toBe("FAILED");
  });
  it("rechecks the live switch/stage/session after model completion and cancels a revoked result", async () => {
    mocks.assertScope.mockRejectedValue(new ContentMonitorScopeClosed());
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data).toMatchObject({ status: "CANCELLED", input: { requestId: "request", fingerprint: "hash" } });
    expect(mocks.db.domainEvent.upsert).not.toHaveBeenCalled();
  });
  it("cannot publish after another worker replaces its lease", async () => {
    mocks.db.aiTask.updateMany.mockResolvedValue({ count: 0 });
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.db.domainEvent.upsert).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("retries one technical failure without duplicating model retries", async () => {
    mocks.classify.mockRejectedValue(new Error("provider failed with sensitive text"));
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data).toMatchObject({ status: "PENDING", error: "CONTENT_MONITOR_INCOMPLETE" });
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data).not.toHaveProperty("input");
    await runContentMonitorJob({ ...job, attemptCount: 2 }, new AbortController().signal);
    expect(mocks.db.aiTask.updateMany.mock.calls[1][0].data).toMatchObject({ status: "FAILED", input: { requestId: "request", fingerprint: "hash" } });
    expect(mocks.db.domainEvent.upsert).not.toHaveBeenCalled();
  });
  it("returns capacity deferrals to the queue without spending a technical retry", async () => {
    mocks.capacity.mockRejectedValue(Object.assign(new Error("busy"), { code: "PROACTIVE_REVIEW_CAPACITY", retryAfterMs: 5000 }));
    await runContentMonitorJob(job, new AbortController().signal);
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data).toMatchObject({ status: "PENDING", attemptCount: { decrement: 1 }, error: "CONTENT_MONITOR_CAPACITY_BUSY" });
  });
  it("stops without publishing or consuming the technical retry when shutdown arrives during the model call", async () => {
    const stop = new AbortController();
    mocks.classify.mockImplementation(async () => { stop.abort(); return flagged; });
    await runContentMonitorJob(job, stop.signal);
    expect(mocks.db.domainEvent.upsert).not.toHaveBeenCalled();
    expect(mocks.db.aiTask.updateMany.mock.calls[0][0].data).toMatchObject({ status: "PENDING", attemptCount: { decrement: 1 } });
  });
  it("claims pending and expired work atomically and retires expired input bodies", async () => {
    mocks.db.$queryRaw.mockResolvedValue([job]);
    expect(await claimContentMonitorJob()).toEqual(job);
    const sql = mocks.db.$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED"); expect(sql).toContain('"leaseUntil" < now()');
    await retireContentMonitorJobs();
    const retired = mocks.db.$executeRaw.mock.calls.map(call => call[0].join("?")).join("\n");
    expect(retired).toContain("documentPasteMonitoringEnabled"); expect(retired).toContain('"sessionVersion"');
    expect(retired).toContain("jsonb_build_object"); expect(retired).not.toContain("'fragments'");
  });
});
