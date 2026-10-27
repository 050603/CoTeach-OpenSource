// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { logger } from "@/lib/observability/logger";
import { ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER, NODE_HTTP_RECEIVED_HEADER } from "@/lib/observability/action-entry-timing";
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  claims: {
    sub: "student-1",
    role: "student" as const,
    courseId: "11111111-1111-4111-8111-111111111111",
    studentId: "student-1",
    studentName: "测试学生",
    sv: 1,
  },
  getRedisClient: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  access: vi.fn(), telemetry: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: vi.fn(async () => ({ claims: mocks.claims })),
  requireSameOrigin: vi.fn(() => null),
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: mocks.getRedisClient,
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    classroomParticipation: {
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/observability/pending-save-reports", async original => ({ ...await original<typeof import('@/lib/observability/pending-save-reports')>(), recordPendingSaveReport: mocks.telemetry }));

import { DELETE, GET, PUT } from "./route";

const courseId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ courseId }) };

function request(method: string) {
  return new Request(`http://localhost:3000/api/courses/${courseId}/presence`, {
    method,
    headers: { Origin: "http://localhost:3000" },
  });
}

describe("course presence database fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedisClient.mockResolvedValue(null);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.access.mockResolvedValue(true);
  });

  it("persists a student heartbeat when Redis is unavailable", async () => {
    const response = await PUT(request("PUT"), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ online: true, degraded: true, source: "database" });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { instanceId: courseId, enrollment: { userId: "student-1" } },
      data: { lastEnteredAt: expect.any(Date) },
    });
  });

  it("uses the database when Redis disconnects at runtime", async () => {
    mocks.getRedisClient.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const response = await PUT(request("PUT"), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ online: true, degraded: true, source: "database" });
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("returns only database heartbeats that have not expired", async () => {
    mocks.findMany.mockResolvedValue([
      { enrollment: { user: { id: "student-1", displayName: "在线学生" } } },
    ]);

    const response = await GET(request("GET"), context);
    const payload = await response.json();

    expect(payload).toMatchObject({ degraded: true, source: "database" });
    expect(payload.members).toEqual([
      { id: "student-1", role: "student", name: "在线学生" },
    ]);
  });

  it("clears the database heartbeat on an explicit leave", async () => {
    const response = await DELETE(request("DELETE"), context);

    expect(response.status).toBe(204);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { instanceId: courseId, enrollment: { userId: "student-1" } },
      data: { lastEnteredAt: expect.any(Date) },
    });
  });

  it("binds diagnostics to verified actor/course and keeps malformed diagnostics out of heartbeat results", async () => {
    const body = { actorId: 'forged', courseId: 'forged', pendingSaves: { clientId: 'browser-profile-123456', known: true, count: 2, oldestCreatedAt: Date.now() - 90_000 } };
    const response = await PUT(new Request(`http://localhost:3000/api/courses/${courseId}/presence`, { method: 'PUT', body: JSON.stringify(body) }), context);
    expect(response.status).toBe(200);
    expect(mocks.telemetry).toHaveBeenCalledWith('student-1', courseId, body.pendingSaves);
    const malformed = await PUT(new Request(`http://localhost:3000/api/courses/${courseId}/presence`, { method: 'PUT', body: '{' }), context);
    expect(malformed.status).toBe(200);
    expect(mocks.telemetry).toHaveBeenLastCalledWith('student-1', courseId, undefined);
    mocks.access.mockResolvedValue(false); mocks.telemetry.mockClear();
    expect((await PUT(request('PUT'), context)).status).toBe(403); expect(mocks.telemetry).not.toHaveBeenCalled();
  });
});


describe("presence write boundary guards", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.getRedisClient.mockResolvedValue(null);
    mocks.updateMany.mockResolvedValue({ count: 1 }); mocks.access.mockResolvedValue(true);
  });
  it.each(["PUT", "DELETE"])("times %s with fixed labels while keeping its real heartbeat/leave result", async method => {
    const now = Date.now();
    const handler = method === "PUT" ? PUT : DELETE;
    const response = await handler(new Request(`http://localhost:3000/api/courses/${courseId}/presence`, { method, headers: {
      Origin: "http://localhost:3000", [NODE_HTTP_RECEIVED_HEADER]: String(now - 100),
      [ACTION_PROXY_STARTED_HEADER]: String(now - 90), [ACTION_PROXY_ENDED_HEADER]: String(now - 80),
    } }), context);
    expect(response.status).toBe(method === "PUT" ? 200 : 204);
    expect(response.headers.get("Server-Timing")).toContain("node-dispatch;dur=10.00");
    expect(mocks.access).toHaveBeenCalledWith(mocks.claims, courseId, "write");
    expect(mocks.updateMany).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenLastCalledWith(expect.objectContaining({ method, route: "/api/courses/:courseId/presence",
      nodeHttpReceivedAtMs: now - 100, nextProxyStartedAtMs: now - 90, nextProxyEndedAtMs: now - 80,
    }), "request completed");
    if (method === "PUT") expect(await response.json()).toMatchObject({ online: true, degraded: true });
    else expect(await response.text()).toBe("");
  });
  it.each(["PUT", "DELETE"])("keeps CSRF, identity and class access guards before any %s persistence", async method => {
    const handler = method === "PUT" ? PUT : DELETE;
    const csrfDenied = new Response("Cross-origin", { status: 403 });
    vi.mocked(requireSameOrigin).mockReturnValueOnce(csrfDenied);
    expect(await handler(request(method), context)).toBe(csrfDenied);
    expect(authenticateRequest).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled(); expect(mocks.getRedisClient).not.toHaveBeenCalled();
    const unauthenticated = new Response("Unauthorized", { status: 401 });
    vi.mocked(authenticateRequest).mockResolvedValueOnce({ response: unauthenticated });
    expect(await handler(request(method), context)).toBe(unauthenticated);
    expect(mocks.access).not.toHaveBeenCalled(); expect(mocks.updateMany).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue(false);
    expect((await handler(request(method), context)).status).toBe(403);
    expect(mocks.updateMany).not.toHaveBeenCalled(); expect(mocks.getRedisClient).not.toHaveBeenCalled();
    expect(mocks.telemetry).not.toHaveBeenCalled();
  });
});
