import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse, decodePblTemplate } from "@/lib/platform/pbl-template";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";

const mocks = vi.hoisted(() => ({ configured: vi.fn(), query: vi.fn(), snapshot: vi.fn(), fallback: vi.fn(), template: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.configured, prisma: {
  $queryRaw: mocks.query, classroomTemplateVersion: { findUnique: mocks.snapshot },
} }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.fallback }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.template }));
import { getDocumentReadContext } from "./document-read-context";

let sequence = 0;
let row: { templateVersionId: string; templateStatus: string; currentStageIndex: unknown; makeArtifactMode: unknown; hasStudent: boolean };
const snapshot = (mode: unknown = "document") => ({ schemaVersion: 2, kind: "pbl-course", design: {
  name: "Frozen design", stages: [{ key: "proposal" }, { key: "make" }], pblConfig: { makeArtifactMode: mode },
  content: { pblOutline: "prompt evidence that history does not consume" },
} });
function expected(raw: unknown) {
  const course = createPblTemplateCourse("course", decodePblTemplate(raw) ?? {});
  const config = { ...course.pblConfig, ...(row.makeArtifactMode ? { makeArtifactMode: row.makeArtifactMode } : {}) };
  return { student: row.hasStudent ? { id: "student" } : undefined,
    currentStageKey: course.stages[Number(row.currentStageIndex ?? 0)]?.key,
    makeArtifactMode: normalizePblCourseConfig(config as typeof course.pblConfig).makeArtifactMode };
}

describe("document history live read guards", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.configured.mockReturnValue(true);
    row = { templateVersionId: `document-read-${++sequence}`, templateStatus: "DRAFT", currentStageIndex: 1, makeArtifactMode: "other", hasStudent: true };
    mocks.query.mockImplementation(async () => [{ ...row }]); mocks.snapshot.mockResolvedValue({ snapshot: snapshot() });
  });
  it("reads only live guard columns and canonical design, never the prompt evidence collections", async () => {
    expect(await getDocumentReadContext("course", "student")).toEqual(expected(snapshot()));
    const sql = mocks.query.mock.calls[0][0].join("");
    expect(mocks.query.mock.calls[0].slice(1)).toEqual(["student", "course"]);
    expect(sql).toContain('ci."runtimeConfig"->\'makeArtifactMode\'');
    expect(sql).toContain('p."instanceId" = ci.id');
    expect(sql).not.toMatch(/SELECT\s+\*|ProjectGroup|Evaluation|TeacherAgentDirective|ClassroomSubmission|StudentProjectWorkspace|AiMessage|AiTask|snapshot/);
    expect(mocks.snapshot).toHaveBeenCalledWith({ where: { id: row.templateVersionId }, select: { snapshot: true } });
    expect(mocks.template).not.toHaveBeenCalled(); expect(mocks.fallback).not.toHaveBeenCalled();
  });
  it.each([null, "", false, "other", "python", "c", "document", "unknown", {}])("preserves runtime mode truthiness and normalization for %j", async runtime => {
    row.makeArtifactMode = runtime; const raw = snapshot("other"); mocks.snapshot.mockResolvedValue({ snapshot: raw });
    expect(await getDocumentReadContext("course", "student")).toEqual(expected(raw));
  });
  it.each([null, 0, "1", false, [], {}, -1, 99])("preserves canonical stages and Number/index semantics for %j", async index => {
    row.currentStageIndex = index;
    expect(await getDocumentReadContext("course", "student")).toEqual(expected(snapshot()));
  });
  it("retains invalid-design defaults and observes subsequent live stage/mode/membership changes", async () => {
    mocks.snapshot.mockResolvedValue({ snapshot: { invalid: true } });
    expect(await getDocumentReadContext("course", "student")).toEqual(expected({ invalid: true }));
    row.currentStageIndex = 0; row.makeArtifactMode = "c"; row.hasStudent = false;
    expect(await getDocumentReadContext("course", "student")).toEqual(expected({ invalid: true }));
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it("keeps instance precedence, missing-instance template/demo fallback and database errors", async () => {
    const course = createPblTemplateCourse("course"); course.students = [{ id: "student", name: "Student", joinedAt: "now", stageProgress: {} }];
    mocks.query.mockResolvedValueOnce([]); mocks.template.mockResolvedValue(course);
    expect(await getDocumentReadContext("course", "student")).toMatchObject({ student: { id: "student" }, currentStageKey: course.stages[0]?.key });
    expect(mocks.template).toHaveBeenCalledWith("course"); mocks.template.mockClear();
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getDocumentReadContext("course", "student")).rejects.toThrow("database unavailable"); expect(mocks.template).not.toHaveBeenCalled();
    mocks.configured.mockReturnValue(false); mocks.fallback.mockResolvedValue(course); mocks.query.mockClear();
    expect(await getDocumentReadContext("course", "other")).toMatchObject({ student: undefined, currentStageKey: course.stages[0]?.key });
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.fallback).toHaveBeenCalledWith("course", { studentId: "other" });
  });
});
