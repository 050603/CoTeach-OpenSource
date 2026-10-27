import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmNotConfiguredError } from "@/lib/llm/errors";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), course: vi.fn(), advice: vi.fn(), process: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: () => null }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.course }));
vi.mock("@/lib/teaching-ai/support-engine", () => ({ buildTeacherDashboardAdvice: mocks.advice, generateProcessEvaluation: mocks.process }));
import { POST } from "./route";
const request = () => new NextRequest("http://localhost/api/teaching-ai/support", { method: "POST", body: JSON.stringify({ action: "buildTeacherDashboardAdvice", input: { courseId: "instance", stageKey: "make" } }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
  mocks.access.mockResolvedValue(true);
  mocks.course.mockResolvedValue({ id: "instance", stages: [{ key: "make" }] });
});
describe("V2 teaching dashboard support", () => {
  it("rejects another teaching offering before reading its classroom evidence", async () => {
    mocks.access.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.course).not.toHaveBeenCalled(); expect(mocks.advice).not.toHaveBeenCalled();
  });
  it("reports missing AI configuration separately from database failure", async () => {
    mocks.advice.mockRejectedValue(new LlmNotConfiguredError());
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "AI_NOT_CONFIGURED", message: "请先在 AI 设置中配置模型服务" });
  });
});
describe("process evaluation compatibility boundary", () => {
  const processRequest = () => new NextRequest("http://localhost/api/teaching-ai/support", { method: "POST", body: JSON.stringify({ action: "generateProcessEvaluation", input: { course: { id: "instance", privateEvidence: "forged" }, evidence: "forged" } }) });
  it("does not let a student use the legacy synchronous process endpoint", async () => {
    mocks.auth.mockResolvedValueOnce({ claims: { sub: "student", role: "student" } }).mockResolvedValueOnce({ response: Response.json({}, { status: 403 }) });
    expect((await POST(processRequest())).status).toBe(403);
    expect(mocks.course).not.toHaveBeenCalled(); expect(mocks.process).not.toHaveBeenCalled();
  });
  it("routes new classrooms to the durable authoritative-evidence queue", async () => {
    mocks.course.mockResolvedValue({ id: "instance", evaluationContractVersion: 2 });
    const response = await POST(processRequest());
    expect(response.status).toBe(409);
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it("uses only the server-owned legacy classroom instead of client-supplied evidence", async () => {
    const saved = { id: "instance", students: [] };
    mocks.course.mockResolvedValue(saved); mocks.process.mockResolvedValue({ dimensions: [] });
    expect((await POST(processRequest())).status).toBe(200);
    expect(mocks.process).toHaveBeenCalledWith({ course: saved }, expect.anything());
  });
});
