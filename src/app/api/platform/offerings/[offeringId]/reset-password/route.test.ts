import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), readAuth: vi.fn(), findUser: vi.fn() }));
vi.mock("@/lib/platform/student-password-recovery", () => ({ getTeacherStudentPasswordResetRequest: mocks.get, updateTeacherStudentPasswordResetRequest: mocks.update }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/session")>(), readAuthFromRequest: mocks.readAuth,
}));
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique: mocks.findUser } } }));

import { GET, POST } from "./route";
import { PlatformError } from "@/lib/platform/platform-error";

const claims = { sub: "teacher-1", role: "teacher", username: "teacher", displayName: "教师", sv: 3 };
const publicRequest = { id: "request-1", username: "student1", displayName: "学生", state: "approved", createdAt: "2026-10-26T08:00:00Z", expiresAt: "2026-10-26T08:10:00Z", approvedAt: "2026-10-26T08:00:00Z" };
const context = { params: Promise.resolve({ offeringId: "offering-1" }) };
const body = { enrollmentId: "enrollment-1", requestId: "request-1", action: "approve" };
function getRequest(enrollmentId = "enrollment-1") {
  return new Request(`http://localhost/api/platform/offerings/offering-1/reset-password?enrollmentId=${enrollmentId}`);
}
function postRequest(data: unknown = body, origin: string | null = "http://localhost") {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (origin !== null) headers.set("Origin", origin);
  return new Request("http://localhost/api/platform/offerings/offering-1/reset-password", { method: "POST", headers, body: JSON.stringify(data) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readAuth.mockResolvedValue(claims);
  mocks.findUser.mockResolvedValue({ role: "TEACHER", status: "ACTIVE", sessionVersion: 3 });
  mocks.get.mockResolvedValue(publicRequest);
  mocks.update.mockResolvedValue(publicRequest);
});

describe("teacher password reset approval route", () => {
  it("reads the selected enrollment within the URL offering using a teacher session", async () => {
    const request = getRequest();
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(mocks.readAuth).toHaveBeenCalledWith(request, "teacher");
    expect(mocks.get).toHaveBeenCalledWith(claims, "offering-1", "enrollment-1");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ request: publicRequest });
  });

  it.each(["approve", "cancel"])("submits %s for the exact request in the selected course and never returns a link or browser credential", async (action) => {
    const response = await POST(postRequest({ ...body, action }), context);
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(claims, "offering-1", "enrollment-1", "request-1", action);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ request: publicRequest });
  });

  it("requires a teacher cookie on both read and approval", async () => {
    mocks.readAuth.mockResolvedValue(null);
    expect((await GET(getRequest(), context)).status).toBe(401);
    expect((await POST(postRequest(), context)).status).toBe(401);
    for (const call of mocks.readAuth.mock.calls) expect(call[1]).toBe("teacher");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    { role: "TEACHER", status: "DISABLED", sessionVersion: 3 },
    { role: "STUDENT", status: "ACTIVE", sessionVersion: 3 },
    { role: "TEACHER", status: "ACTIVE", sessionVersion: 4 },
  ])("rejects revoked teacher sessions before accessing student requests", async (user) => {
    mocks.findUser.mockResolvedValue(user);
    expect((await GET(getRequest(), context)).status).toBe(401);
    expect((await POST(postRequest(), context)).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["https://unrelated.example", null])("rejects unsafe approval origin %s before authentication or mutation", async (origin) => {
    expect((await POST(postRequest(body, origin), context)).status).toBe(403);
    expect(mocks.readAuth).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("requires an enrollment to poll", async () => {
    expect((await GET(getRequest(""), context)).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([
    { enrollmentId: "enrollment-1" }, { ...body, requestId: "" }, { ...body, action: "generate-link" },
    { ...body, offeringId: "foreign-offering" }, { ...body, password: "teacher-selected-password" },
  ])("rejects incomplete approval and attempts to override course or select a password", async (data) => {
    expect((await POST(postRequest(data), context)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("preserves course scope and stale-request failures", async () => {
    mocks.get.mockRejectedValue(new PlatformError("NOT_FOUND", "学生关系不属于你的教学班", 404));
    const read = await GET(getRequest(), context);
    expect(read.status).toBe(404);
    await expect(read.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
    mocks.update.mockRejectedValue(new PlatformError("RESET_REQUEST_INVALID", "重置申请无效", 400));
    const write = await POST(postRequest(), context);
    expect(write.status).toBe(400);
    await expect(write.json()).resolves.toMatchObject({ code: "RESET_REQUEST_INVALID" });
  });
});
