// Run only through verify-research-database.mjs against its marked disposable DB.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthClaims } from "../src/lib/auth/session";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/postgres");
  assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.ok(target.port);
  process.env.PROVIDER_CONFIG_DATABASE_URL = process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  const { prisma } = await import("../src/lib/db/client");
  const directory = await mkdtemp(path.join(tmpdir(), "openpbl-research-export-"));
  try {
    const verification = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(verification.length, 1, "Database must carry this run's disposable marker");
    const { exportOfferingResearch } = await import("../src/lib/platform/research-export");
    const user = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role, passwordHash: "unusable-isolated-fixture" } });
    const teacher = await user("export-teacher", "TEACHER");
    const alice = await user("export-alice");
    const bob = await user("export-bob");
    const outsider = await user("export-outsider");
    const offering = await prisma.courseOffering.create({ data: { name: "Formal research fixture", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const other = await prisma.courseOffering.create({ data: { name: "Other research fixture", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const enrollment = await prisma.enrollment.create({ data: { userId: alice.id, offeringId: offering.id } });
    const bobEnrollment = await prisma.enrollment.create({ data: { userId: bob.id, offeringId: offering.id } });
    const otherEnrollment = await prisma.enrollment.create({ data: { userId: alice.id, offeringId: other.id } });
    await prisma.enrollment.create({ data: { userId: outsider.id, offeringId: other.id } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "Formal", position: 0 } });
    const otherChapter = await prisma.chapter.create({ data: { offeringId: other.id, title: "Other", position: 0 } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "Classroom", type: "CLASSROOM", position: 0 } });
    const otherActivity = await prisma.activity.create({ data: { chapterId: otherChapter.id, title: "Other classroom", type: "CLASSROOM", position: 0 } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: "Research" } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: { title: "Immutable fixture" } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "FINISHED" } });
    const otherInstance = await prisma.classroomInstance.create({ data: { activityId: otherActivity.id, templateVersionId: version.id } });
    const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
    const bobParticipation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: bobEnrollment.id } });
    const foreignParticipation = await prisma.classroomParticipation.create({ data: { instanceId: otherInstance.id, enrollmentId: otherEnrollment.id } });
    const malformed = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: otherEnrollment.id } });
    const conversation = async (id: string, userId: string, offeringId: string | null, participationId: string | null) => prisma.aiConversation.create({ data: {
      id, userId, offeringId, participationId, metadata: { feature: "lecture-chat", stageKey: "ai-learning", privateNote: "Synthetic private context" },
    } });
    const valid = await conversation("export-valid", alice.id, offering.id, participation.id);
    const nullOffering = await conversation("export-null-offering", alice.id, null, participation.id);
    const offeringOnly = await conversation("export-offering-only", alice.id, offering.id, null);
    const foreign = await conversation("export-foreign", alice.id, other.id, foreignParticipation.id);
    const badOwner = await conversation("export-wrong-owner", bob.id, offering.id, participation.id);
    const badEnrollment = await conversation("export-wrong-enrollment", alice.id, offering.id, malformed.id);
    const badClassroom = await conversation("export-wrong-classroom", alice.id, offering.id, foreignParticipation.id);
    const noMembership = await conversation("export-no-membership", outsider.id, offering.id, null);
    const explicitForeign = await conversation("export-explicit-foreign", alice.id, other.id, participation.id);
    const timestamp = new Date("2026-10-20T05:30:00.000Z");
    const message = (id: string, conversationId: string, userId: string | null = null) => prisma.aiMessage.create({ data: {
      id, conversationId, userId, role: userId ? "user" : "assistant", content: "Synthetic private answer: " + id, createdAt: timestamp,
      metadata: { visibility: "teacher-only", hiddenFromStudentAt: timestamp.toISOString(), privateOwner: alice.id },
    } });
    for (const [id, owner] of [["export-01-valid", valid], ["export-02-valid", valid], ["export-03-null-offering", nullOffering], ["export-04-offering-only", offeringOnly],
      ["export-05-foreign", foreign], ["export-06-bad-owner", badOwner], ["export-07-bad-enrollment", badEnrollment], ["export-08-bad-classroom", badClassroom],
      ["export-09-no-membership", noMembership], ["export-10-explicit-foreign", explicitForeign]] as const) await message(id, owner.id);
    await message("export-11-bad-message-owner", valid.id, bob.id);
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "WITHDRAWN" } });
    const claims: AuthClaims = { sub: teacher.id, role: "teacher", sv: teacher.sessionVersion };
    const query = { type: "ai_messages", since: "2026-10-20T00:00:00Z", until: "2026-10-21T00:00:00Z" };
    const all = await exportOfferingResearch(claims, offering.id, query);
    const expected = ["export-01-valid", "export-02-valid", "export-03-null-offering", "export-04-offering-only"];
    assert.deepEqual(all.rows.map(row => row.id), expected);
    assert.ok(all.rows.every(row => row.researchKey === enrollment.researchKey));
    const publicResult = JSON.stringify(all);
    for (const secret of ["Synthetic private", alice.id, valid.id, "privateOwner"]) assert.ok(!publicResult.includes(secret));
    assert.equal((all.rows[0] as { researchConversationKey: string }).researchConversationKey, (all.rows[1] as { researchConversationKey: string }).researchConversationKey);
    assert.equal((all.rows.at(-1) as { association: string; classroomInstanceId: string | null }).association, "offering_only");
    assert.equal((all.rows.at(-1) as { classroomInstanceId: string | null }).classroomInstanceId, null);
    const content = await exportOfferingResearch(claims, offering.id, { ...query, includeContent: "true" });
    assert.deepEqual(content.rows.map(row => row.id), expected);
    assert.ok(content.rows.every(row => "content" in row && typeof row.content === "string" && row.content.startsWith("Synthetic private")));
    assert.ok(content.rows.every(row => "metadata" in row && "conversationMetadata" in row));
    let page = await exportOfferingResearch(claims, offering.id, { ...query, take: "1" });
    const paged = page.rows.map(row => row.id);
    while (page.nextCursor) {
      page = await exportOfferingResearch(claims, offering.id, { type: "ai_messages", take: "1", cursor: page.nextCursor });
      paged.push(...page.rows.map(row => row.id));
    }
    assert.deepEqual(paged, expected);
    await assert.rejects(() => exportOfferingResearch({ sub: alice.id, role: "student", studentName: "Alice", sv: alice.sessionVersion }, offering.id, query), (error: { code: string }) => error.code === "FORBIDDEN");
    console.log("PASS real AI message SQL, strict joined ownership, null-offering/offering-only history, equal-time pagination and explicit content policy");

    const reference = { schemaVersion: 2, detail: { contentRef: "AiMessage", messageId: "export-01-valid" } };
    for (const [id, owner, participant] of [["export-event-valid", alice, participation], ["export-event-wrong-owner", bob, bobParticipation]] as const) {
      await prisma.aiInteractionEvent.create({ data: { id, idempotencyKey: id, offeringId: offering.id, userId: owner.id, participationId: participant.id, conversationId: valid.id, researchKey: enrollment.researchKey, eventType: "response", actor: "assistant", content: null, payload: reference } });
    }
    const ai = await exportOfferingResearch(claims, offering.id, { type: "ai", includeContent: "true" });
    assert.ok("content" in ai.rows[0]);
    const validEvent = ai.rows.find(row => row.id === "export-event-valid") as { content: string | null };
    const rejectedEvent = ai.rows.find(row => row.id === "export-event-wrong-owner") as { content: string | null; contentResolution: string };
    assert.equal(validEvent.content, "Synthetic private answer: export-01-valid");
    assert.equal(rejectedEvent.content, null);
    assert.equal(rejectedEvent.contentResolution, "message_reference_unresolved");
    console.log("PASS real referenced event content resolution and same-page mismatched-reference isolation");

    await prisma.aiTask.create({ data: { id: "export-pending", offeringId: offering.id, conversationId: valid.id, createdById: alice.id, taskType: "DOCUMENT_COLLABORATION", status: "PENDING" } });
    await prisma.aiTask.create({ data: { id: "export-null-offering-task", offeringId: null, conversationId: nullOffering.id, createdById: alice.id, taskType: "LECTURE_CHAT", status: "COMPLETED" } });
    await prisma.aiTask.create({ data: { id: "export-foreign-task", offeringId: other.id, conversationId: foreign.id, createdById: alice.id, taskType: "DOCUMENT_COLLABORATION", status: "PENDING" } });
    await prisma.activitySubmission.create({ data: { id: "export-submission", activityId: activity.id, enrollmentId: enrollment.id, researchKey: enrollment.researchKey, activityVersion: 1, activitySnapshot: { title: "Original" }, payload: { answer: "Synthetic submitted answer" } } });
    await prisma.activitySubmission.create({ data: { id: "export-cross-submission", activityId: otherActivity.id, enrollmentId: enrollment.id, researchKey: enrollment.researchKey, activityVersion: 1, activitySnapshot: {}, payload: { answer: "Excluded malformed submission" } } });
    const fixture = path.join(directory, "fixture.json");
    await writeFile(fixture, JSON.stringify({ offeringId: offering.id, otherOfferingId: other.id, userId: alice.id, otherUserId: outsider.id,
      enrollmentId: enrollment.id, instanceId: instance.id, conversations: [valid.id, nullOffering.id, offeringOnly.id],
      messages: [...expected, "export-11-bad-message-owner"], pendingTaskId: "export-pending" }));
    const integration = spawnSync("python3", ["tests/deploy/test_classroom_research_backup_db.py"], { encoding: "utf8", timeout: 90_000,
      env: { ...process.env, OPENPBL_RESEARCH_DB_INTEGRATION: "1", OPENPBL_RESEARCH_DB_FIXTURE: fixture } });
    if (integration.status !== 0 || integration.error) throw new Error(`Research package database verification failed: ${integration.error ?? ""}\n${integration.stdout}\n${integration.stderr}`);
    console.log(integration.stdout.trim());
    console.log(integration.stderr.trim());
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
