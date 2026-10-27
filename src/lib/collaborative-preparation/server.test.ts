import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { CoursePreparationSession, CoursePreparationTurn } from "@prisma/client";
import type { PreparationModelResult } from "./types";
import { preparationPlanFixture } from "./fixtures.test-support";
import { preparationMutationSchema } from "./schema";

const mocks = vi.hoisted(() => ({ sessionFind: vi.fn(), sessionCreate: vi.fn(), sessionUpdate: vi.fn(), sessionUpdateMany: vi.fn(), turnCreate: vi.fn(), turnFind: vi.fn(), turnUpdateMany: vi.fn(), owner: vi.fn(), running: vi.fn(), load: vi.fn(), save: vi.fn(), model: vi.fn(), refs: vi.fn(), evidence: vi.fn(), revisions: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  coursePreparationSession: { findUnique: mocks.sessionFind, create: mocks.sessionCreate, update: mocks.sessionUpdate, updateMany: mocks.sessionUpdateMany },
  coursePreparationTurn: { findUnique: mocks.turnFind, create: mocks.turnCreate, updateMany: mocks.turnUpdateMany },
  classroomTemplate: { findUnique: mocks.owner }, generationJob: { findFirst: mocks.running }, textbookRevision: { findMany: mocks.revisions }, $executeRaw: vi.fn(),
} }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: async (work: (db: unknown) => unknown) => { const { prisma } = await import("@/lib/db/client"); return work(prisma); } }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.load, savePblTemplateCourse: mocks.save }));
vi.mock("@/lib/course-design/generation-references", () => ({ resolveGenerationReferenceMaterials: mocks.refs, formatGenerationReferenceContext: () => "", GenerationReferenceError: class extends Error {} }));
vi.mock("@/lib/textbook/course-evidence", () => ({ resolveCourseEvidenceSnapshot: mocks.evidence, CourseEvidenceError: class extends Error {} }));
vi.mock("./model", () => ({ generatePreparationTurn: mocks.model }));
import { loadPreparationSession, resolveConfirmedPreparation, runPreparationTurn, submitPreparationMutation } from "./server";

let row: CoursePreparationSession | null;
let turns: CoursePreparationTurn[];
let course: Course;
const result = (): PreparationModelResult => ({ message: "方案已经明确，可以确认，也可以继续讨论。", plan: preparationPlanFixture(), fieldOrigins: { grade: "teacher-stated", totalMinutes: "teacher-stated", stagePlan: "ai-proposed" }, question: null, readyToConfirm: true, suggestions: ["五阶段时间分配为AI建议，请确认。"] });
const matches = (record: object, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
  const actual = (record as Record<string, unknown>)[key];
  return value instanceof Date && actual instanceof Date ? value.getTime() === actual.getTime() : actual === value;
});
const read = () => row ? structuredClone({ ...row, turns }) : null;
beforeEach(() => {
  vi.resetAllMocks(); row = null; turns = [];
  course = { id: "course", status: "draft", content: { resourcePackage: { id: "existing-package", revision: 1 } } } as Course;
  mocks.owner.mockResolvedValue({ ownerId: "teacher", status: "ACTIVE" }); mocks.running.mockResolvedValue(null);
  mocks.load.mockImplementation(async () => course);
  mocks.save.mockImplementation(async (next: Course) => { course = next; return course; });
  mocks.refs.mockResolvedValue([]);
  mocks.sessionFind.mockImplementation(async () => read());
  mocks.sessionCreate.mockImplementation(async ({ data }) => { row = { id: "session", revision: 0, status: "DISCUSSING", error: null, confirmedSnapshot: null, createdAt: new Date(), updatedAt: new Date(), ...data }; return read(); });
  const update = (data: Record<string, unknown>) => {
    const patch = { ...data };
    if (patch.confirmedSnapshot && typeof patch.confirmedSnapshot === "object" && !("sessionId" in patch.confirmedSnapshot)) patch.confirmedSnapshot = null;
    row = { ...row!, ...patch, updatedAt: new Date() } as CoursePreparationSession;
  };
  mocks.sessionUpdate.mockImplementation(async ({ data }) => { update(data); return read(); });
  mocks.sessionUpdateMany.mockImplementation(async ({ where, data }) => { if (!row || !matches(row, where)) return { count: 0 }; update(data); return { count: 1 }; });
  mocks.turnCreate.mockImplementation(async ({ data }) => {
    const turn = { id: `turn-${turns.length + 1}`, status: "PENDING", result: null, error: null, executionId: null, leaseExpiresAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
    turns.push(turn); return structuredClone(turn);
  });
  mocks.turnUpdateMany.mockImplementation(async ({ where, data }) => { let count = 0; turns = turns.map((turn) => { if (!matches(turn, where)) return turn; count++; return { ...turn, ...data, updatedAt: new Date() }; }); return { count }; });
  mocks.turnFind.mockImplementation(async ({ where }) => { const turn = turns.find((turn) => turn.id === where.id); return turn ? { ...structuredClone(turn), session: read() } : null; });
  mocks.model.mockImplementation(async ({ onResponse }) => { const response = result(); await onResponse?.(JSON.stringify(response)); return response; });
});
async function firstTurn() {
  return submitPreparationMutation("course", "teacher", { revision: 0, requestId: "first", message: "四年级，45分钟，讲授蒸发" });
}

describe("durable collaborative preparation", () => {
  it("persists the original answer before model work and restores it after leaving", async () => {
    const submitted = await firstTurn();
    expect(submitted.session).toMatchObject({ revision: 1, status: "processing", turns: [{ role: "user", content: "四年级，45分钟，讲授蒸发" }] });
    expect(mocks.model).not.toHaveBeenCalled();
    expect((await loadPreparationSession("course", "teacher"))?.turns[0].content).toContain("45分钟");
    expect(course.content.preparationSource).toBe("collaborative-preparation");
    expect(course.content.resourcePackage?.id).toBe("existing-package");
    await runPreparationTurn(submitted.turnId!);
    const saved = await loadPreparationSession("course", "teacher");
    expect(saved).toMatchObject({ status: "ready", readyToConfirm: true, plan: { totalMinutes: 45 } });
    expect(saved?.turns).toHaveLength(2);
    expect(turns[0].result).toHaveProperty("rawResponse");
  });
  it("deduplicates retries of the same request and rejects reuse for another answer", async () => {
    const first = await firstTurn();
    const duplicate = await firstTurn();
    expect(duplicate.turnId).toBe(first.turnId); expect(turns).toHaveLength(1);
    await expect(submitPreparationMutation("course", "teacher", { revision: 0, requestId: "first", message: "另一门课程" })).rejects.toMatchObject({ code: "PREPARATION_REQUEST_CONFLICT" });
    await runPreparationTurn(first.turnId!); await runPreparationTurn(first.turnId!);
    expect(mocks.model).toHaveBeenCalledTimes(1);
  });
  it("prevents concurrent stale answers and changes during a generation job", async () => {
    await firstTurn();
    await expect(submitPreparationMutation("course", "teacher", { revision: 0, requestId: "second", message: "改成高中" })).rejects.toMatchObject({ code: "PREPARATION_REVISION_CONFLICT" });
    await expect(submitPreparationMutation("course", "teacher", { revision: 1, requestId: "second", message: "改成高中" })).rejects.toMatchObject({ code: "PREPARATION_BUSY" });
    await runPreparationTurn(turns[0].id);
    mocks.running.mockResolvedValue({ id: "generation" });
    await expect(submitPreparationMutation("course", "teacher", { revision: 1, requestId: "confirm", action: "confirm" })).rejects.toMatchObject({ code: "PREPARATION_GENERATION_RUNNING" });
  });
  it("confirms a revision-bound snapshot, then invalidates it on a new answer", async () => {
    const first = await firstTurn(); await runPreparationTurn(first.turnId!);
    const confirmed = await submitPreparationMutation("course", "teacher", { revision: 1, requestId: "confirm", action: "confirm" });
    expect(confirmed.session.confirmed).toMatchObject({ sessionId: "session", revision: 2, confirmedBy: "teacher", plan: { totalMinutes: 45 } });
    expect(await resolveConfirmedPreparation("course", "session", 2, "teacher")).toEqual(confirmed.session.confirmed);
    await expect(resolveConfirmedPreparation("course", "session", 1, "teacher")).rejects.toMatchObject({ code: "PREPARATION_REVISION_CONFLICT" });
    await submitPreparationMutation("course", "teacher", { revision: 2, requestId: "change", action: "revise", message: "保留实验，改为两课时" });
    expect(course.content.confirmedPreparation).toBeUndefined();
    expect(course.content.resourcePackage?.id).toBe("existing-package");
    await expect(resolveConfirmedPreparation("course", "session", 2, "teacher")).rejects.toMatchObject({ code: "PREPARATION_CONFIRMATION_REQUIRED" });
  });
  it("keeps the previous plan and original answer on failure and retries without duplicating teacher turns", async () => {
    const first = await firstTurn(); await runPreparationTurn(first.turnId!);
    const change = await submitPreparationMutation("course", "teacher", { revision: 1, requestId: "change", action: "revise", message: "希望增加生活案例" });
    mocks.model.mockImplementationOnce(async ({ onResponse }) => { await onResponse("invalid json"); throw new Error("invalid output"); });
    await runPreparationTurn(change.turnId!);
    const failed = await loadPreparationSession("course", "teacher");
    expect(failed).toMatchObject({ status: "failed", plan: { totalMinutes: 45 } });
    expect(failed?.turns.at(-1)?.content).toBe("希望增加生活案例");
    expect(turns.at(-1)?.result).toMatchObject({ rawResponse: "invalid json", diagnostic: { message: "invalid output" } });
    const retry = await submitPreparationMutation("course", "teacher", { revision: 2, requestId: "retry", action: "retry" });
    await runPreparationTurn(retry.turnId!);
    expect((await loadPreparationSession("course", "teacher"))?.turns.filter((turn) => turn.role === "user")).toHaveLength(2);
  });
  it("marks an expired execution retryable without issuing a model call", async () => {
    await firstTurn(); turns[0].leaseExpiresAt = new Date(0);
    expect((await loadPreparationSession("course", "teacher"))?.status).toBe("failed");
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it("checks teacher ownership and refuses a changed source set at confirmation", async () => {
    mocks.owner.mockResolvedValueOnce({ ownerId: "other", status: "ACTIVE" });
    await expect(firstTurn()).rejects.toMatchObject({ status: 404 });
    const first = await firstTurn(); await runPreparationTurn(first.turnId!);
    await expect(submitPreparationMutation("course", "teacher", { revision: 1, requestId: "confirm", action: "confirm", referenceIds: ["new-upload"] })).rejects.toMatchObject({ code: "PREPARATION_SOURCES_CHANGED" });
    await expect(resolveConfirmedPreparation("course", "session", 1, "other")).rejects.toMatchObject({ status: 404 });
  });
  it("confirms the same textbook after JSONB key ordering and request-schema projection without repeating retrieval", async () => {
    const first = await firstTurn(); await runPreparationTurn(first.turnId!);
    const state = row!.state as unknown as { textbookSelections: Array<{ revisionId: string; primary: boolean; sectionIds: string[] }> };
    const revisionId = "b0f10612-a5eb-40d7-a00f-bbb448392972";
    const sectionId = "2f1755b7-b8e3-57b8-b458-2dc2f11c464a";
    // PostgreSQL JSONB returned primary before revisionId in the real acceptance run.
    state.textbookSelections = JSON.parse(JSON.stringify([{ primary: true, revisionId, sectionIds: [sectionId] }]));
    mocks.revisions.mockResolvedValue([{ id: revisionId, status: "READY", textbook: { status: "ACTIVE" }, sections: [{ id: sectionId }] }]);
    const input = preparationMutationSchema.parse({ revision: 1, requestId: "confirm", action: "confirm", referenceIds: [], textbookSelections: state.textbookSelections });
    expect(Object.keys(state.textbookSelections[0])).not.toEqual(Object.keys(input.textbookSelections![0]));
    await submitPreparationMutation("course", "teacher", input);
    const confirmedRevision = row!.revision;
    await submitPreparationMutation("course", "teacher", input);
    expect(row!.revision).toBe(confirmedRevision);
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(course.content.confirmedPreparation?.textbookSelections[0].revisionId).toBe(revisionId);
    expect(course.content.confirmedPreparation?.textbookSelections[0].sectionIds).toEqual([sectionId]);
  });
  it("still rejects a real textbook scope change rather than treating key normalization as a new confirmation", async () => {
    const first = await firstTurn(); await runPreparationTurn(first.turnId!);
    const state = row!.state as unknown as { textbookSelections: Array<{ revisionId: string; primary: boolean; sectionIds: string[] }> };
    state.textbookSelections = [{ primary: true, revisionId: "revision", sectionIds: ["section"] }];
    await expect(submitPreparationMutation("course", "teacher", { revision: 1, requestId: "confirm", action: "confirm", textbookSelections: [{ revisionId: "revision", primary: true, sectionIds: ["different-section"] }] })).rejects.toMatchObject({ code: "PREPARATION_SOURCES_CHANGED" });
  });
  it("compares attachment and section sets and normalizes missing nonprimary metadata", async () => {
    const first = await firstTurn(); await runPreparationTurn(first.turnId!);
    const state = row!.state as unknown as { referenceIds: string[]; textbookSelections: Array<{ revisionId: string; primary?: boolean; sectionIds: string[] }> };
    state.referenceIds = ["a", "b"];
    state.textbookSelections = [{ primary: true, revisionId: "primary", sectionIds: ["s1", "s2"] }, { revisionId: "secondary", sectionIds: [] }];
    mocks.revisions.mockResolvedValue([
      { id: "primary", status: "READY", textbook: { status: "ACTIVE" }, sections: [{ id: "s1" }, { id: "s2" }] },
      { id: "secondary", status: "READY", textbook: { status: "ACTIVE" }, sections: [] },
    ]);
    await expect(submitPreparationMutation("course", "teacher", { revision: 1, requestId: "confirm", action: "confirm", referenceIds: ["b", "a", "a"], textbookSelections: [{ revisionId: "secondary", primary: false, sectionIds: [] }, { revisionId: "primary", primary: true, sectionIds: ["s2", "s1", "s1"] }] })).resolves.toMatchObject({ session: { status: "confirmed" } });
  });
});
