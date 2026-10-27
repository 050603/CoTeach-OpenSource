import { describe, expect, it } from "vitest";
import { httpOperation } from "./http-operation";

describe("bounded HTTP operation categories", () => {
  it.each([
    ["GET", "/api/courses", 200, "read"],
    ["GET", "/api/courses/:courseId/public-discussion", 200, "read"],
    ["PUT", "/api/courses/:courseId/presence", 200, "write"],
    ["DELETE", "/api/courses/:courseId/presence", 204, "write"],
    ["GET", "/api/openmaic/classroom-media/:classroomId/:path", 206, "resource"],
    ["GET", "/_next/static/openpbl-runtime/monaco/:version/:fingerprint/:path", 200, "resource"],
    ["HEAD", "/_next/static/openpbl-runtime/monaco/:version/:fingerprint/:path", 304, "resource"],
    ["POST", "/api/learning-events", 200, "write"],
    ["POST", "/api/project-practice/submissions/finalize", 200, "write"],
    ["GET", "/api/courses/:courseId/events", 200, "realtime"],
    ["GET", "/api/courses/:courseId/projection", 200, "projection"],
    ["POST", "/api/ai-collaboration/document", 202, "ai-background"],
    ["POST", "/api/ai-collaboration/document", 200, "ai-interactive"],
    ["GET", "/api/uploads/:id", 200, "resource"],
    ["GET", "/api/metrics", 200, "probe"],
  ])("classifies %s %s without mixing realtime/AI/probe latency into saves", (method, route, status, operation) => {
    expect(httpOperation(method, route, Number(status))).toBe(operation);
  });
});
