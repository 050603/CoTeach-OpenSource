import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), commit: vi.fn(), notify: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (fn: (tx: object) => unknown) => fn({}) }));
vi.mock("@/lib/project-practice/code-finalize", () => ({ finalizeCodeArtifact: mocks.commit }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
vi.mock("@/lib/evaluation/process-notifications", () => ({ notifyProcessEvaluation: mocks.notify }));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ legacyAiError: (error: { code: string; status: number }) => Response.json({ code: error.code }, { status: error.status }) }));
import { POST } from "./route";
const body = { courseId: "course", submissionId: "submission", stageKey: "make", expectedVersion: 2, requestId: "request", revisionNote: " 添加边界测试 " };
const request = (value = body) => new Request("http://localhost/api/project-practice/submissions/finalize-code", { method: "POST", body: JSON.stringify(value) });
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims: { role: "student", sub: "student", sv: 1 } }); mocks.commit.mockResolvedValue({ versionId: "version", sequence: 1, submittedAt: "now", submissionVersion: 3 }); });
it("accepts a bounded note, returns the frozen version and wakes process evaluation only after success", async () => {
  const response = await POST(request()); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ versionId: "version", submissionVersion: 3 });
  expect(mocks.commit.mock.calls[0][2]).toMatchObject({ revisionNote: "添加边界测试" }); expect(mocks.notify).toHaveBeenCalledWith("course", "student", true);
});
it.each([{ ...body, sourceHtml: "forged" }, { ...body, expectedVersion: 0 }, { ...body, revisionNote: "x".repeat(2001) }])("rejects unsupported client data before any mutation", async value => {
  expect((await POST(request(value))).status).toBe(400); expect(mocks.commit).not.toHaveBeenCalled();
});
it("honors authentication and same-origin guards", async () => {
  mocks.csrf.mockReturnValue(Response.json({}, { status: 403 })); expect((await POST(request())).status).toBe(403); expect(mocks.auth).not.toHaveBeenCalled();
  mocks.csrf.mockReturnValue(null); mocks.auth.mockResolvedValue({ response: Response.json({}, { status: 401 }) }); expect((await POST(request())).status).toBe(401); expect(mocks.commit).not.toHaveBeenCalled();
});
it("does not advertise a failed transaction as an available artifact", async () => {
  mocks.commit.mockRejectedValue({ code: "DRAFT_VERSION_CONFLICT", status: 409 }); expect((await POST(request())).status).toBe(409); expect(mocks.notify).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});
