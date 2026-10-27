// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn(), outbox: vi.fn(), review: vi.fn(), saves: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read }));
vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: mocks.query } }));
vi.mock("@/lib/ai-collaboration/audit-outbox", () => ({ readAiAuditOutboxCounts: mocks.outbox }));
vi.mock("@/lib/llm/classroom-capacity", () => ({ classroomAiCapacitySnapshot: () => ({ active: 3, pending: 2 }) }));
vi.mock("@/lib/project-practice/document-conversion-pool", () => ({ documentConversionHealth: () => ({ ok: true, ready: 2, busy: 1, queued: 4 }) }));
vi.mock("@/lib/ai-collaboration/document-review-worker", () => ({ documentReviewWorkerSnapshot: mocks.review }));
vi.mock("./pending-save-reports", () => ({ pendingSaveReportSnapshot: mocks.saves }));
import { refreshClassroomHealthMetrics } from "./classroom-health";
import { register } from "./metrics";

async function value(name: string, labels?: Record<string, string>) {
  const metric = await register.getSingleMetric(name)!.get();
  return metric.values.find(sample => !labels || Object.entries(labels).every(([key, val]) => sample.labels[key] === val))?.value;
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED", "true");
  mocks.query.mockResolvedValue([{ connections: BigInt(7), waiting: BigInt(2), max: 100 }]);
  mocks.read.mockResolvedValue(JSON.stringify({ startedEpoch: Math.floor(Date.now() / 1000) - 10 }));
  mocks.outbox.mockResolvedValue({ pending: 2, quarantined: 0 });
  mocks.review.mockReturnValue({ initialized: true, running: true, active: 2, queued: 5, lastTickAt: Date.now(), lastErrorAt: null });
  mocks.saves.mockReturnValue({ known: false, count: Number.NaN, oldestCreatedAt: Number.NaN, clients: 0, unknownClients: 0, knownCount: 0, oldestKnownCreatedAt: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("classroom health telemetry truthfulness", () => {
  it("keeps an old running review visible to the five minute settlement alert when no pending job remains", async () => {
    const oldest = Date.now() - 6 * 60_000;
    mocks.review.mockReturnValue({ initialized: true, running: true, active: 1, queued: 0, lastTickAt: Date.now(), lastErrorAt: null, oldestQueuedAt: oldest });
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_document_review_queued")).toBe(0);
    expect(await value("openpbl_document_review_oldest_pending_timestamp_seconds")).toBe(oldest / 1000);
  });

  it("reports observed pending saves, explicit empty reports and unknown samples separately", async () => {
    mocks.saves.mockReturnValue({ known: true, count: 2, oldestCreatedAt: Date.now() - 90_000, clients: 2, unknownClients: 0, knownCount: 2, oldestKnownCreatedAt: Date.now() - 90_000 });
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_pending_save_count")).toBe(2);
    expect(await value("openpbl_pending_save_oldest_age_seconds")).toBeGreaterThanOrEqual(90);
    expect(await value("openpbl_pending_save_sample_available")).toBe(1);
    mocks.saves.mockReturnValue({ known: false, count: Number.NaN, oldestCreatedAt: Number.NaN, clients: 2, unknownClients: 1, knownCount: 2, oldestKnownCreatedAt: Date.now() - 90_000 });
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_pending_save_count")).toBeNaN(); expect(await value("openpbl_pending_save_oldest_age_seconds")).toBeNaN();
    expect(await value("openpbl_pending_save_sample_available")).toBe(0);
    expect(await value("openpbl_pending_save_known_count")).toBe(2);
    expect(await value("openpbl_pending_save_known_oldest_age_seconds")).toBeGreaterThanOrEqual(90);
    mocks.saves.mockReturnValue({ known: true, count: 0, oldestCreatedAt: null, clients: 2, unknownClients: 0, knownCount: 0, oldestKnownCreatedAt: null });
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_pending_save_count")).toBe(0); expect(await value("openpbl_pending_save_oldest_age_seconds")).toBe(0);
    const metric = await register.getSingleMetric("openpbl_pending_save_count")!.get();
    expect(metric.values[0].labels).toEqual({});
  });
  it("keeps hidden client counts and lock waiters unknown while retaining the configured limit", async () => {
    mocks.query.mockResolvedValue([{ connections: null, waiting: BigInt(2), max: 100 }]);
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_postgres_connections")).toBeNaN();
    expect(await value("openpbl_health_sample_available", { component: "database" })).toBe(0);
    expect(await value("openpbl_postgres_lock_waiters")).toBeNaN();
    expect(await value("openpbl_postgres_connection_limit")).toBe(100);
  });

  it("preserves an explicit zero client sample separately from unavailable collection", async () => {
    mocks.query.mockResolvedValue([{ connections: BigInt(0), waiting: BigInt(2), max: 100 }]);
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_postgres_connections")).toBe(0);
    expect(await value("openpbl_health_sample_available", { component: "database" })).toBe(1);
    expect(await value("openpbl_postgres_lock_waiters")).toBe(2);
  });

  it("collects worker, database and checkpoint samples without identity labels", async () => {
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_postgres_connections")).toBe(7);
    expect(await value("openpbl_document_conversion_workers_busy")).toBe(1);
    expect(await value("openpbl_document_review_worker_healthy")).toBe(1);
    expect(await value("openpbl_document_review_queued")).toBe(5);
    expect(await value("openpbl_health_sample_available", { component: "backup" })).toBe(1);
    const metrics = await register.getSingleMetric("openpbl_health_sample_available")!.get();
    expect(metrics.values.every(sample => Object.keys(sample.labels).every(label => label === "component"))).toBe(true);
  });

  it("keeps shared worker failures visible when new document reviews are disabled", async () => {
    vi.stubEnv("DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED", "false");
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_document_review_worker_enabled")).toBe(1);
    expect(await value("openpbl_document_review_worker_healthy")).toBe(1);
    mocks.review.mockReturnValue({ initialized: false, running: false, active: 0, queued: 0, lastTickAt: null, lastErrorAt: null });
    await refreshClassroomHealthMetrics();
    expect(await value("openpbl_document_review_worker_enabled")).toBe(1);
    expect(await value("openpbl_document_review_worker_healthy")).toBe(0);
    expect(await value("openpbl_health_sample_available", { component: "document-review" })).toBe(0);
    expect(await value("openpbl_document_review_queued")).toBeNaN();
  });

  it("marks failed collection unknown instead of zero or a stale successful value", async () => {
    await refreshClassroomHealthMetrics();
    mocks.query.mockRejectedValue(new Error("database down"));
    mocks.read.mockRejectedValue(new Error("checkpoint unavailable"));
    mocks.outbox.mockRejectedValue(new Error("outbox unavailable"));
    mocks.review.mockReturnValue({ initialized: true, running: true, active: 0, queued: 0, lastTickAt: Date.now() - 60_000, lastErrorAt: Date.now() });
    await refreshClassroomHealthMetrics();
    for (const name of ["openpbl_postgres_connections", "openpbl_postgres_connection_limit", "openpbl_postgres_lock_waiters", "openpbl_ai_audit_outbox_pending", "openpbl_local_backup_checkpoint_timestamp_seconds", "openpbl_document_review_queued"])
      expect(await value(name), name).toBeNaN();
    expect(await value("openpbl_document_review_worker_healthy")).toBe(0);
    expect(await value("openpbl_health_sample_available", { component: "backup" })).toBe(0);
  });

  it.each(["not-json", "{}", '{"startedEpoch":0}', '{"startedEpoch":9999999999999}'])("does not fabricate a checkpoint from %s", async status => {
    mocks.read.mockResolvedValue(status); await refreshClassroomHealthMetrics();
    expect(await value("openpbl_local_backup_checkpoint_timestamp_seconds")).toBeNaN();
    expect(await value("openpbl_health_sample_available", { component: "backup" })).toBe(0);
  });
});
