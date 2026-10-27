import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), findUnique: vi.fn() },
  enrollment: { findFirst: vi.fn() },
  request: { findUnique: vi.fn(), findFirst: vi.fn() },
  hashPassword: vi.fn(),
  transaction: vi.fn(),
  tx: {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    enrollment: { findFirst: vi.fn() },
    studentPasswordResetRequest: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    passwordResetToken: { updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: { user: mocks.user, enrollment: mocks.enrollment, studentPasswordResetRequest: mocks.request } }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: mocks.hashPassword }));

import {
  completeStudentPasswordReset, createStudentPasswordResetRequest, getStudentPasswordResetRequest,
  getTeacherStudentPasswordResetRequest, updateTeacherStudentPasswordResetRequest,
} from "./student-password-recovery";

const now = new Date("2026-10-26T08:00:00Z");
const browserToken = "a1".repeat(32);
const requestHash = createHash("sha256").update(`student-reset-request:v1:${browserToken}`).digest("hex");
const student = { id: "student-1", username: "STUDENT1", displayName: "学生", role: "STUDENT", status: "ACTIVE" };
const teacher = { id: "teacher-1", role: "TEACHER", status: "ACTIVE" };
const claims: AuthClaims = { sub: teacher.id, role: "teacher", username: "teacher", displayName: "教师", sv: 3 };
const enrollment = { userId: student.id, user: { username: student.username, displayName: student.displayName } };
const activeStudent = { role: { in: ["STUDENT", "student"] }, status: { in: ["ACTIVE", "active"] } };
const enrolled = { in: ["ACTIVE", "active", "COMPLETED", "completed"] };
const pending = {
  id: "request-1", userId: student.id, requestHash, createdAt: now, expiresAt: new Date(now.getTime() + 30 * 60_000),
  approvedAt: null, approvedById: null, offeringId: null, cancelledAt: null, usedAt: null,
};
const approved = { ...pending, approvedAt: now, approvedById: teacher.id, offeringId: "offering-1", expiresAt: new Date(now.getTime() + 10 * 60_000) };
const invalid = { code: "RESET_REQUEST_INVALID", status: 400 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  mocks.user.findFirst.mockResolvedValue(student);
  mocks.user.findUnique.mockResolvedValue(teacher);
  mocks.tx.user.findFirst.mockResolvedValue({ id: student.id });
  mocks.tx.user.findUnique.mockResolvedValue(teacher);
  mocks.enrollment.findFirst.mockResolvedValue(enrollment);
  mocks.tx.enrollment.findFirst.mockResolvedValue(enrollment);
  mocks.request.findUnique.mockResolvedValue(approved);
  mocks.request.findFirst.mockResolvedValue(pending);
  mocks.tx.studentPasswordResetRequest.findUnique.mockResolvedValue(approved);
  mocks.tx.studentPasswordResetRequest.findFirst.mockResolvedValue(null);
  mocks.tx.studentPasswordResetRequest.create.mockImplementation(async ({ data }) => ({ ...pending, ...data }));
  mocks.tx.studentPasswordResetRequest.update.mockImplementation(async ({ data }) => ({ ...pending, ...data }));
  mocks.tx.studentPasswordResetRequest.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.user.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.hashPassword.mockResolvedValue("new-password-hash");
  mocks.transaction.mockImplementation((operation) => operation(mocks.tx));
});
afterEach(() => vi.useRealTimers());

function expectPublicRequest(value: unknown, state: string) {
  expect(value).toMatchObject({ id: pending.id, username: student.username, displayName: student.displayName, state });
  expect(Object.keys(value as object).sort()).toEqual(["approvedAt", "createdAt", "displayName", "expiresAt", "id", "state", "username"]);
}

function teacherScope() {
  return { where: {
    id: "enrollment-1", offeringId: "offering-1", status: enrolled, user: activeStudent,
    offering: { teachers: { some: { userId: teacher.id } } },
  }, select: { userId: true, user: { select: { username: true, displayName: true } } } };
}

const unavailableRequests = [
  ["pending", pending],
  ["expired", { ...approved, expiresAt: now }],
  ["cancelled", { ...approved, cancelledAt: now }],
  ["used", { ...approved, usedAt: now }],
] as const;

describe("browser-bound student reset applications", () => {
  it("checks student identity, locks the account, and persists only a digest of the random browser credential", async () => {
    const result = await createStudentPasswordResetRequest(" ＳＴＵＤＥＮＴ１ ", " 学生 ");
    expect(mocks.user.findFirst).toHaveBeenCalledWith({ where: { usernameKey: "student1", displayName: "学生", ...activeStudent }, select: { id: true, username: true, displayName: true } });
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join("")).toContain("FOR UPDATE");
    expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.studentPasswordResetRequest.findFirst.mock.invocationCallOrder[0]);
    expect(result.browserToken).toMatch(/^[a-f0-9]{64}$/);
    const stored = mocks.tx.studentPasswordResetRequest.create.mock.calls[0][0].data;
    expect(stored.requestHash).toBe(createHash("sha256").update(`student-reset-request:v1:${result.browserToken}`).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(result.browserToken);
    expectPublicRequest(result.request, "pending");
    const second = await createStudentPasswordResetRequest("student2", "学生");
    expect(second.browserToken).not.toBe(result.browserToken);
  });

  it("lets the original browser resume without creating a second application or extending its deadline", async () => {
    mocks.tx.studentPasswordResetRequest.findFirst.mockResolvedValue(approved);
    const result = await createStudentPasswordResetRequest(student.username, student.displayName, browserToken);
    expect(result.browserToken).toBe(browserToken);
    expect(result.request.expiresAt).toEqual(approved.expiresAt);
    expectPublicRequest(result.request, "approved");
    expect(mocks.tx.studentPasswordResetRequest.create).not.toHaveBeenCalled();
    expect(mocks.tx.studentPasswordResetRequest.update).not.toHaveBeenCalled();
  });

  it.each([undefined, "b2".repeat(32), "malformed"])("prevents another browser from replacing an active application (%s)", async (token) => {
    mocks.tx.studentPasswordResetRequest.findFirst.mockResolvedValue(pending);
    await expect(createStudentPasswordResetRequest(student.username, student.displayName, token)).rejects.toMatchObject({ code: "RESET_ALREADY_REQUESTED", status: 409 });
    expect(mocks.tx.studentPasswordResetRequest.create).not.toHaveBeenCalled();
    expect(mocks.tx.studentPasswordResetRequest.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown identity or account disabled before the locked recheck", async () => {
    mocks.user.findFirst.mockResolvedValueOnce(null);
    await expect(createStudentPasswordResetRequest("unknown", "学生")).rejects.toMatchObject({ code: "INVALID_IDENTITY" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    mocks.tx.user.findFirst.mockResolvedValueOnce(null);
    await expect(createStudentPasswordResetRequest(student.username, student.displayName)).rejects.toMatchObject(invalid);
    expect(mocks.tx.studentPasswordResetRequest.create).not.toHaveBeenCalled();
  });

  it.each([undefined, "invalid", "A".repeat(64)])("does not query requests without a valid browser credential (%s)", async (token) => {
    expect(await getStudentPasswordResetRequest(token)).toBeNull();
    expect(mocks.request.findUnique).not.toHaveBeenCalled();
  });

  it.each(unavailableRequests)("returns the %s state without exposing its credential", async (state, row) => {
    mocks.request.findUnique.mockResolvedValue({ ...row, user: student });
    const result = await getStudentPasswordResetRequest(browserToken);
    expect(mocks.request.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { requestHash } }));
    expectPublicRequest(result, state);
  });

  it.each([null, { ...approved, user: { ...student, status: "DISABLED" } }, { ...approved, user: { ...student, role: "TEACHER" } }])("hides missing and unavailable accounts", async (row) => {
    mocks.request.findUnique.mockResolvedValue(row);
    expect(await getStudentPasswordResetRequest(browserToken)).toBeNull();
  });
});

describe("teacher approval scope", () => {
  it("reads only the selected enrollment within this teacher's offering and returns public request fields", async () => {
    const result = await getTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1");
    expect(mocks.enrollment.findFirst).toHaveBeenCalledWith(teacherScope());
    expect(mocks.request.findFirst).toHaveBeenCalledWith({ where: { userId: student.id }, orderBy: { createdAt: "desc" } });
    expectPublicRequest(result, "pending");
  });

  it("does not read or approve students outside the teacher's course scope", async () => {
    mocks.enrollment.findFirst.mockResolvedValue(null);
    mocks.tx.enrollment.findFirst.mockResolvedValue(null);
    await expect(getTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(updateTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1", pending.id, "approve")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(mocks.request.findFirst).not.toHaveBeenCalled();
    expect(mocks.tx.studentPasswordResetRequest.update).not.toHaveBeenCalled();
  });

  it("rejects student claims and a teacher account that has been disabled", async () => {
    await expect(getTeacherStudentPasswordResetRequest({ sub: student.id, role: "student", studentName: "学生", sv: 1 }, "offering-1", "enrollment-1")).rejects.toThrow("FORBIDDEN");
    mocks.user.findUnique.mockResolvedValue({ ...teacher, status: "DISABLED" });
    await expect(getTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1")).rejects.toThrow("TEACHER_NOT_FOUND");
    expect(mocks.enrollment.findFirst).not.toHaveBeenCalled();
  });

  it("approves only the explicit request id for the selected student", async () => {
    mocks.tx.studentPasswordResetRequest.findFirst.mockResolvedValue(pending);
    const result = await updateTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1", pending.id, "approve");
    expect(mocks.tx.enrollment.findFirst).toHaveBeenCalledWith(teacherScope());
    expect(mocks.tx.studentPasswordResetRequest.findFirst).toHaveBeenCalledWith({ where: { id: pending.id, userId: student.id } });
    expect(mocks.tx.studentPasswordResetRequest.update).toHaveBeenCalledWith({ where: { id: pending.id }, data: {
      approvedAt: now, approvedById: teacher.id, offeringId: "offering-1", expiresAt: new Date(now.getTime() + 10 * 60_000),
    } });
    expectPublicRequest(result, "approved");
  });

  it("never substitutes the latest application for a stale or foreign request id", async () => {
    await expect(updateTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1", "stale-request", "approve")).rejects.toMatchObject(invalid);
    expect(mocks.tx.studentPasswordResetRequest.findFirst).toHaveBeenCalledWith({ where: { id: "stale-request", userId: student.id } });
    expect(mocks.tx.studentPasswordResetRequest.update).not.toHaveBeenCalled();
  });

  it("keeps repeated approval idempotent without extending the original expiry", async () => {
    mocks.tx.studentPasswordResetRequest.findFirst.mockResolvedValue(approved);
    vi.setSystemTime(new Date(now.getTime() + 5 * 60_000));
    const result = await updateTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1", pending.id, "approve");
    expect(result.expiresAt).toEqual(approved.expiresAt);
    expect(mocks.tx.studentPasswordResetRequest.update).not.toHaveBeenCalled();
  });

  it("allows cancellation of an approved application", async () => {
    mocks.tx.studentPasswordResetRequest.findFirst.mockResolvedValue(approved);
    await updateTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1", pending.id, "cancel");
    expect(mocks.tx.studentPasswordResetRequest.update).toHaveBeenCalledWith({ where: { id: pending.id }, data: { cancelledAt: now } });
  });

  it.each(unavailableRequests.slice(1))("rejects approval of a %s application", async (_state, row) => {
    mocks.tx.studentPasswordResetRequest.findFirst.mockResolvedValue(row);
    await expect(updateTeacherStudentPasswordResetRequest(claims, "offering-1", "enrollment-1", pending.id, "approve")).rejects.toMatchObject(invalid);
    expect(mocks.tx.studentPasswordResetRequest.update).not.toHaveBeenCalled();
  });
});

describe("completing an approved application", () => {
  it("consumes the approval once, updates the password/session version, and invalidates legacy credentials in one transaction", async () => {
    await expect(completeStudentPasswordReset(browserToken, "password123")).resolves.toEqual({ ok: true });
    expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.studentPasswordResetRequest.findUnique.mock.invocationCallOrder[0]);
    expect(mocks.tx.studentPasswordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { id: pending.id, usedAt: null, cancelledAt: null, approvedAt: { not: null }, expiresAt: { gt: now } }, data: { usedAt: now },
    });
    expect(mocks.tx.user.updateMany).toHaveBeenCalledWith({ where: { id: student.id, ...activeStudent }, data: { passwordHash: "new-password-hash", sessionVersion: { increment: 1 }, recoveryCodeHash: null } });
    expect(mocks.tx.passwordResetToken.updateMany).toHaveBeenCalledWith({ where: { userId: student.id, usedAt: null }, data: { usedAt: now } });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it.each(unavailableRequests)("refuses a %s application before hashing the password", async (_state, row) => {
    mocks.request.findUnique.mockResolvedValue(row);
    await expect(completeStudentPasswordReset(browserToken, "password123")).rejects.toMatchObject({ code: "RESET_NOT_APPROVED", status: 403 });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(unavailableRequests)("rechecks %s state after locking rather than trusting the initial approval", async (_state, row) => {
    mocks.tx.studentPasswordResetRequest.findUnique.mockResolvedValue(row);
    await expect(completeStudentPasswordReset(browserToken, "password123")).rejects.toMatchObject(invalid);
    expect(mocks.tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("rechecks current teacher ownership, active teacher/student status, and enrollment before consuming the application", async () => {
    mocks.tx.enrollment.findFirst.mockResolvedValue(null);
    await expect(completeStudentPasswordReset(browserToken, "password123")).rejects.toMatchObject(invalid);
    expect(mocks.tx.enrollment.findFirst).toHaveBeenCalledWith({ where: {
      userId: student.id, offeringId: "offering-1", status: enrolled, user: activeStudent,
      offering: { teachers: { some: { userId: teacher.id, user: { role: { in: ["TEACHER", "teacher"] }, status: { in: ["ACTIVE", "active"] } } } } },
    }, select: { id: true } });
    expect(mocks.tx.studentPasswordResetRequest.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("cannot change the password if another request wins the single-use compare-and-set", async () => {
    mocks.tx.studentPasswordResetRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(completeStudentPasswordReset(browserToken, "password123")).rejects.toMatchObject(invalid);
    expect(mocks.tx.user.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
  });

  it("fails the transaction if the student is disabled before the final password update", async () => {
    mocks.tx.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(completeStudentPasswordReset(browserToken, "password123")).rejects.toMatchObject(invalid);
    expect(mocks.tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
  });

  it.each([9, 257])("rejects password length %i before any credential access", async (length) => {
    await expect(completeStudentPasswordReset(browserToken, "p".repeat(length))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.request.findUnique).not.toHaveBeenCalled();
  });

  it.each([undefined, "bad-token"])("requires the browser credential (%s)", async (token) => {
    await expect(completeStudentPasswordReset(token, "password123")).rejects.toMatchObject(invalid);
    expect(mocks.request.findUnique).not.toHaveBeenCalled();
  });
});
