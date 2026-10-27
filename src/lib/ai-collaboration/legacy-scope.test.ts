import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({ user: vi.fn(), instance: vi.fn(), participation: vi.fn(), query: vi.fn(), authenticate: vi.fn(), csrf: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: mocks.query, classroomInstance: { findUnique: mocks.instance }, classroomParticipation: { findFirst: mocks.participation } } }));
vi.mock("@/lib/platform/access", () => ({ getPlatformUser: mocks.user }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.authenticate, requireSameOrigin: mocks.csrf }));
import { authorizeLegacyAiScope, authenticateLegacyAiStudent } from "./legacy-scope";
const claims = { sub: "user", role: "student", sv: 1 } as AuthClaims;
const instance = () => ({ id: "instance", status: "TEACHING", activity: { archivedAt: null, chapter: { offering: { id: "offering", status: "OPEN", teachers: [{ userId: "teacher" }] } } } });
const studentScope = () => ({ id: "user", role: "STUDENT", status: "ACTIVE", sessionVersion: 1,
  instanceId: "instance", instanceStatus: "TEACHING", offeringStatus: "OPEN", archivedAt: null as Date | null,
  participationId: "participation", enrollmentStatus: "ACTIVE" });
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "user", role: "student" }); mocks.instance.mockResolvedValue(instance());
  mocks.participation.mockResolvedValue({ id: "participation", enrollment: { status: "ACTIVE" } }); mocks.authenticate.mockResolvedValue({ claims });
  mocks.query.mockResolvedValue([studentScope()]);
});
describe("legacy classroom identity bridge", () => {
  it("uses the JWT subject with the instance instead of requiring old course/student claims", async () => {
    const result = await authenticateLegacyAiStudent(new Request("http://localhost/api", { method: "POST" }), "instance", "user");
    expect(result).toMatchObject({ studentId: "user", participationId: "participation" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0].slice(1)).toEqual(["instance", "user"]);
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.instance).not.toHaveBeenCalled(); expect(mocks.participation).not.toHaveBeenCalled();
  });
  it("rejects requests attempting to impersonate another student", async () => {
    await expect(authorizeLegacyAiScope(claims, "instance", "other")).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
    expect(mocks.participation).not.toHaveBeenCalled();
  });
  it("requires an actual participation even if a user has an account", async () => {
    mocks.participation.mockResolvedValue(null);
    await expect(authorizeLegacyAiScope(claims, "instance", "user")).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
  });
  it("allows classroom history reads after class ends while denying writes", async () => {
    const row = instance(); row.status = "ENDED"; mocks.instance.mockResolvedValue(row);
    await expect(authorizeLegacyAiScope(claims, "instance", "user")).resolves.toHaveProperty("participation");
    await expect(authorizeLegacyAiScope(claims, "instance", "user", true)).rejects.toMatchObject({ code: "COURSE_LOCKED" });
  });
  it("restricts teacher monitoring to assigned offerings", async () => {
    mocks.user.mockResolvedValue({ id: "other-teacher", role: "teacher" });
    await expect(authorizeLegacyAiScope({ sub: "other-teacher", role: "teacher" } as AuthClaims, "instance")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("enforces same-origin before authenticating write requests", async () => {
    mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
    const response = await authenticateLegacyAiStudent(new Request("http://localhost/api", { method: "POST" }), "instance", "user");
    expect(response).toBeInstanceOf(Response); expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    ["account removed", null, "UNAUTHENTICATED", 401],
    ["account disabled", { status: "DISABLED" }, "UNAUTHENTICATED", 401],
    ["role changed", { role: "TEACHER" }, "UNAUTHENTICATED", 401],
    ["session revoked after cookie check", { sessionVersion: 2 }, "UNAUTHENTICATED", 401],
    ["classroom absent", { instanceId: null }, "COURSE_NOT_FOUND", 404],
    ["membership absent or withdrawn", { participationId: null }, "STUDENT_SCOPE_MISMATCH", 403],
  ])("fresh student scope rejects %s", async (_label, changes, error, status) => {
    mocks.query.mockResolvedValue(changes === null ? [] : [{ ...studentScope(), ...changes }]);
    const response = await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "user");
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(status);
    expect(await (response as Response).json()).toMatchObject({ error });
  });

  it("does not reuse a prior successful authorization for a later request", async () => {
    mocks.query.mockResolvedValueOnce([studentScope()]).mockResolvedValueOnce([{ ...studentScope(), participationId: null }]);
    expect(await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "")).toMatchObject({ studentId: "user" });
    expect((await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "")) as Response).toHaveProperty("status", 403);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("rejects a different requested student without exposing their participation", async () => {
    const response = await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "another-user") as Response;
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: "STUDENT_SCOPE_MISMATCH" });
  });

  it.each([
    { instanceStatus: "FINISHED" }, { offeringStatus: "CLOSED" },
    { archivedAt: new Date("2026-01-01T00:00:00Z") }, { enrollmentStatus: "COMPLETED" },
  ])("retains history but blocks writes in locked scope %j", async changes => {
    mocks.query.mockResolvedValue([{ ...studentScope(), ...changes }]);
    expect(await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "user")).toMatchObject({ participationId: "participation" });
    const response = await authenticateLegacyAiStudent(new Request("http://localhost/api", { method: "POST" }), "instance", "user") as Response;
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "COURSE_LOCKED" });
  });

  it("does not run a scope query after a rejected cookie or teacher role", async () => {
    const expired = Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    mocks.authenticate.mockResolvedValueOnce({ response: expired });
    expect(await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "user")).toBe(expired);
    mocks.authenticate.mockResolvedValueOnce({ claims: { ...claims, role: "teacher" } });
    expect(await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "user")).toHaveProperty("status", 403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("reports database unavailability without authorizing from an old result", async () => {
    mocks.query.mockRejectedValue(new Error("private connection details"));
    const response = await authenticateLegacyAiStudent(new Request("http://localhost/api"), "instance", "user") as Response;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATABASE_UNAVAILABLE", message: "课堂数据暂时不可用，请重试" });
  });
});
