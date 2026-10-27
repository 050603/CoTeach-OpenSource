import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: vi.fn() }));
vi.mock("@/lib/platform/repository", () => ({ getStudentActivity: mocks.read, archiveActivity: vi.fn(), updateActivity: vi.fn(), PlatformError: class extends Error {} }));
import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "student", role: "student" } });
  mocks.read.mockResolvedValue({ id: "activity" });
});

describe("student activity background refresh", () => {
  it.each([["", false], ["?refresh=1", true], ["?refresh=true", false]])("handles %s without changing default visit behavior", async (query, refresh) => {
    const response = await GET(new Request(`http://localhost/api/platform/activities/activity${query}`), { params: Promise.resolve({ activityId: "activity" }) });
    expect(mocks.read).toHaveBeenCalledWith({ sub: "student", role: "student" }, "activity", { refresh });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("authenticates refresh requests before reading classroom state", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    const response = await GET(new Request("http://localhost/api/platform/activities/activity?refresh=1"), { params: Promise.resolve({ activityId: "activity" }) });
    expect(response.status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
