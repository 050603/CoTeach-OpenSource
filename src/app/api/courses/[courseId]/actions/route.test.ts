import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  executeCourseAction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  requireSameOrigin: () => null,
  authenticateRequest: async () => ({
    claims: {
      sub: "teacher-1",
      role: "teacher",
      username: "teacher",
      displayName: "教师",
      sv: 1,
    },
  }),
}));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({
  checkDistributedRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/courses/action-service", () => ({
  CourseActionError: class extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  },
  executeCourseAction: mocks.executeCourseAction,
}));
vi.mock("@/lib/observability/http", () => ({
  withHttpMetrics: (_method: string, _route: string, handler: unknown) => handler,
}));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: mocks.warn } }));

import { POST } from "./route";
import { CourseActionError } from "@/lib/courses/action-service";

const context = { params: Promise.resolve({ courseId: "course-1" }) };

describe("course action rate limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, retryAfterMs: 0 });
    mocks.executeCourseAction.mockResolvedValue({
      requestId: "018f47a2-89d4-7c12-a4f4-18f244f6ec0b",
      courseVersion: 2,
      eventCursor: "cursor",
    });
  });

  it("uses the independent 10-per-second projection bucket", async () => {
    const response = await POST(new Request(
      "http://localhost/api/courses/course-1/actions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({
          requestId: "018f47a2-89d4-7c12-a4f4-18f244f6ec0b",
          action: {
            type: "SET_UI_STATE",
            payload: { courseId: "course-1", projectionControl: { clientId: "tab", baseStageVersion: 1, stageKey: "launch" }, patch: { resourceProjection: null } },
          },
        }),
      },
    ), context);

    expect(response.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith({
      namespace: "course-projection",
      key: "teacher-1:course-1",
      limit: 20,
      windowSeconds: 2,
    });
  });

  it("logs rejected action identifiers without the classroom content or credentials", async () => {
    mocks.executeCourseAction.mockRejectedValue(new CourseActionError("FORBIDDEN", "无权修改此课堂", 403));
    const requestId = "018f47a2-89d4-7c12-a4f4-18f244f6ec0b";
    const response = await POST(new Request("http://localhost/api/courses/course-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": "http-request", authorization: "Bearer private-token" },
      body: JSON.stringify({ requestId, action: { type: "ADD_ACTIVITY", payload: {
        courseId: "course-1", activity: { id: "activity-1", actor: "私密教师", action: "投屏", detail: "私密教学正文", createdAt: "2026-10-19T08:46:03Z" },
      } } }),
    }), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN", requestId: "http-request" });
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith({
      event: "course-action-rejected", actionType: "ADD_ACTIVITY", errorCode: "FORBIDDEN", courseId: "course-1",
      requestId, httpRequestId: "http-request", status: 403,
    }, "Course action rejected");
  });
});
