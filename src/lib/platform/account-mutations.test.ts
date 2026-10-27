import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    courseInvitation: { findUnique: vi.fn(), update: vi.fn() },
    enrollment: { findUnique: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn() },
    activityProgress: { createMany: vi.fn() },
  };
  return { tx, transaction: vi.fn(), student: vi.fn(), instance: vi.fn(), participation: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: {
  classroomInstance: { findUnique: mocks.instance },
  classroomParticipation: { upsert: mocks.participation },
} }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("./access", () => ({ requireStudentUser: mocks.student, normalizeUsername: (value: string) => value.toLowerCase(), requireTeacherUser: vi.fn() }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: vi.fn().mockResolvedValue("hash"), verifyPassword: vi.fn() }));

import { enterClassroom, joinOffering, registerStudent } from "./repository";
const claims = { sub: "student", role: "student" } as AuthClaims;
const invitation = {
  id: "invite", offeringId: "offering", status: "ACTIVE", disabledAt: null, expiresAt: null,
  maxUses: 1, useCount: 0,
  offering: { status: "OPEN", chapters: [{ activities: [{ id: "activity" }] }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((operation) => operation(mocks.tx));
  mocks.student.mockResolvedValue({ id: "student" });
  mocks.tx.courseInvitation.findUnique.mockResolvedValue(invitation);
  mocks.tx.enrollment.findUnique.mockResolvedValue(null);
  mocks.tx.enrollment.create.mockResolvedValue({ id: "enrollment", offeringId: "offering", status: "ACTIVE" });
  mocks.tx.user.findUnique.mockResolvedValue(null);
  mocks.tx.user.create.mockResolvedValue({ id: "student" });
});

describe("invitation mutations", () => {
  it("locks the invitation quota before registering a new student", async () => {
    await registerStudent({ invitationCode: "ABCDEF", username: "student", displayName: "Student", password: "password123" });
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join("")).toContain("FOR UPDATE");
    expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.courseInvitation.findUnique.mock.invocationCallOrder[0]);
    expect(mocks.tx.courseInvitation.update).toHaveBeenCalledWith({ where: { id: "invite" }, data: { useCount: { increment: 1 } } });
  });

  it("does not create a user after the final invitation use is consumed", async () => {
    mocks.tx.courseInvitation.findUnique.mockResolvedValue({ ...invitation, useCount: 1 });
    await expect(registerStudent({ invitationCode: "ABCDEF", username: "student", displayName: "Student", password: "password123" })).rejects.toMatchObject({ code: "INVITE_CODE_EXHAUSTED" });
    expect(mocks.tx.user.create).not.toHaveBeenCalled();
  });

  it("joins with enrollment, initial progress, and quota in one transaction", async () => {
    await expect(joinOffering(claims, "ABCDEF")).resolves.toEqual({ id: "enrollment", offeringId: "offering", status: "active" });
    expect(mocks.student).toHaveBeenCalledWith(claims, mocks.tx);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.tx.activityProgress.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ enrollmentId: "enrollment", activityId: "activity" })] });
    expect(mocks.tx.courseInvitation.update).toHaveBeenCalledOnce();
  });

  it("repeated joins succeed without spending an already exhausted invitation", async () => {
    mocks.tx.courseInvitation.findUnique.mockResolvedValue({ ...invitation, useCount: 1 });
    mocks.tx.enrollment.findUnique.mockResolvedValue({ id: "existing", offeringId: "offering", status: "ACTIVE" });
    await expect(joinOffering(claims, "ABCDEF")).resolves.toMatchObject({ id: "existing" });
    expect(mocks.tx.enrollment.create).not.toHaveBeenCalled();
    expect(mocks.tx.courseInvitation.update).not.toHaveBeenCalled();
  });
});

describe("classroom entry release rules", () => {
  it.each(["DRAFT", "draft"])("rejects an instance in a %s offering before creating participation", async (status) => {
    mocks.instance.mockResolvedValue({ status: "TEACHING", activity: { chapter: { offering: { status } } } });
    await expect(enterClassroom(claims, "instance")).rejects.toMatchObject({ code: "COURSE_NOT_OPEN" });
    expect(mocks.participation).not.toHaveBeenCalled();
  });

  it("rejects a locked chapter even if the classroom is teaching", async () => {
    mocks.instance.mockResolvedValue({ status: "TEACHING", activity: { isOpen: true, opensAt: null, archivedAt: null, chapter: { isOpen: false, opensAt: null, archivedAt: null, offering: { status: "OPEN" } } } });
    await expect(enterClassroom(claims, "instance")).rejects.toMatchObject({ code: "ACTIVITY_LOCKED" });
    expect(mocks.participation).not.toHaveBeenCalled();
  });
});


describe("shared new-password policy", () => {
  it.each([9, 257])("rejects %i characters before registration changes the database", async (length) => {
    const password = "p".repeat(length);
    await expect(registerStudent({ invitationCode: "ABCDEF", username: "student", displayName: "Student", password })).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
