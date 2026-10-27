// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({ canAccess: vi.fn(), course: {} as Record<string, unknown>, rows: [] as Array<Record<string, unknown>>, store: {
  loadCourse: vi.fn(), listStudents: vi.fn(), listMembers: vi.fn(), listDocuments: vi.fn(), listFiles: vi.fn(), listPresentations: vi.fn(),
  findPresentation: vi.fn(), findGroup: vi.fn(), findMember: vi.fn(), findDocument: vi.fn(), findFile: vi.fn(), findParticipation: vi.fn(),
  createPresentation: vi.fn(), updatePresentation: vi.fn(), updatePresentations: vi.fn(), lock: vi.fn(), updateCourse: vi.fn(), transaction: vi.fn(),
} }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("./persistence", () => ({ showcaseStore: mocks.store }));
vi.mock("./state", () => ({ rowToSnapshot: (row: unknown) => row, loadShowcaseState: vi.fn() }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.canAccess }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn(async () => undefined) }));

import { executeShowcaseAction, getShowcaseData, updateShowcaseViewport } from "./presentation-service";
const teacher = { sub: "teacher", role: "teacher" } as AuthClaims;
const student = { sub: "s2", role: "student" } as AuthClaims;
const action = { action: "save-queue" as const, selectionMode: "teacher-selected" as const, selectedStudentIds: ["s1"], orderedStudentIds: ["s1"], minutesPerStudent: 2, presentationSec: 80, discussionSec: 30, transitionSec: 10 };

describe("selected showcase lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAccess.mockResolvedValue(true);
    mocks.course = { id: "course", status: "teaching", currentStageIndex: 3, stages: ["launch", "ai-learning", "make", "showcase", "reflection"].map((key) => ({ key })),
      presentingStudentId: null, presentingGroupId: null, uiState: {}, content: { stagePlan: { schemaVersion: 2, stages: [{ key: "showcase", durationMin: 3 }] } } };
    mocks.rows = [];
    mocks.store.loadCourse.mockImplementation(async () => mocks.course);
    mocks.store.listStudents.mockResolvedValue([{ id: "s1", name: "甲" }, { id: "s2", name: "乙" }]);
    mocks.store.listMembers.mockResolvedValue([{ groupId: "g1", studentId: "s1", studentName: "甲" }, { groupId: "g2", studentId: "s2", studentName: "乙" }]);
    mocks.store.listDocuments.mockResolvedValue([]); mocks.store.listFiles.mockResolvedValue([]);
    mocks.store.listPresentations.mockImplementation(async () => mocks.rows);
    mocks.store.findPresentation.mockResolvedValue(null);
    mocks.store.transaction.mockImplementation(async (fn) => fn(mocks.store));
    mocks.store.updateCourse.mockImplementation(async ({ data }) => { mocks.course = { ...mocks.course, ...data }; });
    mocks.store.findGroup.mockResolvedValue({ id: "g2" });
    mocks.store.findMember.mockResolvedValue({ studentId: "s2", studentName: "乙", groupId: "g2" });
    mocks.store.findParticipation.mockResolvedValue({ id: "participation-s2" });
    mocks.store.updatePresentations.mockResolvedValue({ count: 0 });
    mocks.store.createPresentation.mockImplementation(async ({ data }) => ({ ...data, revision: 1, requestedAt: new Date(), updatedAt: new Date(), rejectionReason: null, endedAt: null, evaluatedAt: null, evaluatedBy: null, evaluationNote: null }));
  });
  it("checks live access once and does not load archives when access was revoked", async () => {
    mocks.canAccess.mockResolvedValue(false);
    await expect(getShowcaseData("course", student)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.canAccess).toHaveBeenCalledOnce();
    expect(mocks.store.loadCourse).not.toHaveBeenCalled();
    expect(mocks.store.listDocuments).not.toHaveBeenCalled();
  });
  it("uses summaries while preserving shared queue order and student artifact privacy", async () => {
    mocks.course.content = { stagePlan: { schemaVersion: 1, stages: [] } };
    mocks.store.listDocuments.mockResolvedValue(["s1", "s2"].map((studentId, i) => ({ id: `version-${i}`, courseId: "course", submissionId: `submission-${i}`, studentId, stageKey: "make", sequence: 1, sourceVersion: 1, title: `private-${studentId}`, sourceHtml: "", status: "submitted", createdAt: new Date(1_000 + i), submittedAt: new Date(1_000 + i) })));
    const teacherView = await getShowcaseData("course", teacher);
    const studentView = await getShowcaseData("course", student);
    expect(mocks.store.listDocuments).toHaveBeenCalledWith(expect.objectContaining({ where: { courseId: "course", stageKey: "make" }, select: { sourceHtml: false } }));
    expect(studentView.queue.map(row => row.studentId)).toEqual(teacherView.queue.map(row => row.studentId));
    expect(JSON.stringify(studentView)).not.toContain("private-s1");
    expect(JSON.stringify(studentView)).toContain("private-s2");
  });
  it("joins identical student GET inputs only while pending, then independently redacts complete results", async () => {
    const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
    const roster = deferred<Array<{ id: string; name: string }>>();
    const documents = deferred<Array<Record<string, unknown>>>();
    const presentations = deferred<Array<Record<string, unknown>>>();
    mocks.course.content = { stagePlan: { schemaVersion: 1, stages: [] } };
    mocks.store.listStudents.mockImplementation(() => roster.promise);
    mocks.store.listDocuments.mockImplementation(() => documents.promise);
    mocks.store.listPresentations.mockImplementation(() => presentations.promise);
    const a = getShowcaseData("course", { role: "student", sub: "s1" } as AuthClaims);
    const b = getShowcaseData("course", student);
    await vi.waitFor(() => expect(mocks.store.listStudents).toHaveBeenCalledOnce());
    expect(mocks.canAccess).toHaveBeenCalledTimes(2);
    expect(mocks.store.loadCourse).toHaveBeenCalledTimes(2);
    expect(mocks.store.listMembers).toHaveBeenCalledOnce();
    roster.resolve([{ id: "s1", name: "甲" }, { id: "s2", name: "乙" }]);
    await vi.waitFor(() => expect(mocks.store.listDocuments).toHaveBeenCalledOnce());
    expect(mocks.store.listFiles).toHaveBeenCalledOnce();
    const docRows = ["s1", "s2"].flatMap(studentId => [1, 2].map(sequence => ({ id: `${studentId}-${sequence}`, courseId: "course", submissionId: studentId,
      studentId, stageKey: "make", sequence, sourceVersion: sequence, title: `private-${studentId}-${sequence}`, sourceHtml: "", status: "submitted", createdAt: new Date(sequence * 1000), submittedAt: new Date(sequence * 1000) })));
    documents.resolve(docRows);
    await vi.waitFor(() => expect(mocks.store.listPresentations).toHaveBeenCalledOnce());
    const presentationRows = ["s1", "s2"].flatMap(studentId => ["ended", "rejected"].map(status => ({ id: `${studentId}-${status}`, studentId, status, updatedAt: "2026-10-01T00:00:00Z", evaluationNote: "teacher-private", evaluatedBy: "teacher" })));
    presentations.resolve(presentationRows);
    const [left, right] = await Promise.all([a, b]);
    expect(left.queue.map(row => row.studentId)).toEqual(right.queue.map(row => row.studentId));
    expect(left.presentations.map(row => row.id)).toEqual(["s1-ended", "s1-rejected"]);
    expect(right.presentations.map(row => row.id)).toEqual(["s2-ended", "s2-rejected"]);
    expect(JSON.stringify(left)).not.toContain("private-s2");
    expect(JSON.stringify(right)).not.toContain("private-s1");
    expect(JSON.stringify([left, right])).not.toContain("teacher-private");
    left.queue[0].studentName = "mutated response";
    expect(right.queue[0].studentName).not.toBe("mutated response");
    expect(presentationRows[0].evaluationNote).toBe("teacher-private");
    // No settled response reuse: complete underlying history is read again.
    mocks.store.listPresentations.mockResolvedValue([...presentationRows, { id: "new", studentId: "s2", status: "ended", updatedAt: "2026-10-02T00:00:00Z" }]);
    const fresh = await getShowcaseData("course", student);
    expect(fresh.presentations.map(row => row.id)).toContain("new");
    for (const read of [mocks.store.listStudents, mocks.store.listMembers, mocks.store.listDocuments, mocks.store.listFiles, mocks.store.listPresentations]) expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not share teacher or mutation readback inputs and never shares an access decision", async () => {
    let release!: (value: Array<{ id: string; name: string }>) => void;
    const roster = new Promise<Array<{ id: string; name: string }>>(yes => { release = yes; });
    mocks.store.listStudents.mockImplementation(() => roster);
    const reads = [getShowcaseData("course", student), getShowcaseData("course", teacher), getShowcaseData("course", student, false)];
    await vi.waitFor(() => expect(mocks.store.listStudents).toHaveBeenCalledTimes(3));
    mocks.canAccess.mockResolvedValueOnce(false);
    await expect(getShowcaseData("course", student)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.store.listStudents).toHaveBeenCalledTimes(3);
    release([{ id: "s1", name: "甲" }, { id: "s2", name: "乙" }]);
    await Promise.all(reads);
    expect(mocks.canAccess).toHaveBeenCalledTimes(4);
    for (const read of [mocks.store.listMembers, mocks.store.listDocuments, mocks.store.listFiles, mocks.store.listPresentations]) expect(read).toHaveBeenCalledTimes(3);
  });
  it("starts with an empty shortlist, keeps the complete roster and persists selected seconds", async () => {
    expect((await getShowcaseData("course", teacher)).queue).toEqual([]);
    const result = await executeShowcaseAction("course", action, teacher);
    expect(result).toMatchObject({ students: [{ studentId: "s1" }, { studentId: "s2" }], queue: [{ studentId: "s1" }], budget: { plannedRemainingSec: 90, stageRemainingSec: 180, overrunSec: 0 } });
    expect((await getShowcaseData("course", teacher)).queue.map((item) => item.studentId)).toEqual(["s1"]);
  });
  it("uses the confirmed resource-package presenter count and timings before the teacher saves a queue", async () => {
    mocks.course.content = { stagePlan: { schemaVersion: 2, stages: [{ key: "showcase", durationMin: 10, requirements: "每位学生汇报90秒，点评30秒，衔接5秒", teacherActions: "选取5名学生现场汇报", aiActions: "", outputs: "" }] } };
    const result = await getShowcaseData("course", teacher);
    expect(result.queueConfig).toMatchObject({ presenterCount: 5, presentationSec: 90, discussionSec: 30, transitionSec: 5, minutesPerStudent: 95 / 60 });
  });
  it("updates the prepared presenter when the teacher places another ready student next", async () => {
    mocks.course.presentingStudentId = "s1";
    mocks.course.presentingGroupId = "g1";
    mocks.course.uiState = { showcaseReporting: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: ["s1", "s2"], orderedStudentIds: ["s1", "s2"] } };
    mocks.store.listFiles.mockResolvedValue(["s1", "s2"].map((studentId) => ({ id: `pdf-${studentId}`, studentId, courseId: "course", kind: "pdf", status: "submitted", stageKey: "make", title: studentId, sequence: 1, createdAt: new Date(1000), submittedAt: new Date(1000) })));
    const result = await executeShowcaseAction("course", { ...action, selectedStudentIds: ["s1", "s2"], orderedStudentIds: ["s2", "s1"] }, teacher);
    expect(result).toMatchObject({ presentingStudentId: "s2", presentingGroupId: "g2", currentQueueItem: { studentId: "s2", status: "called" } });
    expect(await getShowcaseData("course", student)).toMatchObject({ presentingStudentId: "s2", presentingStudentName: "乙", activePresentation: null });
    expect(mocks.store.updateCourse).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ presentingStudentId: "s2", presentingGroupId: "g2", uiState: expect.objectContaining({ showcaseReporting: expect.objectContaining({ orderedStudentIds: ["s2", "s1"] }) }) }) }));
  });
  it("clears a removed prepared presenter without a replacement and does not call a student from an idle queue", async () => {
    mocks.course.presentingStudentId = "s1";
    mocks.course.presentingGroupId = "g1";
    mocks.course.uiState = { showcaseReporting: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: ["s1"], orderedStudentIds: ["s1"] } };
    expect(await executeShowcaseAction("course", { ...action, selectedStudentIds: [], orderedStudentIds: [] }, teacher)).toMatchObject({ queue: [], currentQueueItem: null });
    expect(mocks.course).toMatchObject({ presentingStudentId: null, presentingGroupId: null });
    mocks.store.listFiles.mockResolvedValue([{ id: "pdf-s2", studentId: "s2", courseId: "course", kind: "pdf", status: "submitted", stageKey: "make", title: "乙的作品", sequence: 1, createdAt: new Date(1000), submittedAt: new Date(1000) }]);
    await executeShowcaseAction("course", { ...action, selectedStudentIds: ["s2"], orderedStudentIds: ["s2"] }, teacher);
    expect(mocks.course).toMatchObject({ presentingStudentId: null, presentingGroupId: null });
  });
  it("allows a shortlist exceeding the stage budget with an honest warning and rejects foreign students", async () => {
    const saved = await executeShowcaseAction("course", { ...action, selectedStudentIds: ["s1", "s2"], presentationSec: 100 }, teacher);
    expect(saved).toMatchObject({ budget: { plannedRemainingSec: 220, stageRemainingSec: 180, overrunSec: 40 } });
    mocks.store.updateCourse.mockClear();
    await expect(executeShowcaseAction("course", { ...action, selectedStudentIds: ["foreign"] }, teacher)).rejects.toMatchObject({ code: "INVALID_QUEUE" });
    expect(mocks.store.updateCourse).not.toHaveBeenCalled();
  });
  it("checks the live remaining stage budget after refresh without resetting elapsed time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T10:01:00Z"));
    const clock = { schemaVersion: 1, status: "running", sessionStartedAt: "2026-09-12T10:00:00Z", lastResumedAt: "2026-09-12T10:00:00Z", activeStageKey: "showcase", updatedAt: "2026-09-12T10:00:00Z", stages: [{ stageKey: "showcase", label: "汇报", basePlannedSec: 180, adjustmentSec: 0, elapsedSec: 10, status: "active" }] };
    mocks.course.uiState = { classroomTiming: clock };
    expect((await getShowcaseData("course", teacher)).budget?.stageRemainingSec).toBe(110);
    expect(await executeShowcaseAction("course", { ...action, presentationSec: 120 }, teacher)).toMatchObject({ budget: { overrunSec: 20 } });
    const saved = await executeShowcaseAction("course", { ...action, presentationSec: 70 }, teacher);
    expect("budget" in saved && saved.budget).toMatchObject({ stageRemainingSec: 110, plannedRemainingSec: 80 });
    expect((mocks.course.uiState as Record<string, unknown>).classroomTiming).toEqual(clock);
  });
  it("rejects assigning or starting projection for an unselected student and blocks student-side starts", async () => {
    await expect(executeShowcaseAction("course", { action: "assign", groupId: "g2", studentId: "s2" }, teacher)).rejects.toMatchObject({ code: "STUDENT_NOT_SELECTED" });
    await expect(executeShowcaseAction("course", { action: "start", studentId: "s2", artifactKind: "pdf", artifactVersionId: "artifact", displayMode: "slides" }, teacher)).rejects.toMatchObject({ code: "STUDENT_NOT_SELECTED" });
    await expect(executeShowcaseAction("course", { action: "start", studentId: "s2", artifactKind: "pdf", artifactVersionId: "artifact", displayMode: "slides" }, student)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("creates an active projection directly from the teacher-selected student's material", async () => {
    mocks.course.uiState = { showcaseReporting: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: ["s2"], orderedStudentIds: ["s2"] } };
    mocks.store.findFile.mockResolvedValue({ id: "artifact", title: "乙的汇报.pdf" });
    const result = await executeShowcaseAction("course", { action: "start", studentId: "s2", artifactKind: "pdf", artifactVersionId: "artifact", displayMode: "slides" }, teacher);
    expect(result).toMatchObject({ studentId: "s2", artifactVersionId: "artifact", status: "active", displayMode: "slides" });
    expect(mocks.store.createPresentation).toHaveBeenCalledWith({ data: expect.objectContaining({
      studentId: "s2",
      groupId: "g2",
      artifactKind: "pdf",
      artifactVersionId: "artifact",
      status: "active",
      reviewedBy: "teacher",
    }) });
    expect(mocks.course).toMatchObject({ presentingStudentId: "s2", presentingGroupId: "g2" });
  });
  it("shares only the active public projection with classmates while keeping their own history separate", async () => {
    mocks.rows = [{ id: "active", studentId: "s1", artifactTitle: "Public work", status: "active", updatedAt: "2026-10-01", reviewedBy: "private-teacher", evaluationNote: "private-note", evaluatedBy: "private-evaluator", projectionVersion: 9 }];
    const result = await getShowcaseData("course", student);
    expect(result.activePresentation).toMatchObject({ id: "active", artifactTitle: "Public work", projectionVersion: 9 });
    expect(result.presentations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("ends immediately, prepares the next selected presenter atomically and remains idempotent", async () => {
    mocks.course.presentingStudentId = "s1";
    mocks.course.presentingGroupId = "g1";
    mocks.course.uiState = { showcaseReporting: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: ["s1", "s2"], orderedStudentIds: ["s1", "s2"] }, projectionVersion: 4 };
    mocks.rows = [{ id: "p1", studentId: "s1", status: "active", updatedAt: "2026-10-01", revision: 1 }];
    mocks.store.findPresentation.mockImplementation(async ({ where }) => mocks.rows.find((row) => row.id === where.id && (!where.status || row.status === where.status)) ?? null);
    mocks.store.updatePresentation.mockImplementation(async ({ where, data }) => {
      const row = mocks.rows.find((item) => item.id === where.id)!;
      Object.assign(row, data, { revision: Number(row.revision) + 1 });
      return row;
    });
    mocks.store.listFiles.mockResolvedValue(["s1", "s2"].map((studentId) => ({ id: `pdf-${studentId}`, studentId, courseId: "course", kind: "pdf", status: "submitted", stageKey: "make", title: studentId, sequence: 1, createdAt: new Date(1000), submittedAt: new Date(1000) })));
    expect(await executeShowcaseAction("course", { action: "end", presentationId: "p1" }, teacher)).toMatchObject({ status: "ended", projectionVersion: 5 });
    expect(mocks.course).toMatchObject({ presentingStudentId: "s2", presentingGroupId: "g2", uiState: { projectionVersion: 5, projectionController: null } });
    expect(mocks.rows[0].status).toBe("ended");
    await executeShowcaseAction("course", { action: "end", presentationId: "p1" }, teacher);
    expect(mocks.store.updatePresentation).toHaveBeenCalledOnce();
    expect((await getShowcaseData("course", teacher)).activePresentation).toBeNull();
  });
  it("rejects stale controller epochs, ignores old sequence numbers and persists the final reading position", async () => {
    mocks.course.uiState = { projectionVersion: 8, projectionController: { teacherId: "teacher", clientId: "tab" } };
    mocks.rows = [{ id: "p", studentId: "s1", status: "active", artifactKind: "pdf", updatedAt: "2026-10-01", revision: 1, controllerClientId: "tab", controlEpoch: 2, clientSequence: 3, projectionVersion: 8 }];
    mocks.store.findPresentation.mockImplementation(async ({ where }) => mocks.rows.find((row) => row.id === where.id && row.status === where.status) ?? null);
    mocks.store.updatePresentation.mockImplementation(async ({ data }) => {
      Object.assign(mocks.rows[0], data, { revision: Number(mocks.rows[0].revision) + 1 });
      return mocks.rows[0];
    });
    const update = { presentationId: "p", clientId: "tab", controlEpoch: 2, sequence: 4, viewState: { page: 7, pageOffset: 0.4 } };
    expect(await updateShowcaseViewport("course", update, teacher)).toMatchObject({ revision: 2, viewState: { page: 7, pageOffset: 0.4 } });
    await updateShowcaseViewport("course", { ...update, sequence: 3, viewState: { page: 1 } }, teacher);
    expect(mocks.store.updatePresentation).toHaveBeenCalledOnce();
    await executeShowcaseAction("course", { action: "take-control", presentationId: "p", clientId: "new-tab" }, teacher);
    expect(mocks.rows[0]).toMatchObject({ controllerClientId: "new-tab", controlEpoch: 3, projectionVersion: 9 });
    await expect(updateShowcaseViewport("course", { ...update, sequence: 5 }, teacher)).rejects.toMatchObject({ code: "PROJECTION_CONTROL_CONFLICT" });
    mocks.rows[0].status = "ended";
    await expect(updateShowcaseViewport("course", update, teacher)).rejects.toMatchObject({ code: "PRESENTATION_NOT_ACTIVE" });
  });
  it("keeps old v1 classrooms on their original roster queue and preserves started history", async () => {
    mocks.course.content = { stagePlan: { schemaVersion: 1, stages: [] } };
    expect((await getShowcaseData("course", teacher)).queue.map((item) => item.studentId).sort()).toEqual(["s1", "s2"]);
    mocks.course.content = { stagePlan: { schemaVersion: 2, stages: [{ key: "showcase", durationMin: 3 }] } };
    mocks.course.uiState = { showcaseReporting: { schemaVersion: 2, selectedStudentIds: ["s1"], orderedStudentIds: ["s1"] } };
    mocks.rows = [{ studentId: "s1", status: "ended", updatedAt: "2026-09-12T10:00:00Z" }];
    await expect(executeShowcaseAction("course", { ...action, selectedStudentIds: [], orderedStudentIds: [] }, teacher)).rejects.toMatchObject({ code: "QUEUE_LOCKED" });
  });
});
