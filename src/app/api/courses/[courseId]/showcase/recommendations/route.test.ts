// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), access: vi.fn(), rate: vi.fn(), recommendations: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/auth/read-api-boundary", () => ({ withReadApiBoundary: (fn: unknown) => fn, readApiMethodNotAllowed: () => new Response(null, { status: 405 }), readApiOptionsFor: () => () => new Response(null, { status: 204 }) }));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({ checkDistributedRateLimit: mocks.rate }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: () => true }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/showcase/presentation-service", () => ({ ShowcasePresentationError: class extends Error { constructor(public code: string, message: string, public status: number) { super(message); } } }));
vi.mock("@/lib/showcase/recommendation-service", () => ({ getShowcaseRecommendations: mocks.recommendations }));
import { GET, POST } from "./route";
import { ShowcasePresentationError } from "@/lib/showcase/presentation-service";
const context = { params: Promise.resolve({ courseId: "course" }) };
const request = (method = "GET") => new Request("http://localhost/api/courses/course/showcase/recommendations", { method });
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ claims: { role: "teacher", sub: "teacher" } }); mocks.csrf.mockReturnValue(null);
  mocks.access.mockResolvedValue(true); mocks.rate.mockResolvedValue({ allowed: true }); mocks.recommendations.mockResolvedValue({ targetCount: 3, candidates: [] });
});

it("requires teacher authentication and makes GET a private read without enqueueing", async () => {
  const result = await GET(request(), context);
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "teacher");
  expect(mocks.recommendations).toHaveBeenCalledWith("course", { role: "teacher", sub: "teacher" }, false);
  expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.access).not.toHaveBeenCalled();
});

it("protects task creation with same-origin, live write access and rate limits", async () => {
  mocks.csrf.mockReturnValueOnce(new Response(null, { status: 403 }));
  expect((await POST(request("POST"), context)).status).toBe(403);
  expect(mocks.auth).not.toHaveBeenCalled();
  mocks.access.mockResolvedValueOnce(false);
  expect((await POST(request("POST"), context)).status).toBe(403);
  expect(mocks.recommendations).not.toHaveBeenCalled();
  expect((await POST(request("POST"), context)).status).toBe(200);
  expect(mocks.recommendations).toHaveBeenCalledWith("course", expect.anything(), true);
});

it("does not read recommendations when authentication fails and propagates live course revocation", async () => {
  mocks.auth.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) });
  expect((await GET(request(), context)).status).toBe(401);
  expect(mocks.recommendations).not.toHaveBeenCalled();
  mocks.recommendations.mockRejectedValueOnce(new ShowcasePresentationError("FORBIDDEN", "revoked", 403));
  expect((await GET(request(), context)).status).toBe(403);
});

it("reports analysis infrastructure failures as nonblocking fallback guidance", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.recommendations.mockRejectedValueOnce(new Error("queue down"));
  const result = await POST(request("POST"), context);
  expect(result.status).toBe(503); expect((await result.json()).message).toContain("自行选择学生");
  log.mockRestore();
});
