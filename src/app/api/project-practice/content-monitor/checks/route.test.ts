import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), submit: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ legacyAiError: (e: { status?: number }) => Response.json({ error: "failed" }, { status: e.status ?? 503 }) }));
vi.mock("@/lib/project-practice/content-monitor-service", () => ({ submitContentMonitorCheck: mocks.submit, readContentMonitorCheck: mocks.read, ContentMonitorScopeClosed: class extends Error {} }));
import { ContentMonitorScopeClosed } from "@/lib/project-practice/content-monitor-service";
import { POST, GET } from "./route";
const body = { courseId: "course", requestId: "request", fragments: [{ text: "测试".repeat(160), beforeText: "" }], documentText: "当前文稿" };
const request = (value: unknown) => new Request("http://localhost/api/project-practice/content-monitor/checks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims: { sub: "student", role: "student", sv: 1 } }); mocks.submit.mockResolvedValue({ requestId: "request", status: "pending" }); });
describe("paste checks route", () => {
  it("requires same origin before attempting any mutation", async () => {
    mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
    expect((await POST(request(body))).status).toBe(403); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("authenticates and returns a private receipt without echoing pasted text", async () => {
    const result = await POST(request(body));
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toEqual({ requestId: "request", status: "pending" });
    expect(mocks.auth.mock.calls[0][1]).toBe("student");
  });
  it("rejects oversized content and untrusted extra provenance claims", async () => {
    expect((await POST(request({ ...body, fragments: [{ text: "a".repeat(30001), beforeText: "" }] }))).status).toBe(400);
    expect((await POST(request({ ...body, trustedSource: "system-ai" }))).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("returns cancellation when the classroom no longer accepts checks", async () => {
    mocks.submit.mockRejectedValue(new ContentMonitorScopeClosed());
    expect(await (await POST(request(body))).json()).toEqual({ requestId: "request", status: "cancelled" });
  });
  it("receipt lookup rejects a studentId override", async () => {
    const result = await GET(new Request("http://localhost/api/project-practice/content-monitor/checks?courseId=course&requestId=request&studentId=another"));
    expect(result.status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });
});
