import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/experiment-access-service", () => ({ getClassroomPosttestAccess: mocks.get, setClassroomPosttestAccess: mocks.set }));
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ instanceId: "run" }) };
const claims = { role: "teacher", sub: "teacher" };
const request = (body: unknown) => new Request("http://localhost/api/platform/classroom-instances/run/experiment/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims }); mocks.csrf.mockReturnValue(null); });

it("requires teacher authentication and same-origin writes", async () => {
  mocks.auth.mockResolvedValue({ response: new Response(null, { status: 403 }) });
  expect((await GET(new Request("http://localhost/access"), context)).status).toBe(403);
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "teacher");
  mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
  expect((await POST(request({ status: "open", version: 0 }), context)).status).toBe(403);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.set).not.toHaveBeenCalled();
});

it("passes the observed lifecycle version to the teacher mutation", async () => {
  mocks.set.mockResolvedValue({ contractVersion: 2, access: { status: "open", version: 3 } });
  const result = await POST(request({ status: "open", version: 2 }), context);
  expect(result.status).toBe(200);
  expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.set).toHaveBeenCalledWith(claims, "run", { status: "open", version: 2 });
});

it.each([{ status: "open" }, { status: "open", version: -1 }, { status: "open", version: 0, studentId: "other" }])("rejects invalid lifecycle mutations %j", async (body) => {
  expect((await POST(request(body), context)).status).toBe(400);
  expect(mocks.set).not.toHaveBeenCalled();
});
