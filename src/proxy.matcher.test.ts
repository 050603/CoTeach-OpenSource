// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { signTeacherToken } from "@/lib/auth/session";
import { ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER } from "@/lib/observability/action-entry-timing";
import { config, proxy } from "./proxy";

const originalSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

describe("proxy matcher", () => {
  it("sets an explicit same-origin connection source on public entry pages", async () => {
    delete process.env.JWT_SECRET;
    for (const pathname of ["/", "/student", "/teacher/login"]) {
      const url = `http://127.0.0.1:3000${pathname}`;
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
      const response = await proxy(new NextRequest(url, { headers: { host: "127.0.0.1:3000" } }));
      expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self' data: wss: http://127.0.0.1:3000");
    }
  });

  it("keeps upload bodies out of Proxy buffering", () => {
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/api/uploads",
    })).toBe(false);
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/api/uploads/00000000-0000-4000-8000-000000000000",
    })).toBe(false);
  });

  it("leaves large slide-image bodies to the authenticated route without broadening adjacent exclusions", () => {
    for (const suffix of ["", "/", "?page=1"]) {
      expect(unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000/api/openmaic/export/slide-image${suffix}` })).toBe(false);
    }
    for (const suffix of ["/extra", "-extra"]) {
      expect(unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000/api/openmaic/export/slide-image${suffix}` })).toBe(true);
    }
  });

  it("continues matching protected pages and other APIs", () => {
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/teacher",
    })).toBe(true);
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/api/courses/course/actions",
    })).toBe(true);
  });
});

describe("teacher login memory", () => {
  it("sends a returning teacher with a valid persistent session to the workspace", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const signed = await signTeacherToken({
      teacherId: "teacher-1",
      username: "teacher",
      displayName: "Teacher",
      sessionVersion: 1,
    });
    const request = new NextRequest("http://localhost:3000/teacher/login", {
      headers: { cookie: `${signed.cookieName}=${signed.token}` },
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/teacher");
  });

  it("keeps the login form available when the session was reported expired", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const signed = await signTeacherToken({
      teacherId: "teacher-1",
      username: "teacher",
      displayName: "Teacher",
      sessionVersion: 1,
    });
    const request = new NextRequest(
      "http://localhost:3000/teacher/login?reason=session-expired",
      { headers: { cookie: `${signed.cookieName}=${signed.token}` } },
    );

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("public runtime asset admission", () => {
  it.each(["GET", "HEAD"])("keeps CSP and diagnostic forwarding without reading cookies for public %s assets", async method => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const request = new NextRequest("http://127.0.0.1:3000/api/openmaic/interactive-runtime/monaco/vs/editor/editor.main.js?v=version", {
      method, headers: { host: "127.0.0.1:3000", cookie: "openpbl_student=invalid-cookie; openpbl_teacher=invalid-cookie",
        [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "2" },
    });
    const cookies = vi.spyOn(request.cookies, "get");
    try {
      const response = await proxy(request);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
      expect(cookies).not.toHaveBeenCalled();
      if (method === "GET") {
        const started = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_STARTED_HEADER}`));
        const ended = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_ENDED_HEADER}`));
        expect(started).toBeGreaterThan(2);
        expect(ended).toBeGreaterThanOrEqual(started);
      }
    } finally { cookies.mockRestore(); }
  });
  it("still checks cookies and rejects unauthenticated nearby private API paths", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    for (const pathname of ["/api/courses/course/state", "/api/openmaic/classroom", "/api/openmaic/interactive-runtime-private/file.js"]) {
      const request = new NextRequest(`http://localhost:3000${pathname}`);
      const cookies = vi.spyOn(request.cookies, "get");
      try {
        expect((await proxy(request)).status).toBe(401);
        expect(cookies).toHaveBeenCalled();
      } finally { cookies.mockRestore(); }
    }
  });
});
