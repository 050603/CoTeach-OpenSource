// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- Minimal in-memory Prisma query fake for scheduling integration tests. */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { ShowcaseData } from "./types";
import { showcaseContentSnapshot, showcaseHtmlEvidence } from "./recommendation-preparation";
const mocks = vi.hoisted(() => ({ data: vi.fn(), course: vi.fn(), latest: vi.fn(), snapshot: vi.fn(), counts: vi.fn(), rows: new Map<string, Record<string, any>>() }));
vi.mock("server-only", () => ({}));
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => key === "input" ? row.input?.[value.path[0]] === value.equals
    : value && typeof value === "object" ? value.in ? value.in.includes(row[key]) : value.not ? row[key] !== value.not : value.lt !== undefined ? row[key] < value.lt : row[key]?.getTime?.() === value.getTime?.()
    : row[key] === value);
}
const tasks = {
  upsert: vi.fn(async ({ where, create, update }) => { const row = mocks.rows.get(where.id); const next = row ? { ...row, ...update } : { attemptCount: 0, updatedAt: new Date(), ...create }; mocks.rows.set(where.id, next); return next; }),
  findUnique: vi.fn(async ({ where }) => mocks.rows.get(where.id) ?? null),
  findFirst: vi.fn(async ({ where }) => [...mocks.rows.values()].find(row => matches(row, where)) ?? null),
  findMany: vi.fn(async ({ where }) => [...mocks.rows.values()].filter(row => matches(row, where))),
  updateMany: vi.fn(async ({ where, data }) => { let count = 0; for (const [id, row] of mocks.rows) if (matches(row, where)) { mocks.rows.set(id, { ...row, ...data }); count++; } return { count }; }),
};
vi.mock("@/lib/db/client", () => ({ prisma: { get aiTask() { return tasks; }, artifactVersion: { findFirst: mocks.latest }, $transaction: (run: any) => run({ aiTask: tasks, $executeRaw: vi.fn() }) } }));
vi.mock("./persistence", () => ({ showcaseStore: { loadCourse: mocks.course } }));
vi.mock("./recommendation-analysis", () => ({ loadShowcaseRecommendationSnapshot: mocks.snapshot, ShowcaseUnreadableArtifact: class extends Error {} }));
vi.mock("./recommendation-facts", () => ({ readShowcaseFactCounts: mocks.counts }));
vi.mock("./presentation-service", () => ({ getShowcaseData: mocks.data, ShowcasePresentationError: class extends Error { constructor(public code: string, message: string, public status: number) { super(message); } } }));
import { buildShowcaseRecommendationResult, enqueueShowcaseRecommendationForStudent, getShowcaseRecommendations, prepareShowcaseRecommendation,
  showcasePreparationId, SHOWCASE_RECOMMENDATION_QUEUE, type ShowcasePreparedState } from "./recommendation-service";
const teacher = { role: "teacher", sub: "teacher" } as AuthClaims;
const body = "实验记录显示三次结果一致，结论与数据能够对应，证据可供核对。";
let version: string, html: string;
async function prepare() {
  await enqueueShowcaseRecommendationForStudent("course", "s");
  const id = showcasePreparationId("course", "s"); const row = mocks.rows.get(id)!;
  row.status = "RUNNING"; row.startedAt = new Date();
  await prepareShowcaseRecommendation(row as never);
  return mocks.rows.get(id)!.output as ShowcasePreparedState;
}
function complete(id: string) {
  const row = mocks.rows.get(id)!;
  row.status = "COMPLETED"; row.completedAt = new Date();
  row.output = { qualityScore: 88, dimensionScores: { work: 88 }, reasons: [{ kind: "quality", text: "结论与实验记录对应", location: "段落 1", quote: "实验记录显示三次结果一致" }] };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
  version = "v1"; html = `<p>${body}</p>`;
  mocks.course.mockResolvedValue({ status: "teaching", content: { pblOutline: "课程要求", stagePlan: { schemaVersion: 2, stages: [], showcasePlan: { presenterCount: 2 } } }, uiState: {} });
  mocks.data.mockImplementation(async () => ({ students: [{ studentId: "s", name: "学生", artifacts: [{ kind: "document", versionId: version, title: "作品", submittedAt: new Date().toISOString() }] }], queue: [], queueConfig: { selectedStudentIds: [] } }));
  mocks.latest.mockImplementation(async () => ({ id: version, submittedAt: new Date(), createdAt: new Date(), artifact: { type: "DOCUMENT_ARCHIVE" } }));
  mocks.snapshot.mockImplementation(async () => showcaseContentSnapshot(showcaseHtmlEvidence(html), html)); mocks.counts.mockResolvedValue(new Map([["s", 18]]));
});
afterEach(() => vi.useRealTimers());
it("rejects students and keeps GET and compatibility POST free of analysis side effects", async () => {
  await expect(getShowcaseRecommendations("course", { role: "student" } as AuthClaims)).rejects.toMatchObject({ code: "FORBIDDEN" });
  const rec = await getShowcaseRecommendations("course", teacher, true);
  expect(rec).toMatchObject({ targetCount: 2, targetSource: "plan", recommendedStudentIds: ["s"], pendingCount: 1 });
  expect(tasks.upsert).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled();
});
it("only enqueues local work on submission and merges identical content across versions", async () => {
  await enqueueShowcaseRecommendationForStudent("course", "s"); expect(mocks.snapshot).not.toHaveBeenCalled();
  const first = await prepare(); const initial = mocks.rows.get(first.taskId!)!;
  expect(initial.availableAt.getTime() - Date.now()).toBe(30_000);
  version = "v2"; html = `<p style="font-size:24px">${body}</p>`; vi.advanceTimersByTime(20_000);
  const second = await prepare(); expect(second.taskId).toBe(first.taskId);
  expect([...mocks.rows.values()].filter(r => r.queueKey === SHOWCASE_RECOMMENDATION_QUEUE)).toHaveLength(1);
  expect(mocks.rows.get(first.taskId!)!.availableAt.getTime() - Date.now()).toBe(30_000);
  complete(first.taskId!);
  const third = await prepare(); expect(third.freshness).toBe("reused");
  expect((await getShowcaseRecommendations("course", teacher)).candidates[0]).toMatchObject({ analysisStatus: "complete", qualityScore: 88, analysisFreshness: "reused", analyzedArtifactVersionId: "v1", aiRequestCount: 18 });
});
it("repositions evidence after paragraph edits, references minor changes, excludes major outdated scores", async () => {
  const first = await prepare(); complete(first.taskId!);
  version = "v2"; html = `<p>补充说明</p><p>${body.repeat(10)}</p>`;
  // This is a significant cumulative change; old quality must not rank the new work.
  const changed = await prepare(); expect(changed.taskId).not.toBe(first.taskId);
  expect((await getShowcaseRecommendations("course", teacher)).candidates[0]).toMatchObject({ analysisFreshness: "outdated", analysisStatus: "pending" });
  expect((await getShowcaseRecommendations("course", teacher)).candidates[0].qualityScore).toBeUndefined();
  version = "v3"; html = `<p>${body}补充</p>`;
  const minor = await prepare(); expect(minor.freshness).toBe("minor-change");
  expect((await getShowcaseRecommendations("course", teacher)).candidates[0]).toMatchObject({ analysisFreshness: "minor-change", qualityScore: 88 });
});
it("cancels superseded pending versions, preserves running results, and marks empty work locally", async () => {
  const first = await prepare();
  version = "v2"; html = '<p>完全不同的作品内容，数字结论是42，并有新的数据。</p>';
  const second = await prepare(); expect(mocks.rows.get(first.taskId!)!.status).toBe("CANCELLED");
  mocks.rows.get(second.taskId!)!.status = "RUNNING";
  version = "v3"; html = '<p>新的实质内容为99，与上一版完全不同，等待分析。</p>';
  await prepare(); expect(mocks.rows.get(second.taskId!)!.status).toBe("RUNNING");
  version = "v4"; html = '<p>空</p>'; const empty = await prepare(); expect(empty.unreadable).toBe(true); expect(empty.taskId).toBeUndefined();
  expect((await getShowcaseRecommendations("course", teacher)).candidates[0].analysisStatus).toBe("unreadable");
});
it("changes context invalidate quality, while finished classrooms never queue AI", async () => {
  const first = await prepare(); complete(first.taskId!);
  mocks.course.mockResolvedValue({ status: "teaching", content: { pblOutline: "新课程要求" }, uiState: {} });
  expect((await prepare()).taskId).not.toBe(first.taskId);
  mocks.rows.clear(); mocks.course.mockResolvedValue({ status: "finished", content: {}, uiState: {} });
  await prepare(); expect([...mocks.rows.values()].filter(r => r.queueKey === SHOWCASE_RECOMMENDATION_QUEUE)).toHaveLength(0);
});
it("counts completed and selected students once and only fills remaining slots", () => {
  const result = buildShowcaseRecommendationResult("course", { targetCount: 3, targetSource: "teacher" }, ["selected", "new", "extra"].map(studentId => ({ studentId, studentName: studentId, artifactVersionId: studentId, artifactKind: "document", analysisStatus: "pending", reasons: [], aiRequestCount: 0 })), { queueConfig: { selectedStudentIds: ["completed", "selected"] }, queue: [{ studentId: "completed", status: "completed" }] } as ShowcaseData);
  expect(result.recommendedStudentIds).toHaveLength(1); expect(result.recommendedStudentIds).not.toContain("selected");
});

it("retains verified exact-version quality when its quotation appears in more than one paragraph", async () => {
  html = `<p>${body}</p><p>${body}</p>`;
  const first = await prepare(); complete(first.taskId!);
  const candidate = (await getShowcaseRecommendations("course", teacher)).candidates[0];
  expect(candidate.qualityScore).toBe(88); expect(candidate.reasons[0].location).toBe("段落 1");
});
