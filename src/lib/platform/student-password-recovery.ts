import { createHash, randomBytes } from "node:crypto";
import type { StudentPasswordResetRequest } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { isValidNewPasswordLength, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { normalizeUsername, requireTeacherUser, type PlatformDb } from "./access";
import { PlatformError } from "./platform-error";

const activeStudent = { role: { in: ["STUDENT", "student"] }, status: { in: ["ACTIVE", "active"] } };
const enrolled = { in: ["ACTIVE", "active", "COMPLETED", "completed"] };
const activeRequest = { usedAt: null, cancelledAt: null };
export const RESET_REQUEST_SECONDS = 30 * 60;
const APPROVAL_SECONDS = 10 * 60;
export const RESET_BROWSER_SECONDS = RESET_REQUEST_SECONDS + APPROVAL_SECONDS;
const invalidRequest = () => new PlatformError("RESET_REQUEST_INVALID", "重置申请无效或已过期，请重新申请", 400);

function requestHash(token: string | undefined): string | null {
  return token && /^[a-f0-9]{64}$/.test(token) ? createHash("sha256").update(`student-reset-request:v1:${token}`).digest("hex") : null;
}

function requestState(row: StudentPasswordResetRequest, now = new Date()) {
  if (row.usedAt) return "used" as const;
  if (row.cancelledAt) return "cancelled" as const;
  if (row.expiresAt <= now) return "expired" as const;
  return row.approvedAt ? "approved" as const : "pending" as const;
}

function publicRequest(row: StudentPasswordResetRequest, user: { username: string; displayName: string }) {
  return { id: row.id, username: user.username, displayName: user.displayName, state: requestState(row), createdAt: row.createdAt, expiresAt: row.expiresAt, approvedAt: row.approvedAt };
}

export async function createStudentPasswordResetRequest(username: string, displayName: string, browserToken?: string) {
  const user = await prisma.user.findFirst({
    where: { usernameKey: normalizeUsername(username), displayName: displayName.normalize("NFC").trim(), ...activeStudent },
    select: { id: true, username: true, displayName: true },
  });
  if (!user) throw new PlatformError("INVALID_IDENTITY", "请核对学号和姓名，或联系任课教师", 400);
  const existingHash = requestHash(browserToken);
  return runMutationTransaction(async (tx) => {
    // One active browser request per account. An unauthenticated second browser
    // cannot replace a request which the teacher is currently checking.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    const currentUser = await tx.user.findFirst({ where: { id: user.id, ...activeStudent }, select: { id: true } });
    if (!currentUser) throw invalidRequest();
    const pending = await tx.studentPasswordResetRequest.findFirst({
      where: { userId: user.id, ...activeRequest, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" },
    });
    if (pending) {
      if (pending.requestHash === existingHash) return { request: publicRequest(pending, user), browserToken: browserToken! };
      throw new PlatformError("RESET_ALREADY_REQUESTED", "该账号已有重置申请，请在原申请页面继续；如无法返回，请教师取消后重新申请", 409);
    }
    const token = randomBytes(32).toString("hex");
    const row = await tx.studentPasswordResetRequest.create({ data: { userId: user.id, requestHash: requestHash(token)!, expiresAt: new Date(Date.now() + RESET_REQUEST_SECONDS * 1_000) } });
    return { request: publicRequest(row, user), browserToken: token };
  });
}

export async function getStudentPasswordResetRequest(browserToken?: string) {
  const hash = requestHash(browserToken);
  if (!hash) return null;
  const row = await prisma.studentPasswordResetRequest.findUnique({ where: { requestHash: hash }, include: { user: { select: { username: true, displayName: true, role: true, status: true } } } });
  if (!row || row.user.role.toLowerCase() !== "student" || row.user.status.toLowerCase() !== "active") return null;
  return publicRequest(row, row.user);
}

async function scopedStudent(claims: AuthClaims, offeringId: string, enrollmentId: string, db: PlatformDb = prisma) {
  const teacher = await requireTeacherUser(claims, db);
  const enrollment = await db.enrollment.findFirst({
    where: { id: enrollmentId, offeringId, status: enrolled, user: activeStudent, offering: { teachers: { some: { userId: teacher.id } } } },
    select: { userId: true, user: { select: { username: true, displayName: true } } },
  });
  if (!enrollment) throw new PlatformError("NOT_FOUND", "学生关系不存在或不属于你的教学班", 404);
  return { teacher, enrollment };
}

export async function getTeacherStudentPasswordResetRequest(claims: AuthClaims, offeringId: string, enrollmentId: string) {
  const { enrollment } = await scopedStudent(claims, offeringId, enrollmentId);
  const row = await prisma.studentPasswordResetRequest.findFirst({ where: { userId: enrollment.userId }, orderBy: { createdAt: "desc" } });
  return row ? publicRequest(row, enrollment.user) : null;
}

export async function updateTeacherStudentPasswordResetRequest(claims: AuthClaims, offeringId: string, enrollmentId: string, id: string, action: "approve" | "cancel") {
  return runMutationTransaction(async (tx) => {
    const { teacher, enrollment } = await scopedStudent(claims, offeringId, enrollmentId, tx);
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${enrollment.userId} FOR UPDATE`;
    const row = await tx.studentPasswordResetRequest.findFirst({ where: { id, userId: enrollment.userId } });
    if (!row) throw invalidRequest();
    const state = requestState(row);
    if (action === "approve" && state === "approved") return publicRequest(row, enrollment.user);
    if (state !== "pending" && state !== "approved") throw invalidRequest();
    const updated = await tx.studentPasswordResetRequest.update({
      where: { id: row.id },
      data: action === "cancel" ? { cancelledAt: new Date() } : { approvedAt: new Date(), approvedById: teacher.id, offeringId, expiresAt: new Date(Date.now() + APPROVAL_SECONDS * 1_000) },
    });
    return publicRequest(updated, enrollment.user);
  });
}

export async function completeStudentPasswordReset(browserToken: string | undefined, password: string) {
  if (!isValidNewPasswordLength(password)) throw new PlatformError("INVALID_INPUT", PASSWORD_LENGTH_HINT, 400);
  const hash = requestHash(browserToken);
  if (!hash) throw invalidRequest();
  const initial = await prisma.studentPasswordResetRequest.findUnique({ where: { requestHash: hash } });
  if (!initial || requestState(initial) !== "approved") throw new PlatformError("RESET_NOT_APPROVED", "请先提交申请并等待任课教师允许重置", 403);
  const passwordHash = await hashPassword(password);
  await runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${initial.userId} FOR UPDATE`;
    const row = await tx.studentPasswordResetRequest.findUnique({ where: { requestHash: hash } });
    if (!row || requestState(row) !== "approved" || !row.approvedById || !row.offeringId) throw invalidRequest();
    // Approval remains valid only while its teacher and enrollment still exist.
    const authorized = await tx.enrollment.findFirst({
      where: { userId: row.userId, offeringId: row.offeringId, status: enrolled, user: activeStudent,
        offering: { teachers: { some: { userId: row.approvedById, user: { role: { in: ["TEACHER", "teacher"] }, status: { in: ["ACTIVE", "active"] } } } } } },
      select: { id: true },
    });
    if (!authorized) throw invalidRequest();
    const now = new Date();
    const consumed = await tx.studentPasswordResetRequest.updateMany({
      where: { id: row.id, ...activeRequest, approvedAt: { not: null }, expiresAt: { gt: now } }, data: { usedAt: now },
    });
    if (consumed.count !== 1) throw invalidRequest();
    const changed = await tx.user.updateMany({ where: { id: row.userId, ...activeStudent }, data: { passwordHash, sessionVersion: { increment: 1 }, recoveryCodeHash: null } });
    if (changed.count !== 1) throw invalidRequest();
    await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } });
  });
  return { ok: true };
}
