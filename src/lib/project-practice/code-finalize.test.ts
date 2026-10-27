// @vitest-environment node
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
const lock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: lock }));
vi.mock("@/lib/platform/repository", () => ({ PlatformError: class extends Error { constructor(public code: string, message: string, public status: number) { super(message); } } }));
import { finalizeCodeArtifact } from "./code-finalize";
const claims: AuthClaims = { role: "student", sub: "student", studentName: "学生", sv: 1 };
const input = { courseId: "course", submissionId: "view", expectedVersion: 3, stageKey: "make" as const, requestId: "request", revisionNote: "修正了边界条件" };
const db = { classroomParticipation: { findFirst: vi.fn() }, classroomSubmission: { findUnique: vi.fn(), update: vi.fn() }, artifact: { upsert: vi.fn() }, artifactVersion: { findFirst: vi.fn(), create: vi.fn() }, domainEvent: { findUnique: vi.fn(), create: vi.fn() }, aiInteractionEvent: { create: vi.fn() }, classroomInstance: { update: vi.fn() } };
const tx = db as unknown as Prisma.TransactionClient;
function scope() { return { id: "p", enrollment: { status: "ACTIVE", userId: "student", offeringId: "offering", researchKey: "research", user: { status: "ACTIVE", role: "STUDENT", sessionVersion: 1 } }, instance: { status: "TEACHING", runtimeConfig: { version: 9, retained: true }, activity: { archivedAt: null, chapter: { archivedAt: null, offering: { status: "OPEN" } } } } }; }
beforeEach(() => {
  vi.resetAllMocks(); db.classroomParticipation.findFirst.mockResolvedValue(scope());
  db.classroomSubmission.findUnique.mockResolvedValue({ id: "db-submission", payload: { view: { id: "view", studentId: "student", type: "code", version: 3, title: "代码", content: JSON.stringify({ version: 1, language: "python", activeFileId: "main", files: [{ id: "main", path: '<img src=x onerror="bad">.py', content: 'print("<script>bad()</script>")' }] }) } } });
  db.artifact.upsert.mockResolvedValue({ id: "code:db-submission" }); db.artifactVersion.findFirst.mockResolvedValue({ sequence: 2 }); db.artifactVersion.create.mockImplementation(async ({ data }) => data);
});
describe("formal code submission", () => {
  it("creates an immutable escaped version from the saved draft and persists a revision note and receipt atomically", async () => {
    const result = await finalizeCodeArtifact(tx, claims, input);
    expect(lock).toHaveBeenCalledWith(tx, "course");
    expect(result).toMatchObject({ sequence: 3, sourceVersion: 3, submissionVersion: 4, revisionNote: input.revisionNote });
    expect(db.artifact.upsert.mock.calls[0][0].create).toMatchObject({ type: "CODE_ARCHIVE", status: "SUBMITTED", participationId: "p" });
    const version = db.artifactVersion.create.mock.calls[0][0].data;
    expect(version).toMatchObject({ mimeType: "text/html", status: "SUBMITTED", sequence: 3 });
    expect(version.sourceHtml).toContain("&lt;script&gt;"); expect(version.sourceHtml).not.toContain("<script>"); expect(version.sourceHtml).not.toContain("<img");
    expect(db.classroomSubmission.update.mock.calls[0][0].data.payload.view).toMatchObject({ version: 4, status: "submitted", revisionNote: input.revisionNote });
    expect(db.domainEvent.create.mock.calls[0][0].data).toMatchObject({ eventType: "code_version_submitted", participationId: "p", actorId: "student", payload: result });
    expect(db.classroomInstance.update.mock.calls[0][0].data.runtimeConfig).toEqual({ version: 10, retained: true });
  });
  it("replays the same request after finalization without creating another version", async () => {
    const receipt = await finalizeCodeArtifact(tx, claims, input);
    db.artifactVersion.create.mockClear(); db.domainEvent.findUnique.mockResolvedValue({ payload: receipt });
    const changed = scope(); changed.instance.status = "FINISHED"; db.classroomParticipation.findFirst.mockResolvedValue(changed);
    expect(await finalizeCodeArtifact(tx, claims, input)).toEqual(receipt); expect(db.artifactVersion.create).not.toHaveBeenCalled();
    await expect(finalizeCodeArtifact(tx, claims, { ...input, revisionNote: "other" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("rejects stale versions and foreign drafts before creating a formal version", async () => {
    await expect(finalizeCodeArtifact(tx, claims, { ...input, expectedVersion: 2 })).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });
    await expect(finalizeCodeArtifact(tx, claims, { ...input, submissionId: "foreign" })).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
    await expect(finalizeCodeArtifact(tx, claims, { ...input, studentId: "other" })).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
    expect(db.artifactVersion.create).not.toHaveBeenCalled();
  });
  it.each(["finished", "enrollment", "offering", "archive", "session", "missing"])("retains the %s authorization boundary", async boundary => {
    const current = scope();
    if (boundary === "finished") current.instance.status = "FINISHED";
    if (boundary === "enrollment") current.enrollment.status = "SUSPENDED";
    if (boundary === "offering") current.instance.activity.chapter.offering.status = "CLOSED";
    if (boundary === "archive") Object.assign(current.instance.activity, { archivedAt: new Date() });
    if (boundary === "session") current.enrollment.user.sessionVersion = 2;
    db.classroomParticipation.findFirst.mockResolvedValue(boundary === "missing" ? null : current);
    await expect(finalizeCodeArtifact(tx, claims, input)).rejects.toThrow(); expect(db.artifactVersion.create).not.toHaveBeenCalled();
  });
});
