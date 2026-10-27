import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), load: vi.fn(), submit: vi.fn(), run: vi.fn(), after: vi.fn(), limit: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.auth }));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({ checkDistributedRateLimit: mocks.limit }));
vi.mock("@/lib/collaborative-preparation/server", () => ({ loadPreparationSession: mocks.load, submitPreparationMutation: mocks.submit, runPreparationTurn: mocks.run, PreparationError: class extends Error { code = "PREPARATION_REVISION_CONFLICT"; status = 409; } }));
vi.mock("@/lib/course-design/generation-references", () => ({ GenerationReferenceError: class extends Error {} }));
vi.mock("@/lib/textbook/course-evidence", () => ({ CourseEvidenceError: class extends Error {} }));
import { GET, PATCH, POST } from "./route";
import { PreparationError } from "@/lib/collaborative-preparation/server";
const context = { params: Promise.resolve({ courseId: "course" }) };
const request = (method: string, body?: object) => new Request("http://localhost/api/courses/course/collaborative-preparation", { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
beforeEach(() => {
  vi.resetAllMocks(); mocks.auth.mockResolvedValue("teacher"); mocks.limit.mockResolvedValue({ allowed: true }); mocks.load.mockResolvedValue(null);
  mocks.submit.mockResolvedValue({ session: { id: "session", revision: 1, status: "processing" }, turnId: "turn" });
});
describe("collaborative preparation route", () => {
  it("restores private state without starting a model request", async () => {
    const response = await GET(request("GET"), context);
    expect(await response.json()).toEqual({ session: null });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("authorizes the course before reading or mutating a private conversation", async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await GET(request("GET"), context)).status).toBe(403);
    expect((await POST(request("POST", { revision: 0, requestId: "a", message: "蒸发课" }), context)).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("returns a persisted pending turn before scheduling AI work", async () => {
    const input = { revision: 0, requestId: "first", message: "蒸发课" };
    const response = await POST(request("POST", input), context);
    expect(response.status).toBe(202);
    expect(mocks.submit).toHaveBeenCalledWith("course", "teacher", input);
    expect(mocks.run).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0](); expect(mocks.run).toHaveBeenCalledWith("turn");
  });
  it("returns conflicts and preserves caller input rather than starting another turn", async () => {
    mocks.submit.mockRejectedValue(new PreparationError("备课内容已更新"));
    const response = await PATCH(request("PATCH", { action: "revise", revision: 1, requestId: "edit", message: "改成初中" }), context);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "PREPARATION_REVISION_CONFLICT" });
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it("rejects absent revision and actions on the wrong HTTP method", async () => {
    expect((await POST(request("POST", { message: "蒸发课" }), context)).status).toBe(400);
    expect((await POST(request("POST", { action: "confirm", revision: 1, requestId: "confirm" }), context)).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("does not dispatch a model call for a confirmed snapshot", async () => {
    mocks.submit.mockResolvedValue({ session: { id: "session", revision: 2, status: "confirmed" }, turnId: null });
    expect((await PATCH(request("PATCH", { action: "confirm", revision: 1, requestId: "confirm" }), context)).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
