import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/platform/student-password-recovery", () => ({
  createStudentPasswordResetRequest: mocks.create, getStudentPasswordResetRequest: mocks.get, RESET_BROWSER_SECONDS: 2400,
}));
vi.mock("@/lib/redis/client", () => ({ getRedisClient: async () => null }));

import { GET, POST } from "./route";
import { PlatformError } from "@/lib/platform/platform-error";
import { __resetDistributedRateLimitsForTests } from "@/lib/auth/distributed-rate-limit";

const browserToken = "a1".repeat(32);
const publicRequest = { id: "request-1", username: "student1", displayName: "学生", state: "pending", createdAt: "2026-10-26T08:00:00Z", expiresAt: "2026-10-26T08:30:00Z", approvedAt: null };
function request(body: unknown = { username: "student1", displayName: "学生" }, options: { origin?: string | null; token?: string; ip?: string; method?: "GET" | "POST" } = {}) {
  const headers = new Headers({ "Content-Type": "application/json", "x-real-ip": options.ip ?? "192.0.2.10" });
  if (options.origin !== null) headers.set("Origin", options.origin ?? "http://localhost");
  if (options.token) headers.set("Cookie", `openpbl_password_reset=${options.token}`);
  return new Request("http://localhost/api/platform/auth/password-reset-request", { method: options.method ?? "POST", headers, ...(options.method === "GET" ? {} : { body: JSON.stringify(body) }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TRUST_PROXY_HEADERS", "true");
  __resetDistributedRateLimitsForTests();
  mocks.create.mockResolvedValue({ request: publicRequest, browserToken });
  mocks.get.mockResolvedValue(publicRequest);
});
afterEach(() => vi.unstubAllEnvs());

describe("anonymous student reset applications", () => {
  it("creates an application without login and puts the browser credential only in a scoped HttpOnly cookie", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("student1", "学生", undefined);
    await expect(response.json()).resolves.toEqual({ request: publicRequest });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain(`openpbl_password_reset=${browserToken};`);
    expect(cookie).toContain("Path=/api/platform/auth;");
    expect(cookie).toContain("HttpOnly;");
    expect(cookie).toContain("Max-Age=2400;");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("retains the original browser credential when resuming an application", async () => {
    const response = await POST(request({ username: "student1", displayName: "学生" }, { token: browserToken }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("student1", "学生", browserToken);
  });

  it("reads current application state anonymously from the cookie and never returns the credential", async () => {
    const response = await GET(request(null, { method: "GET", token: browserToken }));
    expect(mocks.get).toHaveBeenCalledWith(browserToken);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ request: publicRequest });
    mocks.get.mockResolvedValue(null);
    await expect((await GET(request(null, { method: "GET" }))).json()).resolves.toEqual({ request: null });
    expect(mocks.get).toHaveBeenLastCalledWith(undefined);
  });

  it.each(["https://unrelated.example", null])("rejects unsafe origin %s before creating an application", async (origin) => {
    expect((await POST(request({ username: "student1", displayName: "学生" }, { origin }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    { username: "", displayName: "学生" }, { username: "student1", displayName: "" }, null,
    { username: "student1", displayName: "学生", browserToken },
  ])("rejects missing identity and body-supplied browser credentials", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves another-browser conflict without replacing the browser cookie", async () => {
    mocks.create.mockRejectedValue(new PlatformError("RESET_ALREADY_REQUESTED", "请回原申请浏览器继续", 409));
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "RESET_ALREADY_REQUESTED" });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("allows 40 students sharing an IP and limits one normalized account across IPs", async () => {
    const classmates = await Promise.all(Array.from({ length: 40 }, (_, index) => POST(request({ username: `classmate${index}`, displayName: "学生" }))));
    expect(classmates.map((response) => response.status)).toEqual(Array(40).fill(201));
    const repeated = await Promise.all(Array.from({ length: 6 }, (_, index) => POST(request({ username: index % 2 ? " ＳＴＵＤＥＮＴ１ " : "student1", displayName: "学生" }, { ip: `192.0.2.${index + 1}` }))));
    expect(repeated.map((response) => response.status)).toEqual([201, 201, 201, 201, 201, 429]);
    expect(repeated[5].headers.get("Retry-After")).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledTimes(45);
  });

  it("bounds scans across account names from one IP", async () => {
    const responses = await Promise.all(Array.from({ length: 121 }, (_, index) => POST(request({ username: `target${index}`, displayName: "学生" }))));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(120);
    expect(responses[120].status).toBe(429);
  });

  it("hides internal failures on both creation and polling", async () => {
    mocks.create.mockRejectedValue(new Error("database connection secret"));
    mocks.get.mockRejectedValue(new Error("database connection secret"));
    const created = await POST(request());
    const polled = await GET(request(null, { method: "GET" }));
    expect(created.status).toBe(503);
    expect(polled.status).toBe(503);
    await expect(created.json()).resolves.toMatchObject({ code: "RESET_REQUEST_FAILED", message: "暂时无法提交申请，请稍后重试" });
    await expect(polled.json()).resolves.toMatchObject({ code: "RESET_UNAVAILABLE", message: "暂时无法查看重置申请，请稍后重试" });
  });
});
