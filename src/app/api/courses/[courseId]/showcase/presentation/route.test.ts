// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/observability/logger";
import { ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER, NODE_HTTP_RECEIVED_HEADER } from "@/lib/observability/action-entry-timing";
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  canAccess: vi.fn(async () => true),
  executeShowcaseAction: vi.fn(),
  getShowcaseData: vi.fn(),
  updateShowcaseViewport: vi.fn(),
  isDatabaseConfigured: vi.fn(),
  checkDistributedRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: vi.fn(async () => ({ claims: { sub: "teacher-1", role: "teacher" as const } })),
  requireSameOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.isDatabaseConfigured }));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({ checkDistributedRateLimit: mocks.checkDistributedRateLimit }));
vi.mock("@/lib/showcase/presentation-service", () => ({
  executeShowcaseAction: mocks.executeShowcaseAction,
  getShowcaseData: mocks.getShowcaseData,
  updateShowcaseViewport: mocks.updateShowcaseViewport,
  ShowcasePresentationError: class ShowcasePresentationError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } },
}));

vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.canAccess }));

import { DELETE, GET, OPTIONS, PATCH, POST, PUT } from "./route";

import { ShowcasePresentationError } from "@/lib/showcase/presentation-service";

const courseId = "course-1";
const context = { params: Promise.resolve({ courseId }) };

function request(body: unknown) {
  return new Request(`http://localhost:3000/api/courses/${courseId}/showcase/presentation`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("showcase presentation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDatabaseConfigured.mockReturnValue(true);
    mocks.checkDistributedRateLimit.mockResolvedValue({ allowed: true });
    mocks.executeShowcaseAction.mockResolvedValue({ ok: true });
  });

  it("delegates GET live authorization to the service and propagates revocation", async () => {
    mocks.getShowcaseData.mockResolvedValueOnce({ queue: [] });
    const response = await GET(new Request("http://localhost/showcase"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.canAccess).not.toHaveBeenCalled();
    mocks.getShowcaseData.mockRejectedValueOnce(new ShowcasePresentationError("FORBIDDEN", "revoked", 403));
    expect((await GET(new Request("http://localhost/showcase"), context)).status).toBe(403);
  });

  it("keeps the original authentication gate ahead of reads, commands and automatic method responses", async () => {
    vi.stubEnv("JWT_SECRET", "showcase-boundary-regression-secret-at-least-32-bytes");
    try {
      const incoming = (method: string) => new Request(`http://localhost/api/courses/${courseId}/showcase/presentation`, { method });
      expect((await GET(incoming("GET"), context)).status).toBe(401);
      expect((await POST(incoming("POST"), context)).status).toBe(401);
      for (const [method, endpoint] of [["OPTIONS", OPTIONS], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE]] as const) {
        expect((await endpoint(incoming(method), context)).status).toBe(401);
      }
      expect(mocks.getShowcaseData).not.toHaveBeenCalled();
      expect(mocks.executeShowcaseAction).not.toHaveBeenCalled();
      expect(mocks.canAccess).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records the fixed GET route and entry clocks without changing the private snapshot", async () => {
    const snapshot = { queue: [{ studentId: "student-1" }], presentations: [] };
    mocks.getShowcaseData.mockResolvedValueOnce(snapshot);
    const started = Date.now() - 60;
    const response = await GET(new Request(`http://localhost/api/courses/${courseId}/showcase/presentation`, { headers: {
      [NODE_HTTP_RECEIVED_HEADER]: String(started), [ACTION_PROXY_STARTED_HEADER]: String(started + 10), [ACTION_PROXY_ENDED_HEADER]: String(started + 30),
    } }), context);
    expect(response.headers.get("Server-Timing")).toMatch(/node-dispatch;dur=10\.00.*proxy;dur=20\.00.*handler;dur=/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ route: "/api/courses/:courseId/showcase/presentation", method: "GET", status: 200, nodeHttpReceivedAtMs: started }), "request completed");
    expect(mocks.canAccess).not.toHaveBeenCalled();
  });

  it("accepts the optional empty evaluation note and dispatches the action", async () => {
    const response = await POST(request({ action: "finish-evaluation", presentationId: "11111111-1111-4111-8111-111111111111", note: "  " }), context);
    expect(response.status).toBe(200);
    expect(mocks.executeShowcaseAction).toHaveBeenCalledWith(courseId, {
      action: "finish-evaluation",
      presentationId: "11111111-1111-4111-8111-111111111111",
      note: "",
    }, expect.anything());
  });

  it("accepts a null note for clients that omit the optional record", async () => {
    const response = await POST(request({ action: "finish-evaluation", presentationId: "11111111-1111-4111-8111-111111111111", note: null }), context);
    expect(response.status).toBe(200);
    expect(mocks.executeShowcaseAction).toHaveBeenCalledWith(courseId, {
      action: "finish-evaluation",
      presentationId: "11111111-1111-4111-8111-111111111111",
      note: null,
    }, expect.anything());
  });

  it("rejects an overlong evaluation note before touching the service", async () => {
    const response = await POST(request({ action: "finish-evaluation", presentationId: "11111111-1111-4111-8111-111111111111", note: "x".repeat(2_001) }), context);
    expect(response.status).toBe(400);
    expect(mocks.executeShowcaseAction).not.toHaveBeenCalled();
  });

  it("accepts a teacher-started projection with an explicit student and artifact", async () => {
    const response = await POST(request({ action: "start", studentId: "student-1", artifactKind: "pdf", artifactVersionId: "artifact-1", displayMode: "slides" }), context);
    expect(response.status).toBe(200);
    expect(mocks.executeShowcaseAction).toHaveBeenCalledWith(courseId, {
      action: "start",
      studentId: "student-1",
      artifactKind: "pdf",
      artifactVersionId: "artifact-1",
      displayMode: "slides",
    }, expect.anything());
  });

  it("no longer accepts student projection requests", async () => {
    const response = await POST(request({ action: "request", artifactKind: "document", artifactVersionId: "artifact-1", displayMode: "continuous" }), context);
    expect(response.status).toBe(400);
    expect(mocks.executeShowcaseAction).not.toHaveBeenCalled();
  });

  it("validates viewport revisions and uses a separate high frequency limit", async () => {
    const body = { presentationId: "presentation", clientId: "window", controlEpoch: 2, sequence: 4, displayMode: "slides", viewState: { page: 8, pageOffset: 0.5 } };
    mocks.updateShowcaseViewport.mockResolvedValueOnce({ status: "active", revision: 5 });
    const incoming = (value: unknown) => new Request(`http://localhost:3000/api/courses/${courseId}/showcase/presentation`, { method: "PATCH", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(value) });
    expect((await PATCH(incoming(body), context)).status).toBe(200);
    expect(mocks.updateShowcaseViewport).toHaveBeenCalledWith(courseId, body, expect.anything());
    expect(mocks.checkDistributedRateLimit).toHaveBeenCalledWith(expect.objectContaining({ namespace: "showcase-viewport", limit: 300 }));
    expect((await PATCH(incoming({ ...body, viewState: { scrollRatio: 2 } }), context)).status).toBe(400);
    expect(mocks.updateShowcaseViewport).toHaveBeenCalledOnce();
  });
});
