import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), find: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findFirst: mocks.find } } }));
import { GET } from "./route";
describe("student profile", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requires a student session", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await GET(new Request("http://localhost/api/platform/auth/student-profile"))).status).toBe(401);
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("returns public account fields without password or legacy credential digests", async () => {
    mocks.auth.mockResolvedValue({ claims: { sub: "student-1" } });
    mocks.find.mockResolvedValue({ displayName: "小林", username: "lin", recoveryCodeHash: "legacy-private-digest", passwordHash: "private-password-digest" });
    const response = await GET(new Request("http://localhost/api/platform/auth/student-profile"));
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "student");
    expect(mocks.find).toHaveBeenCalledWith({ where: { id: "student-1", role: { in: ["STUDENT", "student"] }, status: { in: ["ACTIVE", "active"] } }, select: { displayName: true, username: true } });
    expect(await response.json()).toEqual({ user: { displayName: "小林", username: "lin", role: "student" } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("rejects accounts no longer available after session authentication", async () => {
    mocks.auth.mockResolvedValue({ claims: { sub: "student-1" } });
    mocks.find.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/api/platform/auth/student-profile"))).status).toBe(401);
  });
});
