// Run only via verify-research-database.mjs against its disposable database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.username, "postgres");
  assert.equal(target.password, "");
  assert.equal(target.pathname, "/postgres");
  assert.ok(target.port);
  process.env.OPENPBL_COURSE_READ_WORKERS = "0";
  const { prisma: db } = await import("../src/lib/db/client");
  try {
    const matching = await db.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(matching.length, 1);
    const { hashPassword, verifyPassword } = await import("../src/lib/auth/password");
    const service = await import("../src/lib/platform/student-password-recovery");
    const { hasCurrentSessionVersion } = await import("../src/lib/auth/session-version");
    const { registerStudent } = await import("../src/lib/platform/repository");
    const password = "initial-password-2026";
    const student = await db.user.create({ data: { username: "reset-student", usernameKey: "reset-student", displayName: "Reset Student", passwordHash: await hashPassword(password), recoveryCodeHash: "retired-digest" } });
    const teacher = await db.user.create({ data: { username: "reset-teacher", usernameKey: "reset-teacher", displayName: "Reset Teacher", role: "TEACHER", passwordHash: "unusable" } });
    const teacherClaims = { sub: teacher.id, role: "teacher" as const, username: teacher.username, displayName: teacher.displayName, sv: 1 };
    const studentClaims = { sub: student.id, role: "student" as const, studentName: student.displayName, sv: 1 };
    const offering = await db.courseOffering.create({ data: { name: "Reset regression fixture", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const enrollment = await db.enrollment.create({ data: { userId: student.id, offeringId: offering.id } });
    await assert.rejects(service.getTeacherStudentPasswordResetRequest(teacherClaims, "wrong-offering", enrollment.id), { code: "NOT_FOUND" });
    const requested = await service.createStudentPasswordResetRequest(" ＲＥＳＥＴ－ＳＴＵＤＥＮＴ ", student.displayName);
    assert.equal(requested.request.state, "pending");
    const stored = await db.studentPasswordResetRequest.findUniqueOrThrow({ where: { id: requested.request.id } });
    assert.notEqual(stored.requestHash, requested.browserToken);
    assert(!("requestHash" in requested.request));
    assert.equal((await service.getStudentPasswordResetRequest(requested.browserToken))?.state, "pending");
    await assert.rejects(service.createStudentPasswordResetRequest(student.username, student.displayName), { code: "RESET_ALREADY_REQUESTED" });
    assert.equal((await service.createStudentPasswordResetRequest(student.username, student.displayName, requested.browserToken)).request.id, requested.request.id);
    await assert.rejects(service.completeStudentPasswordReset(requested.browserToken, "new-password-2026"), { code: "RESET_NOT_APPROVED" });
    await assert.rejects(service.completeStudentPasswordReset("a".repeat(64), "new-password-2026"), { code: "RESET_NOT_APPROVED" });
    console.log("PASS browser-bound application, no takeover by a second browser, and no reset before teacher approval");

    const approved = await service.updateTeacherStudentPasswordResetRequest(teacherClaims, offering.id, enrollment.id, requested.request.id, "approve");
    const repeated = await service.updateTeacherStudentPasswordResetRequest(teacherClaims, offering.id, enrollment.id, requested.request.id, "approve");
    assert.equal(approved.expiresAt.getTime(), repeated.expiresAt.getTime());
    assert(approved.expiresAt.getTime() <= Date.now() + 600_000);
    await db.passwordResetToken.create({ data: { userId: student.id, tokenHash: createHash("sha256").update("retired-link").digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => service.completeStudentPasswordReset(requested.browserToken, "new-password-2026")));
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    const updated = await db.user.findUniqueOrThrow({ where: { id: student.id } });
    assert.equal(updated.sessionVersion, 2);
    assert(await verifyPassword("new-password-2026", updated.passwordHash));
    assert.equal(updated.recoveryCodeHash, null);
    assert.equal(await hasCurrentSessionVersion(studentClaims), false);
    assert.equal(await db.passwordResetToken.count({ where: { userId: student.id, usedAt: null } }), 0);
    assert.equal((await service.getStudentPasswordResetRequest(requested.browserToken))?.state, "used");
    console.log("PASS eight concurrent approved resets yield one success; password, session invalidation and retired credentials persisted");

    const cancelled = await service.createStudentPasswordResetRequest(student.username, student.displayName);
    await service.updateTeacherStudentPasswordResetRequest(teacherClaims, offering.id, enrollment.id, cancelled.request.id, "cancel");
    await assert.rejects(service.completeStudentPasswordReset(cancelled.browserToken, "other-password-2026"), { code: "RESET_NOT_APPROVED" });
    const expired = await service.createStudentPasswordResetRequest(student.username, student.displayName);
    await service.updateTeacherStudentPasswordResetRequest(teacherClaims, offering.id, enrollment.id, expired.request.id, "approve");
    await db.studentPasswordResetRequest.update({ where: { id: expired.request.id }, data: { expiresAt: new Date(0) } });
    await assert.rejects(service.completeStudentPasswordReset(expired.browserToken, "other-password-2026"), { code: "RESET_NOT_APPROVED" });
    const revoked = await service.createStudentPasswordResetRequest(student.username, student.displayName);
    await service.updateTeacherStudentPasswordResetRequest(teacherClaims, offering.id, enrollment.id, revoked.request.id, "approve");
    await db.courseTeacher.deleteMany({ where: { offeringId: offering.id } });
    await assert.rejects(service.completeStudentPasswordReset(revoked.browserToken, "other-password-2026"), { code: "RESET_REQUEST_INVALID" });
    console.log("PASS cancelled, expired and no-longer-authorized teacher approvals cannot change a password");

    await db.courseInvitation.create({ data: { offeringId: offering.id, code: "ABC123" } });
    const registration = await registerStudent({ invitationCode: "ABC123", username: "fresh-student", displayName: "Fresh Student", password });
    assert(!("recoveryCode" in registration));
    assert.equal(registration.user.recoveryCodeHash, null);
    assert.equal(await db.enrollment.count({ where: { userId: registration.user.id } }), 1);
    console.log("PASS registration returns directly to the course contract without issuing a recovery code");
  } finally { await db.$disconnect(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
