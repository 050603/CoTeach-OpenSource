import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { Course, LearningSignal } from "@/lib/session/types";
import { applySessionAction, initialSessionState, normalizeCourse } from "@/lib/session/actions";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
const { cancelContentMonitorChecks } = vi.hoisted(() => ({ cancelContentMonitorChecks: vi.fn() }));
vi.mock("@/lib/companion/server-store", () => ({ loadCompanionState: vi.fn(async () => ({})), persistCompanionState: vi.fn(async () => undefined) }));
vi.mock("@/lib/project-practice/content-monitor-cancellation", () => ({ cancelContentMonitorChecks }));
import { assertImmutableClassroomDesign, persistInstanceCourse, projectStoredCourseResource } from "./v2-course-projection";
function fixture() {
  const course = createPblTemplateCourse("instance", { name: "Project" }); course.status = "teaching"; course.version = 1;
  course.students = ["a", "b"].map(id => ({ id, name: id, joinedAt: "2026-09-01T00:00:00Z", stageProgress: {} }));
  course.groups = [{ id: "group", name: "Team", topic: "Topic", keywords: [], selectedForms: [], members: [{ studentId: "a", name: "Alex" }, { studentId: "b", name: "Alex" }], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }];
  return course;
}
const teacher = { id: "teacher-2", role: "teacher" };
let delegates: Record<string, { findUnique: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> }>;
let db: Prisma.TransactionClient;
beforeEach(() => {
  cancelContentMonitorChecks.mockReset().mockResolvedValue(0);
  delegates = Object.fromEntries(["classroomInstance", "classroomParticipation", "studentProjectWorkspace", "classroomSubmission", "reflection", "evaluation", "aiSupportRecord", "intervention", "projectGroup", "groupBoard", "groupMember", "announcement", "announcementReply", "todo", "todoCompletion", "resource", "workPlanItem", "domainEvent", "learningSignal", "teacherAgentDirective", "fileAsset"].map(name => [name, { findUnique: vi.fn(async () => null), findUniqueOrThrow: vi.fn(), update: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() }]));
  delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ id: "instance", activityId: "activity", status: "TEACHING", startedAt: new Date(), runtimeConfig: {}, activity: { chapter: { offeringId: "offering", offering: { status: "OPEN", teachers: [{ userId: "teacher-1" }, { userId: "teacher-2" }] } } }, participations: ["a", "b"].map(id => ({ id: `p-${id}`, enrollmentId: `e-${id}`, enrollment: { userId: id, offeringId: "offering", status: "ACTIVE" } })) });
  db = delegates as unknown as Prisma.TransactionClient;
});
describe("V2 classroom projection writes", () => {
  it.each([undefined, 50])("preserves server-owned evaluation progress %s through generic classroom writes", async reflection => {
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" }, include: { participations: { include: { enrollment: true } } } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, runtimeConfig: { evaluationContractVersion: 2 }, participations: instance.participations.map(p => ({ ...p, stageProgress: { progress: reflection === undefined ? {} : { reflection } } })) });
    const before = fixture();
    const after = { ...before, students: before.students.map(student => student.id === "a" ? { ...student, stageProgress: { reflection: 100, "ai-learning": 70 } } : student) };
    await persistInstanceCourse(db, before, after, teacher);
    const progress = delegates.classroomParticipation.update.mock.calls[0][0].data.stageProgress.progress;
    expect(progress["ai-learning"]).toBe(70);
    if (reflection === undefined) expect(progress).not.toHaveProperty("reflection");
    else expect(progress.reflection).toBe(reflection);
    expect(after.students[0].stageProgress.reflection).toBe(100);
  });
  it("stores reflection text once and evaluation views in their canonical result", async () => {
    const before = fixture();
    const reflection = { id: "reflection", courseId: "instance", studentId: "a", studentName: "Alex", content: "完整反思正文",
      improvementPlan: "下次验证来源", createdAt: "2026-10-20T01:00:00Z", updatedAt: "2026-10-20T01:00:00Z" };
    const feedback = { id: "feedback", courseId: "instance", targetType: "student" as const, targetId: "a", stageKey: "make",
      kind: "comment" as const, content: "完整教师反馈", createdAt: "2026-10-20T01:00:00Z" };
    await persistInstanceCourse(db, before, { ...before, reflections: [reflection], feedback: [feedback] }, teacher);
    const savedReflection = delegates.reflection.upsert.mock.calls[0][0].create;
    expect(savedReflection.content).toBe(reflection.content);
    expect(savedReflection.metadata.view).not.toHaveProperty("content");
    expect(savedReflection.metadata.view).toMatchObject({ improvementPlan: reflection.improvementPlan, studentId: "a" });
    const savedFeedback = delegates.evaluation.upsert.mock.calls[0][0].create;
    expect(savedFeedback.result).toEqual(feedback);
    expect(savedFeedback.metadata).toMatchObject({ schemaVersion: 2, instanceId: "instance", collection: "feedback" });
    expect(savedFeedback.metadata).not.toHaveProperty("view");
  });
  it("persists a teacher projection activity with an idempotent classroom record", async () => {
    const before = normalizeCourse(fixture());
    const record = { id: "projection-activity", actor: "教师", action: "投屏知识讲授历史页面", detail: "能量守恒", createdAt: "2026-10-19T08:46:03Z" };
    const after = applySessionAction({ ...initialSessionState(), courses: [before] }, {
      type: "ADD_ACTIVITY", payload: { courseId: before.id, activity: record },
    }).courses[0]!;
    await persistInstanceCourse(db, before, after, teacher);
    expect(delegates.domainEvent.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "activity:instance:projection-activity" },
      create: expect.objectContaining({ actorId: teacher.id, classroomInstanceId: before.id, eventType: "CLASSROOM_ACTIVITY", payload: expect.objectContaining({ view: record }) }),
      update: {},
    });
  });

  it("rejects an activity from a teacher removed from the offering before persistence", async () => {
    const before = fixture();
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: before.id }, include: {
      activity: { include: { chapter: { include: { offering: { include: { teachers: true } } } } } },
    } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, activity: { ...instance.activity, chapter: {
      ...instance.activity.chapter, offering: { ...instance.activity.chapter.offering, teachers: [] },
    } } });
    await expect(persistInstanceCourse(db, before, { ...before, activityLog: [{
      id: "projection-activity", actor: "教师", action: "投屏", createdAt: "2026-10-19T08:46:03Z",
    }] }, teacher)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(delegates.classroomInstance.update).not.toHaveBeenCalled();
    expect(delegates.domainEvent.upsert).not.toHaveBeenCalled();
  });

  it("restores the canonical upload URL for a classroom video", () => {
    expect(projectStoredCourseResource({
      id: "video-resource",
      title: "课堂示范.mp4",
      type: "MP4",
      description: null,
      metadata: { stageKey: "launch", url: "https://stale.example/video.mp4" },
      fileAsset: {
        id: "video-asset",
        size: BigInt(65_770_721),
        deletedAt: null,
      },
    })).toMatchObject({
      id: "video-resource",
      title: "课堂示范.mp4",
      type: "MP4",
      stageKey: "launch",
      size: "65770721",
      url: "/api/uploads/video-asset",
      downloadedBy: [],
    });
  });

  it("completes participations and records the shared lifecycle event when ending", async () => {
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, status: "finished" }, teacher);
    expect(delegates.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FINISHED", endedAt: expect.any(Date) }) }));
    expect(delegates.classroomParticipation.updateMany).toHaveBeenCalledWith({ where: { instanceId: "instance", completedAt: null }, data: { completedAt: expect.any(Date) } });
    expect(delegates.domainEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { idempotencyKey: "classroom:instance:finish" }, create: expect.objectContaining({ eventType: "classroom_finished", actorId: "teacher-2" }) }));
  });
  it("atomically revokes the showcase projection and its controller when leaving the stage", async () => {
    const before = normalizeCourse(fixture());
    before.currentStageIndex = 3;
    before.presentingStudentId = "a";
    before.presentingGroupId = "group";
    before.uiState = { projectionVersion: 5, projectionController: { teacherId: "teacher-2", clientId: "tab" } };
    const executeRaw = vi.fn();
    Object.assign(db, { $executeRaw: executeRaw });
    await persistInstanceCourse(db, before, { ...before, currentStageIndex: 4 }, teacher);
    const runtime = delegates.classroomInstance.update.mock.calls[0][0].data.runtimeConfig;
    expect(runtime).toMatchObject({ uiState: { projectionVersion: 6, projectionController: null, resourceProjection: null, teacherResourceProjection: null } });
    expect(runtime).not.toHaveProperty("presentingStudentId");
    expect(runtime).not.toHaveProperty("presentingGroupId");
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(executeRaw.mock.calls[0][0].join(" ")).toContain("sp.status IN ('PENDING', 'ACTIVE', 'EVALUATING')");
  });
  it.each([1, 3])("advances the projection generation when leaving stage one for stage index %i", async currentStageIndex => {
    const before = normalizeCourse(fixture());
    before.uiState = { projectionVersion: 9, projectionController: { teacherId: teacher.id, clientId: "tab" },
      resourceProjection: { resourceId: "video", title: "Stage-one video", stageKey: "launch", startedAt: new Date().toISOString() } };
    await persistInstanceCourse(db, before, { ...before, currentStageIndex }, teacher);
    const runtime = delegates.classroomInstance.update.mock.calls[0][0].data.runtimeConfig;
    expect(runtime).toMatchObject({ uiState: { projectionVersion: 10, projectionUpdatedAt: expect.any(String),
      projectionController: null, resourceProjection: null, teacherResourceProjection: null } });
  });
  it("starts a scheduled instance without changing its snapshot", async () => {
    const before = fixture(); before.status = "ready";
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, status: "SCHEDULED", startedAt: null });
    await persistInstanceCourse(db, before, { ...before, status: "teaching" }, teacher);
    expect(delegates.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "TEACHING", startedAt: expect.any(Date) }) }));
    expect(delegates.domainEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { idempotencyKey: "classroom:instance:start" }, create: expect.objectContaining({ eventType: "classroom_started" }) }));
    expect(delegates.classroomParticipation.updateMany).not.toHaveBeenCalled();
  });
  it("records the first visit to stage five and keeps its posttest release when revisiting earlier stages", async () => {
    const before = normalizeCourse(fixture());
    await persistInstanceCourse(db, before, { ...before, currentStageIndex: 4 }, teacher);
    const opened = delegates.classroomInstance.update.mock.calls[0][0].data.runtimeConfig.posttestOpenedAt;
    expect(Date.parse(opened)).not.toBeNaN();
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, runtimeConfig: { posttestOpenedAt: opened } });
    await persistInstanceCourse(db, { ...before, currentStageIndex: 4 }, { ...before, currentStageIndex: 3 }, teacher);
    expect(delegates.classroomInstance.update.mock.calls[1][0].data.runtimeConfig.posttestOpenedAt).toBe(opened);
  });
  it("does not open V2 experiment extensions when entering the evaluation stage", async () => {
    const before = normalizeCourse(fixture());
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, runtimeConfig: { evaluationContractVersion: 2, posttestAccess: { status: "closed", version: 0 } } });
    await persistInstanceCourse(db, before, { ...before, currentStageIndex: 4 }, teacher);
    const runtime = delegates.classroomInstance.update.mock.calls[0][0].data.runtimeConfig;
    expect(runtime).toMatchObject({ evaluationContractVersion: 2, posttestAccess: { status: "closed", version: 0 } });
    expect(runtime).not.toHaveProperty("posttestOpenedAt");
  });
  it("persists project-practice settings as runtime overrides while keeping other design immutable", async () => {
    const before = normalizeCourse(fixture());
    const after = { ...before, pblConfig: { ...before.pblConfig!, makeArtifactMode: "python" as const, practiceWebSearchEnabled: false } };
    await persistInstanceCourse(db, before, after, teacher);
    expect(delegates.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ runtimeConfig: expect.objectContaining({ makeArtifactMode: "python", practiceWebSearchEnabled: false }) }) }));
    expect(() => assertImmutableClassroomDesign(before, { ...after, name: "Changed" })).toThrow();
  });
  it("persists classroom monitoring separately from the frozen course default", async () => {
    const before = normalizeCourse(fixture());
    const after = { ...before, pblConfig: { ...before.pblConfig!, documentPasteMonitoringEnabled: true } };
    await persistInstanceCourse(db, before, after, teacher);
    expect(delegates.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      runtimeConfig: expect.objectContaining({ documentPasteMonitoringEnabled: true }),
    }) }));
    expect(before.pblConfig?.documentPasteMonitoringEnabled).toBe(false);
    expect(() => assertImmutableClassroomDesign(before, { ...after, name: "Changed" })).toThrow();
  });
  it("rejects monitoring changes after the classroom has ended", async () => {
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, status: "FINISHED" });
    const before = normalizeCourse(fixture());
    await expect(persistInstanceCourse(db, before, { ...before, pblConfig: { ...before.pblConfig!, documentPasteMonitoringEnabled: true } }, teacher))
      .rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    expect(delegates.classroomInstance.update).not.toHaveBeenCalled();
  });
  it("cancels pending checks in the configuration transaction before a rapid re-enable", async () => {
    const before = normalizeCourse(fixture());
    before.currentStageIndex = 2;
    before.pblConfig!.documentPasteMonitoringEnabled = true;
    const disabled = { ...before, pblConfig: { ...before.pblConfig!, documentPasteMonitoringEnabled: false } };
    await persistInstanceCourse(db, before, disabled, teacher);
    expect(cancelContentMonitorChecks).toHaveBeenCalledExactlyOnceWith(db, before.id);
    expect(delegates.classroomInstance.update.mock.invocationCallOrder[0]).toBeLessThan(cancelContentMonitorChecks.mock.invocationCallOrder[0]);
    await persistInstanceCourse(db, disabled, before, teacher);
    expect(cancelContentMonitorChecks).toHaveBeenCalledTimes(1);
    expect(delegates.classroomInstance.update.mock.calls[1][0].data.runtimeConfig.documentPasteMonitoringEnabled).toBe(true);
  });
  it.each(["stage", "classroom", "artifact"] as const)("cancels pending checks when the %s monitoring scope closes", async scope => {
    const before = normalizeCourse(fixture());
    before.currentStageIndex = 2;
    before.pblConfig!.documentPasteMonitoringEnabled = true;
    const after: Course = scope === "stage" ? { ...before, currentStageIndex: 3 }
      : scope === "classroom" ? { ...before, status: "finished" }
      : { ...before, pblConfig: { ...before.pblConfig!, makeArtifactMode: "python" } };
    await persistInstanceCourse(db, before, after, teacher);
    expect(cancelContentMonitorChecks).toHaveBeenCalledExactlyOnceWith(db, before.id);
  });
  it("keeps pending checks when an active document classroom saves unrelated runtime state", async () => {
    const before = normalizeCourse(fixture());
    before.currentStageIndex = 2;
    before.pblConfig!.documentPasteMonitoringEnabled = true;
    await persistInstanceCourse(db, before, { ...before, uiState: { ...before.uiState, projectionVersion: 2 } }, teacher);
    expect(cancelContentMonitorChecks).not.toHaveBeenCalled();
  });
  it("propagates cancellation failure so the configuration transaction cannot commit alone", async () => {
    const before = normalizeCourse(fixture());
    before.pblConfig!.documentPasteMonitoringEnabled = true;
    cancelContentMonitorChecks.mockRejectedValueOnce(new Error("cancellation failed"));
    await expect(persistInstanceCourse(db, before, { ...before, pblConfig: { ...before.pblConfig!, documentPasteMonitoringEnabled: false } }, teacher))
      .rejects.toThrow("cancellation failed");
  });
  it("rejects a queued student write when the classroom closes before its transaction", async () => {
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, status: "FINISHED" });
    const before = fixture();
    await expect(persistInstanceCourse(db, before, before, { id: "a", role: "student" })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    expect(delegates.classroomInstance.update).not.toHaveBeenCalled();
  });
  it("rejects published design changes before writing and permits runtime summaries", async () => {
    const before = fixture();
    expect(() => assertImmutableClassroomDesign(before, { ...before, name: "Changed" })).toThrow("课堂已固定发布教案");
    await expect(persistInstanceCourse(db, before, { ...before, stages: [] }, teacher)).rejects.toMatchObject({ code: "CLASSROOM_DESIGN_IMMUTABLE" });
    expect(delegates.classroomInstance.update).not.toHaveBeenCalled();
    const after = { ...before, content: { ...before.content, courseSummaryPresentation: { slides: [] } as unknown as Course["content"]["courseSummaryPresentation"] } };
    await expect(persistInstanceCourse(db, before, after, teacher)).resolves.toBeUndefined();
  });
  it("accepts reducer design defaults without permitting content edits", () => {
    const before = fixture(); const normalized = normalizeCourse(before);
    expect(() => assertImmutableClassroomDesign(before, normalized)).not.toThrow();
    expect(() => assertImmutableClassroomDesign(before, { ...normalized, content: { ...normalized.content, pblOutline: "Changed" } })).toThrow();
  });
  it("switches stages for published templates with partial practice settings", () => {
    const before = fixture();
    // The public template API accepts partial configuration, including snapshots
    // created before practiceWebSearchEnabled was introduced.
    before.pblConfig = { makeArtifactMode: "document" } as Course["pblConfig"];
    const after = applySessionAction(
      { ...initialSessionState(), hydrated: true, courses: [before] },
      { type: "SET_STAGE", payload: { id: before.id, index: 1 } },
    ).courses[0]!;
    expect(after.currentStageIndex).toBe(1);
    expect(() => assertImmutableClassroomDesign(before, after)).not.toThrow();
    expect(() => assertImmutableClassroomDesign(before, {
      ...after, content: { ...after.content, pblOutline: "Unauthorized design edit" },
    })).toThrow("课堂已固定发布教案");
  });
  it("starts an authored generated course after reducer normalization", () => {
    const before = fixture();
    before.status = "ready";
    before.stages = before.stages.map((stage, index) => ({
      ...stage,
      description: `生成课程的第 ${index + 1} 阶段说明`,
    }));
    const after = applySessionAction(
      { ...initialSessionState(), hydrated: true, courses: [before] },
      {
        type: "START_TEACHING",
        payload: {
          id: before.id,
          classConfig: before.classConfig!,
          inviteCode: "ABC123",
        },
      },
    ).courses[0]!;

    expect(() => assertImmutableClassroomDesign(before, after)).not.toThrow();
  });
  it("namespaces legacy personal group IDs by offering", async () => {
    const before = fixture(); before.groups = []; const after = normalizeCourse(before);
    await persistInstanceCourse(db, before, after, teacher);
    expect(delegates.projectGroup.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ id: "offering:grp-a", offeringId: "offering" }) }));
    expect(delegates.groupMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ groupId: "offering:grp-a", userId: "a" }) }));
  });
  it("keeps finished classrooms closed", async () => {
    const before = fixture(); before.status = "finished";
    await expect(persistInstanceCourse(db, before, { ...before, status: "teaching" }, teacher)).rejects.toMatchObject({ code: "CLASSROOM_STATE_CONFLICT" });
  });
  it("does not guess a student's ID from an ambiguous display name", async () => {
    const before = fixture();
    const after = { ...before, workPlan: [{ id: "task", groupId: "group", memberName: "Alex", role: "researcher", task: "Investigate", progress: 0 }] };
    await expect(persistInstanceCourse(db, before, after, teacher)).rejects.toMatchObject({ code: "AMBIGUOUS_ASSIGNEE" });
    expect(delegates.workPlanItem.upsert).not.toHaveBeenCalled();
  });
  it("retains an existing unambiguous ID binding when classmates have the same name", async () => {
    const before = fixture();
    delegates.workPlanItem.findUnique.mockResolvedValue({ id: "task", groupId: "group", assigneeId: "b" });
    await persistInstanceCourse(db, before, { ...before, workPlan: [{ id: "task", groupId: "group", memberName: "Alex", role: "researcher", task: "Investigate", progress: 50 }] }, teacher);
    expect(delegates.workPlanItem.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ assigneeId: "b" }) }));
  });
  it("attributes new teacher records to the actual actor, never the first course teacher", async () => {
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, announcements: [{ id: "notice", title: "Note", content: "Read", replies: [], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }] }, teacher);
    expect(delegates.announcement.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ createdById: "teacher-2" }) }));
  });
  it("refuses to invent a teacher identity for system-authored notices", async () => {
    const before = fixture();
    await expect(persistInstanceCourse(db, before, { ...before, announcements: [{ id: "notice", title: "Note", content: "Read", replies: [], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }] })).rejects.toMatchObject({ code: "CLASSROOM_ACTOR_REQUIRED" });
  });
  it("stores group contributions only against group members' participations", async () => {
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, teamContributions: [{ id: "contribution", courseId: "instance", groupId: "group", studentName: "Team", percent: 100, updatedAt: "2026-09-01T00:00:00Z" }] }, teacher);
    expect(delegates.classroomSubmission.upsert.mock.calls.map(([args]) => args.create.participationId)).toEqual(["p-a", "p-b"]);
    expect(delegates.evaluation.upsert).not.toHaveBeenCalled();
  });
  it("rejects unknown group targets instead of broadcasting to the class", async () => {
    const before = fixture();
    await expect(persistInstanceCourse(db, before, { ...before, feedback: [{ id: "feedback", courseId: "instance", targetType: "group", targetId: "foreign", stageKey: "make", kind: "comment", content: "Feedback", createdAt: "2026-09-01T00:00:00Z" }] }, teacher)).rejects.toMatchObject({ code: "GROUP_SCOPE_MISMATCH" });
    expect(delegates.evaluation.upsert).not.toHaveBeenCalled();
  });
  it("canonicalizes upload references from the owned FileAsset", async () => {
    delegates.fileAsset.findUnique.mockResolvedValue({ id: "asset", offeringId: "offering", uploadedById: "a", originalName: "actual.pdf", mimeType: "application/pdf", size: BigInt(12), deletedAt: null });
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, uploads: [{ id: "asset", courseId: "instance", studentId: "a", stageKey: "make", category: "artifact", title: "File", fileName: "forged", fileType: "HTML", size: "wrong", url: "https://foreign.example/file", createdAt: "2026-09-01T00:00:00Z" }] }, { id: "a", role: "student" });
    expect(delegates.classroomSubmission.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ payload: expect.objectContaining({ view: expect.objectContaining({ fileName: "actual.pdf", fileType: "application/pdf", url: "/api/uploads/asset", size: "12" }) }) }) }));
  });

  it.each(["handled", "resolved"] as const)("keeps private issue derivations when the teacher marks a signal %s", async (status) => {
    const detectedAt = new Date().toISOString();
    const signal: LearningSignal = {
      id: "friction", courseId: "instance", studentId: "a", stageKey: "ai-learning", sceneId: "first",
      kind: "dwell-overrun", severity: "warning", status: "open", title: "需要关注", summary: "停留较久；反复回顾",
      normalizedIssueKey: "comprehension-friction:ai-learning:kp:shared", evidenceEventIds: ["heartbeat", "replay"],
      aiInterventionAttempts: 0, firstDetectedAt: detectedAt, lastDetectedAt: detectedAt,
    };
    const components = [
      { ...signal, evidenceEventIds: ["heartbeat"] },
      { ...signal, sceneId: "second", kind: "repeated-playback", severity: "notice", evidenceEventIds: ["replay"] },
    ];
    const unchanged = { ...signal, id: "unrelated", studentId: "b" };
    const before = fixture();
    before.learningSignals = [signal, unchanged];
    const after = status === "resolved" ? applySessionAction(
      { ...initialSessionState(), hydrated: true, courses: [before] },
      { type: "RESOLVE_INTERVENTION_SIGNALS", payload: { courseId: before.id, signalIds: [signal.id] } },
    ).courses[0]! : { ...before, learningSignals: [{ ...signal, status, handledAt: "2026-09-01T00:02:00Z" }, unchanged] };
    delegates.learningSignal.findUnique.mockResolvedValue({ payload: { view: signal, components, staleMetadata: true } });

    await persistInstanceCourse(db, before, after, teacher);

    expect(delegates.learningSignal.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "p-a:friction" }, select: { payload: true } });
    expect(delegates.learningSignal.upsert).toHaveBeenCalledTimes(1);
    const write = delegates.learningSignal.upsert.mock.calls[0][0];
    expect(write.where).toEqual({ id: "p-a:friction" });
    expect(write.update.status).toBe(status);
    expect(write.update.payload.components).toEqual(components);
    expect(write.update.payload.view).toEqual(after.learningSignals!.find(item => item.id === signal.id));
    expect(write.update.payload.view.status).toBe(status);
    expect(write.update.payload.view).not.toHaveProperty("components");
    expect(write.update.payload).not.toHaveProperty("staleMetadata");
    expect(write.update.payload.provenance).toEqual({ actorId: "teacher-2", actorRole: "teacher" });
  });

  it("keeps signal writes scoped to participants and accepts legacy payloads without private derivations", async () => {
    const before = fixture();
    const signal = {
      id: "help", courseId: "instance", studentId: "a", stageKey: "ai-learning", kind: "student-help-request",
      severity: "warning", status: "open", title: "请求帮助", summary: "问题", normalizedIssueKey: "help-request",
      evidenceEventIds: [], aiInterventionAttempts: 0, firstDetectedAt: "2026-09-01T00:00:00Z", lastDetectedAt: "2026-09-01T00:00:00Z",
    } as LearningSignal;
    delegates.learningSignal.findUnique.mockResolvedValue({ payload: { view: signal } });
    await persistInstanceCourse(db, before, { ...before, learningSignals: [signal] }, teacher);
    expect(delegates.learningSignal.upsert.mock.calls[0][0].update.payload).not.toHaveProperty("components");
    delegates.learningSignal.findUnique.mockClear(); delegates.learningSignal.upsert.mockClear();
    await expect(persistInstanceCourse(db, before, { ...before, learningSignals: [{ ...signal, studentId: "foreign" }] }, teacher)).rejects.toThrow("SIGNAL_PARTICIPATION_REQUIRED");
    expect(delegates.learningSignal.findUnique).not.toHaveBeenCalled();
    expect(delegates.learningSignal.upsert).not.toHaveBeenCalled();
  });
});
