// Invoked only by verify-research-database.mjs against its marked disposable PostgreSQL container.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { AuthClaims } from "../src/lib/auth/session";
import type { CompanionTask, CompanionConfirmation, CompanionProcessRecord } from "../src/lib/session/types";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/postgres");
  assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.ok(target.port);
  const { prisma } = await import("../src/lib/db/client");
  let outputDirectory: string | undefined;
  try {
    const rows = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(rows.length, 1, "Database must carry this run's disposable marker");
    outputDirectory = await mkdtemp(path.join(tmpdir(), "openpbl-collaboration-verification-"));
    process.env.UPLOAD_DIR = outputDirectory;
    process.env.JWT_SECRET = randomUUID() + randomUUID();
    delete process.env.REDIS_URL;
    const companion = await import("../src/lib/companion/server-store");
    const { PlatformError } = await import("../src/lib/platform/repository");
    const audit = await import("../src/lib/ai-collaboration/audit-store");
    const { authorizeLegacyAiScope } = await import("../src/lib/ai-collaboration/legacy-scope");
    const { readAiCollaboration } = await import("../src/lib/platform/ai-collaboration");
    const { listProjectDocumentVersions } = await import("../src/lib/project-practice/versions");
    const { POST: finalize } = await import("../src/app/api/project-practice/submissions/finalize/route");
    const { signStudentToken } = await import("../src/lib/auth/session");
    const user = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role, passwordHash: "verification-only-unusable-hash" } });
    const teacher = await user("collaboration-teacher", "TEACHER");
    const alice = await user("collaboration-alice");
    const bob = await user("collaboration-bob");
    const offering = await prisma.courseOffering.create({ data: { name: "Collaboration verification", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const enrollment = await prisma.enrollment.create({ data: { offeringId: offering.id, userId: alice.id } });
    const otherEnrollment = await prisma.enrollment.create({ data: { offeringId: offering.id, userId: bob.id } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "Research", position: 0, isOpen: true } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "Document practice", type: "CLASSROOM", position: 0, isOpen: true } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: "Collaboration" } });
    const templateVersion = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: { title: "Verification lesson" } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: templateVersion.id, status: "TEACHING", runtimeConfig: { version: 1, currentStageIndex: 2 } } });
    const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
    await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: otherEnrollment.id } });
    const claims: AuthClaims = { sub: alice.id, role: "student", studentName: alice.displayName, sv: alice.sessionVersion };
    const otherClaims: AuthClaims = { sub: bob.id, role: "student", studentName: bob.displayName, sv: bob.sessionVersion };
    assert.equal((await authorizeLegacyAiScope(claims, instance.id, alice.id)).participation?.id, participation.id);
    await assert.rejects(() => authorizeLegacyAiScope(otherClaims, instance.id, alice.id), (error: { code: string }) => error.code === "STUDENT_SCOPE_MISMATCH");

    // Deliberately insert equal-time IDs out of order; the existing read must
    // return every message in createdAt/id order, including private evidence.
    const readPrefix = `companion-read-${randomUUID()}`; const messageAt = new Date().toISOString();
    const message = { ...companion.companionMessage({ role: "student", content: "Verification research question", visibility: "student-and-teacher", conversationId: "verification-logical", createdAt: messageAt }), id: `${readPrefix}-b` };
    const privateMessage = { ...companion.companionMessage({ role: "system-trigger", content: "Teacher-only verification note", visibility: "teacher-only", conversationId: "verification-logical", createdAt: messageAt }), id: `${readPrefix}-a` };
    await Promise.all(Array.from({ length: 3 }, () => companion.appendCompanionMessages({ courseId: instance.id, studentId: alice.id, stageKey: "make", messages: [message, privateMessage] })));
    const thread = await companion.getCompanionThread(instance.id, alice.id, "make");
    assert.equal(thread?.messages.length, 2);
    assert.ok(thread);
    assert.deepEqual(thread.messages.map(row => row.id), [privateMessage.id, message.id]);
    assert.equal(thread.messages[0].visibility, "teacher-only");
    assert.deepEqual(thread.messages.map(row => row.content), [privateMessage.content, message.content]);
    assert.equal(await prisma.aiMessage.count({ where: { conversationId: thread!.id } }), 2);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { conversationId: thread!.id, researchKey: enrollment.researchKey } }), 2);
    assert.equal(await companion.softDeleteCompanionMessage({ courseId: instance.id, studentId: alice.id, stageKey: "make", messageId: message.id, conversationId: "verification-logical" }), true);
    assert.equal((await prisma.aiMessage.findUniqueOrThrow({ where: { id: message.id } })).content, message.content);
    assert.equal((await readAiCollaboration(claims, participation.id)).conversations.find(row => row.id === thread!.id)?.messages.length, 0);
    const retained = await companion.getCompanionThread(instance.id, alice.id, "make");
    assert.equal(retained?.messages.length, 2);
    assert.ok(retained);
    assert.ok(retained.messages.find(row => row.id === message.id)?.hiddenFromStudentAt);
    assert.equal(retained.messages.find(row => row.id === message.id)?.content, message.content);
    console.log("PASS real V2 companion append concurrency, message deduplication, research linkage and hidden-message visibility");

    const scopeRejected = (operation: () => Promise<unknown>) => assert.rejects(operation, (error: unknown) =>
      error instanceof PlatformError && error.code === "STUDENT_SCOPE_MISMATCH" && error.status === 403
      && error.message === "协作记录不属于该课堂");
    assert.equal(await companion.getCompanionThread(instance.id, bob.id, "make"), undefined);
    await scopeRejected(() => companion.getCompanionThread(randomUUID(), alice.id, "make"));
    await scopeRejected(() => companion.getCompanionThread(instance.id, randomUUID(), "make"));
    // This disposable malformed participation has no messages/facts. Change
    // only its relationship, proving each read checks the live offering chain.
    const misplacedStudent = await user("collaboration-read-misplaced");
    const foreignOffering = await prisma.courseOffering.create({ data: { name: "Read scope mismatch fixture" } });
    const misplacedEnrollment = await prisma.enrollment.create({ data: { userId: misplacedStudent.id, offeringId: foreignOffering.id } });
    const misplaced = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: misplacedEnrollment.id } });
    try {
      await scopeRejected(() => companion.getCompanionThread(instance.id, misplacedStudent.id, "make"));
      await prisma.enrollment.update({ where: { id: misplacedEnrollment.id }, data: { offeringId: offering.id } });
      assert.equal(await companion.getCompanionThread(instance.id, misplacedStudent.id, "make"), undefined);
      await prisma.enrollment.update({ where: { id: misplacedEnrollment.id }, data: { offeringId: foreignOffering.id } });
      await scopeRejected(() => companion.getCompanionThread(instance.id, misplacedStudent.id, "make"));
    } finally {
      await prisma.classroomParticipation.delete({ where: { id: misplaced.id } });
      await prisma.enrollment.delete({ where: { id: misplacedEnrollment.id } });
      await prisma.user.delete({ where: { id: misplacedStudent.id } });
      await prisma.courseOffering.delete({ where: { id: foreignOffering.id } });
    }
    // Keep the pre-existing read semantics: completed/archived state is not a
    // write authorization and must not remove a teacher's historical messages.
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "COMPLETED" } });
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED" } });
    await prisma.courseOffering.update({ where: { id: offering.id }, data: { status: "ARCHIVED" } });
    try {
      assert.deepEqual(await companion.getCompanionThread(instance.id, alice.id, "make"), retained);
    } finally {
      await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: enrollment.status } });
      await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: instance.status } });
      await prisma.courseOffering.update({ where: { id: offering.id }, data: { status: offering.status } });
    }
    console.log("PASS real joined companion read ownership, missing/empty scope, offering changes, equal-time history order and completed/archived reads");

    const now = new Date().toISOString();
    const task: CompanionTask = { id: randomUUID(), courseId: instance.id, studentId: alice.id, stageKey: "make", kind: "formal-action", title: "Verify proposal", request: "Save a verification proposal", status: "waiting-confirmation", createdAt: now, updatedAt: now };
    const confirmation: CompanionConfirmation = { id: randomUUID(), courseId: instance.id, studentId: alice.id, stageKey: "make", action: "save", title: "Confirm test proposal", summary: "Verification only", taskId: task.id, status: "pending", createdAt: now };
    const record: CompanionProcessRecord = { id: randomUUID(), courseId: instance.id, studentId: alice.id, stageKey: "make", title: "Process evidence", summary: "Verification evidence", source: "student", taskId: task.id, createdAt: now };
    task.confirmationId = confirmation.id;
    const before = await companion.loadCompanionState(instance.id);
    await prisma.$transaction(tx => companion.persistCompanionState(tx, instance.id, before, { ...before, companionTasks: [task], companionConfirmations: [confirmation], companionProcessRecords: [record] }, alice.id));
    const pending = await companion.loadCompanionState(instance.id);
    assert.equal(pending.companionTasks?.find(row => row.id === task.id)?.status, "waiting-confirmation");
    assert.equal(pending.companionConfirmations?.find(row => row.id === confirmation.id)?.status, "pending");
    const resolvedAt = new Date(Date.now() + 1).toISOString();
    await prisma.$transaction(tx => companion.persistCompanionState(tx, instance.id, pending, { ...pending, companionTasks: [{ ...task, status: "saved", result: "Confirmed test proposal", updatedAt: resolvedAt }], companionConfirmations: [{ ...confirmation, status: "confirmed", resolvedAt }] }, alice.id));
    assert.equal((await prisma.aiActionConfirmation.findUniqueOrThrow({ where: { id: confirmation.id } })).status, "APPROVED");
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } })).status, "SAVED");
    assert.equal(await prisma.aiSupportRecord.count({ where: { participationId: participation.id, type: "COMPANION_PROCESS" } }), 1);
    assert.equal(await prisma.domainEvent.count({ where: { participationId: participation.id, researchKey: enrollment.researchKey } }), 5);
    console.log("PASS real V2 companion task, confirmation and process-record round trips with durable domain facts");

    // Exercise the actual PostgreSQL JSON-string predicate, including the
    // empty-string historical stage. No task input/history is deleted to make
    // the smaller companion projection possible.
    const legacyInput = { request: "Retained historical task request", legacy: {
      stageKey: "", title: "Historical task with empty stage", companionId: "historical-member", evidenceIds: ["historical-evidence"],
    } };
    const legacyReadTask = await prisma.aiTask.create({ data: { conversationId: thread.id, offeringId: offering.id,
      createdById: alice.id, taskType: "formal-action", status: "SAVED", input: legacyInput,
      output: { result: "Retained historical task result" }, error: "Retained historical diagnostic" } });
    const beforeSnapshotTask = await companion.loadCompanionState(instance.id);
    const beforeStudentSnapshotTask = await companion.loadCompanionState(instance.id, prisma, alice.id);
    const reviewInput = { requestId: "read-projection-snapshot-fixture", reviewSnapshot: {
      version: 1, course: { id: instance.id, stages: [{ key: "make", content: "Retained course material. ".repeat(4096) }] },
      documentHtml: `<p>${"Retained original document evidence. ".repeat(8192)}</p>`,
    } };
    // Completed, not placed in the worker queue: this fixture cannot execute a
    // model request. Its large immutable input must remain available by task ID.
    const snapshotTask = await prisma.aiTask.create({ data: { conversationId: thread.id, offeringId: offering.id,
      createdById: alice.id, taskType: "DOCUMENT_COLLABORATION", status: "COMPLETED", input: reviewInput } });
    const afterSnapshotTask = await companion.loadCompanionState(instance.id);
    assert.deepEqual(afterSnapshotTask, beforeSnapshotTask);
    assert.deepEqual(await companion.loadCompanionState(instance.id, prisma, alice.id), beforeStudentSnapshotTask);
    assert.deepEqual(afterSnapshotTask.companionTasks?.find(row => row.id === legacyReadTask.id), {
      ...legacyInput.legacy, id: legacyReadTask.id, courseId: instance.id, studentId: alice.id, kind: "formal-action", status: "saved",
      request: legacyInput.request, result: "Retained historical task result", error: "Retained historical diagnostic",
      createdAt: legacyReadTask.createdAt.toISOString(), updatedAt: legacyReadTask.updatedAt.toISOString(),
    });
    assert.ok(!afterSnapshotTask.companionTasks?.some(row => row.id === snapshotTask.id));
    const persistedSnapshot = await prisma.aiTask.findUniqueOrThrow({ where: { id: snapshotTask.id }, select: { input: true } });
    assert.deepEqual(persistedSnapshot.input, reviewInput);
    assert.ok(JSON.stringify(persistedSnapshot.input).length > 128 * 1024);
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: legacyReadTask.id }, select: { input: true } })).input, legacyInput);
    console.log("PASS actual companion task string/empty-stage filter, teacher/student projection equality and durable large review snapshot retention");

    // Keep the prompt projection equal to the full live student projection
    // while leaving unrelated large workspace evidence in its original row.
    const { loadDocumentCourseContext } = await import("../src/lib/ai-collaboration/document-course-context");
    const { loadInstanceCourse } = await import("../src/lib/db/v2-course-projection");
    const { buildAuthoritativeCourseContext } = await import("../src/lib/ai-collaboration/document-policy");
    const contextTemplate = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: "Context read parity" } });
    const contextSnapshot = (point: string) => ({ schemaVersion: 2, kind: "pbl-course", design: {
      name: "Published context design", stages: [{ key: "proposal", label: "方案" }, { key: "make", label: "制作" }],
      pblConfig: { makeArtifactMode: "document" }, content: { knowledgePoints: [{ id: "context-point", name: point }] },
    } });
    const contextVersion = await prisma.classroomTemplateVersion.create({ data: { templateId: contextTemplate.id, version: 1,
      status: "PUBLISHED", snapshot: contextSnapshot("Published context concept") } });
    const contextInstance = await prisma.classroomInstance.create({ data: { activityId: activity.id, runNo: 2, templateVersionId: contextVersion.id,
      status: "TEACHING", runtimeConfig: { version: 7, currentStageIndex: 1, makeArtifactMode: "document" } } });
    const contextParticipation = await prisma.classroomParticipation.create({ data: { instanceId: contextInstance.id, enrollmentId: enrollment.id } });
    const contextPeer = await prisma.classroomParticipation.create({ data: { instanceId: contextInstance.id, enrollmentId: otherEnrollment.id } });
    const contextWorkspace = await prisma.studentProjectWorkspace.create({ data: { participationId: contextParticipation.id } });
    await prisma.studentProjectWorkspace.create({ data: { participationId: contextPeer.id, projectState: { aiLearningProgress: { foreign: "retained peer progress" } } } });
    const largeDraft = "Retained private workspace draft. ".repeat(8192);
    const progress = { knowledgeLectureAttempts: [{ questions: [{ correct: false, knowledgePointIds: ["context-point"],
      prompt: "Context method", feedback: "Retain the full original progress" }] }], extension: { preserved: ["all", "nested", "fields"] } };
    const workspaceCases: Array<{ stored: Prisma.InputJsonValue | typeof Prisma.JsonNull; progress?: unknown }> = [
      { stored: Prisma.JsonNull }, { stored: "scalar" }, { stored: [] }, { stored: { unrelatedDraft: largeDraft } },
      { stored: { aiLearningProgress: null } }, { stored: { aiLearningProgress: false } },
      { stored: { aiLearningProgress: 7 }, progress: 7 }, { stored: { aiLearningProgress: [] }, progress: [] },
      { stored: { aiLearningProgress: progress, unrelatedDraft: largeDraft }, progress },
    ];
    const contextFields = ["id", "name", "grade", "stages", "pblConfig", "content", "students", "groups", "feedback", "learningEvidence",
      "teacherAgentDirectives", "aiLearningProgress", "status", "currentStageIndex", "version", "createdAt", "updatedAt"] as const;
    for (const entry of workspaceCases) {
      await prisma.studentProjectWorkspace.update({ where: { id: contextWorkspace.id }, data: { projectState: entry.stored } });
      const full = await loadInstanceCourse(contextInstance.id, prisma, { studentId: alice.id });
      const narrow = await loadDocumentCourseContext(contextInstance.id, alice.id);
      assert.ok(full && narrow);
      for (const key of contextFields) assert.deepEqual(narrow[key], full[key], `Document context field changed: ${key}`);
      assert.deepEqual(narrow.aiLearningProgress, entry.progress ? { [alice.id]: entry.progress } : {});
      assert.equal(buildAuthoritativeCourseContext(narrow, alice.id, "make"), buildAuthoritativeCourseContext(full, alice.id, "make"));
    }
    const originalWorkspace = await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { id: contextWorkspace.id } });
    assert.deepEqual(originalWorkspace.projectState, { aiLearningProgress: progress, unrelatedDraft: largeDraft });
    assert.ok(JSON.stringify(originalWorkspace.projectState).length > 128 * 1024);
    const firstContext = (await loadDocumentCourseContext(contextInstance.id, alice.id))!;
    firstContext.content.knowledgePoints[0].name = "Caller-local mutation";
    assert.equal((await loadDocumentCourseContext(contextInstance.id, alice.id))?.content.knowledgePoints[0].name, "Published context concept");
    const draftContextVersion = await prisma.classroomTemplateVersion.create({ data: { templateId: contextTemplate.id, version: 2,
      status: "DRAFT", snapshot: contextSnapshot("Draft context one") } });
    await prisma.classroomInstance.update({ where: { id: contextInstance.id }, data: { templateVersionId: draftContextVersion.id } });
    assert.equal((await loadDocumentCourseContext(contextInstance.id, alice.id))?.content.knowledgePoints[0].name, "Draft context one");
    await prisma.classroomTemplateVersion.update({ where: { id: draftContextVersion.id }, data: { snapshot: contextSnapshot("Draft context two") } });
    assert.equal((await loadDocumentCourseContext(contextInstance.id, alice.id))?.content.knowledgePoints[0].name, "Draft context two");
    await prisma.$transaction(async tx => {
      assert.equal((await loadDocumentCourseContext(contextInstance.id, alice.id, tx))?.content.knowledgePoints[0].name, "Draft context two");
      await tx.classroomTemplateVersion.update({ where: { id: draftContextVersion.id }, data: { snapshot: contextSnapshot("Uncommitted draft context") } });
      assert.equal((await loadDocumentCourseContext(contextInstance.id, alice.id, tx))?.content.knowledgePoints[0].name, "Uncommitted draft context");
    });
    console.log("PASS actual document prompt/full-projection parity, complete progress JSON types, durable large draft, immutable published isolation and fresh draft/transaction reads");

    const auditInput = { courseId: instance.id, studentId: alice.id, stageKey: "make", conversationId: "verification-logical", source: "sidebar" as const, eventType: "decision" as const, actorRole: "student" as const, content: "Verification confirmed", requestId: "verification-audit-request" };
    await Promise.all([audit.appendAiInteractionEvents([auditInput]), audit.appendAiInteractionEvents([auditInput])]);
    const auditRows = await audit.listAiInteractionEvents({ courseId: instance.id, studentId: alice.id, stageKey: "make", limit: 1 });
    assert.equal(auditRows.events.length, 1); assert.ok(auditRows.nextCursor);
    assert.equal(auditRows.events[0].conversationId, "verification-logical");
    assert.equal(await prisma.aiInteractionEvent.count({ where: { participationId: participation.id, requestId: auditInput.requestId } }), 1);
    const invalidAudit = { ...auditInput, courseId: randomUUID(), requestId: "invalid" };
    await assert.rejects(() => audit.appendAiInteractionEvents([invalidAudit]), (error: { code: string }) => error.code === "EVENT_SCOPE_MISMATCH");
    console.log("PASS actual V2 audit logical-conversation mapping, request deduplication, scope rejection and pagination");

    const imageId = randomUUID();
    const imageName = `${imageId}.png`;
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3pWQAAAABJRU5ErkJggg==", "base64");
    await writeFile(path.join(outputDirectory, imageName), imageBytes, { mode: 0o600, flag: "wx" });
    await prisma.fileAsset.create({ data: { id: imageId, originalName: "verification.png", storageKey: imageName, offeringId: offering.id, uploadedById: alice.id, mimeType: "image/png", size: BigInt(imageBytes.length) } });
    const logicalSubmissionId = randomUUID();
    const draft = { id: logicalSubmissionId, courseId: instance.id, studentId: alice.id, stageKey: "make", type: "document", title: "Verification artifact", content: `<h1>Verification artifact</h1><p>Immutable evidence from a disposable test database.</p><img src="/api/uploads/${imageId}" alt="verification">`, version: 1, status: "draft", createdAt: now, updatedAt: now };
    const submission = await prisma.classroomSubmission.create({ data: { participationId: participation.id, stageKey: "make:document", payload: { collection: "submissions", view: draft } } });
    const token = await signStudentToken({ userId: alice.id, studentName: alice.displayName, sessionVersion: alice.sessionVersion });
    const request = (requestId: string, expectedVersion = 1) => new Request("http://localhost/api/project-practice/submissions/finalize", { method: "POST", headers: { origin: "http://localhost", cookie: `${token.cookieName}=${token.token}`, "content-type": "application/json", "x-openpbl-role": "student" }, body: JSON.stringify({ courseId: instance.id, submissionId: logicalSubmissionId, studentId: alice.id, stageKey: "make", expectedVersion, requestId }) });
    const first = await finalize(request("document-first"));
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const result = await first.json() as { versionId: string; docxUploadId: string; sha256: string; sequence: number };
    assert.equal(result.sequence, 1);
    const version = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: result.versionId } });
    assert.equal(version.artifactId, `document:${submission.id}`); assert.equal(version.fileAssetId, result.docxUploadId); assert.ok(version.sourceHtml?.includes("data:image/png;base64,"));
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: result.docxUploadId } });
    const bytes = await readFile(path.join(outputDirectory, file.storageKey));
    assert.equal(bytes.subarray(0, 2).toString(), "PK"); assert.equal(createHash("sha256").update(bytes).digest("hex"), result.sha256);
    const retry = await finalize(request("document-first"));
    assert.equal(retry.status, 200); assert.equal((await retry.json()).versionId, result.versionId);
    assert.equal((await finalize(request("document-first", 2))).status, 409);
    assert.equal((await finalize(request("document-stale", 1))).status, 409);
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: version.artifactId } }), 1);
    assert.equal((await readdir(outputDirectory)).length, 2);
    const archiveVersions = await listProjectDocumentVersions({ courseId: instance.id, studentId: alice.id, submissionId: logicalSubmissionId, stageKey: "make" });
    assert.equal(archiveVersions[0].id, result.versionId); assert.equal(archiveVersions[0].sourceVersion, 1);
    const receipt = await prisma.domainEvent.findFirstOrThrow({ where: { participationId: participation.id, eventType: "document_version_submitted" } });
    assert.equal(receipt.researchKey, enrollment.researchKey);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { participationId: participation.id, eventType: "submit", researchKey: enrollment.researchKey } }), 1);
    console.log("PASS real authenticated DOCX finalization, FileAsset/ArtifactVersion binding, digest, receipt idempotency and stale-draft rejection");

    const documentRequests = await import("../src/lib/ai-collaboration/document-request-store");
    const documentInput = { requestId: "canonical-document-verification", courseId: instance.id, studentId: alice.id,
      participationId: participation.id, stageKey: "make", workspaceKind: "document", conversationId: "canonical-document-logical",
      threadStageKey: "make:canonical-document-verification", fingerprint: "canonical-document-verification-v1",
      documentVersion: "verification-version-1", message: "Synthetic document question", intent: "discuss", history: [] };
    const documentClaim = await documentRequests.claimDocumentRequest(documentInput);
    assert.equal(documentClaim.kind, "run");
    if (documentClaim.kind !== "run") throw new Error("Expected fresh isolated document claim");
    const documentQuestion = companion.companionMessage({ role: "student", content: documentInput.message,
      conversationId: documentInput.conversationId, visibility: "student-and-teacher" });
    const documentAnswer = companion.companionMessage({ role: "agent", content: "Synthetic document answer",
      conversationId: documentInput.conversationId, visibility: "student-and-teacher" });
    const documentResponse = { requestId: documentInput.requestId,
      result: { kind: "discussion", message: "Retained structured result" },
      messages: [documentQuestion, documentAnswer], commentThread: { comments: [documentAnswer] } };
    const policyKey = "canonical-document-policy-verification";
    const documentCompletion = { ...documentInput, token: documentClaim.token,
      messages: [documentQuestion, documentAnswer], response: documentResponse,
      auditEvents: [{ idempotencyKey: policyKey, eventType: "policy", actor: "system" as const, content: "",
        payload: { schemaVersion: 1, legacy: { stageKey: "make", source: "document" }, detail: { allowed: true } } }] };
    // A late policy-insert failure must roll back earlier canonical messages,
    // their reference facts and the completion receipt in the same transaction.
    await prisma.aiInteractionEvent.create({ data: { idempotencyKey: policyKey, offeringId: offering.id,
      userId: alice.id, participationId: participation.id, researchKey: enrollment.researchKey,
      eventType: "policy", actor: "system" } });
    await assert.rejects(() => documentRequests.completeDocumentRequest(documentCompletion), (error: { code: string }) => error.code === "P2002");
    const documentTaskId = documentRequests.documentTaskId(participation.id, documentInput.requestId);
    assert.equal(await prisma.aiMessage.count({ where: { id: { in: [documentQuestion.id, documentAnswer.id] } } }), 0);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: documentTaskId } }), 0);
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: documentTaskId } })).status, "RUNNING");
    await prisma.aiInteractionEvent.delete({ where: { idempotencyKey: policyKey } });
    assert.equal(await documentRequests.completeDocumentRequest(documentCompletion), true);
    assert.equal(await documentRequests.completeDocumentRequest(documentCompletion), false);
    const completedDocumentTask = await prisma.aiTask.findUniqueOrThrow({ where: { id: documentTaskId } });
    const savedDocumentOutput = completedDocumentTask.output as Prisma.JsonObject;
    assert.equal(savedDocumentOutput.schemaVersion, 2);
    assert.equal(JSON.stringify(savedDocumentOutput).includes(documentQuestion.content), false);
    assert.equal(JSON.stringify(savedDocumentOutput).includes(documentAnswer.content), false);
    assert.deepEqual((savedDocumentOutput.response as Prisma.JsonObject).result, documentResponse.result);
    const canonicalFacts = await prisma.aiInteractionEvent.findMany({ where: { taskId: documentTaskId, eventType: { in: ["request", "response"] } } });
    assert.equal(canonicalFacts.length, 2);
    assert.ok(canonicalFacts.every(row => row.content === null && (row.payload as Prisma.JsonObject).schemaVersion === 2));
    assert.deepEqual(new Set(canonicalFacts.map(row => ((row.payload as Prisma.JsonObject).detail as Prisma.JsonObject).messageId)), new Set([documentQuestion.id, documentAnswer.id]));
    assert.equal(await prisma.aiMessage.count({ where: { conversationId: completedDocumentTask.conversationId! } }), 2);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: documentTaskId, eventType: "policy" } }), 1);
    assert.deepEqual(await documentRequests.readDocumentRequestReceipt(documentInput), { status: 200, body: documentResponse });
    const documentRetry = await documentRequests.claimDocumentRequest(documentInput);
    assert.equal(documentRetry.kind, "existing");
    if (documentRetry.kind === "existing") assert.deepEqual(documentRetry.state.response, documentResponse);
    const canonicalRead = await audit.listAiInteractionEvents({ courseId: instance.id, studentId: alice.id, stageKey: "make" });
    assert.equal(canonicalRead.events.find(row => row.requestId === documentInput.requestId && row.eventType === "request")?.content, documentQuestion.content);
    assert.equal(canonicalRead.events.find(row => row.requestId === documentInput.requestId && row.eventType === "response")?.content, documentAnswer.content);
    console.log("PASS real document canonical messages/reference facts, atomic policy rollback, compact receipt hydration, original-request retry and audit-reader compatibility without model calls");

    const { exportOfferingResearch } = await import("../src/lib/platform/research-export");
    const teacherClaims: AuthClaims = { sub: teacher.id, role: "teacher", username: teacher.username, displayName: teacher.displayName, sv: teacher.sessionVersion };
    const exportPages = async (type: "ai" | "domain", includeContent: boolean) => {
      const exported: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await exportOfferingResearch(teacherClaims, offering.id, { type, take: "1", includeContent: String(includeContent), ...(cursor ? { cursor } : {}) });
        exported.push(...page.rows); cursor = page.nextCursor; pages += 1;
      } while (cursor);
      assert.ok(pages > 1, "Verify the actual cursor across multiple database pages");
      assert.equal(new Set(exported.map(row => row.id)).size, exported.length);
      return exported;
    };
    const aiExport = await exportPages("ai", false);
    assert.equal(aiExport.length, await prisma.aiInteractionEvent.count({ where: { offeringId: offering.id } }));
    assert.ok(aiExport.every(row => row.researchKey === enrollment.researchKey && !("userId" in row) && !("payload" in row) && !("content" in row)));
    const domainExport = await exportPages("domain", false);
    assert.equal(domainExport.length, await prisma.domainEvent.count({ where: { offeringId: offering.id } }));
    assert.ok(domainExport.some(row => row.eventType === "companion_confirmation_changed"));
    assert.ok(domainExport.some(row => row.eventType === "document_version_submitted"));
    assert.ok(domainExport.every(row => !("actorId" in row) && !("payload" in row)));
    assert.ok((await exportPages("ai", true)).some(row => row.content === "Verification confirmed"));
    assert.ok((await exportPages("domain", true)).every(row => "payload" in row));
    console.log("PASS real AI/domain research export pagination, complete category coverage and opt-in content whitelist");

    const { projectGroupStorageId, resolveProjectGroupId } = await import("../src/lib/platform/group-identity");
    const { createShowcaseStore, showcaseStore } = await import("../src/lib/showcase/persistence");
    const { executeShowcaseAction, getShowcaseData } = await import("../src/lib/showcase/presentation-service");
    const { POST: uploadArtifact } = await import("../src/app/api/courses/[courseId]/showcase/artifacts/pdf/route");
    const secondOffering = await prisma.courseOffering.create({ data: { name: "Second collaboration class", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const secondEnrollment = await prisma.enrollment.create({ data: { offeringId: secondOffering.id, userId: alice.id } });
    const secondChapter = await prisma.chapter.create({ data: { offeringId: secondOffering.id, title: "Second research", position: 0, isOpen: true } });
    const secondActivity = await prisma.activity.create({ data: { chapterId: secondChapter.id, title: "Second practice", type: "CLASSROOM", position: 0, isOpen: true } });
    const secondInstance = await prisma.classroomInstance.create({ data: { activityId: secondActivity.id, templateVersionId: templateVersion.id, status: "TEACHING", runtimeConfig: { version: 1, currentStageIndex: 2 } } });
    const secondParticipation = await prisma.classroomParticipation.create({ data: { instanceId: secondInstance.id, enrollmentId: secondEnrollment.id } });
    const alias = `grp-${alice.id}`;
    const store = createShowcaseStore();
    for (const scope of [{ offering, instance, participation }, { offering: secondOffering, instance: secondInstance, participation: secondParticipation }]) {
      const groupId = projectGroupStorageId(scope.offering.id, alias);
      await prisma.projectGroup.create({ data: { id: groupId, offeringId: scope.offering.id, name: "Personal project", members: { create: { userId: alice.id, participationId: scope.participation.id } } } });
      assert.equal((await store.findMember({ where: { courseId: scope.instance.id, studentId: alice.id } }))?.groupId, alias);
      const form = new FormData();
      form.set("file", new File(["Verification external artifact"], "verification.txt", { type: "text/plain" }));
      form.set("title", "Personal project evidence"); form.set("requestId", randomUUID());
      const upload = await uploadArtifact(new Request(`http://localhost/api/courses/${scope.instance.id}/showcase/artifacts/pdf`, { method: "POST", headers: { origin: "http://localhost", cookie: `${token.cookieName}=${token.token}`, "x-openpbl-role": "student" }, body: form }), { params: Promise.resolve({ courseId: scope.instance.id }) });
      assert.equal(upload.status, 201, JSON.stringify(await upload.clone().json()));
      const uploaded = await upload.json() as { versionId: string };
      const uploadedVersion = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: uploaded.versionId }, include: { artifact: true } });
      assert.equal(uploadedVersion.artifact.groupId, groupId);
      assert.equal((await store.listFiles({ where: { courseId: scope.instance.id, studentId: alice.id } }))[0].groupId, alias);
      const documentVersion = scope.instance.id === instance.id ? version : await prisma.artifactVersion.create({ data: { artifact: { create: { participationId: scope.participation.id, groupId, title: "Second document", type: "DOCUMENT_ARCHIVE", status: "SUBMITTED" } }, sequence: 1, sourceHtml: "<p>Second class evidence</p>", status: "SUBMITTED", submittedAt: new Date() } });
      await prisma.classroomInstance.update({ where: { id: scope.instance.id }, data: { runtimeConfig: { version: 1, currentStageIndex: 3 } } });
      await executeShowcaseAction(scope.instance.id, { action: "assign", groupId: alias, studentId: alice.id }, teacherClaims);
      if (scope.instance.id === secondInstance.id) await assert.rejects(() => executeShowcaseAction(scope.instance.id, { action: "start", studentId: alice.id, artifactKind: "document", artifactVersionId: version.id, displayMode: "continuous" }, teacherClaims), (error: { code: string }) => error.code === "ARTIFACT_NOT_LATEST");
      await assert.rejects(() => executeShowcaseAction(scope.instance.id, { action: "start", studentId: alice.id, artifactKind: "document", artifactVersionId: documentVersion.id, displayMode: "continuous" }, claims), (error: { code: string }) => error.code === "FORBIDDEN");
      const requested = await executeShowcaseAction(scope.instance.id, { action: "start", studentId: alice.id, artifactKind: "document", artifactVersionId: documentVersion.id, displayMode: "continuous" }, teacherClaims);
      assert.ok("id" in requested); assert.ok("groupId" in requested && requested.groupId === alias);
      const storedPresentation = await prisma.showcasePresentation.findUniqueOrThrow({ where: { id: requested.id } });
      assert.equal(storedPresentation.groupId, groupId); assert.equal(storedPresentation.artifactVersionId, documentVersion.id);
      assert.equal(storedPresentation.status.toLowerCase(), "active");
      assert.equal((storedPresentation.content as { reviewedBy?: string }).reviewedBy, teacher.id);
      await assert.rejects(() => executeShowcaseAction(scope.instance.id, { action: "end", presentationId: requested.id }, claims), (error: { code: string }) => error.code === "FORBIDDEN");
      await executeShowcaseAction(scope.instance.id, { action: "end", presentationId: requested.id }, teacherClaims);
      await executeShowcaseAction(scope.instance.id, { action: "finish-evaluation", presentationId: requested.id }, teacherClaims);
    }
    assert.notEqual(projectGroupStorageId(offering.id, alias), projectGroupStorageId(secondOffering.id, alias));
    assert.equal(await resolveProjectGroupId(prisma, secondOffering.id, projectGroupStorageId(offering.id, alias)), null);
    console.log("PASS same student in two offerings: personal group aliases, uploaded artifact FKs and full document showcase lifecycle");

    // Compare complete responses with the previous broad database reads, not
    // only a list of selected keys. The reference still executes real SQL in
    // this marked disposable database and retains every historical row.
    const { createPblTemplateCourse, decodePblTemplate } = await import("../src/lib/platform/pbl-template");
    const showcaseObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const previousCourseRead = async (query: { where?: Record<string, unknown> }) => {
      const row = await prisma.classroomInstance.findUnique({ where: { id: String(query.where?.id ?? "") }, include: { templateVersion: true } });
      if (!row) return null;
      const config = showcaseObject(row.runtimeConfig);
      const design = createPblTemplateCourse(row.id, decodePblTemplate(row.templateVersion.snapshot) ?? {});
      return { ...design, ...config, id: row.id, status: row.status.toLowerCase(), currentStageIndex: Number(config.currentStageIndex ?? 0),
        version: Number(config.version ?? 1), name: design.name, stages: config.stages ?? design.stages, uiState: config.uiState ?? design.uiState ?? {},
        presentingGroupId: typeof config.presentingGroupId === "string" ? config.presentingGroupId : null,
        presentingStudentId: typeof config.presentingStudentId === "string" ? config.presentingStudentId : null };
    };
    const previousReadDb = {
      artifactVersion: { findMany: (query: Prisma.ArtifactVersionFindManyArgs) => prisma.artifactVersion.findMany({ where: query.where,
        include: { artifact: { include: { participation: { include: { enrollment: true } } } }, fileAsset: { select: { mimeType: true } } } }) },
      showcasePresentation: { findMany: (query: Prisma.ShowcasePresentationFindManyArgs) => prisma.showcasePresentation.findMany({ where: query.where,
        include: { participation: { include: { enrollment: true } } } }) },
    };
    const previousStore = createShowcaseStore(previousReadDb as unknown as Prisma.TransactionClient);
    const originalReads = { loadCourse: showcaseStore.loadCourse, listFiles: showcaseStore.listFiles, listPresentations: showcaseStore.listPresentations, listDocuments: showcaseStore.listDocuments };
    const withPreviousReads = async <T>(read: () => Promise<T>, exportBodies = false) => {
      Object.assign(showcaseStore, { loadCourse: previousCourseRead, listFiles: previousStore.listFiles, listPresentations: previousStore.listPresentations,
        ...(exportBodies ? { listDocuments: (query: Parameters<typeof store.listDocuments>[0]) => store.listDocuments({ ...query, select: { ...query.select, sourceHtml: true } }) } : {}) });
      try { return await read(); }
      finally { Object.assign(showcaseStore, originalReads); }
    };
    const historyAt = new Date("2026-01-01T00:00:00Z");
    const privateHtml = "<p>Preserved historical document evidence.</p>".repeat(4096);
    const nextDocument = await prisma.artifactVersion.create({ data: { artifactId: version.artifactId, sequence: 2, sourceHtml: privateHtml,
      status: "SUBMITTED", submittedAt: new Date((version.submittedAt?.getTime() ?? Date.now()) + 1) } });
    const cancelled = await prisma.showcasePresentation.create({ data: { artifactId: version.artifactId, artifactVersionId: version.id,
      participationId: participation.id, groupId: projectGroupStorageId(offering.id, alias), status: "CANCELLED", createdAt: historyAt, updatedAt: historyAt,
      content: { artifactKind: "document", artifactTitle: "Retained cancelled history", revision: 1, evaluationNote: "Private teacher evidence" } } });
    await prisma.classroomParticipation.update({ where: { id: participation.id }, data: { stageProgress: { research: "Unneeded showcase relation data. ".repeat(4096) } } });
    const filesBefore = await previousStore.listFiles({ where: { courseId: instance.id }, orderBy: { sequence: "desc" } });
    assert.deepEqual(await store.listFiles({ where: { courseId: instance.id }, orderBy: { sequence: "desc" } }), filesBefore);
    const presentationsBefore = await previousStore.listPresentations({ where: { courseId: instance.id }, orderBy: { updatedAt: "desc" } });
    assert.deepEqual(await store.listPresentations({ where: { courseId: instance.id }, orderBy: { updatedAt: "desc" } }), presentationsBefore);
    assert.ok(presentationsBefore.some(row => row.id === cancelled.id), "Full adapter history must retain cancelled records");
    const gateSelect = { id: true, status: true, currentStageIndex: true, stages: true, presentingGroupId: true, presentingStudentId: true, uiState: true, content: true } as const;
    const fullPrevious = await previousCourseRead({ where: { id: instance.id } });
    assert.ok(fullPrevious);
    assert.deepEqual(await store.loadCourse({ where: { id: instance.id }, select: gateSelect }),
      Object.fromEntries(Object.keys(gateSelect).map(key => [key, fullPrevious[key as keyof typeof fullPrevious]])));
    for (const actor of [teacherClaims, claims, otherClaims]) {
      assert.deepEqual(await getShowcaseData(instance.id, actor), await withPreviousReads(() => getShowcaseData(instance.id, actor)));
    }
    const studentShowcase = await getShowcaseData(instance.id, otherClaims);
    assert.ok(!JSON.stringify(studentShowcase).includes("Private teacher evidence"));
    assert.ok(!JSON.stringify(studentShowcase).includes(privateHtml));
    assert.equal((await prisma.artifactVersion.findUniqueOrThrow({ where: { id: nextDocument.id } })).sourceHtml, privateHtml);
    assert.ok(JSON.stringify((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: participation.id } })).stageProgress).length > 64 * 1024);
    // These reads use no design or permission cache: draft edits and an open
    // transaction must be visible, including fields outside the read gate.
    const contextGateSelect = { id: true, name: true, content: true, version: true } as const;
    await prisma.classroomTemplateVersion.update({ where: { id: draftContextVersion.id }, data: { snapshot: contextSnapshot("Showcase draft one") } });
    assert.equal((await store.loadCourse({ where: { id: contextInstance.id }, select: contextGateSelect }))?.content.knowledgePoints[0].name, "Showcase draft one");
    await prisma.classroomTemplateVersion.update({ where: { id: draftContextVersion.id }, data: { snapshot: contextSnapshot("Showcase draft two") } });
    assert.equal((await store.loadCourse({ where: { id: contextInstance.id }, select: contextGateSelect }))?.content.knowledgePoints[0].name, "Showcase draft two");
    await prisma.$transaction(async tx => {
      await tx.classroomTemplateVersion.update({ where: { id: draftContextVersion.id }, data: { snapshot: contextSnapshot("Showcase transaction draft") } });
      assert.equal((await createShowcaseStore(tx).loadCourse({ where: { id: contextInstance.id }, select: contextGateSelect }))?.content.knowledgePoints[0].name, "Showcase transaction draft");
    });
    const { GET: readShowcaseArtifact } = await import("../src/app/api/courses/[courseId]/showcase/artifacts/[versionId]/route");
    const { GET: exportShowcase } = await import("../src/app/api/courses/[courseId]/showcase/artifacts/export/route");
    const { signTeacherToken } = await import("../src/lib/auth/session");
    const teacherToken = await signTeacherToken({ teacherId: teacher.id, username: teacher.username, displayName: teacher.displayName, sessionVersion: teacher.sessionVersion });
    const otherToken = await signStudentToken({ userId: bob.id, studentName: bob.displayName, sessionVersion: bob.sessionVersion });
    const artifactRequest = (cookie: { cookieName: string; token: string }, courseId: string, artifactVersionId: string, role = "student") =>
      new Request(`http://localhost/api/courses/${courseId}/showcase/artifacts/${artifactVersionId}`, { headers: { cookie: `${cookie.cookieName}=${cookie.token}`, "x-openpbl-role": role } });
    const artifactParams = { params: Promise.resolve({ courseId: instance.id, versionId: nextDocument.id }) };
    const actualDocument = await readShowcaseArtifact(artifactRequest(token, instance.id, nextDocument.id), artifactParams);
    assert.equal(actualDocument.status, 200);
    assert.equal((await actualDocument.json()).html, privateHtml, "Metadata narrowing must not alter the actual archived body");
    assert.equal((await readShowcaseArtifact(artifactRequest(otherToken, instance.id, nextDocument.id), artifactParams)).status, 404);
    assert.equal((await readShowcaseArtifact(artifactRequest(token, secondInstance.id, nextDocument.id), { params: Promise.resolve({ courseId: secondInstance.id, versionId: nextDocument.id }) })).status, 404);
    const exportRequest = () => new Request(`http://localhost/api/courses/${instance.id}/showcase/artifacts/export`, { headers: { cookie: `${teacherToken.cookieName}=${teacherToken.token}`, "x-openpbl-role": "teacher" } });
    const { default: JSZip } = await import("jszip");
    const archiveEntries = async (response: Response) => {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      return Promise.all(Object.values(zip.files).filter(entry => !entry.dir).sort((a, b) => a.name.localeCompare(b.name)).map(async entry => [entry.name,
        entry.name === "成果清单.txt" ? (await entry.async("string")).replace(/导出时间：[^\n]*/, "导出时间：[runtime]") : (await entry.async("nodebuffer")).toString("base64"),
      ]));
    };
    const exportContext = { params: Promise.resolve({ courseId: instance.id }) };
    assert.deepEqual(await archiveEntries(await exportShowcase(exportRequest(), exportContext)),
      await archiveEntries(await withPreviousReads(() => exportShowcase(exportRequest(), exportContext), true)));
    // The export route explicitly authenticates the teacher cookie. A student
    // cookie is rejected at authentication, before its defensive role check.
    assert.equal((await exportShowcase(artifactRequest(token, instance.id, nextDocument.id), exportContext)).status, 401);
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "WITHDRAWN" } });
    try {
      await assert.rejects(() => getShowcaseData(instance.id, claims), (error: { code: string; status: number }) => error.code === "FORBIDDEN" && error.status === 403);
      assert.equal((await readShowcaseArtifact(artifactRequest(token, instance.id, nextDocument.id), artifactParams)).status, 403);
    } finally { await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "ACTIVE" } }); }
    console.log("PASS real showcase broad/narrow full-response/ZIP equality, complete history, original artifact bytes, private evidence, draft/transaction freshness and immediate revocation");

    for (const operation of [() => prisma.user.delete({ where: { id: alice.id } }), () => prisma.classroomParticipation.delete({ where: { id: participation.id } }), () => prisma.aiConversation.delete({ where: { id: thread!.id } }), () => prisma.artifact.delete({ where: { id: version.artifactId } }), () => prisma.fileAsset.delete({ where: { id: result.docxUploadId } })]) {
      await assert.rejects(operation, (error: { code: string }) => error.code === "P2003");
    }
    assert.equal(await prisma.artifactVersion.count({ where: { id: result.versionId } }), 1);
    assert.equal((await prisma.aiMessage.findUniqueOrThrow({ where: { id: message.id } })).content, message.content);
    console.log("PASS research delete restrictions retain AI conversation/message and submitted artifact evidence");
  } finally {
    try { await prisma.$disconnect(); }
    finally { if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true }); }
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Collaboration verification failed"); process.exitCode = 1; });
