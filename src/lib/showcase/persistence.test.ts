// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createPblTemplateCourse, encodePblTemplate } from "@/lib/platform/pbl-template";
import { createShowcaseStore } from "./persistence";

const defaultDb = vi.hoisted(() => ({}));
vi.mock("@/lib/db/client", () => ({ prisma: defaultDb }));
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
type Selection = Record<string, boolean | { select: Selection }>;

/** Simulate the database returning only requested fields, rather than a broad
 * fixture hiding a missing relation/column in the adapter's real projection. */
function selected(row: Row, select: Selection): Row {
  return Object.fromEntries(Object.entries(select).filter(([, option]) => option).map(([key, option]) => [key,
    typeof option === "object" && row[key] != null ? selected(row[key] as Row, option.select) : row[key],
  ]));
}

const at = new Date("2026-10-01T10:00:00Z");
const source = createPblTemplateCourse("course", { name: "Published lesson" });
const snapshot = encodePblTemplate(source);

describe("showcase storage read projections", () => {
  let instance: Row;
  let fileRows: Row[];
  let presentationRows: Row[];
  let db: {
    classroomInstance: { findUnique: ReturnType<typeof vi.fn> };
    artifactVersion: { findMany: ReturnType<typeof vi.fn> };
    showcasePresentation: { findMany: ReturnType<typeof vi.fn> };
  };
  let store: ReturnType<typeof createShowcaseStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    instance = { id: "course", status: "TEACHING", runtimeConfig: { version: 7, currentStageIndex: 3, uiState: { private: "live" } }, templateVersion: { snapshot, mediaRefs: "unneeded media" } };
    fileRows = [];
    presentationRows = [];
    db = {
      classroomInstance: { findUnique: vi.fn(async ({ select }) => instance ? selected(instance, select) : null) },
      artifactVersion: { findMany: vi.fn(async ({ select }) => fileRows.map((row) => selected(row, select))) },
      showcasePresentation: { findMany: vi.fn(async ({ include }) => presentationRows.map((row) => ({ ...row, participation: selected(row.participation as Row, include.participation.select) }))) },
    };
    store = createShowcaseStore(db as unknown as Prisma.TransactionClient);
  });
  afterEach(() => vi.useRealTimers());

  it("returns exactly the course gate fields with the same runtime/default precedence", async () => {
    const config = { version: "9", currentStageIndex: "3", stages: null, content: null, uiState: null, presentingGroupId: 42, presentingStudentId: "student", unrelatedLargeDraft: "private".repeat(10_000) };
    instance.runtimeConfig = config;
    const full = await store.loadCourse({ where: { id: "course" } });
    const select = { id: true, status: true, currentStageIndex: true, stages: true, content: true, uiState: true, presentingGroupId: true, presentingStudentId: true, name: false } as const;
    const gate = await store.loadCourse({ where: { id: "course" }, select });
    expect(gate).toEqual(Object.fromEntries(Object.keys(select).filter((key) => select[key as keyof typeof select]).map((key) => [key, full![key as keyof typeof full]])));
    expect(gate).toMatchObject({ id: "course", currentStageIndex: 3, status: "teaching", content: null, uiState: {}, presentingGroupId: null, presentingStudentId: "student" });
    expect(gate).not.toHaveProperty("unrelatedLargeDraft");
    expect(gate).not.toHaveProperty("name");
    expect(db.classroomInstance.findUnique.mock.lastCall?.[0]).toEqual({ where: { id: "course" }, select: { id: true, status: true, runtimeConfig: true, templateVersion: { select: { id: true, status: true, snapshot: true } } } });
  });

  it("does not read runtime JSON for export name or template JSON for runtime-only reads", async () => {
    expect(await store.loadCourse({ where: { id: "course" }, select: { id: true, name: true } })).toEqual({ id: "course", name: "Published lesson" });
    expect(db.classroomInstance.findUnique.mock.lastCall?.[0].select.runtimeConfig).toBe(false);
    expect(await store.loadCourse({ where: { id: "course" }, select: { id: true, status: true } })).toEqual({ id: "course", status: "teaching" });
    expect(db.classroomInstance.findUnique.mock.lastCall?.[0].select).toMatchObject({ runtimeConfig: false, templateVersion: false });
    expect(await store.loadCourse({ where: { id: "course" }, select: { version: true, uiState: true } })).toEqual({ version: 7, uiState: { private: "live" } });
    expect(db.classroomInstance.findUnique.mock.lastCall?.[0].select.templateVersion).toBe(false);
    instance.runtimeConfig = { version: 8, uiState: { private: "changed" } };
    expect(await store.loadCourse({ where: { id: "course" }, select: { version: true, uiState: true } })).toEqual({ version: 8, uiState: { private: "changed" } });
  });

  it("preserves complete no-select results, invalid-template defaults and missing rows", async () => {
    instance.templateVersion = { snapshot: { invalid: true } };
    instance.runtimeConfig = { summary: "live override", content: { legacy: true }, version: 2 };
    const full = await store.loadCourse({ where: { id: "course" } });
    expect(full).toEqual({ ...createPblTemplateCourse("course"), summary: "live override", content: { legacy: true }, version: 2, status: "teaching", uiState: {}, presentingGroupId: null, presentingStudentId: null });
    expect(await store.loadCourse({ where: { id: "course" }, select: { name: true, content: true } })).toEqual({ name: "未命名课程", content: { legacy: true } });
    db.classroomInstance.findUnique.mockResolvedValueOnce(null);
    expect(await store.loadCourse({ where: { id: "missing" }, select: { id: true } })).toBeNull();
  });

  it("keeps every file version, null fallback, alias, kind and ordering without bodies or broad ownership rows", async () => {
    const participation = { instanceId: "course", stageProgress: { unused: "large".repeat(20_000) }, enrollment: { userId: "student", offeringId: "offering", researchKey: "unused-private" } };
    const file = (id: string, sequence: number, type: string) => ({ id, sequence, fileAssetId: `upload-${id}`, sourceHtml: "unneeded body", mimeType: null, sha256: null, size: BigInt(123), status: "SUBMITTED", submittedAt: null, createdAt: at,
      artifact: { groupId: "offering:grp-student", title: id, type, participation }, fileAsset: { mimeType: "application/pdf", regenerationRecipe: { unused: true } } });
    fileRows = [file("old-pdf", 1, "PDF_ARCHIVE"), file("new-file", 2, "FILE_ARCHIVE")];
    const rows = await store.listFiles({ where: { courseId: "course" }, orderBy: { sequence: "desc" } });
    expect(rows.map((row) => [row.id, row.sequence, row.kind, row.groupId, row.studentId, row.courseId])).toEqual([
      ["new-file", 2, "file", "grp-student", "student", "course"], ["old-pdf", 1, "pdf", "grp-student", "student", "course"],
    ]);
    expect(rows[0]).toMatchObject({ mimeType: "application/pdf", size: 123, submittedAt: at, createdAt: at, status: "submitted" });
    const query = db.artifactVersion.findMany.mock.lastCall?.[0];
    expect(query.where.artifact.participation).toEqual({ instanceId: "course" });
    expect(query.select).not.toHaveProperty("sourceHtml");
    expect(query.select.artifact.select.participation.select).toEqual({ instanceId: true, enrollment: { select: { userId: true, offeringId: true } } });
    expect(JSON.stringify(rows)).not.toContain("unused-private");
    await store.listFiles({ where: { courseId: "course", studentId: "student", kind: "pdf" } });
    expect(db.artifactVersion.findMany.mock.lastCall?.[0].where.artifact.participation).toEqual({ instanceId: "course", enrollment: { userId: "student" } });
  });

  it("preserves complete presentation history and private adapter metadata with narrow fresh ownership", async () => {
    const participation = { instanceId: "course", stageProgress: { unused: "large".repeat(20_000) }, enrollment: { userId: "student", offeringId: "offering", researchKey: "unused-private" } };
    const row = (id: string, status: string, offset: number) => ({ id, artifactVersionId: "version", participation, groupId: "offering:grp-student", status, createdAt: at, updatedAt: new Date(at.getTime() + offset), content: {
      revision: 3, artifactKind: "document", artifactTitle: "private artifact", displayMode: "continuous", evaluationNote: "teacher-only", evaluatedBy: "teacher", evaluatedAt: at.toISOString(), retainedLegacyField: { evidence: "retained" },
    } });
    presentationRows = [row("ended", "ENDED", 10), row("cancelled", "CANCELLED", 0), row("active", "ACTIVE", 20)];
    const all = await store.listPresentations({ where: { courseId: "course" }, orderBy: { updatedAt: "desc" } });
    expect(all.map((item) => item.id)).toEqual(["active", "ended", "cancelled"]);
    expect(all[0]).toMatchObject({ courseId: "course", studentId: "student", groupId: "grp-student", evaluationNote: "teacher-only", evaluatedBy: "teacher", evaluatedAt: at, retainedLegacyField: { evidence: "retained" } });
    const visible = await store.listPresentations({ where: { courseId: "course", status: { in: ["active", "ended"] } }, orderBy: { updatedAt: "desc" } });
    expect(visible.map((item) => item.id)).toEqual(["active", "ended"]);
    expect(db.showcasePresentation.findMany.mock.lastCall?.[0].include).toEqual({ participation: { select: { instanceId: true, enrollment: { select: { userId: true, offeringId: true } } } } });
  });
});

describe("showcase published design reuse with live runtime", () => {
  const gate = { where: { id: "course" }, select: { name: true, stages: true, content: true, uiState: true, currentStageIndex: true, version: true } } as const;
  let version = 0;
  function fixture(status = "PUBLISHED") {
    const instance = { id: "course", status: "TEACHING", runtimeConfig: { version: 7, currentStageIndex: 3, uiState: { live: "first" } },
      templateVersion: { id: `showcase-cache-${++version}`, status, snapshot } };
    const findUnique = vi.fn(async ({ select }: { select: Selection }) => structuredClone(selected(instance, select)));
    const readSnapshot = vi.fn(async () => ({ snapshot: structuredClone(instance.templateVersion.snapshot) }));
    Object.assign(defaultDb, { classroomInstance: { findUnique }, classroomTemplateVersion: { findUnique: readSnapshot } });
    return { instance, findUnique, readSnapshot, store: createShowcaseStore() };
  }
  it("reuses only published snapshots, refreshes runtime every time and isolates nested results", async () => {
    const { instance, findUnique, readSnapshot, store } = fixture();
    const first = await store.loadCourse(gate);
    (first!.stages as typeof source.stages)[0].label = "mutated caller";
    first!.content.pblOutline = "mutated caller";
    instance.runtimeConfig = { version: 8, currentStageIndex: 4, uiState: { live: "changed" } };
    const second = await store.loadCourse(gate);
    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(findUnique.mock.lastCall?.[0].select.templateVersion).toEqual({ select: { id: true, status: true } });
    expect(second).toMatchObject({ name: "Published lesson", version: 8, currentStageIndex: 4, uiState: { live: "changed" } });
    expect((second!.stages as typeof source.stages)[0].label).not.toBe("mutated caller");
    expect(second!.content).toEqual(source.content);
    instance.templateVersion.id += "-next";
    instance.templateVersion.snapshot = encodePblTemplate(createPblTemplateCourse("course", { name: "New published version" }));
    expect((await store.loadCourse(gate))!.name).toBe("New published version");
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a previously published cache entry when the live version is DRAFT", async () => {
    const { instance, readSnapshot, store } = fixture();
    await store.loadCourse(gate);
    instance.templateVersion.status = "DRAFT";
    for (const name of ["Draft one", "Draft two"]) {
      instance.templateVersion.snapshot = encodePblTemplate(createPblTemplateCourse("course", { name }));
      expect((await store.loadCourse(gate))!.name).toBe(name);
    }
    expect(readSnapshot).toHaveBeenCalledTimes(3);
  });
  it("concurrent published readers share the fetch but receive independent nested designs", async () => {
    const { readSnapshot, store } = fixture();
    let release!: (value: { snapshot: typeof snapshot }) => void;
    readSnapshot.mockImplementation(() => new Promise(yes => { release = yes; }));
    const a = store.loadCourse(gate), b = store.loadCourse(gate);
    await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
    release({ snapshot });
    const [first, second] = await Promise.all([a, b]);
    first!.content.pblOutline = "caller change";
    (first!.stages as typeof source.stages)[0].label = "caller label";
    expect(second!.content.pblOutline).not.toBe("caller change");
    expect((second!.stages as typeof source.stages)[0].label).not.toBe("caller label");
  });
  it("transaction reads use their own complete snapshot even for the same cached published version", async () => {
    const { instance, readSnapshot, store } = fixture();
    await store.loadCourse(gate);
    const txRead = vi.fn(async ({ select }: { select: Selection }) => structuredClone(selected(instance, select)));
    const tx = createShowcaseStore({ classroomInstance: { findUnique: txRead } } as unknown as Prisma.TransactionClient);
    for (const name of ["Transaction one", "Transaction two"]) {
      instance.templateVersion.snapshot = encodePblTemplate(createPblTemplateCourse("course", { name }));
      expect((await tx.loadCourse(gate))!.name).toBe(name);
    }
    expect(txRead.mock.lastCall?.[0].select.templateVersion).toEqual({ select: { id: true, status: true, snapshot: true } });
    expect(readSnapshot).toHaveBeenCalledOnce();
    expect((await store.loadCourse(gate))!.name).toBe("Published lesson");
  });
});
