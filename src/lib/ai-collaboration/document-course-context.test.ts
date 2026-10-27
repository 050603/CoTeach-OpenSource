import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { buildAuthoritativeCourseContext } from "./document-policy";

const mocks = vi.hoisted(() => ({
  instance: vi.fn(), groups: vi.fn(), evaluations: vi.fn(), directives: vi.fn(), evidence: vi.fn(), workspaces: vi.fn(),
  configured: vi.fn(), fallback: vi.fn(), template: vi.fn(), design: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.configured, prisma: {
  classroomInstance: { findUnique: mocks.instance }, projectGroup: { findMany: mocks.groups },
  classroomTemplateVersion: { findUnique: mocks.design },
  evaluation: { findMany: mocks.evaluations }, teacherAgentDirective: { findMany: mocks.directives },
  classroomSubmission: { findMany: mocks.evidence }, $queryRaw: mocks.workspaces,
} }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.fallback }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.template }));
import { getDocumentCourseContext, loadDocumentCourseContext } from "./document-course-context";
import { prisma } from "@/lib/db/client";

const time = new Date("2026-09-27T00:00:00.000Z");
let versionSequence = 0;
let versionId = "";
function snapshot(point = "控制变量") {
  return { schemaVersion: 2, kind: "pbl-course", design: {
    name: "旧模板标题", grade: "七年级", stages: [{ key: "proposal", label: "方案" }, { key: "make", label: "制作", description: "对比节能结果" }],
    pblConfig: { makeArtifactMode: "document" }, content: { knowledgePoints: [{ id: "kp", name: point }] },
  } };
}
function instance() {
  return {
    id: "course", status: "TEACHING", runtimeConfig: { version: 9, currentStageIndex: 1, makeArtifactMode: "other" }, createdAt: time, updatedAt: time,
    activity: { title: "实例标题", chapter: { offeringId: "offering" } },
    templateVersion: { id: versionId, status: "PUBLISHED" },
    participations: ["self", "peer"].map(id => ({ id: `p-${id}`, firstEnteredAt: null, lastEnteredAt: time, stageProgress: { progress: { make: 10 } },
      enrollment: { userId: id, joinedAt: time, user: { displayName: id } },
    })),
  };
}

describe("document AI course context", () => {
  beforeEach(() => {
    vi.resetAllMocks(); versionId = `document-context-${++versionSequence}`;
    mocks.configured.mockReturnValue(true); mocks.instance.mockResolvedValue(instance()); mocks.design.mockResolvedValue({ snapshot: snapshot() });
    for (const fn of [mocks.groups, mocks.evaluations, mocks.directives, mocks.evidence, mocks.workspaces]) fn.mockResolvedValue([]);
  });

  it("keeps frozen design, runtime overrides and live student identity without unrelated projections", async () => {
    const result = await getDocumentCourseContext("course", "self");
    expect(result).toMatchObject({ name: "实例标题", grade: "七年级", version: 9, status: "teaching", currentStageIndex: 1, pblConfig: { makeArtifactMode: "other" } });
    expect(result?.students).toEqual(["self", "peer"].map(id => ({ id, name: id, joinedAt: time.toISOString(), lastSeenAt: time.toISOString(), stageProgress: { make: 10 } })));
    expect(result?.content.knowledgePoints).toEqual([{ id: "kp", name: "控制变量" }]);
    for (const key of ["learningEvents", "companionThreads", "showcasePresentations", "projectDocumentVersions", "aiLearningTimingByStudent"]) expect(result).not.toHaveProperty(key);
    expect(mocks.instance.mock.calls[0][0].select.templateVersion).toEqual({ select: { id: true, status: true } });
    expect(mocks.design).toHaveBeenCalledWith({ where: { id: versionId }, select: { snapshot: true } });
    const workspaceQuery = mocks.workspaces.mock.calls[0][0] as Prisma.Sql;
    expect(workspaceQuery.sql).toContain("jsonb_build_object('aiLearningProgress', w.\"projectState\"->'aiLearningProgress')");
    expect(workspaceQuery.sql).toContain('w."participationId" IN (?)');
    expect(workspaceQuery.values).toEqual(["p-self"]);
    expect(mocks.fallback).not.toHaveBeenCalled(); expect(mocks.template).not.toHaveBeenCalled();
  });

  it("deduplicates before target filtering and preserves last value at the first position", async () => {
    mocks.groups.mockResolvedValue([{ id: "offering:grp-self", name: "个人项目", board: { snapshot: { proposal: { topic: "节能", goal: "控制条件", selectedForms: ["报告"] }, nodes: ["unused"] } },
      members: [{ userId: "self", role: "MEMBER", user: { displayName: "本人" } }], createdAt: time, updatedAt: time }]);
    const feedback = (id: string, targetId: string, content: string) => ({ metadata: { collection: "feedback", view: { id, stageKey: "make", targetType: "student", targetId, content } } });
    mocks.evaluations.mockResolvedValue([feedback("duplicate", "self", "应被覆盖"), feedback("second", "grp-self", "组内反馈"), feedback("duplicate", "peer", "别人的更新"),
      { metadata: { collection: "feedback", view: { id: "whole", stageKey: "make", targetType: "course", targetId: "course", content: "全班要求" } } }]);
    const evidence = (id: string, studentId: string, summary: string) => ({ payload: { collection: "learningEvidence", view: { id, stageKey: "make", studentId, title: id, summary } } });
    mocks.evidence.mockResolvedValue([evidence("same", "self", "旧证据"), evidence("kept", "self", "本人证据"), evidence("same", "peer", "其他学生证据")]);
    mocks.directives.mockResolvedValue([{ payload: { view: { status: "active", stageKey: "make", targetScope: "course", targetStudentIds: [], goal: "测量", instruction: "同一时间段" } } }]);
    const progress = { knowledgeLectureAttempts: [{ questions: [{ correct: false, knowledgePointIds: ["kp"], prompt: "方法", feedback: "控制条件" }] }] };
    mocks.workspaces.mockResolvedValue([{ participationId: "p-self", projectState: { aiLearningProgress: progress, largeDraft: "unused" } }]);
    const result = (await loadDocumentCourseContext("course", "self"))!;
    expect(result.feedback?.map(item => item.id)).toEqual(["duplicate", "second", "whole"]);
    expect(result.learningEvidence?.map(item => item.id)).toEqual(["same", "kept"]);
    expect(result.aiLearningProgress).toEqual({ self: progress });
    const text = buildAuthoritativeCourseContext(result, "self", "make");
    for (const value of ["组内反馈", "全班要求", "本人证据", "控制条件", "同一时间段", "报告"]) expect(text).toContain(value);
    for (const value of ["应被覆盖", "别人的更新", "旧证据", "其他学生证据"]) expect(text).not.toContain(value);
    expect(mocks.evidence).toHaveBeenCalledWith({ where: { participationId: { in: ["p-self", "p-peer"] }, payload: { path: ["collection"], equals: "learningEvidence" } }, select: { payload: true } });
    expect(mocks.directives.mock.calls[0][0].where.OR).toEqual([{ participationId: { in: ["p-self", "p-peer"] } }, { payload: { path: ["instanceId"], equals: "course" } }]);
  });

  it("does not reuse settled runtime, group or feedback results", async () => {
    await loadDocumentCourseContext("course", "self");
    const changed = instance(); changed.runtimeConfig = { version: 10, currentStageIndex: 0, makeArtifactMode: "document" };
    changed.status = "FINISHED"; mocks.instance.mockResolvedValue(changed);
    expect(await loadDocumentCourseContext("course", "self")).toMatchObject({ version: 10, currentStageIndex: 0, status: "finished", pblConfig: { makeArtifactMode: "document" } });
    expect(mocks.instance).toHaveBeenCalledTimes(2); expect(mocks.groups).toHaveBeenCalledTimes(2);
  });
  it("reads canonical feedback results alongside older metadata views", async () => {
    const canonical = { id: "new-feedback", stageKey: "make", targetType: "student", targetId: "self", content: "新格式反馈" };
    const legacy = { id: "old-feedback", stageKey: "make", targetType: "student", targetId: "self", content: "旧格式反馈" };
    mocks.evaluations.mockResolvedValue([
      { metadata: { schemaVersion: 2, collection: "feedback" }, result: canonical },
      { metadata: { collection: "feedback", view: legacy }, result: null },
    ]);
    expect((await loadDocumentCourseContext("course", "self"))?.feedback).toEqual([canonical, legacy]);
  });

  it("shares only simultaneous common reads and keeps each student's workspace separate", async () => {
    mocks.workspaces.mockImplementation((query: Prisma.Sql) => Promise.resolve([
      { participationId: query.values[0], projectState: { aiLearningProgress: { owner: query.values[0] } } },
    ]));
    const [self, peer] = await Promise.all([loadDocumentCourseContext("course", "self"), loadDocumentCourseContext("course", "peer")]);
    expect(mocks.instance).toHaveBeenCalledTimes(1); expect(mocks.groups).toHaveBeenCalledTimes(1);
    expect(mocks.workspaces).toHaveBeenCalledTimes(2);
    expect(self?.aiLearningProgress).toEqual({ self: { owner: "p-self" } });
    expect(peer?.aiLearningProgress).toEqual({ peer: { owner: "p-peer" } });
  });

  it("reuses the published immutable design but keeps runtime and progress reads fresh and independent", async () => {
    mocks.workspaces.mockResolvedValueOnce([{ participationId: "p-self", projectState: { aiLearningProgress: { marker: "old" } } }]);
    const first = (await loadDocumentCourseContext("course", "self"))!;
    first.content.knowledgePoints[0].name = "caller mutation";
    const changed = instance(); changed.runtimeConfig = { version: 10, currentStageIndex: 0, makeArtifactMode: "document" };
    mocks.instance.mockResolvedValue(changed);
    mocks.workspaces.mockResolvedValueOnce([{ participationId: "p-self", projectState: { aiLearningProgress: { marker: "new" } } }]);
    const second = (await loadDocumentCourseContext("course", "self"))!;
    expect(second.content.knowledgePoints[0].name).toBe("控制变量");
    expect(second).toMatchObject({ version: 10, currentStageIndex: 0, aiLearningProgress: { self: { marker: "new" } } });
    expect(mocks.design).toHaveBeenCalledOnce(); expect(mocks.instance).toHaveBeenCalledTimes(2); expect(mocks.workspaces).toHaveBeenCalledTimes(2);
  });

  it("reads drafts freshly through the existing design loader", async () => {
    const draft = instance(); draft.templateVersion.status = "DRAFT"; mocks.instance.mockResolvedValue(draft);
    mocks.design.mockResolvedValueOnce({ snapshot: snapshot("draft one") }).mockResolvedValueOnce({ snapshot: snapshot("draft two") });
    const first = await loadDocumentCourseContext("course", "self");
    const second = await loadDocumentCourseContext("course", "self");
    expect(first?.content.knowledgePoints[0].name).toBe("draft one");
    expect(second?.content.knowledgePoints[0].name).toBe("draft two");
    expect(mocks.design).toHaveBeenCalledTimes(2);
  });

  it("never joins a cached published design into a transaction read", async () => {
    await loadDocumentCourseContext("course", "self");
    const txDesign = vi.fn().mockResolvedValueOnce({ snapshot: snapshot("transaction one") }).mockResolvedValueOnce({ snapshot: snapshot("transaction two") });
    const tx = { ...prisma, classroomTemplateVersion: { findUnique: txDesign } } as unknown as Prisma.TransactionClient;
    const first = await loadDocumentCourseContext("course", "self", tx);
    const second = await loadDocumentCourseContext("course", "self", tx);
    expect(first?.content.knowledgePoints[0].name).toBe("transaction one");
    expect(second?.content.knowledgePoints[0].name).toBe("transaction two");
    expect(txDesign).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, false, 0, "", {}, [], { completed: ["one"], nested: { untouched: true } }])("preserves the previous progress projection for %j", async progress => {
    mocks.workspaces.mockResolvedValue([{ participationId: "p-self", projectState: { aiLearningProgress: progress } }]);
    expect((await loadDocumentCourseContext("course", "self"))?.aiLearningProgress).toEqual(progress ? { self: progress } : {});
  });

  it("does not issue an invalid empty workspace IN query when the live roster has no own participation", async () => {
    const changed = instance(); changed.participations = changed.participations.filter(row => row.enrollment.userId !== "self");
    mocks.instance.mockResolvedValue(changed);
    expect((await loadDocumentCourseContext("course", "self"))?.aiLearningProgress).toEqual({});
    expect(mocks.workspaces).not.toHaveBeenCalled();
  });

  it("stops missing-instance reads and retains the original template namespace fallback", async () => {
    mocks.instance.mockResolvedValue(null); mocks.template.mockResolvedValue({ id: "template" });
    expect(await getDocumentCourseContext("missing", "self")).toEqual({ id: "template" });
    expect(mocks.groups).not.toHaveBeenCalled(); expect(mocks.template).toHaveBeenCalledWith("missing");
  });

  it("retains the original non-database fallback", async () => {
    mocks.configured.mockReturnValue(false); mocks.fallback.mockResolvedValue({ id: "demo" });
    expect(await getDocumentCourseContext("demo", "self")).toEqual({ id: "demo" });
    expect(mocks.fallback).toHaveBeenCalledWith("demo", { studentId: "self" }); expect(mocks.instance).not.toHaveBeenCalled();
  });
});
