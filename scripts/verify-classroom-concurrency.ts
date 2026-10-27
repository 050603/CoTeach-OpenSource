// Only run through the disposable database runner; never against a configured deployment.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthClaims } from "../src/lib/auth/session";
import type { ActionEnvelope, ActionAck } from "../src/lib/courses/contracts";
import type { ClassroomSubmission, KnowledgeLectureAttempt, StudentAiProgress } from "../src/lib/session/types";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.equal(target.pathname, "/postgres"); assert.ok(target.port);
  target.searchParams.set("connection_limit", "30"); target.searchParams.set("pool_timeout", "10");
  process.env.DATABASE_URL = target.toString();
  const { prisma } = await import("../src/lib/db/client");
  let uploads: string | undefined;
  try {
    const matching = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(matching.length, 1, "Disposable database nonce is required");
    uploads = await mkdtemp(path.join(tmpdir(), "openpbl-concurrency-uploads-"));
    process.env.UPLOAD_DIR = uploads;
    process.env.JWT_SECRET = randomUUID() + randomUUID();
    delete process.env.REDIS_URL;
    const { executeCourseAction } = await import("../src/lib/courses/action-service");
    const { POST: finalize } = await import("../src/app/api/project-practice/submissions/finalize/route");
    const { signStudentToken } = await import("../src/lib/auth/session");
    const { authenticateLegacyAiStudent } = await import("../src/lib/ai-collaboration/legacy-scope");
    const { persistStudentAiProgress, playbackProgress } = await import("../src/lib/courses/ai-progress-service");
    const { persistKnowledgeLectureAttempt, loadKnowledgeLectureContext } = await import("../src/lib/courses/knowledge-lecture-attempts");
    const { claimTutorRequest, finishTutorRequest } = await import("../src/lib/courses/knowledge-tutor-requests");
    const { resolveLegacyCourseAccess } = await import("../src/lib/platform/access");
    const { resolveStudentStateScope } = await import("../src/lib/courses/student-state-scope");
    const { createPblTemplateCourse, encodePblTemplate } = await import("../src/lib/platform/pbl-template");
    const createUser = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role, passwordHash: "test-only-unusable" } });
    const teachers = await Promise.all([createUser("concurrent-teacher-1", "TEACHER"), createUser("concurrent-teacher-2", "TEACHER")]);
    const users = await Promise.all(Array.from({ length: 40 }, (_, index) => createUser(`concurrent-student-${index}`)));
    const offering = await prisma.courseOffering.create({ data: { name: "42 participant concurrency verification", status: "OPEN", teachers: { create: teachers.map(teacher => ({ userId: teacher.id })) } } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "Verification", position: 0, isOpen: true } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "Concurrent practice", type: "CLASSROOM", position: 0, isOpen: true } });
    const template = await prisma.classroomTemplate.create({ data: { title: "Concurrent practice", ownerId: teachers[0].id } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: JSON.parse(JSON.stringify(encodePblTemplate(createPblTemplateCourse(template.id, { name: "Concurrent practice", aiLearningClassroomId: "verification-classroom" })))) } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING", runtimeConfig: { version: 1, currentStageIndex: 2 } } });
    const students = await Promise.all(users.map(async user => {
      const enrollment = await prisma.enrollment.create({ data: { userId: user.id, offeringId: offering.id } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
      const groupViewId = `grp-${user.id}`;
      const group = await prisma.projectGroup.create({ data: { id: `${offering.id}:${groupViewId}`, offeringId: offering.id, name: user.username } });
      await prisma.groupMember.create({ data: { groupId: group.id, userId: user.id, participationId: participation.id } });
      const token = await signStudentToken({ userId: user.id, studentName: user.displayName, sessionVersion: user.sessionVersion });
      const claims: AuthClaims = { sub: user.id, role: "student", studentName: user.displayName, sv: user.sessionVersion };
      const now = new Date().toISOString();
      const draft: ClassroomSubmission = { id: randomUUID(), courseId: instance.id, studentId: user.id, groupId: groupViewId, studentName: user.displayName, type: "document", stageKey: "make", title: user.username, content: `<p>${user.username}-initial</p>`, status: "draft", version: 1, createdAt: now, updatedAt: now };
      return { user, enrollment, participation, group, token, claims, draft };
    }));
    const readAccess = () => resolveLegacyCourseAccess(students[0].claims, instance.id, "read", prisma);
    const aiScope = (student = students[0], { courseId = instance.id, studentId = student.user.id, write = false } = {}) =>
      authenticateLegacyAiStudent(new Request("http://localhost/api/ai-collaboration/document", {
        method: write ? "POST" : "GET", headers: { Cookie: `${student.token.cookieName}=${student.token.token}`, Origin: "http://localhost" },
      }), courseId, studentId);
    const initialAiScope = await aiScope();
    assert.ok(!(initialAiScope instanceof Response));
    assert.equal(initialAiScope.claims.sub, students[0].user.id);
    assert.equal(initialAiScope.studentId, students[0].user.id);
    assert.equal(initialAiScope.participationId, students[0].participation.id);
    assert.equal((await aiScope(students[0], { studentId: students[1].user.id }) as Response).status, 403);
    assert.equal((await aiScope(students[0], { courseId: randomUUID() }) as Response).status, 404);
    assert.deepEqual(await readAccess(), { accessible: true,
      studentInstanceScope: { accessible: true, offeringId: offering.id, version: 1 } });
    try {
      for (const [stored, expected] of [[17, 17], ["17", 1], [null, 1]] as const) {
        await prisma.classroomInstance.update({ where: { id: instance.id }, data: {
          runtimeConfig: { version: stored, currentStageIndex: 2 },
        } });
        assert.equal((await readAccess()).studentInstanceScope?.version, expected,
          "Fresh SQL scope retains number-only event version semantics");
      }
    } finally {
      await prisma.classroomInstance.update({ where: { id: instance.id }, data: {
        runtimeConfig: instance.runtimeConfig as Prisma.InputJsonValue,
      } });
    }
    assert.equal(await resolveStudentStateScope(prisma, offering.id, students[0].user.id), null);
    assert.equal(await resolveStudentStateScope(prisma, template.id, students[0].user.id), null);
    console.log("PASS fresh authorized event metadata uses actual SQL JSON number/string/null versions and preserves legacy namespace fallback");
    const saveEnvelope = (student: typeof students[number], expected: number, suffix: string): ActionEnvelope => ({ requestId: randomUUID(), action: { type: "UPSERT_SUBMISSION", payload: { courseId: instance.id, expectedSubmissionVersion: expected, submission: { ...student.draft, content: `<p>${student.user.username}-${suffix}</p>` } } } });
    const save = (student: typeof students[number], envelope: ActionEnvelope) => executeCourseAction(instance.id, envelope, student.claims);
    const foreignGroup = saveEnvelope(students[0], 0, "foreign-group");
    if (foreignGroup.action.type === "UPSERT_SUBMISSION") foreignGroup.action.payload.submission.groupId = students[1].draft.groupId;
    await assert.rejects(save(students[0], foreignGroup), error => (error as { code: string }).code === "FORBIDDEN_ACTION_SCOPE");
    const verifyWriteRollback = async (label: string, operation: () => Promise<unknown>, domainTable: "ClassroomSubmission" | "StudentProjectWorkspace", includeStage = false) => {
      const snapshot = async () => ({
        participation: await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: students[0].participation.id } }),
        course: await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } }),
        drafts: await prisma.classroomSubmission.findMany({ where: { participationId: students[0].participation.id }, orderBy: { id: "asc" } }),
        workspace: await prisma.studentProjectWorkspace.findUnique({ where: { participationId: students[0].participation.id } }),
        events: await prisma.domainEvent.findMany({ where: { classroomInstanceId: instance.id }, orderBy: { id: "asc" } }),
      });
      for (const table of ["ClassroomInstance", domainTable, ...(includeStage ? ["ClassroomParticipation"] : []), "DomainEvent"]) {
        const before = await snapshot();
        await prisma.$executeRawUnsafe(`CREATE FUNCTION verification_fail_cte_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated CTE rollback'; END; $$`);
        await prisma.$executeRawUnsafe(`CREATE TRIGGER verification_fail_cte_write BEFORE INSERT OR UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION verification_fail_cte_write()`);
        try { await assert.rejects(operation, /isolated CTE rollback/); assert.deepEqual(await snapshot(), before, `${label}: ${table} failure rolls back every durable field`); }
        finally { await prisma.$executeRawUnsafe(`DROP TRIGGER verification_fail_cte_write ON "${table}"`); await prisma.$executeRawUnsafe('DROP FUNCTION verification_fail_cte_write()'); }
      }
      console.log(`PASS ${label}: course/domain/event SQL failures roll back rows, timestamps, versions and receipts`);
    };
    const initial = students.map(student => saveEnvelope(student, 0, "initial"));
    await verifyWriteRollback("first draft", () => save(students[0], initial[0]), "ClassroomSubmission");
    const started = performance.now();
    const initialAcks = await Promise.all(students.map((student, index) => save(student, initial[index])));
    assert.ok(initialAcks.every(ack => ack.submissionVersion === 1));
    assert.equal(await prisma.classroomSubmission.count({ where: { participation: { instanceId: instance.id } } }), 40);
    console.log(`PASS 40 simultaneous personal-group autosaves (${Math.round(performance.now() - started)} ms total)`);
    const originalDraft = await prisma.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: { participationId: students[0].participation.id, stageKey: "make:document" } } });
    await assert.rejects(save(students[0], saveEnvelope(students[0], 0, "stale")), error => {
      const conflict = error as { code: string; details: { currentSubmission: ClassroomSubmission } };
      assert.equal(conflict.code, "DRAFT_VERSION_CONFLICT");
      assert.deepEqual(conflict.details.currentSubmission, (originalDraft.payload as { view: ClassroomSubmission }).view);
      return true;
    });
    console.log("PASS stale CAS returns the complete persisted document, not the narrow successful-read metadata");

    const foreignOffering = await prisma.courseOffering.create({ data: { name: "Unrelated draft access fixture", status: "OPEN" } });
    const checkedStudent = students[0];
    const revocations = [
      { name: "disabled account", apply: () => prisma.user.update({ where: { id: checkedStudent.user.id }, data: { status: "DISABLED" } }), restore: () => prisma.user.update({ where: { id: checkedStudent.user.id }, data: { status: checkedStudent.user.status } }) },
      { name: "changed role", apply: () => prisma.user.update({ where: { id: checkedStudent.user.id }, data: { role: "TEACHER" } }), restore: () => prisma.user.update({ where: { id: checkedStudent.user.id }, data: { role: checkedStudent.user.role } }) },
      { name: "revoked session", apply: () => prisma.user.update({ where: { id: checkedStudent.user.id }, data: { sessionVersion: { increment: 1 } } }), restore: () => prisma.user.update({ where: { id: checkedStudent.user.id }, data: { sessionVersion: checkedStudent.user.sessionVersion } }) },
      { name: "withdrawn enrollment", apply: () => prisma.enrollment.update({ where: { id: checkedStudent.enrollment.id }, data: { status: "WITHDRAWN" } }), restore: () => prisma.enrollment.update({ where: { id: checkedStudent.enrollment.id }, data: { status: "ACTIVE" } }) },
      { name: "different offering", apply: () => prisma.enrollment.update({ where: { id: checkedStudent.enrollment.id }, data: { offeringId: foreignOffering.id } }), restore: () => prisma.enrollment.update({ where: { id: checkedStudent.enrollment.id }, data: { offeringId: offering.id } }) },
    ];
    const beforeRevocations = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    for (const revocation of revocations) {
      await revocation.apply();
      try {
        assert.equal((await readAccess()).accessible, false,
          `${revocation.name}: a later event poll must recheck current permission`);
        const aiRead = await aiScope(); const aiWrite = await aiScope(students[0], { write: true });
        assert.ok(aiRead instanceof Response && [401, 403].includes(aiRead.status), `${revocation.name}: fresh AI history scope rejects revoked access`);
        assert.ok(aiWrite instanceof Response && [401, 403].includes(aiWrite.status), `${revocation.name}: fresh AI write scope rejects revoked access`);
        await assert.rejects(save(checkedStudent, initial[0]), error => (error as { status: number }).status === 403, `${revocation.name}: old receipt cannot bypass current authorization`);
        await assert.rejects(save(checkedStudent, saveEnvelope(checkedStudent, 1, "revoked")), error => (error as { status: number }).status === 403);
      } finally { await revocation.restore(); }
    }
    assert.deepEqual(await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } }), beforeRevocations);
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "COURSE_ACTION" } }), 40);
    assert.deepEqual(await save(checkedStudent, initial[0]), initialAcks[0]);
    await prisma.groupMember.updateMany({ where: { groupId: checkedStudent.group.id, userId: checkedStudent.user.id }, data: { leftAt: new Date() } });
    try { await assert.rejects(save(checkedStudent, saveEnvelope(checkedStudent, 1, "left-group")), error => (error as { code: string }).code === "FORBIDDEN_ACTION_SCOPE"); }
    finally { await prisma.groupMember.updateMany({ where: { groupId: checkedStudent.group.id, userId: checkedStudent.user.id }, data: { leftAt: null } }); }
    console.log("PASS disabled/role/session/enrollment/offering revocations reject both old receipts and new drafts; group exit rejects new writes without version/receipt changes");

    const aiHistoryCases = [
      { name: "finished classroom", apply: () => prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED" } }), restore: () => prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: "TEACHING" } }) },
      { name: "completed enrollment", apply: () => prisma.enrollment.update({ where: { id: checkedStudent.enrollment.id }, data: { status: "COMPLETED" } }), restore: () => prisma.enrollment.update({ where: { id: checkedStudent.enrollment.id }, data: { status: "ACTIVE" } }) },
      { name: "closed offering", apply: () => prisma.courseOffering.update({ where: { id: offering.id }, data: { status: "CLOSED" } }), restore: () => prisma.courseOffering.update({ where: { id: offering.id }, data: { status: "OPEN" } }) },
      { name: "archived activity", apply: () => prisma.activity.update({ where: { id: activity.id }, data: { archivedAt: new Date() } }), restore: () => prisma.activity.update({ where: { id: activity.id }, data: { archivedAt: null } }) },
    ];
    for (const scenario of aiHistoryCases) {
      await scenario.apply();
      try {
        assert.equal((await aiScope() as { participationId: string }).participationId, checkedStudent.participation.id, `${scenario.name}: history remains readable`);
        const response = await aiScope(checkedStudent, { write: true }) as Response;
        assert.equal(response.status, 409, `${scenario.name}: writes remain closed`);
        assert.equal((await response.json()).error, "COURSE_LOCKED");
      } finally { await scenario.restore(); }
    }
    console.log("PASS joined AI scope: actual signed cookies/SQL preserve identity, foreign offering and live revocations; completed/finished/archived histories remain read-only");

    await verifyWriteRollback("existing draft", () => save(students[0], saveEnvelope(students[0], 1, "failure-check")), "ClassroomSubmission");

    const createdDrafts = await prisma.classroomSubmission.findMany({ where: { participation: { instanceId: instance.id } } });
    const winners: Array<{ student: typeof students[number]; envelope: ActionEnvelope; ack: ActionAck }> = [];
    await Promise.all(students.map(async student => {
      const left = saveEnvelope(student, 1, "left");
      const right = saveEnvelope(student, 1, "right");
      const results = await Promise.allSettled([save(student, left), save(student, right)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const loser = results.find(result => result.status === "rejected");
      assert.ok(loser?.status === "rejected" && loser.reason.code === "DRAFT_VERSION_CONFLICT");
      const index = results[0].status === "fulfilled" ? 0 : 1;
      const winner = results[index]; assert.equal(winner.status, "fulfilled");
      winners.push({ student, envelope: index === 0 ? left : right, ack: winner.value });
    }));
    const replayAcks = await Promise.all(winners.map(({ student, envelope }) => save(student, envelope)));
    replayAcks.forEach((ack, index) => assert.deepEqual(ack, winners[index].ack));
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "COURSE_ACTION" } }), 80);
    for (const winner of winners) {
      const draft = await prisma.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: { participationId: winner.student.participation.id, stageKey: "make:document" } } });
      const original = createdDrafts.find(row => row.participationId === draft.participationId)!;
      assert.equal(draft.id, original.id); assert.deepEqual(draft.createdAt, original.createdAt);
      const receipt = await prisma.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: `course-action:${winner.student.user.id}:${winner.envelope.requestId}` } });
      assert.deepEqual((receipt.payload as { ack: ActionAck }).ack, winner.ack);
      assert.equal(winner.ack.eventCursor, `${receipt.createdAt.toISOString()}~${receipt.id}`);
    }
    console.log("PASS 80 competing CAS writes: exactly one winner per student; 40 response-loss retries add no receipts");

    const finalizeRequest = (student: typeof students[number], requestId: string, expectedVersion: number) => new Request("http://localhost/api/project-practice/submissions/finalize", { method: "POST", headers: { origin: "http://localhost", cookie: `${student.token.cookieName}=${student.token.token}`, "content-type": "application/json", "x-openpbl-role": "student" }, body: JSON.stringify({ courseId: instance.id, studentId: student.user.id, submissionId: student.draft.id, stageKey: "make", expectedVersion, requestId }) });
    await Promise.all(students.map(async student => {
      const archiveId = randomUUID();
      const edit = saveEnvelope(student, 2, "racing-edit");
      const [archive, saved] = await Promise.all([finalize(finalizeRequest(student, archiveId, 2)), save(student, edit).then(ack => ({ ack }), error => ({ error }))]);
      assert.ok(archive.status === 200 || archive.status === 409, `Unexpected archive status ${archive.status}: ${await archive.clone().text()}`);
      assert.equal(Number(archive.status === 200) + Number("ack" in saved), 1, "finalize and stale autosave cannot both commit");
      if ("error" in saved) assert.equal(saved.error.code, "DRAFT_VERSION_CONFLICT");
      const receipt = archive.status === 200 ? await archive.json() : await (async () => {
        const result = await finalize(finalizeRequest(student, randomUUID(), 3));
        assert.equal(result.status, 200, await result.clone().text()); return result.json();
      })();
      if (archive.status === 200) {
        const replay = await finalize(finalizeRequest(student, archiveId, 2));
        assert.equal(replay.status, 200); assert.equal((await replay.json()).versionId, receipt.versionId);
      }
      const row = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: receipt.versionId }, include: { fileAsset: true } });
      const bytes = await readFile(path.join(uploads!, row.fileAsset!.storageKey));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.sha256);
      const submission = await prisma.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: { participationId: student.participation.id, stageKey: "make:document" } } });
      const view = (submission.payload as { view: ClassroomSubmission }).view;
      assert.equal(view.status, "submitted"); assert.equal(view.version, receipt.submissionVersion);
      assert.ok(row.sourceHtml?.includes(view.content.replace(/<\/?p>/g, "")), "archived content matches the committed draft");
    }));
    assert.equal(await prisma.artifactVersion.count({ where: { artifact: { participation: { instanceId: instance.id } } } }), 40);
    console.log("PASS 40 finalize/autosave races: one winner, immutable file digest/content matches, no duplicate archive on retry");

    const progressInput = { studentId: students[0].user.id, classroomId: "verification-classroom", currentSceneIndex: 1, totalScenes: 2, completedScenes: ["scene-a"], completionModelVersion: 2, masteryLevel: "in-progress" as const, lastActiveAt: new Date().toISOString() };
    const runtimeBeforeProgress = (await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig as Record<string, unknown>;
    const preservedRuntime = { ...runtimeBeforeProgress, version: "2147483648", progressRetentionProbe: { text: "完整课堂状态".repeat(2000), nested: [null, { enabled: true }] } };
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: JSON.parse(JSON.stringify(preservedRuntime)) } });
    await verifyWriteRollback("first progress", () => persistStudentAiProgress(instance.id, students[0].user.id, progressInput), "StudentProjectWorkspace", true);
    await persistStudentAiProgress(instance.id, students[0].user.id, progressInput);
    assert.deepEqual((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig,
      { ...preservedRuntime, version: 2147483649 }, "progress updates only version, preserving complete runtime and numeric-string versions above int32");
    await prisma.$executeRaw`UPDATE "ClassroomInstance" SET "runtimeConfig" = 'null'::jsonb WHERE id = ${instance.id}`;
    await persistStudentAiProgress(instance.id, students[0].user.id, progressInput, undefined, { requestId: randomUUID(), fingerprint: "null-runtime-compatibility" });
    assert.deepEqual((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig,
      { version: 2 }, "JSON-null runtime retains the previous empty-object default");
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: JSON.parse(JSON.stringify({ ...preservedRuntime, version: 2147483650 })) } });
    const preservedWorkspace = await prisma.studentProjectWorkspace.update({ where: { participationId: students[0].participation.id }, data: { aiMembers: [{ id: "preserved-companion" }], status: "PAUSED" } });
    const progressUpdate = { ...progressInput, completedScenes: ["scene-b"] };
    await verifyWriteRollback("existing progress", () => persistStudentAiProgress(instance.id, students[0].user.id, progressUpdate), "StudentProjectWorkspace", true);
    const sceneStarted = performance.now();
    await Promise.all(students.flatMap(student => ["scene-a", "scene-b"].map(scene => persistStudentAiProgress(instance.id, student.user.id, { studentId: student.user.id, classroomId: "verification-classroom", currentSceneIndex: 1, totalScenes: 2, completedScenes: [scene], completionModelVersion: 2, masteryLevel: "in-progress", lastActiveAt: new Date().toISOString() }))));
    const participations = await prisma.classroomParticipation.findMany({ where: { instanceId: instance.id }, include: { workspace: true } });
    for (const participation of participations) {
      assert.equal((participation.stageProgress as { progress: Record<string, number> }).progress["ai-learning"], 100);
      const progress = (participation.workspace!.projectState as { aiLearningProgress: { completedScenes: string[]; masteryLevel: string } }).aiLearningProgress;
      assert.equal(progress.masteryLevel, "completed"); assert.equal(progress.completedScenes.length, 2);
    }
    const updatedWorkspace = await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: students[0].participation.id } });
    for (const field of ["id", "createdAt", "status", "aiMembers"] as const) assert.deepEqual(updatedWorkspace[field], preservedWorkspace[field]);
    assert.equal(updatedWorkspace.version, preservedWorkspace.version + 1);
    console.log(`PASS 80 concurrent scene completions merge to 40 complete progress records at 100% (${Math.round(performance.now() - sceneStarted)} ms batch)`);

    const progressRequests = students.map(student => {
      const body = { ...progressInput, studentId: student.user.id, currentSceneIndex: 0 };
      return { body, receipt: { requestId: randomUUID(), fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"), sessionVersion: student.claims.sv } };
    });
    const progressEventCount = await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "UPDATE_STUDENT_PROGRESS" } });
    const progressReplies = await Promise.all(students.map(async (student, index) => {
      const { body, receipt } = progressRequests[index];
      const pair = await Promise.all([persistStudentAiProgress(instance.id, student.user.id, body, undefined, receipt), persistStudentAiProgress(instance.id, student.user.id, body, undefined, receipt)]);
      assert.deepEqual(pair[0], pair[1]); return pair[0];
    }));
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "UPDATE_STUDENT_PROGRESS" } }), progressEventCount + 40);
    for (const [index, student] of students.entries()) {
      const { body, receipt } = progressRequests[index];
      await assert.rejects(persistStudentAiProgress(instance.id, student.user.id, body, undefined, { ...receipt, fingerprint: "changed" }), error => (error as { code: string }).code === "IDEMPOTENCY_CONFLICT");
    }
    const newProgress = { ...progressRequests[0].body, currentSceneIndex: 1, lastActiveAt: new Date().toISOString() };
    await persistStudentAiProgress(instance.id, students[0].user.id, newProgress, undefined, { requestId: randomUUID(), fingerprint: "later-progress", sessionVersion: students[0].claims.sv });
    const laterWorkspace = await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: students[0].participation.id } });
    assert.deepEqual(await persistStudentAiProgress(instance.id, students[0].user.id, progressRequests[0].body, undefined, progressRequests[0].receipt), progressReplies[0]);
    assert.deepEqual(await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: students[0].participation.id } }), laterWorkspace);
    // Separate actual-PG timing fixture: never contributes to the existing
    // forty-student classroom's progress/submission/event totals.
    const timingTag = randomUUID();
    const timingTeachers = await Promise.all([0, 1].map(i => createUser(`timing-${timingTag}-teacher-${i}`, "TEACHER")));
    const timingClaims = timingTeachers.map((teacher): AuthClaims => ({ sub: teacher.id, role: "teacher",
      username: teacher.username, displayName: teacher.displayName, sv: teacher.sessionVersion }));
    const timingOffering = await prisma.courseOffering.create({ data: { name: `Timing verification ${timingTag}`, status: "OPEN",
      teachers: { create: timingTeachers.map(teacher => ({ userId: teacher.id })) } } });
    const timingChapter = await prisma.chapter.create({ data: { offeringId: timingOffering.id, title: "Timing", position: 0, isOpen: true } });
    const timingActivity = await prisma.activity.create({ data: { chapterId: timingChapter.id, title: "Timing", type: "CLASSROOM", position: 0, isOpen: true } });
    const timingTemplate = await prisma.classroomTemplate.create({ data: { title: "Timing", ownerId: timingTeachers[0].id } });
    const timingClassroomId = `timing-classroom-${timingTag}`;
    const timingDesign = createPblTemplateCourse(timingTemplate.id, { name: "Timing", aiLearningClassroomId: timingClassroomId });
    const timingTemplateVersion = await prisma.classroomTemplateVersion.create({ data: { templateId: timingTemplate.id, version: 1,
      status: "PUBLISHED", snapshot: JSON.parse(JSON.stringify(encodePblTemplate(timingDesign))) } });
    const timingInstance = await prisma.classroomInstance.create({ data: { activityId: timingActivity.id,
      templateVersionId: timingTemplateVersion.id, status: "TEACHING", runtimeConfig: { version: 1, stageVersion: 4, currentStageIndex: 2 } } });
    const timingStudents = await Promise.all(Array.from({ length: 30 }, async (_, i) => {
      const user = await createUser(`timing-${timingTag}-student-${i}`);
      const enrollment = await prisma.enrollment.create({ data: { userId: user.id, offeringId: timingOffering.id } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: timingInstance.id, enrollmentId: enrollment.id } });
      return { user, participation };
    }));
    const { loadCourse: loadTimingCourse } = await import("../src/lib/db/session-repository");
    const initialTimingCourse = await loadTimingCourse(timingInstance.id);
    assert.ok(initialTimingCourse); assert.equal(initialTimingCourse.version, 1); assert.equal(initialTimingCourse.stageVersion, 4);
    assert.equal(initialTimingCourse.uiState?.classroomTiming, undefined);
    const timingInputs = timingStudents.map(({ user }) => {
      const body: StudentAiProgress = { studentId: user.id, classroomId: timingClassroomId, currentSceneIndex: 0,
        totalScenes: 2, completedScenes: ["timing-scene-a"], masteryLevel: "in-progress", lastActiveAt: new Date().toISOString() };
      return { body, receipt: { requestId: randomUUID(), sessionVersion: user.sessionVersion,
        fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") } };
    });
    await Promise.all(timingStudents.map(({ user }, i) => persistStudentAiProgress(timingInstance.id, user.id,
      timingInputs[i].body, undefined, timingInputs[i].receipt)));
    const beforeTiming = await loadTimingCourse(timingInstance.id);
    assert.ok(beforeTiming); assert.equal(beforeTiming.version, 31); assert.equal(beforeTiming.stageVersion, 4);
    assert.equal(Object.keys(beforeTiming.aiLearningProgress ?? {}).length, 30);
    const timingStage = beforeTiming.stages[beforeTiming.currentStageIndex]!.key;
    const timingCommand = (requestId = randomUUID(), stageVersion = 4, stageKey = timingStage): ActionEnvelope => ({ requestId, expectedVersion: 1,
      action: { type: "SET_UI_STATE", payload: { courseId: timingInstance.id, patch: {},
        intent: { type: "initialize-classroom-timing", baseStageVersion: stageVersion, stageKey } } } });
    const timingCommands = [timingCommand(), timingCommand()];
    const timingAcks = await Promise.all(timingClaims.map((claims, i) => executeCourseAction(timingInstance.id, timingCommands[i], claims)));
    assert.ok(timingAcks.every((ack, i) => ack.requestId === timingCommands[i].requestId && ack.courseVersion === 32 && ack.stageVersion === 5));
    assert.notEqual(timingAcks[0].eventCursor, timingAcks[1].eventCursor);
    const afterTiming = await loadTimingCourse(timingInstance.id);
    assert.ok(afterTiming?.uiState?.classroomTiming); assert.equal(afterTiming.version, 32);
    assert.deepEqual(afterTiming.aiLearningProgress, beforeTiming.aiLearningProgress);
    assert.deepEqual(afterTiming.students, beforeTiming.students);
    assert.equal(afterTiming.uiState.classroomTiming.activeStageKey, timingStage);
    assert.deepEqual(afterTiming.uiState.classroomTiming.stages.map(stage => stage.stageKey), beforeTiming.stages.map(stage => stage.key));
    const timingEvents = await prisma.domainEvent.findMany({ where: { classroomInstanceId: timingInstance.id, eventType: "COURSE_ACTION" } });
    assert.equal(timingEvents.length, 2);
    assert.deepEqual(timingEvents.map(event => (event.payload as { timingInitialization: { outcome: string } }).timingInitialization.outcome).sort(),
      ["already-present", "initialized"]);
    for (let i = 0; i < 2; i++) {
      const event = timingEvents.find(row => row.idempotencyKey === `course-action:${timingClaims[i].sub}:${timingCommands[i].requestId}`)!;
      assert.ok(event); assert.equal(event.actorId, timingClaims[i].sub);
      assert.deepEqual((event.payload as { ack: unknown }).ack, timingAcks[i]);
      assert.deepEqual((event.payload as { requestedAction: unknown }).requestedAction, timingCommands[i].action);
    }
    const timingSnapshot = async () => ({
      instance: await prisma.classroomInstance.findUniqueOrThrow({ where: { id: timingInstance.id } }),
      participations: await prisma.classroomParticipation.findMany({ where: { instanceId: timingInstance.id }, orderBy: { id: "asc" } }),
      workspaces: await prisma.studentProjectWorkspace.findMany({ where: { participation: { instanceId: timingInstance.id } }, orderBy: { id: "asc" } }),
      events: await prisma.domainEvent.findMany({ where: { classroomInstanceId: timingInstance.id }, orderBy: { id: "asc" } }),
    });
    const replayTimingReceipts = async () => {
      const before = await timingSnapshot();
      for (let i = 0; i < 2; i++) assert.deepEqual(await executeCourseAction(timingInstance.id, timingCommands[i], timingClaims[i]), timingAcks[i]);
      assert.deepEqual(await timingSnapshot(), before, "Original timing receipts never mutate timer, versions, timestamps or events");
    };
    await replayTimingReceipts();
    const existingTimerCommand = timingCommand();
    const existingTimerAck = await executeCourseAction(timingInstance.id, existingTimerCommand, timingClaims[0]);
    assert.equal(existingTimerAck.courseVersion, 32);
    assert.deepEqual((await loadTimingCourse(timingInstance.id))!.uiState!.classroomTiming, afterTiming.uiState.classroomTiming);
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: timingInstance.id, eventType: "COURSE_ACTION" } }), 3);
    const beforeInvalidTiming = await timingSnapshot();
    for (const envelope of [timingCommand(randomUUID(), 3), timingCommand(randomUUID(), 4, "wrong-stage")]) {
      await assert.rejects(executeCourseAction(timingInstance.id, envelope, timingClaims[0]),
        error => (error as { code: string; status: number }).code === "CLASSROOM_STAGE_CONFLICT" && (error as { status: number }).status === 409);
    }
    await assert.rejects(executeCourseAction(timingInstance.id, timingCommand(timingCommands[0].requestId, 5), timingClaims[0]),
      error => (error as { code: string; status: number }).code === "IDEMPOTENCY_CONFLICT" && (error as { status: number }).status === 409);
    await assert.rejects(executeCourseAction(timingInstance.id, { requestId: randomUUID(), expectedVersion: 1,
      action: { type: "SET_UI_STATE", payload: { courseId: timingInstance.id,
        patch: { classroomTiming: { ...afterTiming.uiState.classroomTiming, status: "paused" } } } } }, timingClaims[0]),
      error => (error as { code: string; status: number }).code === "VERSION_CONFLICT" && (error as { status: number }).status === 409);
    assert.deepEqual(await timingSnapshot(), beforeInvalidTiming);
    // Ordinary teacher clock editing retains its real monotonic token advance;
    // the old initialization receipt cannot authorize a reset after that edit.
    await executeCourseAction(timingInstance.id, { requestId: randomUUID(), expectedVersion: 32,
      action: { type: "SET_UI_STATE", payload: { courseId: timingInstance.id,
        patch: { classroomTiming: { ...afterTiming.uiState.classroomTiming, status: "paused" } } } } }, timingClaims[0]);
    const pausedTiming = await loadTimingCourse(timingInstance.id);
    assert.equal(pausedTiming!.stageVersion, 6); assert.equal(pausedTiming!.version, 33);
    const beforeStalePaused = await timingSnapshot();
    await assert.rejects(executeCourseAction(timingInstance.id, timingCommand(), timingClaims[0]),
      error => (error as { code: string; status: number }).code === "CLASSROOM_STAGE_CONFLICT" && (error as { status: number }).status === 409);
    assert.deepEqual(await timingSnapshot(), beforeStalePaused);
    // A unique blocker holds only this fixture's row. pg_blocking_pids proves
    // the actual command reached that lock before any identity is revoked.
    const timingObserverUrl = new URL(target); timingObserverUrl.searchParams.set("connection_limit", "1");
    const timingObserver = new PrismaClient({ datasourceUrl: timingObserverUrl.toString() });
    const timingTeacher = timingTeachers[0];
    const timingMembership = await prisma.courseTeacher.findFirstOrThrow({ where: { userId: timingTeacher.id, offeringId: timingOffering.id } });
    const timingRevocations = [
      { name: "status", apply: () => prisma.user.update({ where: { id: timingTeacher.id }, data: { status: "DISABLED" } }), restore: () => prisma.user.update({ where: { id: timingTeacher.id }, data: { status: timingTeacher.status } }) },
      { name: "role", apply: () => prisma.user.update({ where: { id: timingTeacher.id }, data: { role: "STUDENT" } }), restore: () => prisma.user.update({ where: { id: timingTeacher.id }, data: { role: timingTeacher.role } }) },
      { name: "session", apply: () => prisma.user.update({ where: { id: timingTeacher.id }, data: { sessionVersion: { increment: 1 } } }), restore: () => prisma.user.update({ where: { id: timingTeacher.id }, data: { sessionVersion: timingTeacher.sessionVersion } }) },
      { name: "membership", apply: () => prisma.courseTeacher.delete({ where: { id: timingMembership.id } }), restore: () => prisma.courseTeacher.create({ data: timingMembership }) },
    ];
    try {
      for (const revocation of timingRevocations) for (const replay of [false, true]) {
        const before = await timingSnapshot();
        let releaseTimingLock!: () => void; let readyTimingLock!: (pid: number) => void; let rejectTimingLock!: (error: unknown) => void;
        const readyTiming = new Promise<number>((resolve, reject) => { readyTimingLock = resolve; rejectTimingLock = reject; });
        const releaseTiming = new Promise<void>(resolve => { releaseTimingLock = resolve; });
        const heldTiming = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${timingInstance.id} FOR UPDATE`;
          const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          readyTimingLock(backend.pid); await releaseTiming;
        }, { timeout: 10_000 });
        void heldTiming.catch(rejectTimingLock);
        let pendingTiming: Promise<{ status: "fulfilled"; value: ActionAck } | { status: "rejected"; reason: unknown }> | undefined;
        let revoked = false;
        try {
          const blocker = await readyTiming;
          const command = replay ? timingCommands[0] : timingCommand(randomUUID(), pausedTiming!.stageVersion!);
          pendingTiming = executeCourseAction(timingInstance.id, command, timingClaims[0]).then(
            value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
          let waiters: Array<{ pid: number }> = [];
          const waitDeadline = performance.now() + 2000;
          while (performance.now() < waitDeadline) {
            waiters = await timingObserver.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND ${blocker} = ANY(pg_blocking_pids(pid)) AND pid <> pg_backend_pid()`;
            if (waiters.length) break;
            await delay(10);
          }
          assert.equal(waiters.length, 1, `${revocation.name}/${replay ? "replay" : "new"}: exact owned row blocker must block the one real command`);
          await revocation.apply(); revoked = true;
          releaseTimingLock(); await heldTiming;
          const result = await pendingTiming;
          assert.equal(result.status, "rejected");
          if (result.status !== "rejected") throw new Error("Revoked timing command unexpectedly succeeded");
          assert.equal((result.reason as { status: number }).status, 403);
          assert.equal((result.reason as { code: string }).code, "FORBIDDEN");
          assert.deepEqual(await timingSnapshot(), before, `${revocation.name}: no timing, workspace, participation, event or receipt change`);
        } finally {
          releaseTimingLock(); await Promise.allSettled([heldTiming, ...(pendingTiming ? [pendingTiming] : [])]);
          if (revoked) await revocation.restore();
        }
      }
    } finally { await timingObserver.$disconnect(); }
    await replayTimingReceipts();
    console.log("PASS independent30-student timing: one initialization/version, two teacher durable receipts, exact no-op replays, existing timer preserved, stage/body/CAS conflicts, eight proven post-lock live-permission revocations");

    // Restart only the nonce-bound disposable container whose loopback port is this database.
    const inspected = JSON.parse(execFileSync("docker", ["inspect", marker!], { encoding: "utf8" }))[0];
    assert.equal(inspected.Name, `/${marker}`);
    assert.deepEqual(inspected.NetworkSettings.Ports["5432/tcp"], [{ HostIp: "127.0.0.1", HostPort: target.port }]);
    await prisma.$disconnect();
    execFileSync("docker", ["restart", marker!], { timeout: 30_000, stdio: "ignore" });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnSync("docker", ["exec", marker!, "pg_isready", "-U", "postgres"], { stdio: "ignore", timeout: 5_000 }).status === 0) { ready = true; break; }
      await delay(100);
    }
    assert.ok(ready, "Disposable PostgreSQL recovers after restart");
    assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`)[0].marker, marker);
    await replayTimingReceipts();
    console.log("PASS both original timing ACKs replay exactly after the existing disposable PostgreSQL restart, with no new facts or version");
    const replayVersion = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    await Promise.all(students.map(async (student, index) => assert.deepEqual(await persistStudentAiProgress(instance.id, student.user.id, progressRequests[index].body, undefined, progressRequests[index].receipt), progressReplies[index])));
    assert.deepEqual(await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } }), replayVersion);
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "UPDATE_STUDENT_PROGRESS" } }), progressEventCount + 41);
    console.log("PASS progress 40 duplicate requests yield 40 receipts, changed bodies conflict, older receipt cannot rewind newer state, PostgreSQL restart replays exactly without new events/version");

    // Exercise the real service/parameterized SQL inside this nonce-bound
    // disposable database, not an alternate receipt implementation.
    const { collectProgressTimings } = await import("../src/lib/observability/progress-request-timing");
    const { subscribeCourseEvents, unsubscribeCourseEvents } = await import("../src/lib/realtime/event-bus");
    type ProgressSpan = import("../src/lib/observability/progress-request-timing").ProgressTimingSpan;
    const progressSnapshot = async () => {
      const [course, participation, workspace, events] = await Promise.all([
        prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } }),
        prisma.classroomParticipation.findUniqueOrThrow({ where: { id: students[0].participation.id } }),
        prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: students[0].participation.id } }),
        prisma.domainEvent.findMany({ where: { classroomInstanceId: instance.id }, orderBy: { id: "asc" } }),
      ]);
      return { course, participation, workspace, events };
    };
    const boundedProgress = async <T>(promise: Promise<T>, message: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), 2_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const waitForProgress = async (condition: () => Promise<boolean> | boolean, message: string) => {
      const deadline = performance.now() + 2_000;
      while (!(await condition())) { assert.ok(performance.now() < deadline, message); await delay(10); }
    };

    // Pause the actual writer after its receipt INSERT and before commit. A
    // sequence makes only the first attempt stop (including a rolled-back one).
    await prisma.$executeRawUnsafe('CREATE TABLE "_OpenpblProgressReceiptGate" ("receiptKey" text PRIMARY KEY, "abortCommit" boolean NOT NULL)');
    await prisma.$executeRawUnsafe('CREATE SEQUENCE "_OpenpblProgressReceiptGateAttempt"');
    await prisma.$executeRawUnsafe(`CREATE FUNCTION verification_progress_receipt_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE abort_commit boolean;
      BEGIN
        SELECT "abortCommit" INTO abort_commit FROM "_OpenpblProgressReceiptGate" WHERE "receiptKey" = NEW."idempotencyKey";
        IF FOUND THEN
          IF nextval('"_OpenpblProgressReceiptGateAttempt"') = 1 THEN
            PERFORM pg_advisory_xact_lock(2026101601::bigint);
            IF abort_commit THEN RAISE EXCEPTION 'isolated progress commit rollback'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END; $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER verification_progress_receipt_gate AFTER INSERT ON "DomainEvent" FOR EACH ROW EXECUTE FUNCTION verification_progress_receipt_gate()');
    try {
      for (const rollback of [false, true]) {
        const body = { ...newProgress, lastActiveAt: new Date().toISOString() };
        const request = { requestId: randomUUID(), fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"), sessionVersion: students[0].claims.sv };
        const receiptKey = `ai-progress:${instance.id}:${students[0].user.id}:${request.requestId}`;
        await prisma.$executeRaw`DELETE FROM "_OpenpblProgressReceiptGate"`;
        await prisma.$executeRaw`INSERT INTO "_OpenpblProgressReceiptGate" ("receiptKey", "abortCommit") VALUES (${receiptKey}, ${rollback})`;
        await prisma.$queryRaw`SELECT setval('"_OpenpblProgressReceiptGateAttempt"', 1, false)`;
        const before = await progressSnapshot();
        let entered!: () => void; let fail!: (error: unknown) => void; let release!: () => void;
        const ready = new Promise<void>((resolve, reject) => { entered = resolve; fail = reject; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const blocker = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(2026101601::bigint)::text`;
          entered(); await gate;
        }, { timeout: 10_000 });
        void blocker.catch(fail);
        let first: Promise<StudentAiProgress> | undefined; let replay: Promise<StudentAiProgress> | undefined;
        const published: string[] = [];
        const listener = subscribeCourseEvents(instance.id, event => { published.push(event.type); });
        try {
          await ready;
          first = persistStudentAiProgress(instance.id, students[0].user.id, body, undefined, request);
          const outcome = first.then(value => ({ ok: true as const, value }), reason => ({ ok: false as const, reason }));
          await waitForProgress(async () => {
            const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
              SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0
                AND objid = 2026101601::oid AND objsubid = 1 AND NOT granted
            ) AS waiting`;
            return row.waiting;
          }, "Actual progress writer must reach its uncommitted receipt gate");
          const spans: ProgressSpan[] = []; let replaySettled = false;
          replay = collectProgressTimings(performance.now(), spans, () =>
            persistStudentAiProgress(instance.id, students[0].user.id, body, undefined, request));
          void replay.then(() => { replaySettled = true; }, () => { replaySettled = true; });
          await waitForProgress(() => spans.some(span => span.phase === "progress-receipt-read"), "Duplicate must finish its actual receipt read");
          assert.deepEqual(await progressSnapshot(), before, "Uncommitted progress/receipt is not visible");
          assert.equal(replaySettled, false, "Uncommitted receipt cannot acknowledge success or conflict");
          assert.equal(published.length, 0);
          release(); await blocker;
          const firstOutcome = await outcome; const acknowledged = await replay;
          assert.equal(firstOutcome.ok, !rollback);
          if (firstOutcome.ok) assert.deepEqual(acknowledged, firstOutcome.value);
          else assert.match(String(firstOutcome.reason), /isolated progress commit rollback/);
          const after = await progressSnapshot();
          assert.equal(after.workspace.version, before.workspace.version + 1);
          assert.equal(Number((after.course.runtimeConfig as { version: number }).version), Number((before.course.runtimeConfig as { version: number }).version) + 1);
          assert.equal(after.events.length, before.events.length + 1);
          assert.equal(after.events.filter(event => event.idempotencyKey === receiptKey).length, 1);
          assert.equal(published.length, 1, "Exactly the committed write publishes; replay/rollback never does");
          assert.deepEqual(JSON.parse(JSON.stringify(playbackProgress((after.workspace.projectState as { aiLearningProgress: StudentAiProgress }).aiLearningProgress))),
            JSON.parse(JSON.stringify(acknowledged)));
        } finally {
          release(); await Promise.allSettled([blocker, ...(first ? [first] : []), ...(replay ? [replay] : [])]);
          unsubscribeCourseEvents(instance.id, listener);
        }
      }
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER verification_progress_receipt_gate ON "DomainEvent"');
      await prisma.$executeRawUnsafe('DROP FUNCTION verification_progress_receipt_gate()');
      await prisma.$executeRawUnsafe('DROP SEQUENCE "_OpenpblProgressReceiptGateAttempt"');
      await prisma.$executeRawUnsafe('DROP TABLE "_OpenpblProgressReceiptGate"');
    }
    console.log("PASS uncommitted progress receipts never acknowledge early; commit replays once and rollback permits exactly one genuine later commit");

    // Corrupt only synthetic fixture rows to exercise actual SQL scope joins;
    // restore the original immutable receipt before checking the full snapshot.
    const progressReceipt = await prisma.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: `ai-progress:${instance.id}:${students[0].user.id}:${progressRequests[0].receipt.requestId}` } });
    const otherInstance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, runNo: 2, status: "SCHEDULED" } });
    const restoreReceipt = { actorId: progressReceipt.actorId, offeringId: progressReceipt.offeringId, classroomInstanceId: progressReceipt.classroomInstanceId,
      participationId: progressReceipt.participationId, eventType: progressReceipt.eventType, payload: progressReceipt.payload as Prisma.InputJsonValue };
    const beforeScopeChecks = await progressSnapshot();
    try {
      const corruptions: Prisma.DomainEventUncheckedUpdateInput[] = [{ actorId: students[1].user.id }, { offeringId: foreignOffering.id },
        { classroomInstanceId: otherInstance.id }, { participationId: students[1].participation.id }, { eventType: "UNRELATED_EVENT" },
        { payload: { ...(progressReceipt.payload as Prisma.JsonObject), response: { ...progressReplies[0], classroomId: "foreign-classroom" } } as Prisma.InputJsonValue }];
      for (const data of corruptions) {
        await prisma.domainEvent.update({ where: { id: progressReceipt.id }, data });
        try {
          await assert.rejects(persistStudentAiProgress(instance.id, students[0].user.id, progressRequests[0].body, undefined, progressRequests[0].receipt),
            error => (error as { code: string }).code === "IDEMPOTENCY_CONFLICT");
        } finally { await prisma.domainEvent.update({ where: { id: progressReceipt.id }, data: restoreReceipt }); }
      }
      assert.deepEqual(await progressSnapshot(), beforeScopeChecks);
    } finally { await prisma.classroomInstance.delete({ where: { id: otherInstance.id } }); }
    // A foreign receipt may become visible only after the fast read misses.
    // The locked replay must reject it as well, rather than trust the key/hash.
    const lateForeignRequest = { ...progressRequests[0].receipt, requestId: randomUUID() };
    const lateForeignKey = `ai-progress:${instance.id}:${students[0].user.id}:${lateForeignRequest.requestId}`;
    let foreignEntered!: () => void; let foreignFailed!: (error: unknown) => void; let foreignRelease!: () => void;
    const foreignReady = new Promise<void>((resolve, reject) => { foreignEntered = resolve; foreignFailed = reject; });
    const foreignGate = new Promise<void>(resolve => { foreignRelease = resolve; });
    const foreignInsert = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`v2-course:${instance.id}`}, 0))::text`;
      await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE`;
      await tx.domainEvent.create({ data: { idempotencyKey: lateForeignKey, actorId: students[1].user.id,
        offeringId: offering.id, classroomInstanceId: instance.id, participationId: students[0].participation.id,
        eventType: "UPDATE_STUDENT_PROGRESS", payload: { ...(progressReceipt.payload as Prisma.JsonObject), requestId: lateForeignRequest.requestId } as Prisma.InputJsonValue } });
      foreignEntered(); await foreignGate;
    }, { timeout: 10_000 });
    void foreignInsert.catch(foreignFailed);
    let lateForeignReplay: Promise<StudentAiProgress> | undefined;
    const foreignPublished: string[] = [];
    const foreignListener = subscribeCourseEvents(instance.id, event => { foreignPublished.push(event.type); });
    try {
      await foreignReady;
      const spans: ProgressSpan[] = []; let settled = false;
      lateForeignReplay = collectProgressTimings(performance.now(), spans, () => persistStudentAiProgress(instance.id, students[0].user.id,
        progressRequests[0].body, undefined, lateForeignRequest));
      void lateForeignReplay.then(() => { settled = true; }, () => { settled = true; });
      await waitForProgress(() => spans.some(span => span.phase === "progress-receipt-read"), "Foreign fixture must remain invisible to the first read");
      assert.deepEqual(await progressSnapshot(), beforeScopeChecks);
      assert.equal(settled, false);
      foreignRelease(); await foreignInsert;
      await assert.rejects(lateForeignReplay, error => (error as { code: string }).code === "IDEMPOTENCY_CONFLICT");
      assert.ok(spans.some(span => span.phase === "progress-read"));
      assert.equal(foreignPublished.length, 0);
    } finally {
      foreignRelease(); await Promise.allSettled([foreignInsert, ...(lateForeignReplay ? [lateForeignReplay] : [])]);
      unsubscribeCourseEvents(instance.id, foreignListener);
      await prisma.domainEvent.deleteMany({ where: { idempotencyKey: lateForeignKey } });
    }
    assert.deepEqual(await progressSnapshot(), beforeScopeChecks);
    console.log("PASS foreign actor/offering/instance/participation/type/response cannot turn a matching key into an acknowledgement");

    await Promise.all(students.map(async student => {
      const request = { courseId: instance.id, classroomId: "verification-classroom", studentId: student.user.id, requestId: randomUUID(), threadId: "verification-thread", attemptId: "attempt", questionId: "question", message: "Why?", initial: false };
      const claims = await Promise.all([claimTutorRequest(request), claimTutorRequest(request)]);
      assert.equal(claims.filter(claim => claim.run).length, 1);
      const claim = claims.find(item => item.run); assert.ok(claim?.run);
      const now = new Date().toISOString();
      const fullAnswer = "完整解释".repeat(1000);
      const rawOutput = "\n" + JSON.stringify({ answer: fullAnswer, boardNotes: [{ title: "证据", body: "完整板书".repeat(300) }] }) + " ";
      const thread = await finishTutorRequest(request, claim.token, { id: request.threadId, attemptId: "attempt", questionId: "question", messages: [{ id: randomUUID(), role: "student", content: "Why?", createdAt: now }, { id: randomUUID(), role: "assistant", content: fullAnswer, createdAt: now }], boardNotes: [], createdAt: now, updatedAt: now }, rawOutput);
      assert.deepEqual(await claimTutorRequest(request), { run: false, status: "COMPLETED", thread });
      const task = await prisma.aiTask.findFirstOrThrow({ where: { input: { path: ["requestId"], equals: request.requestId } } });
      assert.deepEqual((task.output as { modelOutput: unknown }).modelOutput, { raw: rawOutput, sha256: createHash("sha256").update(rawOutput).digest("hex") });
      assert.equal((await prisma.aiMessage.findUniqueOrThrow({ where: { id: `${task.id}:assistant` } })).content, fullAnswer);
      assert.equal((await prisma.aiInteractionEvent.findUniqueOrThrow({ where: { idempotencyKey: `${task.id}:answer` } })).content, fullAnswer);
    }));
    assert.equal(await prisma.aiMessage.count({ where: { conversation: { participation: { instanceId: instance.id } } } }), 80);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { participation: { instanceId: instance.id }, eventType: { in: ["message", "response"] } } }), 80);
    console.log("PASS 40 duplicate tutor requests create exactly 40 tasks and 80 durable messages/audit facts");

    const rawRequest = { courseId: instance.id, classroomId: "verification-classroom", studentId: students[0].user.id, requestId: randomUUID(), threadId: "raw-rollback-thread", attemptId: "attempt", questionId: "question", message: "verify raw atomicity", initial: false };
    const rawClaim = await claimTutorRequest(rawRequest); assert.ok(rawClaim.run);
    const rawText = " " + JSON.stringify({ answer: "完整内容".repeat(1000), boardNotes: [{ body: "完整板书".repeat(500) }] }) + "\n";
    const rawAdditions = { id: rawRequest.threadId, attemptId: "attempt", questionId: "question", messages: [{ id: "raw-assistant", role: "assistant" as const, content: "完整内容".repeat(1000), createdAt: new Date().toISOString() }], boardNotes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const rawTaskBefore = await prisma.aiTask.findFirstOrThrow({ where: { input: { path: ["requestId"], equals: rawRequest.requestId } } });
    await verifyWriteRollback("full tutor output", () => finishTutorRequest(rawRequest, rawClaim.token, rawAdditions, rawText), "StudentProjectWorkspace");
    assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id: rawTaskBefore.id } }), rawTaskBefore);
    assert.equal(await prisma.aiMessage.count({ where: { id: `${rawTaskBefore.id}:assistant` } }), 0);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: rawTaskBefore.id } }), 1);
    const rawThread = await finishTutorRequest(rawRequest, rawClaim.token, rawAdditions, rawText);
    assert.deepEqual(await finishTutorRequest(rawRequest, rawClaim.token, rawAdditions, "different raw on replay"), rawThread);
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: rawTaskBefore.id } })).output, { thread: rawThread, modelOutput: { raw: rawText, sha256: createHash("sha256").update(rawText).digest("hex") } });
    assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: rawTaskBefore.id } }), 2);
    console.log("PASS 40 full tutor answers/raw JSON hashes retained; failed output commit rolls back task/messages/facts and same request retry writes exactly two facts");

    const teacherClaims = teachers.map((teacher): AuthClaims => ({ sub: teacher.id, role: "teacher", username: teacher.username, displayName: teacher.displayName, sv: teacher.sessionVersion }));
    const projectionCourse = await loadTimingCourse(instance.id);
    assert.ok(projectionCourse);
    const project = (teacherIndex: number, takeover = false): ActionEnvelope => ({ requestId: randomUUID(), action: { type: "SET_UI_STATE", payload: { courseId: instance.id, projectionControl: { clientId: `teacher-tab-${teacherIndex}`, takeover, baseStageVersion: projectionCourse.stageVersion ?? 1, stageKey: projectionCourse.stages[projectionCourse.currentStageIndex].key }, patch: { resourceProjection: { resourceId: "resource", stageKey: "make", title: "投屏", startedAt: new Date().toISOString() } } } } });
    const projections = await Promise.allSettled(teacherClaims.map((claims, index) => executeCourseAction(instance.id, project(index), claims)));
    assert.equal(projections.filter(result => result.status === "fulfilled").length, 1);
    const rejectedTeacher = projections[0].status === "rejected" ? 0 : 1;
    const rejection = projections[rejectedTeacher]; assert.equal(rejection.status, "rejected"); assert.equal(rejection.reason.code, "PROJECTION_CONTROL_CONFLICT");
    await executeCourseAction(instance.id, project(rejectedTeacher, true), teacherClaims[rejectedTeacher]);
    console.log("PASS two teachers cannot silently overwrite projection ownership; explicit takeover succeeds");

    const initialQuiz = students.map(student => ({ courseId: instance.id, studentId: student.user.id, classroomId: "verification-classroom", attempt: {
      id: `quiz-${student.user.id}`, sectionId: "quiz-section", quizOutlineId: "quiz-outline", runtimeSceneId: "quiz-scene", submittedAt: new Date().toISOString(), gradingSource: "server", gradingStatus: "pending", score: 0, maxScore: 0, knowledgePointIds: [], questions: [{ questionId: "short", questionType: "short_answer", prompt: "Explain the evidence", answer: `Original answer ${student.user.id}`, rawAnswer: `Original answer ${student.user.id}`, points: 5, earned: 0, correct: null, gradingStatus: "pending", feedback: "pending", knowledgePointIds: [], teachingUnitIds: [] }],
    } satisfies KnowledgeLectureAttempt }));
    await verifyWriteRollback("first quiz attempt", () => persistKnowledgeLectureAttempt(initialQuiz[0]), "StudentProjectWorkspace");
    const history = students.flatMap(student => Array.from({ length: 360 }, (_, index) => ({ userId: student.user.id, idempotencyKey: `history-${index}`, researchKey: student.enrollment.researchKey, offeringId: offering.id, enrollmentId: student.enrollment.id, classroomInstanceId: instance.id, participationId: student.participation.id, eventType: "heartbeat", occurredAt: new Date(Date.now() - index * 10000), metadata: { legacy: { id: `history-${index}`, courseId: instance.id, studentId: student.user.id, stageKey: "ai-learning", type: "heartbeat", durationMs: 10000 } } })));
    for (let i = 0; i < history.length; i += 1000) await prisma.learningEvent.createMany({ data: history.slice(i, i + 1000) });
    const latest = await prisma.classroomSubmission.findMany({ where: { participation: { instanceId: instance.id }, stageKey: "make:document" } });
    const durations: Record<string, number[]> = { quiz: [], progress: [], draft: [], projection: [] };
    const measured = async <T>(kind: string, operation: () => Promise<T>) => { const started = performance.now(); const value = await operation(); durations[kind].push(performance.now() - started); return value; };
    const mixed = await Promise.allSettled([
      ...students.flatMap((student, index) => {
        const version = (latest.find(row => row.participationId === student.participation.id)!.payload as { view: ClassroomSubmission }).view.version!;
        return [
          measured("quiz", () => persistKnowledgeLectureAttempt(initialQuiz[index])),
          measured("progress", () => persistStudentAiProgress(instance.id, student.user.id, { studentId: student.user.id, classroomId: "verification-classroom", currentSceneIndex: 1, totalScenes: 2, completedScenes: ["scene-a", "scene-b"], completionModelVersion: 2, masteryLevel: "completed", lastActiveAt: new Date().toISOString() })),
          measured("draft", () => save(student, saveEnvelope(student, version, "mixed-document-evidence".repeat(700)))),
        ];
      }),
      (async () => { await delay(90); return measured("projection", () => executeCourseAction(instance.id, project(rejectedTeacher, true), teacherClaims[rejectedTeacher])); })(),
    ]);
    const failedMixed = mixed.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    assert.equal(failedMixed.length, 0, failedMixed.map(item => String(item.reason)).join("\n"));
    for (const [kind, times] of Object.entries(durations)) { times.sort((a, b) => a - b); console.log(`MEASURE 14,400-history mixed ${kind}: n=${times.length} p95=${Math.round(times[Math.ceil(times.length * .95) - 1])}ms max=${Math.round(times.at(-1)!)}ms`); }
    const quizEventsBefore = await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "KNOWLEDGE_QUIZ_SUBMITTED" } });
    await Promise.all(students.map(async (student, index) => {
      assert.deepEqual(await persistKnowledgeLectureAttempt(initialQuiz[index]), initialQuiz[index].attempt);
      await assert.rejects(persistKnowledgeLectureAttempt({ ...initialQuiz[index], attempt: { ...initialQuiz[index].attempt, questions: [{ ...initialQuiz[index].attempt.questions[0], rawAnswer: "Changed answer" }] } }), error => (error as Error).message === "QUIZ_ALREADY_SUBMITTED");
      const workspace = await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: student.participation.id } });
      const progress = (workspace.projectState as { aiLearningProgress: { completedScenes: string[]; knowledgeLectureAttempts: KnowledgeLectureAttempt[]; knowledgeLectureTutorThreads: unknown[] } }).aiLearningProgress;
      assert.equal(progress.completedScenes.length, 2); assert.equal(progress.knowledgeLectureAttempts.length, 1); assert.equal(progress.knowledgeLectureTutorThreads.length, index === 0 ? 2 : 1);
      const context = await loadKnowledgeLectureContext(instance.id, student.user.id);
      assert.equal(context?.aiLearningClassroomId, "verification-classroom"); assert.deepEqual(context.students, [{ id: student.user.id }]);
      assert.deepEqual(Object.keys(context.aiLearningProgress), [student.user.id]); assert.equal(context.aiLearningProgress[student.user.id].knowledgeLectureAttempts?.length, 1);
    }));
    assert.equal(quizEventsBefore, 40);
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "KNOWLEDGE_QUIZ_SUBMITTED" } }), 40);
    console.log("PASS 40 quiz submissions + progress + personal-group drafts + teacher projection preserve all progress/attempts/threads; lost-ack replays are no-ops; changed answers rejected");

    // Hold a row-only closure lock while student requests enter, proving it excludes
    // the application's advisory+row protocol and that checks run after the wait.
    let entered!: () => void; let release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closure = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE`;
      await tx.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED", endedAt: new Date() } });
      entered(); await gate;
    }, { timeout: 10_000 });
    await locked;
    const observerUrl = new URL(target); observerUrl.searchParams.set("connection_limit", "1");
    const observer = new PrismaClient({ datasourceUrl: observerUrl.toString() });
    const late = Promise.allSettled(students.map(student => save(student, saveEnvelope(student, 3, "too-late"))));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const rows = await observer.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
        if (rows[0].count > 0n) { waiting = true; break; }
        await delay(25);
      }
      assert.ok(waiting, "Observe a student transaction waiting on closure before releasing the row lock");
    } finally { release(); await observer.$disconnect(); }
    await closure;
    const lateResults = await late;
    assert.equal(lateResults.filter(result => result.status === "rejected").length, 40);
    assert.ok(lateResults.every(result => result.status === "rejected" && result.reason.code === "CLASSROOM_READ_ONLY"));
    const finalReplay = await save(winners[0].student, winners[0].envelope);
    assert.deepEqual(finalReplay, winners[0].ack, "closed classroom still replays a previously committed receipt");
    console.log("PASS classroom closure rejects all 40 queued new writes while confirmed receipt replay remains available");
    await Promise.all(students.map(async (student, index) => {
      assert.deepEqual(await persistStudentAiProgress(instance.id, student.user.id, progressRequests[index].body, undefined, progressRequests[index].receipt), progressReplies[index]);
      await assert.rejects(persistStudentAiProgress(instance.id, student.user.id, progressRequests[index].body, undefined, { ...progressRequests[index].receipt, requestId: randomUUID() }), error => (error as { code: string }).code === "CLASSROOM_READ_ONLY");
    }));
    // Historical read permission survives terminal classroom/offering states.
    // It must not wait behind either of the course writer locks or publish anew.
    const replayEnrollment = await prisma.enrollment.findUniqueOrThrow({ where: { id: students[0].enrollment.id } });
    await prisma.enrollment.update({ where: { id: replayEnrollment.id }, data: { status: "COMPLETED" } });
    await prisma.courseOffering.update({ where: { id: offering.id }, data: { status: "CLOSED" } });
    await prisma.activity.update({ where: { id: activity.id }, data: { archivedAt: new Date() } });
    let enteredReplayLock!: () => void; let failReplayLock!: (error: unknown) => void; let releaseReplayLock!: () => void;
    const replayLockReady = new Promise<void>((resolve, reject) => { enteredReplayLock = resolve; failReplayLock = reject; });
    const replayLockGate = new Promise<void>(resolve => { releaseReplayLock = resolve; });
    const heldReplayLock = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`v2-course:${instance.id}`}, 0))::text`;
      await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE`;
      enteredReplayLock(); await replayLockGate;
    }, { timeout: 10_000 });
    void heldReplayLock.catch(failReplayLock);
    const replayPublished: string[] = [];
    const replayListener = subscribeCourseEvents(instance.id, event => { replayPublished.push(event.type); });
    let lockedReplay: Promise<StudentAiProgress> | undefined;
    try {
      await replayLockReady;
      const before = await progressSnapshot(); const spans: ProgressSpan[] = [];
      lockedReplay = collectProgressTimings(performance.now(), spans, () => persistStudentAiProgress(instance.id, students[0].user.id,
        progressRequests[0].body, undefined, progressRequests[0].receipt));
      assert.deepEqual(await boundedProgress(lockedReplay, "Committed replay must finish while both course writer locks remain held"), progressReplies[0]);
      assert.deepEqual(spans.map(span => span.phase), ["progress-receipt-read"]);
      assert.deepEqual(await progressSnapshot(), before);
      assert.equal(replayPublished.length, 0);
    } finally {
      releaseReplayLock(); await Promise.allSettled([heldReplayLock, ...(lockedReplay ? [lockedReplay] : [])]);
      unsubscribeCourseEvents(instance.id, replayListener);
      await prisma.enrollment.update({ where: { id: replayEnrollment.id }, data: { status: replayEnrollment.status } });
      await prisma.courseOffering.update({ where: { id: offering.id }, data: { status: offering.status } });
      await prisma.activity.update({ where: { id: activity.id }, data: { archivedAt: activity.archivedAt } });
    }
    console.log("PASS committed receipt bypasses held course advisory/row locks after finish/completed/closed/archive with original timestamp, full state and zero publications");
    for (const revocation of revocations) {
      await revocation.apply();
      try { await assert.rejects(persistStudentAiProgress(instance.id, students[0].user.id, progressRequests[0].body, undefined, progressRequests[0].receipt), error => (error as { status: number }).status === 403); }
      finally { await revocation.restore(); }
    }
    console.log("PASS closed progress receipts replay while new requests and revoked account/role/session/enrollment/offering reject");
    await assert.rejects(persistKnowledgeLectureAttempt({ ...initialQuiz[0], attempt: { ...initialQuiz[0].attempt, id: "new-closed-attempt", quizOutlineId: "new-quiz" } }), error => (error as { code: string }).code === "CLASSROOM_READ_ONLY");
    const grade = (index: number) => persistKnowledgeLectureAttempt(initialQuiz[index], new Map([["short", { ...initialQuiz[index].attempt.questions[0], earned: 4, gradingStatus: "graded" as const, feedback: "Supported by evidence" }]]));
    await verifyWriteRollback("closed accepted quiz grade", () => grade(0), "StudentProjectWorkspace");
    await Promise.all(students.map(async (_, index) => { const result = await grade(index); assert.equal(result.score, 4); assert.equal(result.questions[0].rawAnswer, initialQuiz[index].attempt.questions[0].rawAnswer); }));
    await Promise.all(students.map((_, index) => grade(index)));
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "KNOWLEDGE_QUIZ_GRADED" } }), 40);
    const gradedWorkspace = await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: students[0].participation.id } });
    for (const field of ["id", "createdAt", "status", "aiMembers"] as const) assert.deepEqual(gradedWorkspace[field], preservedWorkspace[field]);
    console.log("PASS closed classroom completes all 40 accepted grades, preserves first answers, rejects new attempts, replays completed grades without duplicate notifications; failed durable event rolls back grade and version");
    const { courseAdmissionPipelineStarted, courseAdmissionPipelineActive, courseAdmissionLocalActive } = await import("../src/lib/observability/course-admission");
    const startedCandidates = (await courseAdmissionPipelineStarted.get()).values[0].value;
    const enabled = process.env.OPENPBL_COURSE_MUTATION_PIPELINE === "2";
    assert.ok(enabled ? startedCandidates > 0 : startedCandidates === 0, "The tested pipeline flag must actually control candidate transactions");
    assert.equal((await courseAdmissionPipelineActive.get()).values[0].value, 0);
    assert.equal((await courseAdmissionLocalActive.get()).values[0].value, 0);
    assert.equal(globalThis.__openPblCourseMutationQueuesV2?.size ?? 0, 0);
    assert.equal(globalThis.__openPblCourseMutationPipelineV2?.extraActive ?? 0, 0);
    console.log(`PASS pipeline mode=${enabled ? 2 : 1} actually started ${startedCandidates} candidates; all permits, local queues and active gauges drained`);
  } finally {
    await prisma.$disconnect();
    if (uploads) await rm(uploads, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
