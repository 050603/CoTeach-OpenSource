// @vitest-environment node
import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "./proxy";
import { isDirectReadApiPath } from "./lib/auth/read-api-boundary";

const bypassed = ["/api/server-providers", "/api/courses", ...["state", "events", "projection", "presence", "public-discussion"]
  .map(operation => `/api/courses/11111111-1111-4111-8111-111111111111/${operation}`),
  "/api/openmaic/classroom", "/api/openmaic/progress", "/api/learning-events",
  "/api/courses/course/showcase/presentation", "/api/courses/course/showcase/artifacts/pdf",
  "/api/ai-collaboration/code", "/api/ai-collaboration/document", "/api/ai-collaboration/memory"];
const retained = ["/api/auth/me", "/api/learning-events-extra", "/api/learning-events/extra",
  "/api/openmaic/progress/extra", "/api/openmaic/classroom-extra",
  "/api/ai-collaboration/code/run", "/api/ai-collaboration/document/extra",
  "/api/ai-collaboration/memory-extra", "/api/courses/course/public-discussion/settings",
  "/api/courses/course/presence-extra", "/", "/student", "/teacher", "/teacher/login", "/student/classroom/course",
  "/api/auth/login", "/api/auth/register", "/api/auth/join", "/api/platform/auth/me",
  "/api/server-providers-private", "/api/server-providers/extra", "/api/openmaic/server-providers",
  "/api/courses-extra", "/api/courses/course", "/api/courses/course/actions",
  "/api/courses/course/showcase/presentation/extra", "/api/courses/course/showcase/presentation-extra",
  "/api/courses/course/showcase/artifacts/export", "/api/courses/course/showcase/artifacts/11111111-1111-4111-8111-111111111111",
  "/api/courses/course/showcase/artifacts/pdf/extra", "/api/courses/course/showcase/artifacts/pdf-extra", "/api/courses/course/state/extra",
  "/api/courses/course/events-extra", "/api/courses/course/projection/extra",
  "/api/teacher-directives", "/api/openmaic/provider-config",
  "/api/health/ready", "/api/metrics",
  "/api/openmaic/classroom-media/class/audio/a.wav",
  "/api/openmaic/interactive-runtime/monaco/vs/editor/editor.main.js"];

describe("exact read API Proxy exclusions", () => {
  it.each(bypassed)("avoids the adapter for %s, including its existing trailing slash/query shape", pathname => {
    expect(isDirectReadApiPath(pathname)).toBe(true);
    for (const suffix of ["", "/", "?courseId=other", "/?x=1"]) {
      expect(unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${pathname}${suffix}` })).toBe(false);
    }
  });

  it.each(retained)("retains Proxy protection for %s", pathname => {
    expect(unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${pathname}` })).toBe(true);
    expect(isDirectReadApiPath(pathname)).toBe(false);
  });

  it("does not turn incoming headers or a method assertion into a bypass for an adjacent path", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "http://localhost:3000/api/courses/course/actions",
      headers: { "x-openpbl-role": "student", "x-http-method-override": "GET",
        "x-openpbl-action-proxy-started": "1", "x-openpbl-action-proxy-ended": "2" } })).toBe(true);
  });

  it("preserves the existing upload and native static-resource exclusions", () => {
    for (const pathname of ["/api/uploads", "/api/uploads/asset", "/_next/static/asset.js", "/brand/logo.svg"]) {
      expect(unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${pathname}` })).toBe(false);
    }
  });
});
