import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { getStagesForSystemMode } from "@/lib/system-mode";

const mocks = vi.hoisted(() => ({ configured: vi.fn(), query: vi.fn(), design: vi.fn(), fallback: vi.fn(), template: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.configured, prisma: { $queryRaw: mocks.query } }));
vi.mock("@/lib/db/classroom-design-cache", () => ({ readClassroomDesign: mocks.design }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.fallback }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.template }));
import { getCodeReadContext, loadCodeReadContext } from "./code-read-context";

describe("code GET context", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.configured.mockReturnValue(true);
    mocks.query.mockResolvedValue([{ templateVersionId: "version", templateStatus: "PUBLISHED", currentStageIndex: 1, hasStudent: true }]);
    mocks.design.mockResolvedValue({ stages: [{ key: "proposal" }, { key: "make" }] });
  });

  it("reads only live roster membership and stage metadata, preserving instance precedence over template IDs", async () => {
    expect(await getCodeReadContext("course", "student")).toEqual({ student: { id: "student" }, currentStageKey: "make" });
    const query = mocks.query.mock.calls[0][0].join("");
    expect(mocks.query.mock.calls[0].slice(1)).toEqual(["student", "course"]);
    expect(query).toContain('ci."runtimeConfig"->\'currentStageIndex\'');
    expect(query).toContain('p."instanceId" = ci.id');
    expect(query).not.toMatch(/SELECT\s+\*|AiMessage|AiTask|ClassroomSubmission|projectState|snapshot/);
    expect(mocks.design).toHaveBeenCalledWith(expect.anything(), { id: "version", status: "PUBLISHED" });
    expect(mocks.fallback).not.toHaveBeenCalled(); expect(mocks.template).not.toHaveBeenCalled();
  });

  it.each([null, 0, 1, "1", false, [], {}, 12, -1])("preserves the existing Number/index rules for %j", async currentStageIndex => {
    mocks.query.mockResolvedValue([{ templateVersionId: "version", templateStatus: "DRAFT", currentStageIndex, hasStudent: true }]);
    const stages = [{ key: "proposal" }, { key: "make" }];
    expect((await loadCodeReadContext("course", "student"))?.currentStageKey).toBe(stages[Number(currentStageIndex ?? 0)]?.key);
    expect(mocks.design.mock.calls[0][1].status).toBe("DRAFT");
  });

  it("does not manufacture missing membership or hide database errors as success", async () => {
    mocks.query.mockResolvedValueOnce([{ templateVersionId: "version", templateStatus: "PUBLISHED", currentStageIndex: 1, hasStudent: false }]);
    expect(await getCodeReadContext("course", "student")).toEqual({ student: undefined, currentStageKey: "make" });
    mocks.query.mockRejectedValueOnce(new Error("DB unavailable"));
    await expect(getCodeReadContext("course", "student")).rejects.toThrow("DB unavailable");
    expect(mocks.template).not.toHaveBeenCalled();
  });

  it("keeps canonical defaults for an invalid design and leaves read authorization to the route", async () => {
    mocks.design.mockResolvedValue(null);
    expect((await loadCodeReadContext("course", "student"))?.currentStageKey).toBe(getStagesForSystemMode()[1]?.key);
    const sql = mocks.query.mock.calls[0][0].join("");
    expect(sql).not.toContain("TEACHING"); expect(sql).not.toContain("ACTIVE");
  });

  it("retains the template fallback only when there is no instance, and demo reads use the original store", async () => {
    const course = { ...createPblTemplateCourse("same-id"), students: [{ id: "student", name: "Student", joinedAt: "now" }] };
    mocks.query.mockResolvedValue([]); mocks.template.mockResolvedValue(course);
    expect(await getCodeReadContext("same-id", "student")).toEqual({ student: { id: "student" }, currentStageKey: course.stages[0]?.key });
    expect(mocks.template).toHaveBeenCalledWith("same-id");
    mocks.configured.mockReturnValue(false); mocks.fallback.mockResolvedValue(course); mocks.query.mockClear();
    expect(await getCodeReadContext("same-id", "other")).toEqual({ student: undefined, currentStageKey: course.stages[0]?.key });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.fallback).toHaveBeenCalledWith("same-id", { studentId: "other" });
  });
});
