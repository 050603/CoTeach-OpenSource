import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/platform/student-password-recovery", () => ({ completeStudentPasswordReset: mocks.complete }));
vi.mock("@/lib/redis/client", () => ({ getRedisClient: async () => null }));

import { POST } from "./route";
import { PlatformError } from "@/lib/platform/platform-error";
import { __resetDistributedRateLimitsForTests } from "@/lib/auth/distributed-rate-limit";

const browserToken = "a1".repeat(32);
function request(data: unknown = { password: "password123" }, options: { origin?: string | null; token?: string | null } = {}) {
  const headers = new Headers({ "Content-Type": "application/json", "x-real-ip": "192.0.2.10" });
  if (options.origin !== null) headers.set("Origin", options.origin ?? "http://localhost");
  if (options.token !== null) headers.set("Cookie", `openpbl_password_reset=${options.token ?? browserToken}`);
  return new Request("http://localhost/api/platform/auth/reset-password", { method: "POST", headers, body: JSON.stringify(data) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TRUST_PROXY_HEADERS", "true");
  __resetDistributedRateLimitsForTests();
  mocks.complete.mockResolvedValue({ ok: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("complete student password reset route", () => {
  it("accepts a new password with the original browser cookie without a login session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith(browserToken, "password123");
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["https://unrelated.example", null])("rejects unsafe origin %s before changing a password", async (origin) => {
    expect((await POST(request({ password: "password123" }, { origin }))).status).toBe(403);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([
    { password: "short" }, { password: "p".repeat(257) }, null,
    { token: "old-teacher-reset-link", password: "password123" },
    { username: "student", recoveryCode: "old-recovery-code", password: "password123" },
    { browserToken, password: "password123" },
    { requestId: "approved-request", password: "password123" },
  ])("rejects invalid passwords and obsolete or body-supplied credentials", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("requires the original browser cookie even when a password is valid", async () => {
    const response = await POST(request({ password: "password123" }, { token: null }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "RESET_REQUEST_INVALID" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("preserves an unapproved application error and hides infrastructure details", async () => {
    mocks.complete.mockRejectedValueOnce(new PlatformError("RESET_NOT_APPROVED", "请先等待教师允许", 403));
    const denied = await POST(request());
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: "RESET_NOT_APPROVED" });
    mocks.complete.mockRejectedValueOnce(new Error("database connection secret"));
    const failed = await POST(request());
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({ code: "RESET_FAILED", message: "暂时无法重置密码，请稍后重试" });
  });

  it("limits attempts per browser without blocking other students at the same campus IP", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => POST(request())));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 429]);
    expect(responses[5].headers.get("Retry-After")).toBeTruthy();
    const classmates = await Promise.all(Array.from({ length: 40 }, (_, index) => POST(request({ password: "password123" }, { token: index.toString(16).padStart(64, "0") }))));
    expect(classmates.map((response) => response.status)).toEqual(Array(40).fill(200));
    expect(mocks.complete).toHaveBeenCalledTimes(45);
  });

  it("also bounds scans across many browser credentials from one IP", async () => {
    const responses = await Promise.all(Array.from({ length: 121 }, (_, index) => POST(request({ password: "password123" }, { token: index.toString(16).padStart(64, "0") }))));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(120);
    expect(responses[120].status).toBe(429);
    expect(mocks.complete).toHaveBeenCalledTimes(120);
  });
});
