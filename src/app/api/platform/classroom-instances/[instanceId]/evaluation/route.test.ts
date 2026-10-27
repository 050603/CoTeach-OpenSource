// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), origin: vi.fn(), get: vi.fn(), mutate: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.origin }));
vi.mock("@/lib/evaluation/pbl-service", () => ({ getPblEvaluation: mocks.get, mutatePblEvaluation: mocks.mutate }));
import { PlatformError } from "@/lib/platform/repository";
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ instanceId: "i" }) };
const claims = { sub: "s", role: "student" };
const req = (body?: unknown) => new Request("http://localhost/api/platform/classroom-instances/i/evaluation", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims }); mocks.get.mockResolvedValue({ role: "student", participants: [] }); mocks.mutate.mockResolvedValue({ role: "teacher", participants: [] }); });
describe("PBL evaluation route", () => {
  it("authenticates before returning a private, no-store role projection", async () => {
    const response = await GET(req(), context); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(mocks.get).toHaveBeenCalledWith(claims, "i");
    mocks.auth.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) }); expect((await GET(req(), context)).status).toBe(401); expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it("requires same-origin and valid command before mutation", async () => {
    mocks.origin.mockReturnValueOnce(new Response(null, { status: 403 })); expect((await POST(req({ action: "assign" }), context)).status).toBe(403); expect(mocks.auth).not.toHaveBeenCalled();
    expect((await POST(req({ action: "assign" }), context)).status).toBe(400); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("surfaces membership and optimistic concurrency failures without any report body", async () => {
    mocks.get.mockRejectedValue(new PlatformError("FORBIDDEN", "无权访问", 403)); const response = await GET(req(), context); expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    mocks.mutate.mockRejectedValue(new PlatformError("DRAFT_VERSION_CONFLICT", "请刷新", 409)); const write = await POST(req({ action: "assign", idempotencyKey: "1b283575-dc73-4f24-98d5-be25ee4bcf3f" }), context); expect(write.status).toBe(409); expect(await write.json()).toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });
  });
});
